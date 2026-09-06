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
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { disablePushDevice } from '../notifications/pushRegistration';
import { router } from 'expo-router';
import type { AuthSession, AuthUser } from '@sheer/domain';
import * as authApi from './api';

const STORAGE_KEY = 'sheer.sheer-app.auth.session';

/**
 * How long before the access token expires we rotate it — comfortably longer
 * than a slow round trip on a phone network.
 */
const REFRESH_MARGIN_MS = 60_000;

/** Back-off when a scheduled refresh cannot reach the API. */
const REFRESH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * The closest together two scheduled rotations may be. A handset whose clock is
 * wrong sees every fresh token as already expired; without a floor that would
 * rotate in a loop for as long as the app is open.
 */
const MIN_ROTATION_SPACING_MS = 60_000;

interface AuthState {
  status: 'bootstrapping' | 'authenticated' | 'anonymous';
  user: AuthUser | null;
  session: AuthSession | null;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  // Register a new salon-agnostic customer account and sign straight in — the
  // backend returns the same session shape as login. The customer joins a salon
  // lazily on their first booking.
  signUp: (payload: authApi.RegisterCustomerRequest) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  // Patch the in-memory auth user so surfaces that read auth.user (e.g. the
  // booking review's communication preference) reflect a just-saved profile
  // change without waiting for a re-bootstrap. Only the session is persisted;
  // getCurrentUser re-fetches the authoritative user on next launch.
  updateUser: (patch: Partial<AuthUser>) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('bootstrapping');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  /**
   * Bumped when the app comes to the foreground, so a session that could not be
   * restored while the handset was offline is retried instead of stranding the
   * user on the login screen with valid credentials still in SecureStore.
   */
  const [recoveryTick, setRecoveryTick] = useState(0);
  /** When the scheduler last rotated, so a skewed clock cannot spin. */
  const lastRotationAt = useRef(0);

  const persistSession = useCallback(async (nextSession: AuthSession, nextUser: AuthUser) => {
    setSession(nextSession);
    setUser(nextUser);
    setStatus('authenticated');
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(nextSession));
  }, []);

  const clearSession = useCallback(async () => {
    setSession(null);
    setUser(null);
    setStatus('anonymous');
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  }, []);

  // When an authenticated request still fails after a refresh attempt, the
  // session really is over: clear it and send the user to the login screen.
  useEffect(() => {
    authApi.setUnauthorizedHandler(() => {
      void clearSession();
      router.replace('/login');
    });
    return () => authApi.setUnauthorizedHandler(null);
  }, [clearSession]);

  /**
   * Lets any authenticated request recover from an expired access token by
   * rotating once and replaying itself, instead of ending the session. Reads
   * SecureStore rather than this closure so it always uses the newest token.
   */
  useEffect(() => {
    authApi.setSessionRefreshHandler(async (staleToken: string) => {
      const stored = await readStoredSession();
      if (!stored?.refreshToken) return null;
      // A screen can hold a token captured before the last rotation; if the
      // store already has a newer one, hand that over rather than spending another.
      if (stored.accessToken && stored.accessToken !== staleToken) return stored.accessToken;
      try {
        const refreshed = await authApi.refreshSession(stored.refreshToken);
        await persistSession(refreshed.session, refreshed.user);
        return refreshed.session.accessToken;
      } catch (error: unknown) {
        if (isAuthFailure(error)) await clearSession();
        return null;
      }
    });
    return () => authApi.setSessionRefreshHandler(null);
  }, [clearSession, persistSession]);

  /**
   * Rotate the token BEFORE it expires. The API returns `expiresAt` with every
   * session; until this existed nothing read it, so a stylist was signed out
   * roughly an hour into every shift — usually by the notification badge poll,
   * which is what made it feel random.
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
    let timer: ReturnType<typeof setTimeout>;

    const rotate = async () => {
      if (cancelled) return;
      lastRotationAt.current = Date.now();
      try {
        const refreshed = await authApi.refreshSession(refreshToken);
        if (!cancelled) await persistSession(refreshed.session, refreshed.user);
      } catch (error: unknown) {
        if (cancelled) return;
        if (isAuthFailure(error)) {
          await clearSession();
          return;
        }
        const delayMs = REFRESH_RETRY_DELAYS_MS[Math.min(attempt, REFRESH_RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        timer = setTimeout(() => void rotate(), delayMs);
      }
    };

    // A handset that was asleep past the deadline lands here with a negative
    // delay and rotates immediately.
    const now = Date.now();
    timer = setTimeout(
      () => void rotate(),
      Math.max(
        expiresAtMs - now - REFRESH_MARGIN_MS,
        lastRotationAt.current + MIN_ROTATION_SPACING_MS - now,
        0,
      ),
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    clearSession,
    persistSession,
    status,
    session?.accessToken,
    session?.expiresAt,
    session?.refreshToken,
    recoveryTick,
  ]);

  // Coming back to the foreground is the moment to retry anything we gave up on.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') setRecoveryTick((tick) => tick + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const storedSession = await readStoredSession();
      if (!storedSession?.accessToken) {
        if (!cancelled) setStatus('anonymous');
        return;
      }

      try {
        const { user: currentUser } = await authApi.getCurrentUser(storedSession.accessToken);
        if (!cancelled) {
          setSession(storedSession);
          setUser(currentUser);
          setStatus('authenticated');
        }
        return;
      } catch (error: unknown) {
        // Only the server REJECTING the token proves the session is dead. A
        // cold start with no signal used to look identical to a revoked
        // session, and deleted credentials that were still perfectly good.
        if (!isAuthFailure(error)) {
          if (!cancelled) setStatus('anonymous');
          return;
        }
      }

      if (!storedSession.refreshToken) {
        if (!cancelled) await clearSession();
        return;
      }

      try {
        const refreshed = await authApi.refreshSession(storedSession.refreshToken);
        if (!cancelled) await persistSession(refreshed.session, refreshed.user);
      } catch (error: unknown) {
        if (cancelled) return;
        if (isAuthFailure(error)) await clearSession();
        else setStatus('anonymous');
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [clearSession, persistSession, recoveryTick]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const response = await authApi.login(email, password);
      await persistSession(response.session, response.user);
      return response.user;
    },
    [persistSession],
  );

  const signUp = useCallback(
    async (payload: authApi.RegisterCustomerRequest) => {
      const response = await authApi.registerCustomer(payload);
      await persistSession(response.session, response.user);
      return response.user;
    },
    [persistSession],
  );

  const signOut = useCallback(async () => {
    const currentSession = session;
    // Stop pushing to this handset BEFORE the token is discarded — afterwards
    // there is nothing left to authenticate the call with, and the next person to
    // pick the phone up would keep buzzing for the previous stylist's clients.
    // Best effort: a failure here must never block signing out.
    await disablePushDevice(currentSession?.accessToken).catch(() => undefined);
    await clearSession();
    await authApi.logout(currentSession?.accessToken, currentSession?.refreshToken).catch(() => undefined);
  }, [clearSession, session]);

  const updateUser = useCallback((patch: Partial<AuthUser>) => {
    setUser((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, user, session, signIn, signUp, signOut, updateUser }),
    [session, signIn, signUp, signOut, status, updateUser, user],
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

/** Only the server rejecting our credentials means the session is really gone. */
function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof authApi.ApiError && (error.status === 401 || error.status === 403)
  );
}

async function readStoredSession(): Promise<AuthSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return null;
  }
}
