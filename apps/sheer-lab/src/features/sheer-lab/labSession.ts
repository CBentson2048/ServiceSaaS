import type { PinUnlockRequest } from '@sheer/domain';

import { sheerApiClient } from '../../lib/api/client';
import { clearLabSession, getStoredLabSession, saveLabSession } from '../../lib/storage/sessionStorage';

interface UnlockLabSessionContext {
  sharedDeviceId: string;
  locationId: string;
}

export async function unlockLabSession(pin: string, context: UnlockLabSessionContext) {
  const payload: PinUnlockRequest = {
    deviceId: context.sharedDeviceId,
    locationId: context.locationId,
    pin,
  };
  const session = await sheerApiClient.labSessions.unlock(payload);
  await saveLabSession(session);
  return session;
}

export async function getActiveLabSession() {
  const session = await getStoredLabSession();
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    await clearLabSession();
    return undefined;
  }
  return session;
}

export async function refreshActiveLabSession() {
  const session = await getActiveLabSession();
  if (!session) return undefined;

  try {
    await sheerApiClient.labSessions.heartbeat(session.sessionId);
    return session;
  } catch {
    await clearLabSession();
    return undefined;
  }
}

export async function logoutLabSession(sessionId: string): Promise<void> {
  await sheerApiClient.labSessions.logout(sessionId);
  await clearLabSession();
}
