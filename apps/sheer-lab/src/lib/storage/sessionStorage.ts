import type { AuthSession } from '@sheer/domain';

let inMemorySession: AuthSession | undefined;

export async function getStoredAccessToken(): Promise<string | undefined> {
  return inMemorySession?.accessToken;
}

export async function saveSession(session: AuthSession): Promise<void> {
  inMemorySession = session;
}

export async function clearSession(): Promise<void> {
  inMemorySession = undefined;
}

export async function getStoredSession(): Promise<AuthSession | undefined> {
  return inMemorySession;
}
