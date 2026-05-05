export type UserRole = 'owner' | 'manager' | 'stylist' | 'client';

export type AppSurface = 'sheer_app' | 'sheer_lab' | 'web_dashboard' | 'api';

export type AllowedLocationScope =
  | { kind: 'all'; locationIds: string[] }
  | { kind: 'locations'; locationIds: string[] }
  | { kind: 'self'; locationIds: string[] };

export interface AuthLocation {
  id: string;
  name: string;
  code?: string;
  slug?: string;
}

export interface AuthProfileSummary {
  id: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
}

export interface AuthUser {
  id: string;
  role: UserRole;
  businessId: string;
  businessName?: string;
  businessSlug?: string;
  allowedLocationIds: string[];
  locationScope: AllowedLocationScope;
  locations: AuthLocation[];
  profile: AuthProfileSummary;
  staffProfileId?: string;
  clientProfileId?: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
}

export interface AuthContext extends AuthUser {}

export interface LoginRequest {
  email: string;
  password: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app'>;
}

export interface CreateAccountRequest {
  email: string;
  password: string;
  fullName: string;
  businessName: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard'>;
}

export interface LoginResponse {
  session: AuthSession;
  user: AuthUser;
}

export interface CreateAccountResponse extends LoginResponse {}

export interface OwnerOnboardingOwnerInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface OwnerOnboardingBusinessInput {
  name: string;
  slug: string;
  defaultCurrency: string;
  defaultTimezone: string;
  countryCode: string;
}

export interface OwnerOnboardingLocationInput {
  name: string;
  slug: string;
  phone?: string;
  email?: string;
  timezone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
}

export interface OwnerOnboardingRequest {
  owner: OwnerOnboardingOwnerInput;
  business: OwnerOnboardingBusinessInput;
  location: OwnerOnboardingLocationInput;
}

export interface OwnerOnboardingResult {
  userProfileId: string;
  businessId: string;
  locationId: string;
  nextStep: 'sign_in' | 'dashboard';
  redirectTo: string;
}

export interface OwnerOnboardingResponse extends OwnerOnboardingResult {
  /**
   * Optional auto-issued session. Present when the API was able to sign
   * the new owner in immediately, otherwise the client should redirect
   * to `/login` and use the email it just registered.
   */
  session?: AuthSession;
  user?: AuthUser;
}

export interface BusinessSlugAvailabilityResponse {
  slug: string;
  available: boolean;
  reason?: string;
}

export interface OwnerOnboardingBootstrap {
  defaultCurrency: string;
  defaultTimezone: string;
  defaultCountryCode: string;
  currencies: Array<{ code: string; label: string }>;
  timezones: Array<{ value: string; label: string }>;
  countries: Array<{ code: string; label: string }>;
}

export interface RefreshSessionRequest {
  refreshToken: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app'>;
}

export interface LogoutRequest {
  refreshToken?: string;
}

export interface CurrentUserResponse {
  user: AuthUser;
}

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
