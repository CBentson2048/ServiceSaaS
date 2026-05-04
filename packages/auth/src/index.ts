import type { LabSessionContext, UserRole } from '@sheer/domain';

export const LAB_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export interface TokenSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface AuthGuardContext {
  userProfileId?: string;
  role?: UserRole;
  locationId?: string;
  businessId?: string;
}

export interface LabInactivityState {
  lastActivityAt: number;
  isFormulaInteractionActive: boolean;
}

export function shouldLockLabSession(
  state: LabInactivityState,
  now = Date.now(),
  timeoutMs = LAB_INACTIVITY_TIMEOUT_MS,
): boolean {
  if (state.isFormulaInteractionActive) {
    return false;
  }

  return now - state.lastActivityAt >= timeoutMs;
}

export function touchLabSession(state: LabInactivityState, now = Date.now()): LabInactivityState {
  return {
    ...state,
    lastActivityAt: now,
  };
}

export function canManageLab(role: UserRole): boolean {
  return role === 'owner' || role === 'manager';
}

export function canUseLab(role: UserRole): boolean {
  return role === 'owner' || role === 'manager' || role === 'stylist';
}

export function assertActiveLabSession(session: LabSessionContext | null): session is LabSessionContext {
  return session?.status === 'active';
}

export function createAuthGuardPlaceholder(_context: AuthGuardContext): boolean {
  // TODO: replace with API-specific Supabase/JWT guard integration.
  return true;
}
