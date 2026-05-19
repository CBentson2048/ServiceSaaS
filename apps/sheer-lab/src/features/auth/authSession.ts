import type { LoginRequest } from '@sheer/domain';

import { sheerApiClient } from '../../lib/api/client';
import { clearSession, saveSession } from '../../lib/storage/sessionStorage';

export async function signInToSheerLab(payload: LoginRequest): Promise<void> {
  const response = await sheerApiClient.auth.login({
    ...payload,
    surface: 'sheer_lab',
  });

  await saveSession(response.session);
}

export async function signOutOfSheerLab(): Promise<void> {
  await clearSession();
}
