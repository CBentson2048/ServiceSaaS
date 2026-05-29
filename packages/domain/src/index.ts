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
  firstName?: string;
  lastName?: string;
  fullName: string;
  displayName?: string;
  phone?: string;
  avatarUrl?: string;
  isActive?: boolean;
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
  clientCode?: string;
  clientCommunicationPreference?: 'whatsapp' | 'sms' | 'email';
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
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;
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

// ---------------------------------------------------------------------------
// Owner booking settings
// ---------------------------------------------------------------------------

export interface OwnerBookingService {
  id: string;
  businessId: string;
  locationId?: string;
  name: string;
  description?: string;
  category?: string;
  estimatedDurationMinutes: number;
  startingPriceAmount: number;
  depositRequiredAmount: number;
  currencyCode: string;
  isActive: boolean;
  sortOrder: number;
}

export interface OwnerServiceRequirementRule {
  id: string;
  businessId: string;
  locationId?: string;
  triggerServiceId: string;
  title: string;
  description?: string;
  isActive: boolean;
  requiredServiceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OwnerServiceUpgradeSuggestion {
  id: string;
  businessId: string;
  locationId?: string;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerBookingSettingsResponse {
  locations: BusinessLocationSummary[];
  services: OwnerBookingService[];
  requirementRules: OwnerServiceRequirementRule[];
  upgradeSuggestions: OwnerServiceUpgradeSuggestion[];
}

export interface UpsertServiceRequirementRuleRequest {
  locationId?: string | null;
  triggerServiceId: string;
  title: string;
  description?: string | null;
  requiredServiceIds: string[];
  isActive?: boolean;
}

export interface UpsertServiceUpgradeSuggestionRequest {
  locationId?: string | null;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ServiceRequirementRuleResponse {
  rule: OwnerServiceRequirementRule;
}

export interface ServiceUpgradeSuggestionResponse {
  suggestion: OwnerServiceUpgradeSuggestion;
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
    hourlyRate: number;
    contractedHours: number;
    averageBillBenchmark: number;
    sheerLabPinEnabled: boolean;
    leaveNotes?: string;
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
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  leaveNotes?: string | null;
}

export interface UpdateStaffMemberResponse {
  staff: StaffMember;
}

export interface RefreshSessionRequest {
  refreshToken: string;
  surface?: Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;
}

export interface LogoutRequest {
  refreshToken?: string;
}

export interface CurrentUserResponse {
  user: AuthUser;
}

export type CommunicationPreference = 'whatsapp' | 'sms' | 'email';

export interface UserProfileIdentity {
  userProfileId: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  displayName: string;
  phone?: string;
  avatarUrl?: string;
  role: UserRole;
  isActive: boolean;
}

export interface ClientProfileDetails {
  id: string;
  businessId: string;
  userProfileId?: string;
  primaryLocationId?: string;
  clientCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone?: string;
  communicationPreference?: CommunicationPreference;
  notes?: string;
  source?: string;
  tags: string[];
  lastVisitAt?: string;
  visitCount: number;
  activeAllergies: number;
  expiredPatchTests: number;
}

export interface StaffProfileDetails {
  id: string;
  businessId: string;
  userProfileId: string;
  assignedLocationId: string;
  displayName: string;
  employmentStatus: 'active' | 'on_leave' | 'notice' | 'terminated';
  isBookable: boolean;
  colorHex?: string;
  bio?: string;
  hourlyRate: number;
  contractedHours: number;
  averageBillBenchmark: number;
  sheerLabPinEnabled: boolean;
  leaveNotes?: string;
  pendingLeaveRequests: number;
  openAbsences: number;
}

export interface LocationProfileScope {
  kind: AllowedLocationScope['kind'];
  locationIds: string[];
}

export interface UserProfileResponse {
  identity: UserProfileIdentity;
  clientProfile?: ClientProfileDetails;
  staffProfile?: StaffProfileDetails;
  locations: AuthLocation[];
  scope: LocationProfileScope;
  editableFields: string[];
}

export interface ListProfilesResponse {
  profiles: UserProfileResponse[];
  scope: 'owner' | 'manager';
}

export interface UpdateCurrentProfileRequest {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  communicationPreference?: CommunicationPreference;
}

export interface AdminUpdateProfileRequest {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  avatarUrl?: string | null;
  communicationPreference?: CommunicationPreference | null;
  clientNotes?: string | null;
  assignedLocationId?: string;
  staffDisplayName?: string;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  leaveNotes?: string | null;
  isBookable?: boolean;
}

export interface UpdateProfileResponse {
  profile: UserProfileResponse;
}

export interface StaffBookingSummary {
  id: string;
  businessId: string;
  locationId: string;
  clientProfileId: string;
  assignedStaffProfileId?: string;
  requestedStaffProfileId?: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  clientDisplayName: string;
  serviceNames: string[];
  durationMinutes?: number;
  depositRequiredAmount?: number;
  depositStatus?: string;
  clientNote?: string;
  patchTest?: StaffBookingPatchTestSummary;
  completedAt?: string;
  completedByUserProfileId?: string;
  completedByStaffProfileId?: string;
}

export interface StaffBookingDetail extends StaffBookingSummary {
  communicationPreference?: string;
  internalNote?: string;
}

export interface AppointmentCompletionLineItem {
  lineType: 'service' | 'formula_colour' | string;
  description: string;
  amountCents: number;
  currencyCode: string;
}

export interface AppointmentCompletionCheckout {
  status: 'awaiting_payment' | 'paid' | 'not_ready' | 'voided';
  readyAt?: string;
  route?: string;
  message: string;
}

export interface AppointmentCompletionResponse {
  appointment: StaffBookingDetail;
  visit: CrmVisitSummary;
  checkout: AppointmentCompletionCheckout;
  billing: {
    lineItems: AppointmentCompletionLineItem[];
    serviceTotalCents: number;
    formulaColourTotalCents: number;
    depositPaidCents: number;
    totalCents: number;
    balanceDueCents: number;
    currencyCode: string;
  };
  alreadyCompleted: boolean;
}

export interface AppointmentPaymentConfirmationRequest {
  paymentMethod: 'cash' | 'card_reader';
  amountCents: number;
  notes?: string;
}

export interface AppointmentPaymentRecord {
  id: string;
  appointmentId: string;
  visitId: string;
  paymentMethod: 'cash' | 'card_reader';
  amountCents: number;
  currencyCode: string;
  paidAt: string;
  confirmedByUserProfileId?: string;
  confirmedByStaffProfileId?: string;
  notes?: string;
}

export interface AppointmentPaymentConfirmationResponse extends AppointmentCompletionResponse {
  payment: AppointmentPaymentRecord;
  alreadyPaid: boolean;
}

export interface LinkStylistRebookingRequest {
  sourceVisitId?: string;
  rebookedAppointmentId: string;
}

export interface CreateStylistRebookingRequest {
  sourceVisitId?: string;
  selectedStartAt: string;
  staffProfileId?: string;
  clientNote?: string;
}

export interface StaffBookingPatchTestSummary {
  status: 'unknown' | 'pending' | 'passed' | 'failed' | 'expired';
  performedAt?: string;
  expiresAt?: string;
}

export interface ListStaffBookingsResponse {
  bookings: StaffBookingSummary[];
  scope: 'owner' | 'manager' | 'stylist';
  rangeStart?: string;
  rangeEnd?: string;
}

export type LabSessionStatus = 'unlocking' | 'active' | 'locked' | 'expired' | 'logged_out';

export type DevicePairingStatus = 'unpaired' | 'pairing' | 'paired' | 'disconnected' | 'revoked';

export type AppointmentStatus =
  | 'pending'
  | 'draft'
  | 'booked'
  | 'confirmed'
  | 'checked_in'
  | 'in_progress'
  | 'in_service'
  | 'awaiting_payment'
  | 'paid'
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
  businessId?: string;
  locationId?: string;
  sharedDeviceId?: string;
  userProfileId: string;
  staffProfileId?: string;
  displayName: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  expiresAt: string;
}

export interface LabPinCredentialStatus {
  userProfileId: string;
  staffProfileId?: string;
  displayName: string;
  email: string;
  locationId: string;
  locationName: string;
  status: 'not_set' | StylistPinCredentialStatus;
  isActive: boolean;
  failedAttempts: number;
  lockedUntil?: string;
  lastVerifiedAt?: string;
  lastRotatedAt?: string;
  updatedAt?: string;
}

export interface ListLabPinStatusesResponse {
  stylists: LabPinCredentialStatus[];
  scope: 'owner' | 'manager';
}

export interface SetLabPinRequest {
  locationId: string;
  userProfileId: string;
  pin: string;
}

export interface ResetLabPinRequest {
  locationId: string;
  userProfileId: string;
}

export interface LabPinMutationResponse {
  credential: LabPinCredentialStatus;
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

export interface LabDeviceRegistrationResponse {
  device: SharedDevice;
  deviceSessionToken: string;
}

export interface LabDeviceResolveResponse {
  device: SharedDevice;
  location: BusinessLocationSummary;
}

export interface SharedDeviceSummary extends SharedDevice {
  locationName: string;
}

export interface ListLabDevicesResponse {
  devices: SharedDeviceSummary[];
  scope: 'owner' | 'manager';
}

export interface RevokeLabDeviceRequest {
  deviceId: string;
}

export interface LabDeviceMutationResponse {
  device: SharedDeviceSummary;
}

export type SheerLabAnalyticsRange = 'today' | 'week' | 'month';

export interface SheerLabAnalyticsSummary {
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  grossMarginPercent: number;
  wasteCostCents: number;
  wastePercentOfRevenue: number;
  formulasMixed: number;
  worstLocationName?: string;
  currencyCode: string;
}

export interface SheerLabLocationMetric {
  locationId: string;
  locationName: string;
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  grossMarginPercent: number;
  wasteCostCents: number;
  formulasMixed: number;
  currencyCode: string;
}

export interface SheerLabStylistMetric {
  stylistProfileId?: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  colourRevenueCents: number;
  formulaCostCents: number;
  grossMarginCents: number;
  grossMarginPercent: number;
  wasteCostCents: number;
  formulasMixed: number;
  currencyCode: string;
}

export interface SheerLabServiceTypeMetric {
  serviceType: string;
  formulaCount: number;
  averageFormulaCostCents: number;
  currencyCode: string;
}

export interface SheerLabProductUsageMetric {
  productId?: string;
  productName: string;
  brand?: string;
  totalWeightGrams: number;
  totalCostCents: number;
  formulaCount: number;
  currencyCode: string;
}

export interface SheerLabLowStockAlert {
  id: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  remainingQuantityGrams: number;
  thresholdQuantityGrams: number;
  status: 'open' | 'acknowledged' | 'resolved';
  lastTriggeredAt: string;
}

export interface SheerLabAnalyticsResponse {
  range: SheerLabAnalyticsRange;
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  summary: SheerLabAnalyticsSummary;
  byLocation: SheerLabLocationMetric[];
  byStylist: SheerLabStylistMetric[];
  averageFormulaCostByServiceType: SheerLabServiceTypeMetric[];
  mostUsedProductsByWeight: SheerLabProductUsageMetric[];
  mostUsedProductsByCost: SheerLabProductUsageMetric[];
  lowStockAlerts: SheerLabLowStockAlert[];
}

// ---------------------------------------------------------------------------
// Owner / manager dashboard KPIs
// ---------------------------------------------------------------------------

export type DashboardDateRange = 'today' | 'week' | 'month';

export interface DashboardLocationSummary {
  id: string;
  name: string;
  code?: string;
  addressLine1?: string;
  city?: string;
}

export interface DashboardKpiSummary {
  totalRevenueCents: number;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  noShowBookings: number;
  newClients: number;
  repeatClients: number;
  rebookedVisits: number;
  rebookingRatePercent: number;
  stylistRebookedVisits: number;
  clientRebookedVisits: number;
  completedPaidBookings: number;
  averageBookingValueCents: number;
  lowStockProducts: number;
  currencyCode: string;
}

export interface DashboardLocationKpiSummary extends DashboardKpiSummary {
  locationId: string;
  locationName: string;
}

export interface DashboardKpisResponse {
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  locations: DashboardLocationSummary[];
  summary: DashboardKpiSummary;
  byLocation: DashboardLocationKpiSummary[];
}

export interface DashboardTopService {
  serviceName: string;
  bookingCount: number;
  revenueCents: number;
  currencyCode: string;
}

export interface DashboardTopServicesResponse {
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  services: DashboardTopService[];
}

export interface DashboardStylistPerformance {
  staffProfileId?: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  hourlyRate?: number;
  contractedHours?: number;
  averageBillBenchmark?: number;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  noShowBookings: number;
  rebookedVisits: number;
  rebookingRatePercent: number;
  revenueCents: number;
  averageBookingValueCents: number;
  currencyCode: string;
}

export interface DashboardStylistPerformanceResponse {
  rangeStart: string;
  rangeEnd: string;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  stylists: DashboardStylistPerformance[];
}

export interface DashboardInventoryAlert {
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  quantityOnHandGrams: number;
  thresholdGrams: number;
}

export interface DashboardInventoryAlertsResponse {
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  count: number;
  alerts: DashboardInventoryAlert[];
}

// ---------------------------------------------------------------------------
// Sheer mobile app dashboard
// ---------------------------------------------------------------------------

export interface MobileClientProfileSummary {
  id: string;
  displayName: string;
  communicationPreference?: 'whatsapp' | 'sms' | 'email';
}

export interface MobileClientDashboardResponse {
  role: 'client';
  profile: MobileClientProfileSummary;
  nextAppointment?: StaffBookingSummary;
  upcomingAppointments: StaffBookingSummary[];
  visitHistory: CrmVisitSummary[];
}

export interface MobileStylistDashboardResponse {
  role: 'stylist';
  displayName: string;
  today: {
    rangeStart: string;
    rangeEnd: string;
    totalAppointments: number;
    nextAppointment?: StaffBookingSummary;
    appointments: StaffBookingSummary[];
  };
}

export interface MobileManagerDashboardResponse {
  role: 'manager';
  location: AuthLocation;
  today: {
    rangeStart: string;
    rangeEnd: string;
    bookingsCount: number;
    completedBookingsCount: number;
    upcomingBookingsCount: number;
    stylistsWorkingToday: number;
    lowStockAlertCount: number;
    recentAppointments: StaffBookingSummary[];
  };
}

export interface MobileOwnerDashboardResponse {
  role: 'owner';
  displayName: string;
  message: string;
  locations: AuthLocation[];
}

// ---------------------------------------------------------------------------
// Inventory management
// ---------------------------------------------------------------------------

export type InventoryStockMovementType =
  | 'opening_balance'
  | 'restock'
  | 'manual_adjustment'
  | 'formula_usage'
  | 'formula_waste'
  | 'formula_reversal'
  | 'retail_sale'
  | 'correction';

export interface InventoryProduct {
  id: string;
  businessId: string;
  brand?: string;
  name: string;
  category?: string;
  sku?: string;
  sizeValue?: number;
  sizeUnit: string;
  defaultUnit: string;
  defaultCostPerGramCents?: number;
  retailPriceCents?: number;
  lowStockThresholdGrams: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryLocationStock {
  id: string;
  businessId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  sku?: string;
  category?: string;
  quantityOnHandGrams: number;
  lowStockThresholdGrams?: number;
  effectiveLowStockThresholdGrams: number;
  isLowStock: boolean;
  isActive: boolean;
  updatedAt: string;
}

export interface InventoryStockMovement {
  id: string;
  businessId: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  locationStockId?: string;
  movementType: InventoryStockMovementType;
  quantityDeltaGrams: number;
  unitCostCents?: number;
  totalCostCents?: number;
  referenceType?: string;
  referenceId?: string;
  reason?: string;
  notes?: string;
  createdBy?: string;
  createdAt: string;
}

export interface InventoryLowStockAlert {
  id: string;
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  brand?: string;
  remainingQuantityGrams: number;
  thresholdQuantityGrams: number;
  status: 'open' | 'acknowledged' | 'resolved';
  lastTriggeredAt: string;
}

export interface ListInventoryProductsResponse {
  products: InventoryProduct[];
}

export interface InventoryProductResponse {
  product: InventoryProduct;
}

export interface UpsertInventoryProductRequest {
  brand?: string | null;
  name: string;
  category?: string | null;
  sku?: string | null;
  sizeValue?: number | null;
  sizeUnit?: string | null;
  defaultUnit?: string | null;
  defaultCostPerGramCents?: number | null;
  retailPriceCents?: number | null;
  lowStockThresholdGrams?: number | null;
}

export interface ListInventoryStockResponse {
  stock: InventoryLocationStock[];
  locations: BusinessLocationSummary[];
  scope: 'owner' | 'manager';
}

export interface InitializeInventoryStockRequest {
  locationId: string;
  productId: string;
  quantityOnHandGrams?: number;
  lowStockThresholdGrams?: number | null;
}

export interface AdjustInventoryStockRequest {
  locationId: string;
  productId: string;
  quantityDeltaGrams: number;
  movementType: Extract<InventoryStockMovementType, 'opening_balance' | 'restock' | 'manual_adjustment' | 'retail_sale' | 'correction'>;
  reason?: string | null;
  notes?: string | null;
}

export interface UpdateInventoryStockThresholdRequest {
  lowStockThresholdGrams?: number | null;
  isActive?: boolean;
}

export interface InventoryStockMutationResponse {
  stock: InventoryLocationStock;
}

export interface ListInventoryMovementsResponse {
  movements: InventoryStockMovement[];
}

export interface ListInventoryLowStockResponse {
  alerts: InventoryLowStockAlert[];
}

// ---------------------------------------------------------------------------
// Public client booking flow
// ---------------------------------------------------------------------------

export interface PublicBookingLocationSummary {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  timezone: string;
  currencyCode: string;
  appointmentSlotMinutes: number;
  allowNextAvailable: boolean;
  cancellationNoticeHours?: number;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  phone?: string;
}

export interface PublicBookingServiceSummary {
  id: string;
  name: string;
  description?: string;
  category?: string;
  estimatedDurationMinutes: number;
  startingPriceAmount: number;
  depositRequiredAmount: number;
  currencyCode: string;
}

export interface PublicBookingUpgradeSuggestion {
  id: string;
  triggerServiceId: string;
  suggestedServiceId: string;
  title: string;
  description: string;
  service: PublicBookingServiceSummary;
}

export interface PublicBookingFinishingRequirement {
  id: string;
  triggerServiceId: string;
  title: string;
  description?: string;
  requiredServiceIds: string[];
  requiredServices: PublicBookingServiceSummary[];
}

export interface PublicBookingStylistSummary {
  staffProfileId: string;
  displayName: string;
  colorHex?: string;
  bio?: string;
  nextAvailableAt?: string;
}

export interface PublicBookingServiceSelectionResponse {
  location: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  finishingRequirements: PublicBookingFinishingRequirement[];
  upgradeSuggestions: PublicBookingUpgradeSuggestion[];
}

export interface PublicBookingLocationsResponse {
  locations: PublicBookingLocationSummary[];
}

export interface PublicBookingStylistsResponse {
  location: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  totalDepositRequiredAmount: number;
  stylists: PublicBookingStylistSummary[];
  nextAvailableAt?: string;
}

export interface PublicBookingAvailabilitySlot {
  startAt: string;
  endAt: string;
  startTime?: string;
  endTime?: string;
  date: string;
  locationId: string;
  staffProfileId: string;
  stylistId?: string;
  stylistName: string;
  totalDurationMinutes?: number;
}

export interface PublicBookingAvailabilityResponse {
  location: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  totalDurationMinutes: number;
  slots: PublicBookingAvailabilitySlot[];
}

export interface PublicBookingClientDetails {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

export interface CreatePublicBookingRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  client: PublicBookingClientDetails;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  clientProfileId: string;
  bookedByUserProfileId: string;
  clientNote?: string;
  source?: 'public_booking_flow' | 'mobile_app';
}

export interface StartPublicBookingCheckoutRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  client: PublicBookingClientDetails;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  clientProfileId: string;
  bookedByUserProfileId: string;
  clientNote?: string;
  source?: 'public_booking_flow' | 'mobile_app';
}

export interface MobileBookingConfirmRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  clientNote?: string;
}

export interface MobileBookingStartCheckoutRequest extends MobileBookingConfirmRequest {}

export interface PublicBookingAppointmentSummary {
  id: string;
  locationId: string;
  serviceIds: string[];
  serviceNames: string[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  staffProfileId: string;
  stylistName: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status: AppointmentStatus;
  clientDisplayName: string;
  communicationPreference: string;
  depositRequiredAmount: number;
  currencyCode: string;
}

export type PublicBookingAttemptStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'payment_failed'
  | 'cancelled'
  | 'expired';

export interface PublicBookingAttemptSummary {
  id: string;
  status: PublicBookingAttemptStatus;
  locationId: string;
  serviceIds: string[];
  serviceNames: string[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  staffProfileId: string;
  stylistName: string;
  selectedStartAt: string;
  selectedEndAt: string;
  clientDisplayName: string;
  communicationPreference: string;
  depositAmount: number;
  currencyCode: string;
  paymentStatus: 'pending' | 'paid' | 'failed' | 'cancelled';
  appointment?: PublicBookingAppointmentSummary;
}

export interface StartPublicBookingCheckoutResponse {
  bookingAttempt: PublicBookingAttemptSummary;
  bookingAttemptId: string;
  clientSecret: string;
  depositAmount: number;
  currencyCode: string;
}

export interface PublicBookingAttemptResponse {
  bookingAttempt: PublicBookingAttemptSummary;
}

export interface CreatePublicBookingResponse {
  appointment: PublicBookingAppointmentSummary;
  depositRequired: boolean;
  depositPlaceholder: boolean;
}

export interface ClientBookingSelection {
  locationId: string;
  location?: PublicBookingLocationSummary;
  serviceIds: string[];
  services?: PublicBookingServiceSummary[];
  finishingRequirements?: PublicBookingFinishingRequirement[];
  upgradeSuggestions?: PublicBookingUpgradeSuggestion[];
  staffRequestMode: 'specific_staff' | 'next_available';
  staffProfileId?: string;
  nextAvailableAt?: string;
  selectedSlot?: PublicBookingAvailabilitySlot;
  client?: PublicBookingClientDetails;
  communicationPreference?: 'whatsapp' | 'sms' | 'email';
  account?: {
    accessToken: string;
    refreshToken: string;
    userProfileId: string;
    clientProfileId: string;
    email: string;
  };
  appointment?: PublicBookingAppointmentSummary;
  bookingAttempt?: PublicBookingAttemptSummary;
  bookingAttemptId?: string;
  paymentClientSecret?: string;
}

// ---------------------------------------------------------------------------
// CRM — staff-facing client records
// ---------------------------------------------------------------------------

export type CrmNoteType = 'general' | 'consultation' | 'formula_note' | 'service_note' | 'gdpr';

export type CrmAllergySeverity = 'unknown' | 'mild' | 'moderate' | 'severe';

export type CrmPatchTestStatus = 'pending' | 'passed' | 'failed' | 'expired';

export type CrmVisitPhotoType = 'before' | 'after' | 'inspiration' | 'condition' | 'other';

export type CrmMessageChannel = 'sms' | 'email' | 'push' | 'whatsapp';

export type CrmMessageDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'cancelled' | 'skipped';

export interface CrmClientSummary {
  id: string;
  businessId: string;
  clientCode: string;
  primaryLocationId?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone?: string;
  communicationPreference?: 'whatsapp' | 'sms' | 'email' | string;
  notes?: string;
  marketingOptIn: boolean;
  tags: string[];
  source?: string;
  createdAt: string;
  updatedAt: string;
  lastVisitAt?: string;
  alertCounts: {
    activeAllergies: number;
    expiredPatchTests: number;
  };
}

export interface CrmClientProfile extends CrmClientSummary {
  dateOfBirth?: string;
  notesSummary?: string;
  gdpr: {
    exportReady: boolean;
    pendingRequests: number;
    deletionRequestPending: boolean;
  };
}

export interface CrmClientNote {
  id: string;
  businessId: string;
  locationId?: string;
  clientProfileId: string;
  visitId?: string;
  noteType: CrmNoteType;
  content: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmAllergyRecord {
  id: string;
  businessId: string;
  clientProfileId: string;
  allergenName: string;
  severity: CrmAllergySeverity;
  notes?: string;
  isActive: boolean;
  recordedAt: string;
  recordedByUserId?: string;
}

export interface CrmPatchTestRecord {
  id: string;
  businessId: string;
  locationId?: string;
  clientProfileId: string;
  performedAt: string;
  expiresAt?: string;
  status: CrmPatchTestStatus;
  notes?: string;
  recordedByUserId?: string;
  createdAt: string;
  isExpired: boolean;
}

export interface CrmVisitSummary {
  id: string;
  businessId: string;
  locationId: string;
  appointmentId?: string;
  clientProfileId: string;
  primaryStaffProfileId?: string;
  stylistName?: string;
  status: string;
  occurredAt: string;
  serviceSummary?: string;
  clientVisibleSummary?: string;
  priceAmount?: number;
  currencyCode?: string;
  rebooked?: boolean;
  rebookSource?: 'stylist' | 'client';
  rebookedAppointmentId?: string;
  rebookedAt?: string;
}

export interface CrmMessageLog {
  id: string;
  businessId: string;
  locationId: string;
  clientProfileId?: string;
  appointmentId?: string;
  visitId?: string;
  channel: CrmMessageChannel;
  primaryIntendedChannel?: CrmMessageChannel;
  eventKey?: string;
  messageType?: string;
  deliveryStatus: CrmMessageDeliveryStatus;
  provider?: string;
  providerMessageId?: string;
  providerStatus?: string;
  recipient?: string;
  templateKey?: string;
  contentPreview?: string;
  renderedSummary?: string;
  failureReason?: string;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  createdAt: string;
}

export interface CrmVisitPhoto {
  id: string;
  businessId: string;
  locationId: string;
  visitId: string;
  clientProfileId: string;
  photoType: CrmVisitPhotoType;
  storageBucket: string;
  storagePath: string;
  mimeType?: string;
  uploadedByUserId?: string;
  createdAt: string;
}

export interface CrmClientDetailResponse {
  profile: CrmClientProfile;
  notes: CrmClientNote[];
  visits: CrmVisitSummary[];
  allergies: CrmAllergyRecord[];
  patchTests: CrmPatchTestRecord[];
  messages: CrmMessageLog[];
  photos: CrmVisitPhoto[];
}

export interface ListCrmClientsResponse {
  clients: CrmClientSummary[];
  scope: 'owner' | 'manager' | 'stylist';
}

export interface ListCrmClientNotesResponse {
  notes: CrmClientNote[];
}

export interface ListCrmClientAllergiesResponse {
  allergies: CrmAllergyRecord[];
}

export interface ListCrmClientPatchTestsResponse {
  patchTests: CrmPatchTestRecord[];
}

export interface ListCrmClientVisitsResponse {
  visits: CrmVisitSummary[];
}

export interface ListCrmClientMessagesResponse {
  messages: CrmMessageLog[];
}

export interface ListCrmVisitPhotosResponse {
  photos: CrmVisitPhoto[];
}

export interface CreateCrmClientRequest {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  primaryLocationId?: string;
  communicationPreference?: 'whatsapp' | 'sms' | 'email';
  marketingOptIn?: boolean;
  source?: string;
}

export interface UpdateCrmClientRequest {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  primaryLocationId?: string | null;
  communicationPreference?: 'whatsapp' | 'sms' | 'email' | null;
  marketingOptIn?: boolean;
  tags?: string[];
  notesSummary?: string | null;
}

export interface CreateCrmClientNoteRequest {
  locationId?: string;
  visitId?: string;
  noteType?: CrmNoteType;
  content: string;
}

export interface CreateCrmAllergyRecordRequest {
  allergenName: string;
  severity?: CrmAllergySeverity;
  notes?: string;
  isActive?: boolean;
}

export interface CreateCrmPatchTestRequest {
  locationId?: string;
  performedAt: string;
  expiresAt?: string;
  status: CrmPatchTestStatus;
  notes?: string;
}

export interface CreateCrmVisitPhotoRequest {
  clientProfileId: string;
  photoType?: CrmVisitPhotoType;
  storageBucket: string;
  storagePath: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Rota — manager-facing core (also reusable by future owner + stylist UIs)
// ---------------------------------------------------------------------------

export type ShiftStatus = 'draft' | 'published' | 'completed' | 'cancelled';

export type LeaveRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type AbsenceType =
  | 'sickness'
  | 'emergency'
  | 'bereavement'
  | 'unauthorised'
  | 'other';

export interface RotaBreak {
  id: string;
  shiftId: string;
  startedAt: string;
  endedAt: string;
  isPaid: boolean;
  notes?: string;
}

export interface RotaShift {
  id: string;
  businessId: string;
  locationId: string;
  staffProfileId: string;
  status: ShiftStatus;
  scheduledStartAt: string;
  scheduledEndAt: string;
  publishedAt?: string;
  notes?: string;
  breaks: RotaBreak[];
}

export interface RotaStaffSummary {
  staffProfileId: string;
  userProfileId: string;
  fullName: string;
  displayName: string;
  email: string;
  colorHex?: string;
  isBookable: boolean;
  contractedHours: number;
  /** Default break length in minutes (per-stylist config). */
  defaultBreakMinutes: number;
  /** Whether the default break is paid (per-stylist config). */
  defaultBreakIsPaid: boolean;
  defaultBreakNotes?: string;
}

export interface RotaLeaveIndicator {
  id: string;
  staffProfileId: string;
  status: LeaveRequestStatus;
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface RotaAbsenceIndicator {
  id: string;
  staffProfileId: string;
  absenceType: AbsenceType;
  startsAt: string;
  endsAt?: string;
  notes?: string;
}

export interface WeeklyRotaResponse {
  locationId: string;
  /** ISO date for the Monday at the start of the requested week (local to the location). */
  weekStart: string;
  /** ISO date for the Monday _after_ the requested week (exclusive end). */
  weekEnd: string;
  staff: RotaStaffSummary[];
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
  /** Echoed location holiday-notice rule (in days). */
  holidayNoticeDays: number;
  /** Echoes the actor's role so the client can branch UI without re-querying /auth/me. */
  scope: 'owner' | 'manager';
}

export interface CreateShiftRequest {
  staffProfileId: string;
  locationId: string;
  /** ISO timestamp. */
  scheduledStartAt: string;
  /** ISO timestamp; must be strictly after scheduledStartAt. */
  scheduledEndAt: string;
  status?: ShiftStatus;
  notes?: string;
  /** Required when scheduledStartAt is in the past. */
  pastEditReason?: string;
}

export interface UpdateShiftRequest {
  scheduledStartAt?: string;
  scheduledEndAt?: string;
  status?: ShiftStatus;
  notes?: string | null;
  /** Required if the shift is in the past or being moved into the past. */
  pastEditReason?: string;
}

export interface ShiftMutationResponse {
  shift: RotaShift;
}

export interface CreateBreakRequest {
  startedAt: string;
  endedAt: string;
  isPaid?: boolean;
  notes?: string;
  pastEditReason?: string;
}

export interface UpdateBreakRequest {
  startedAt?: string;
  endedAt?: string;
  isPaid?: boolean;
  notes?: string | null;
  pastEditReason?: string;
}

export interface BreakMutationResponse {
  shift: RotaShift;
  break: RotaBreak;
}

export interface RotaLeaveRequest {
  id: string;
  businessId: string;
  locationId: string;
  staffProfileId: string;
  startDate: string;
  endDate: string;
  status: LeaveRequestStatus;
  reason?: string;
  reviewedAt?: string;
  reviewedByUserProfileId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Hydrated staff identity for list rendering. */
  staff?: RotaStaffSummary;
  /** Number of days between today and start_date — useful to render the threshold pill. */
  noticeDays: number;
  /** True when the leave request falls inside the location holiday-notice rule. */
  insideNoticeWindow: boolean;
}

export interface ListLeaveRequestsResponse {
  leaveRequests: RotaLeaveRequest[];
  holidayNoticeDays: number;
  scope: 'owner' | 'manager';
}

export interface ApproveLeaveRequestRequest {
  /** Manager override of the holiday-notice auto-decline rule. Captured in audit. */
  override?: boolean;
  /** Free-form note attached to the approval audit row. */
  reviewerNote?: string;
}

export interface RejectLeaveRequestRequest {
  /** Reason returned to the requesting stylist + captured in audit. */
  reason?: string;
}

export interface LeaveRequestMutationResponse {
  leaveRequest: RotaLeaveRequest;
}

export interface StylistMyWeekResponse {
  weekStart: string;
  weekEnd: string;
  staffProfileId: string;
  locationId: string;
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
}

export interface MyLeaveRequestsResponse {
  leaveRequests: RotaLeaveRequest[];
  holidayNoticeDays: number;
}

export interface CreateMyLeaveRequest {
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface CreateAbsenceRequest {
  staffProfileId: string;
  locationId: string;
  absenceType: AbsenceType;
  startsAt: string;
  endsAt?: string;
  notes?: string;
}

export interface AbsenceMutationResponse {
  absence: RotaAbsenceIndicator;
}

export interface SaveWeeklyRotaShiftInput {
  /** Optional id — when set, the shift is updated; otherwise created. */
  id?: string;
  staffProfileId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  status?: ShiftStatus;
  notes?: string;
}

export interface SaveWeeklyRotaRequest {
  locationId: string;
  weekStart: string;
  shifts: SaveWeeklyRotaShiftInput[];
  /** Required if any shift in the payload starts before now. */
  pastEditReason?: string;
}

export interface SaveWeeklyRotaResponse {
  saved: RotaShift[];
}

export type RotaCreationMode = 'blank' | 'clone_last_week' | 'generate_from_defaults';

export interface NewWeekDraftBreakInput {
  startedAt: string;
  endedAt: string;
  isPaid?: boolean;
  notes?: string;
}

export interface NewWeekDraftShiftInput {
  staffProfileId: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  notes?: string;
  breaks?: NewWeekDraftBreakInput[];
}

export interface PreviewNewWeekRequest {
  weekStart: string;
  creationMode: RotaCreationMode;
  locationId?: string;
}

export interface PreviewNewWeekResponse {
  weekStart: string;
  creationMode: RotaCreationMode;
  staffCount: number;
  shiftsToCreate: number;
  breaksToCreate: number;
  warnings: string[];
  draftShifts?: RotaShift[];
}

export interface CreateNewWeekRequest {
  weekStart: string;
  creationMode: RotaCreationMode;
  locationId?: string;
  shifts?: NewWeekDraftShiftInput[];
}

export interface CreateNewWeekResponse {
  weekStart: string;
  shiftsCreated: number;
  breaksCreated: number;
}
