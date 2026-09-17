import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSession, AuthUser, LoginResponse } from '@sheer/domain';
import * as authApi from './api';
import { ApiRequestError, setExpiredTokenHandler } from './api';

const STORAGE_KEY = 'sheer.web.auth.session';
/** Per tab, so a reload or Back/Forward into this tab still knows it was signed out of. */
const SIGNED_OUT_KEY = 'sheer.web.auth.signedOut';

/**
 * The saved sign-out counts only when this page load returns to earlier pages
 * (a reload, Back/Forward, a restored tab). A link opened fresh — shared,
 * bookmarked, typed — is a new visit and keeps its sign-in target.
 */
function readSignedOut(): boolean {
  try {
    if (sessionStorage.getItem(SIGNED_OUT_KEY) !== '1') return false;
    const [entry] = (performance.getEntriesByType?.('navigation') ?? []) as PerformanceNavigationTiming[];
    // No timing entry: assume a return (fail-safe). A prerender is a new visit.
    return entry === undefined || entry.type === 'reload' || entry.type === 'back_forward';
  } catch {
    return false;
  }
}

function writeSignedOut(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(SIGNED_OUT_KEY, '1');
    else sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // Storage unavailable: the in-memory flag still covers this page load.
  }
}

/** Cross-tab Web Lock guarding refresh-token rotation. */
const REFRESH_LOCK_NAME = 'sheer.web.auth.refresh';

/**
 * Back-off before re-checking the stored token when the API could not be
 * reached. Long enough to ride out an API restart, short enough that a genuinely
 * offline browser is not left staring at the restoring screen.
 */
const REVALIDATE_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

/**
 * How long before the access token expires we rotate it. Comfortably longer than
 * a slow round trip, so a request is never issued with a token that expires in
 * flight.
 */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Back-off when a scheduled refresh cannot reach the API. The first retry is
 * deliberately quick: Supabase honours a just-rotated refresh token for a short
 * reuse interval, so a fast retry after a failure mid-rotation still succeeds.
 */
const REFRESH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/** `setTimeout` clamps above this, which would fire the timer immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The closest together two scheduled rotations may be.
 *
 * A device whose clock is wrong sees every fresh token as already past its
 * deadline, which without a floor would rotate in a tight loop for as long as
 * the tab is open. The session still works — the server judges expiry by its own
 * clock — so this bounds the damage to one wasted refresh a minute.
 */
const MIN_ROTATION_SPACING_MS = 60_000;

interface AuthState {
  status: 'bootstrapping' | 'authenticated' | 'anonymous';
  user: AuthUser | null;
  session: AuthSession | null;
  createAccount: (input: {
    email: string;
    password: string;
    fullName: string;
    businessName: string;
  }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  applyAuthenticatedSession: (session: AuthSession, user: AuthUser) => void;
  /**
   * True from a sign-out (in this tab or another) until the next sign-in or a
   * proven stored session; a reload or Back/Forward into the tab still sees it,
   * a freshly opened link does not. A protected route then
   * records no sign-in target, so nothing about the page that was signed out
   * of — Back included — reaches whoever signs in next.
   */
  signedOut: boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('bootstrapping');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => readStoredSession());
  // Saved only where it changes: a fresh visit must not erase the saved flag,
  // which a later Back into the signed-out user's pages still needs.
  const [signedOut, setSignedOut] = useState(readSignedOut);
  /**
   * Bumped when something suggests it is worth trying the API again — the
   * browser came back online, the tab was brought forward. Both the bootstrap
   * and the refresh timer watch it, so a session that stood down during an
   * outage recovers by itself instead of waiting for a reload.
   */
  const [recoveryTick, setRecoveryTick] = useState(0);
  /**
   * The access token we have already proved is good. A session we just received
   * from the API does not need proving again — without this the bootstrap effect
   * re-ran on every sign-in and every rotation, spending a second `/auth/me` and
   * (if that one blipped) throwing away the session it had just been handed.
   */
  const provenToken = useRef<string | null>(null);
  /** When the scheduler last rotated, so a skewed clock cannot spin. */
  const lastRotationAt = useRef(0);

  const applySession = useCallback((nextSession: AuthSession, nextUser: AuthUser) => {
    provenToken.current = nextSession.accessToken;
    writeSignedOut(false);
    setSignedOut(false);
    setSession(nextSession);
    setUser(nextUser);
    setStatus('authenticated');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
  }, []);

