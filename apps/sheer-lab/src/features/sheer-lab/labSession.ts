import type { PinUnlockRequest } from '@sheer/domain';

import { sheerApiClient } from '../../lib/api/client';

export async function unlockLabSession(payload: PinUnlockRequest) {
  return sheerApiClient.labSessions.unlock(payload);
}
