import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthSession, AuthUser } from '@sheer/domain';
import * as authApi from './api';

const STORAGE_KEY = 'sheer.web.auth.session';

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

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!session?.accessToken) {
        if (!cancelled) setStatus('anonymous');
        return;
      }

      try {
        const { user: currentUser } = await authApi.getCurrentUser(session.accessToken);
        if (!cancelled) {
          setUser(currentUser);
          setStatus('authenticated');
        }
      } catch {
        if (!session.refreshToken) {
          if (!cancelled) clearSession();
          return;
        }

        try {
          const refreshed = await authApi.refreshSession(session.refreshToken);
          if (!cancelled) applySession(refreshed.session, refreshed.user);
        } catch {
          if (!cancelled) clearSession();
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession, session?.accessToken, session?.refreshToken]);

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
