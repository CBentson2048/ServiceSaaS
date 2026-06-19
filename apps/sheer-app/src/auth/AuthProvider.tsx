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
import { router } from 'expo-router';
import type { AuthSession, AuthUser } from '@sheer/domain';
import * as authApi from './api';

const STORAGE_KEY = 'sheer.sheer-app.auth.session';

interface AuthState {
  status: 'bootstrapping' | 'authenticated' | 'anonymous';
  user: AuthUser | null;
  session: AuthSession | null;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
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

  const signOut = useCallback(async () => {
    const currentSession = session;
    await clearSession();
    await authApi.logout(currentSession?.accessToken, currentSession?.refreshToken).catch(() => undefined);
  }, [clearSession, session]);

  const value = useMemo<AuthState>(
    () => ({ status, user, session, signIn, signOut }),
    [session, signIn, signOut, status, user],
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
