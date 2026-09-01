import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import { disablePushDevice } from '../notifications/pushRegistration';
import { router } from 'expo-router';
import type { AuthSession, AuthUser } from '@sheer/domain';
import * as authApi from './api';

const STORAGE_KEY = 'sheer.sheer-app.auth.session';

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

  // When any authenticated request times out (401), clear the stored session and
  // send the user to the login screen so they can sign back in immediately.
  useEffect(() => {
    authApi.setUnauthorizedHandler(() => {
      void clearSession();
      router.replace('/login');
    });
    return () => authApi.setUnauthorizedHandler(null);
  }, [clearSession]);

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
      } catch {
        if (!storedSession.refreshToken) {
          if (!cancelled) await clearSession();
          return;
        }

        try {
          const refreshed = await authApi.refreshSession(storedSession.refreshToken);
          if (!cancelled) await persistSession(refreshed.session, refreshed.user);
        } catch {
          if (!cancelled) await clearSession();
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [clearSession, persistSession]);

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

async function readStoredSession(): Promise<AuthSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    return null;
  }
}