  const clearSession = useCallback(() => {
    provenToken.current = null;
    setSession(null);
    setUser(null);
    setStatus('anonymous');
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  /**
   * Gives up on this attempt WITHOUT discarding the stored session. Used when
   * the API could not be reached: the credentials are very likely still good, so
   * throwing them away would sign the user out over someone else's outage. The
   * recovery listeners below try again when the world looks better.
   */
  const standDown = useCallback(() => {
    provenToken.current = null;
    setUser(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!session?.accessToken) {
        if (!cancelled) setStatus('anonymous');
        return;
      }

      // Already proved on this page load — nothing to re-check.
      if (provenToken.current === session.accessToken) return;

      const result = await revalidateAccessToken(session.accessToken, () => cancelled);
      if (cancelled) return;

      if (result.outcome === 'valid') {
        provenToken.current = session.accessToken;
        // A proven stored session (this tab reloaded, or another tab signed in)
        // is a sign-in for this tab.
        writeSignedOut(false);
        setSignedOut(false);
        setUser(result.user);
        setStatus('authenticated');
        return;
      }

      if (result.outcome === 'unreachable') {
        standDown();
        return;
      }

      if (!session.refreshToken) {
        clearSession();
        return;
      }

      try {
        const refreshed = await refreshSessionOnce(session.refreshToken);
        if (!cancelled) applySession(refreshed.session, refreshed.user);
      } catch (error: unknown) {
        if (cancelled) return;
        // Only the server rejecting the refresh token proves the session is
        // dead. Anything else is an outage, and the token deserves another go.
        if (isAuthFailure(error)) clearSession();
        else standDown();
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [
    applySession,
    clearSession,
    standDown,
    session?.accessToken,
    session?.refreshToken,
    recoveryTick,
  ]);

  /**
   * Rotate the token BEFORE it expires.
   *
   * This is the difference between a session that lasts as long as someone is
   * working and one that stops an hour after they signed in. The API returns
   * `expiresAt` with every session; until this existed, nothing read it, and
   * the first anyone knew about expiry was every page failing at once.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;
    const refreshToken = session?.refreshToken;
    const expiresAt = session?.expiresAt;
    if (!refreshToken || !expiresAt) return;

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) return;

    let cancelled = false;
    let attempt = 0;
    let timer = 0;

    const rotate = async () => {
      if (cancelled) return;
      lastRotationAt.current = Date.now();
      try {
        const refreshed = await refreshSessionOnce(refreshToken);
        if (!cancelled) applySession(refreshed.session, refreshed.user);
      } catch (error: unknown) {
        if (cancelled) return;
        if (isAuthFailure(error)) {
          clearSession();
          return;
        }
        const delayMs = REFRESH_RETRY_DELAYS_MS[Math.min(attempt, REFRESH_RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        timer = window.setTimeout(() => void rotate(), delayMs);
      }
    };

    // A machine that slept through the deadline lands here with a negative
    // delay and rotates immediately.
    const now = Date.now();
    const dueInMs = Math.min(
      Math.max(expiresAtMs - now - REFRESH_MARGIN_MS, lastRotationAt.current + MIN_ROTATION_SPACING_MS - now, 0),
      MAX_TIMEOUT_MS,
    );
    timer = window.setTimeout(() => void rotate(), dueInMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    applySession,
    clearSession,
    status,
    session?.accessToken,
    session?.expiresAt,
    session?.refreshToken,
    recoveryTick,
  ]);

  /**
   * Lets any authenticated request recover from an expired token by rotating
   * once and replaying itself. Reads the session from storage rather than from
   * this closure so it always uses the newest token — including one another tab
   * rotated a moment ago.
   */
  useEffect(() => {
    setExpiredTokenHandler(async (staleToken: string) => {
      const current = readStoredSession();
      if (!current?.refreshToken) return null;
      // A page can hold a token captured before the last rotation. If storage
      // already has a newer one, hand that over rather than spending another.
      if (current.accessToken && current.accessToken !== staleToken) return current.accessToken;
      try {
        const refreshed = await refreshSessionOnce(current.refreshToken);
        applySession(refreshed.session, refreshed.user);
        return refreshed.session.accessToken;
      } catch (error: unknown) {
        if (isAuthFailure(error)) clearSession();
        return null;
      }
    });
    return () => setExpiredTokenHandler(null);
  }, [applySession, clearSession]);

  // Something changed for the better: try whatever we gave up on.
  useEffect(() => {
    const retry = () => setRecoveryTick((tick) => tick + 1);
    const retryIfVisible = () => {
      if (document.visibilityState === 'visible') retry();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retryIfVisible);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retryIfVisible);
    };
  }, []);

  // Another dashboard tab signed in, signed out, or rotated the token. Adopt its
  // result rather than carrying on with a session the server has already
  // retired — and let a sign-out reach every open tab.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY || event.storageArea !== localStorage) return;

      const next = readStoredSession();
      setSession((current) => {
        if (next?.accessToken === current?.accessToken) return current;
        // A different token may belong to a different person, so the user this
        // tab is showing is no longer known to be right. Leaving `status` alone
        // keeps the UI up while the bootstrap effect re-proves it.
        provenToken.current = null;
        return next;
      });
      if (!next) {
        writeSignedOut(true);
        setSignedOut(true);
        setUser(null);
        setStatus('anonymous');
      }
    }

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const response = await authApi.login({ email, password });
      applySession(response.session, response.user);
      return response.user;
    },
    [applySession],
  );

  const createAccount = useCallback(
    async (input: { email: string; password: string; fullName: string; businessName: string }) => {
      const response = await authApi.createAccount(input);
      applySession(response.session, response.user);
    },
    [applySession],
  );

  const signOut = useCallback(async () => {
    const currentSession = session;
    writeSignedOut(true);
    setSignedOut(true);
    clearSession();
    await authApi.logout(currentSession?.accessToken, currentSession?.refreshToken).catch(() => undefined);
  }, [clearSession, session]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      session,
      createAccount,
      signIn,
      signOut,
      applyAuthenticatedSession: applySession,
      signedOut,
    }),
    [applySession, createAccount, session, signIn, signOut, signedOut, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}

function readStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

type RevalidateResult =
  | { outcome: 'valid'; user: AuthUser }
  | { outcome: 'expired' }
  | { outcome: 'unreachable' };

/**
 * Confirms the stored access token still works.
 *
 * A failed `/auth/me` used to be read as "the session is dead", but `request()`
 * throws the same way for a network rejection, a 502 while the API redeploys and
 * a CORS failure as it does for a 401 — so one bad moment at page load signed the
 * user out and deleted a perfectly good refresh token. Transient failures are
 * retried here instead, and only a 401/403 counts as expired.
 */
async function revalidateAccessToken(
  accessToken: string,
  isCancelled: () => boolean,
): Promise<RevalidateResult> {
  for (let attempt = 0; !isCancelled(); attempt += 1) {
    try {
      const { user } = await authApi.getCurrentUser(accessToken);
      return { outcome: 'valid', user };
    } catch (error: unknown) {
      if (isAuthFailure(error)) return { outcome: 'expired' };
      if (attempt >= REVALIDATE_RETRY_DELAYS_MS.length) return { outcome: 'unreachable' };
      await delay(REVALIDATE_RETRY_DELAYS_MS[attempt]);
    }
  }
  return { outcome: 'unreachable' };
}

let inFlightRefresh: Promise<LoginResponse> | null = null;

/**
 * Rotates the refresh token at most once at a time, per tab AND across tabs.
 *
 * Supabase rotates refresh tokens, so replaying one fails. Two things used to
 * replay it: StrictMode double-invoking the bootstrap effect in development, and
 * several dashboard tabs revalidating the same stored session once the access
 * token expired. Whichever caller lost that race landed in the catch above and
 * signed the user out.
 */
function refreshSessionOnce(refreshToken: string): Promise<LoginResponse> {
  if (inFlightRefresh) return inFlightRefresh;

  const attempt = runExclusively(REFRESH_LOCK_NAME, () => rotateOrAdopt(refreshToken)).finally(() => {
    inFlightRefresh = null;
  });
  inFlightRefresh = attempt;
  return attempt;
}

async function rotateOrAdopt(refreshToken: string): Promise<LoginResponse> {
  // Another tab may have rotated the token while this one waited for the lock.
  // Its new session is already in storage — adopt that rather than replaying a
  // token the server has now retired.
  const stored = readStoredSession();
  if (stored?.refreshToken && stored.refreshToken !== refreshToken) {
    const { user } = await authApi.getCurrentUser(stored.accessToken);
    return { session: stored, user };
  }
  return authApi.refreshSession(refreshToken);
}

/**
 * Runs `task` under a cross-tab Web Lock where the browser provides one. Without
 * it the per-tab guard above still applies, so older browsers degrade to the
 * previous behaviour rather than breaking.
 */
async function runExclusively<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (!locks?.request) return task();
  return await locks.request(name, task);
}

/** Only the server rejecting our credentials means the session is really gone. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
