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

/**
 * Where the freshly-created account is supposed to land.
 *
 * - `web`    — owner / manager. They keep using the dashboard.
 * - `mobile` — stylist / client. The web flow only existed to claim the
 *              account; the actual product surface for them is the Sheer App.
 */
export type AccountCreationTargetSurface = 'web' | 'mobile';

/**
 * What the web client should do immediately after a successful account
 * creation / invitation acceptance.
 *
 * - `redirect_to_dashboard` — owner / manager: enter the web dashboard.
 * - `show_completion_page`  — stylist / client: render the post-claim
 *                             completion page that points them to the
 *                             Sheer App. They MUST NOT be auto-logged into
 *                             the web dashboard.
 */
export type AccountCreationNextAction = 'redirect_to_dashboard' | 'show_completion_page';

export interface OwnerOnboardingResult {
  userProfileId: string;
  businessId: string;
  locationId: string;
  nextStep: 'sign_in' | 'dashboard';
  redirectTo: string;
  /** Always `'owner'` — onboarding cannot produce any other role. */
  role: Extract<UserRole, 'owner'>;
  /** Owners always continue on the web dashboard. */
  targetSurface: Extract<AccountCreationTargetSurface, 'web'>;
  /** Owners always continue on the web dashboard. */
  nextAction: Extract<AccountCreationNextAction, 'redirect_to_dashboard'>;
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

// ---------------------------------------------------------------------------
// Staff invitation + management (Phase 2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Password reset (self-serve, web)
// ---------------------------------------------------------------------------

export type PasswordResetTokenStatus = 'valid' | 'expired' | 'used' | 'unknown';

export interface PasswordResetRequestRequest {
  email: string;
}

export interface PasswordResetRequestResponse {
  /**
   * Always `true` — the endpoint never reveals whether the email matched a
   * real account. Operators can still inspect logs to see whether a token
   * was actually issued + delivered.
   */
  accepted: true;
}

export interface PasswordResetInspectResponse {
  status: PasswordResetTokenStatus;
  /**
   * Masked form of the user's email (e.g. `j***@example.com`). Only present
   * when the token resolves to a real row, regardless of validity. The web
   * UI can render this as a hint without leaking the full address.
   */
  emailMasked?: string;
  /** ISO timestamp the token expires at — for "Link expires in N minutes" UI. */
  expiresAt?: string;
}

export interface PasswordResetCompleteRequest {
  token: string;
  /** New password. The server enforces minimum length (8). */
  password: string;
}

export interface PasswordResetCompleteResponse {
  success: true;
  /**
   * Default redirect target the web client should use if it does not need
   * any custom branching. The role-aware fields below override this for
   * stylist/client (see `nextAction`).
   */
  redirectTo: string;
  /**
   * Role of the account whose password was just reset. Derived from the
   * user's primary active membership (NOT from the request body), so the
   * client can render the role-aware completion screen safely.
   */
  role: UserRole;
  /**
   * Where the user's primary product surface lives.
   * - `web`    — owner / manager — continue to web sign-in.
   * - `mobile` — stylist / client — direct them to the Sheer App.
   */
  targetSurface: AccountCreationTargetSurface;
  /**
   * What the web client should do after success.
   * Mirrors the staff-invitation acceptance contract.
   */
  nextAction: AccountCreationNextAction;
}

export type InvitableRole = Extract<UserRole, 'manager' | 'stylist'>;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'revoked';

export interface BusinessLocationSummary {
  id: string;
  name: string;
  code?: string;
  slug?: string;
}

// ---------------------------------------------------------------------------
// Location management (owner CRUD; manager: read-own only)
// ---------------------------------------------------------------------------

export interface BusinessLocation {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  code: string;
  timezone: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListLocationsResponse {
  locations: BusinessLocation[];
  /** Echoes the requesting user's role so the client can branch UI without re-querying /auth/me. */
  scope: 'owner' | 'manager';
}

export interface LocationDetailResponse {
  location: BusinessLocation;
}

export interface CreateLocationRequest {
  name: string;
  slug: string;
  /** Falls back to the business default timezone server-side if omitted. */
  timezone?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2; falls back to business default. */
  countryCode?: string;
}

export interface UpdateLocationRequest {
  name?: string;
  slug?: string;
  timezone?: string;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string;
}

export interface StaffInvitation {
  id: string;
  businessId: string;
  locationId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: InvitableRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  invitedByUserProfileId: string;
  acceptedByUserProfileId?: string;
  acceptedAt?: string;
  revokedAt?: string;
  location?: BusinessLocationSummary;
  invitedBy?: { id: string; fullName: string; email: string };
}

export interface StaffInvitationWithToken extends StaffInvitation {
  /**
   * Plaintext invite token. Returned only at creation/resend time so the
   * caller can email the deep link to the invitee. The DB only stores the
   * SHA-256 hash.
   */
  inviteToken: string;
  inviteUrl: string;
}

export interface CreateStaffInvitationRequest {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: InvitableRole;
  locationId: string;
  /** Optional stylist-only: display name for the chair. */
  displayName?: string;
  colorHex?: string;
  bio?: string;
  /** Optional override; defaults to 14 days from now on the server. */
  expiresInHours?: number;
}

export interface ListStaffInvitationsQuery {
  status?: InvitationStatus | 'all';
}

export interface AcceptStaffInvitationRequest {
  token: string;
  password: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  displayName?: string;
}

export interface AcceptStaffInvitationResponse {
  userProfileId: string;
  businessId: string;
  locationId: string;
  membershipId: string;
  staffProfileId?: string;
  /** Owner-onboarding-style next step + redirect for the web app. */
  nextStep: 'sign_in' | 'dashboard';
  redirectTo: string;
  /**
   * The role the invitee just claimed. Derived server-side from the
   * invitation row (never trusted from the client) so the frontend can
   * render the role-aware completion flow without re-querying `/auth/me`.
   */
  role: UserRole;
  /**
   * Where this user's primary product surface lives. `mobile` means the
   * web is only an account-claim shell and the next product step is in
   * the Sheer App (stylist / client). `web` means the dashboard is their
   * day-to-day surface (owner / manager).
   */
  targetSurface: AccountCreationTargetSurface;
  /**
   * What the web client should do right after acceptance succeeds.
   * Branches `redirectTo` between dashboard and the completion page.
   */
  nextAction: AccountCreationNextAction;
  session?: AuthSession;
  user?: AuthUser;
}

export interface InvitationLookupResponse {
  /** Subset of fields safe to return from the public `inspect` endpoint. */
  invitationId: string;
  businessName: string;
  locationName: string;
  role: InvitableRole;
  email: string;
  firstName: string;
  lastName: string;
  expiresAt: string;
  status: InvitationStatus;
}

export interface StaffMember {
  userProfileId: string;
  email: string;
  fullName: string;
  phone?: string;
  avatarUrl?: string;
  role: UserRole;
  membershipId: string;
  membershipStatus: MembershipStatus;
  location?: BusinessLocationSummary;
  staffProfile?: {
    id: string;
    displayName: string;
    employmentStatus: 'active' | 'on_leave' | 'notice' | 'terminated';
    isBookable: boolean;
    colorHex?: string;
    bio?: string;
  };
  invitedAt?: string;
  activatedAt?: string;
  suspendedAt?: string;
  revokedAt?: string;
}

export interface ListStaffResponse {
  staff: StaffMember[];
  pendingInvitations: StaffInvitation[];
  locations: BusinessLocationSummary[];
}

export interface UpdateStaffMemberRequest {
  role?: InvitableRole;
  locationId?: string;
  membershipStatus?: Extract<MembershipStatus, 'active' | 'suspended' | 'revoked'>;
  displayName?: string;
  colorHex?: string;
  bio?: string;
  isBookable?: boolean;
}

export interface UpdateStaffMemberResponse {
  staff: StaffMember;
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
