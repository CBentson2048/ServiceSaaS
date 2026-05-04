export type UserRole = 'owner' | 'manager' | 'stylist' | 'client';

export type AppSurface = 'sheer_app' | 'sheer_lab' | 'web_dashboard' | 'api';

export type LabSessionStatus = 'unlocking' | 'active' | 'locked' | 'expired' | 'logged_out';

export type DevicePairingStatus = 'unpaired' | 'pairing' | 'paired' | 'disconnected' | 'revoked';

export type AppointmentStatus =
  | 'draft'
  | 'booked'
  | 'confirmed'
  | 'checked_in'
  | 'in_service'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type FormulaStatus = 'draft' | 'mixing' | 'ready_for_review' | 'saved' | 'voided';

export type StylistPinCredentialStatus = 'active' | 'inactive' | 'locked' | 'rotation_required';

export interface PinUnlockRequest {
  deviceId: string;
  locationId: string;
  pin: string;
}

export interface PinUnlockResponse {
  sessionId: string;
  status: LabSessionStatus;
  userProfileId: string;
  displayName: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  expiresAt: string;
}

export interface LabSessionContext {
  sessionId: string;
  businessId: string;
  locationId: string;
  sharedDeviceId: string;
  userProfileId: string;
  displayName: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  status: LabSessionStatus;
  startedAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface SharedDevice {
  id: string;
  businessId: string;
  locationId: string;
  deviceName: string;
  deviceType: 'ipad' | 'tablet' | 'browser';
  stationLabel?: string;
  appMode: 'sheer_lab';
  status: 'registered' | 'active' | 'inactive' | 'revoked';
  registeredAt: string;
  lastSeenAt?: string;
}
