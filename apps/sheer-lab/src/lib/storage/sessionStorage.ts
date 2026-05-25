import type { AuthSession, PinUnlockResponse } from '@sheer/domain';

let inMemorySession: AuthSession | undefined;
let inMemoryLabSession: PinUnlockResponse | undefined;

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

export async function saveLabSession(session: PinUnlockResponse): Promise<void> {
  inMemoryLabSession = session;
}

export async function getStoredLabSession(): Promise<PinUnlockResponse | undefined> {
  return inMemoryLabSession;
}

export async function clearLabSession(): Promise<void> {
  inMemoryLabSession = undefined;
}
