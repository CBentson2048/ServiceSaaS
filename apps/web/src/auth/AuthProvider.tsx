import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSession, AuthUser, LoginResponse } from '@sheer/domain';
import * as authApi from './api';
import { ApiRequestError } from './api';

const STORAGE_KEY = 'sheer.web.auth.session';

/** Cross-tab Web Lock guarding refresh-token rotation. */
const REFRESH_LOCK_NAME = 'sheer.web.auth.refresh';

/**
 * Back-off before re-checking the stored token when the API could not be
 * reached. Long enough to ride out an API restart, short enough that a genuinely
 * offline browser is not left staring at the restoring screen.
 */
const REVALIDATE_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

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
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('bootstrapping');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => readStoredSession());

  const applySession = useCallback((nextSession: AuthSession, nextUser: AuthUser) => {
    setSession(nextSession);
    setUser(nextUser);
    setStatus('authenticated');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setUser(null);
    setStatus('anonymous');
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  /**
   * Gives up on this page load WITHOUT discarding the stored session. Used when
   * the API could not be reached: the credentials are very likely still good, so
   * throwing them away would sign the user out over someone else's outage.
   */
  const standDown = useCallback(() => {
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

      const result = await revalidateAccessToken(session.accessToken, () => cancelled);
      if (cancelled) return;

      if (result.outcome === 'valid') {
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
  }, [applySession, clearSession, standDown, session?.accessToken, session?.refreshToken]);

  // Another dashboard tab signed in, signed out, or rotated the token. Adopt its
  // result rather than carrying on with a session the server has already
  // retired — and let a sign-out reach every open tab.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY || event.storageArea !== localStorage) return;

      const next = readStoredSession();
      setSession((current) => (next?.accessToken === current?.accessToken ? current : next));
      if (!next) {
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
    }),
    [applySession, createAccount, session, signIn, signOut, status, user],
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
