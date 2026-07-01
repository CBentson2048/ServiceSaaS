// Tax configuration contracts + the single trusted tax logic layer.
export * from './tax';
import type { AppointmentBillingTax } from './tax';

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
  /**
   * Every active role this user holds in the current business. A single user
   * can legitimately be owner AND manager AND stylist at once, so this is the
   * authoritative source for authorization — gate capabilities with
   * `userHasRole(user, …)` / `userHasAnyRole(user, …)`, never on a single role.
   * Ordered highest-privilege first (owner > manager > stylist > client).
   */
  roles: UserRole[];
  /**
   * Highest-privilege role (= `roles[0]`). Use ONLY to pick a default landing
   * surface and for display/echo — never to gate a capability a secondary role
   * grants, or a multi-role user silently loses access to it.
   */
  primaryRole: UserRole;
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
  /** IANA timezone for the signed-in user (e.g. 'Europe/London'). Drives app-wide date/time display. */
  timezone?: string;
}

/**
 * Role privilege ranking — lower number = higher privilege. The single source
 * of truth for "primary role" selection across the platform (auth resolution,
 * surface routing, display). Keep aligned with the membership role enum.
 */
export const ROLE_PRIORITY: Record<UserRole, number> = {
  owner: 0,
  manager: 1,
  stylist: 2,
  client: 3,
};

/** Sort roles highest-privilege first and drop duplicates. */
export function sortRolesByPriority(roles: readonly UserRole[]): UserRole[] {
  return [...new Set(roles)].sort((a, b) => ROLE_PRIORITY[a] - ROLE_PRIORITY[b]);
}

/** The highest-privilege role in a set (owner > manager > stylist > client). */
export function pickPrimaryRole(roles: readonly UserRole[]): UserRole {
  return sortRolesByPriority(roles)[0];
}

/**
 * True when the user actively holds the given role. Null-safe: a missing user
 * (e.g. an optional `auth.user`) returns false, so call sites can pass
 * `auth.user` directly without a separate guard.
 */
export function userHasRole(user: Pick<AuthUser, 'roles'> | null | undefined, role: UserRole): boolean {
  return !!user && user.roles.includes(role);
}

/** True when the user actively holds ANY of the given roles. Null-safe (see {@link userHasRole}). */
export function userHasAnyRole(
  user: Pick<AuthUser, 'roles'> | null | undefined,
  roles: readonly UserRole[],
): boolean {
  return !!user && user.roles.some((role) => roles.includes(role));
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
  /**
   * Communication / reminder settings for the location passed via `locationId`.
   * `null` when the request was not scoped to a specific location (global view).
   */
  communicationSettings?: LocationCommunicationSettings | null;
}

// ---------------------------------------------------------------------------
// WhatsApp booking notifications & reminder rules (per location)
// ---------------------------------------------------------------------------

/**
 * Owner-configurable WhatsApp confirmation + reminder rules for a single
 * location. Persisted under `core.location_settings.metadata.communication`.
 * Reminder timings are stored canonically as `reminderOffsetsHours` but
 * surfaced to owners as discrete toggles (24h / 48h / 1 week).
 */
export interface LocationCommunicationSettings {
  locationId: string;
  /** Master switch — when false no confirmations or reminders are scheduled. */
  enabled: boolean;
  /** Channels permitted for this location. WhatsApp is the primary delivery channel. */
  enabledChannels: CommunicationPreference[];
  /** Send a confirmation immediately after a successful booking (WhatsApp first). */
  sendBookingConfirmation: boolean;
  reminder24hEnabled: boolean;
  reminder48hEnabled: boolean;
  reminder1wEnabled: boolean;
  /**
   * Secondary fallback. When true, a real WhatsApp failure or WhatsApp-ineligibility falls back to
   * **email** for the same notification (when the client has a valid email). Email is never sent
   * while WhatsApp is merely pending/queued.
   */
  emailFallbackEnabled: boolean;
  /**
   * Last-resort fallback. When true, a notification falls back to **SMS** once the channels before
   * it in the WhatsApp → Email → SMS chain are ineligible or have a real failure. SMS is never sent
   * while a prior channel is merely pending/queued.
   */
  smsFallbackEnabled: boolean;
}

export interface UpdateLocationCommunicationSettingsRequest {
  locationId: string;
  enabled?: boolean;
  sendBookingConfirmation?: boolean;
  reminder24hEnabled?: boolean;
  reminder48hEnabled?: boolean;
  reminder1wEnabled?: boolean;
  emailFallbackEnabled?: boolean;
  smsFallbackEnabled?: boolean;
}

export interface LocationCommunicationSettingsResponse {
  settings: LocationCommunicationSettings;
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

// ---------------------------------------------------------------------------
// Product auto-billing (per-location configuration)
// ---------------------------------------------------------------------------

export type ProductBillingRule = 'cost_only' | 'cost_plus_markup_percent' | 'fixed_uplift';

export interface LocationProductBillingSettings {
  locationId: string;
  productBillingEnabled: boolean;
  productBillingRule: ProductBillingRule;
  /** Required when productBillingRule = 'cost_plus_markup_percent'. >= 0 */
  productMarkupPercent: number | null;
  /** Required when productBillingRule = 'fixed_uplift'. >= 0, decimal (e.g. 4.00 = £4) */
  productFixedUpliftAmount: number | null;
  /** When true, the billable amount is rounded UP to the nearest productRoundUpIncrement after the rule is applied. */
  productRoundUpEnabled: boolean;
  /** Round-up step in decimal GBP (e.g. 0.50, 1.00). Required when productRoundUpEnabled. > 0 */
  productRoundUpIncrement: number | null;
}

export interface GetLocationProductBillingSettingsResponse {
  settings: LocationProductBillingSettings;
}

export interface UpdateLocationProductBillingSettingsRequest {
  locationId: string;
  productBillingEnabled?: boolean;
  productBillingRule?: ProductBillingRule;
  productMarkupPercent?: number | null;
  productFixedUpliftAmount?: number | null;
  productRoundUpEnabled?: boolean;
  productRoundUpIncrement?: number | null;
}

export interface UpdateLocationProductBillingSettingsResponse {
  settings: LocationProductBillingSettings;
}

export interface ProductBillingSnapshot {
  costAmountCents: number;
  billableAmountCents: number;
  billingRuleSnapshot: ProductBillingRule;
  markupPercentSnapshot: number | null;
  fixedUpliftAmountSnapshot: number | null;
  roundUpEnabledSnapshot: boolean;
  roundUpIncrementSnapshot: number | null;
}

// ---------------------------------------------------------------------------
// Service-category billing & revenue rules (Sheer Lab "Billing Rules" page)
//
// Per colour-service-category rules describing how product usage is charged:
// a charging strategy, an included gram allowance, and a salon markup. These
// live per location and are managed by owners/managers on the lab station.
// ---------------------------------------------------------------------------

/** The fixed catalogue of colour service categories these rules apply to. */
export type ServiceBillingCategory =
  | 'permanent_colour'
  | 'lightener_bleach'
  | 'semi_toners'
  | 'special_treatments';

/**
 * How a category's product usage becomes a charge:
 *  - `track_only`: record usage, never charge the client.
 *  - `overage`:    charge only grams used beyond the standard allowance.
 *  - `charge_all`: charge every gram used.
 */
export type ChargingStrategy = 'track_only' | 'overage' | 'charge_all';

export interface ServiceBillingRule {
  id: string;
  locationId: string;
  category: ServiceBillingCategory;
  /** Human label, e.g. "Permanent Colour". Derived server-side from `category`. */
  categoryLabel: string;
  /** Short descriptor, e.g. "Standard single-process applications". */
  categoryDescription: string;
  chargingStrategy: ChargingStrategy;
  /** Included grams that are never charged. >= 0 */
  standardAllowanceGrams: number;
  /** Markup applied to the chargeable cost, as a percentage. >= 0 */
  salonMarkupPercent: number;
}

/** Location-level parameters that power the live billing preview. */
export interface ServiceBillingGlobalParameters {
  locationId: string;
  /** Sample grams used in the preview simulation. >= 0 */
  sampleUsageGrams: number;
  /** Base product cost per gram in minor units (e.g. 18 = £0.18). >= 0 */
  baseCostPerGramCents: number;
  /** ISO 4217 currency code, e.g. "GBP". */
  currencyCode: string;
  /** Default markup suggested when seeding new categories. >= 0 */
  defaultMarkupPercent: number;
}

export interface ServiceBillingRulesResponse {
  rules: ServiceBillingRule[];
  globalParameters: ServiceBillingGlobalParameters;
}

export interface UpdateServiceBillingRuleInput {
  category: ServiceBillingCategory;
  chargingStrategy?: ChargingStrategy;
  standardAllowanceGrams?: number;
  salonMarkupPercent?: number;
}

export interface UpdateServiceBillingRulesRequest {
  rules?: UpdateServiceBillingRuleInput[];
  globalParameters?: {
    sampleUsageGrams?: number;
    baseCostPerGramCents?: number;
    currencyCode?: string;
    defaultMarkupPercent?: number;
  };
}

export interface UpdateServiceBillingRulesResponse {
  rules: ServiceBillingRule[];
  globalParameters: ServiceBillingGlobalParameters;
}

export interface ResetServiceBillingRulesResponse {
  rules: ServiceBillingRule[];
  globalParameters: ServiceBillingGlobalParameters;
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
  /**
   * Every role this member holds at their location, highest-privilege first.
   * A member can be both manager AND stylist at the same location. Owners
   * appear as `['owner']`.
   */
  roles: UserRole[];
  /** The highest-privilege membership's id (representative of the member's set). */
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
    /**
     * IDs of the services this stylist is qualified to perform. Empty/undefined
     * means the stylist has no service eligibility yet. See
     * booking.staff_service_eligibility.
     */
    serviceIds?: string[];
    /**
     * Per-stylist price overrides for the services this stylist can perform.
     * `priceAmount` is in major currency units; `null` means the service's base
     * price applies. Entries mirror `serviceIds`. See
     * booking.staff_service_eligibility.price_amount.
     */
    servicePricing?: { serviceId: string; priceAmount: number | null }[];
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
  /**
   * Full desired set of the member's roles at their location (manager and/or
   * stylist). When provided, the member's role memberships are synced to exactly
   * these. Omit to leave the current roles unchanged (e.g. status-only updates).
   */
  roles?: InvitableRole[];
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
  /**
   * Full replacement set of services this stylist can perform. When provided,
   * the stylist's service eligibility is replaced with exactly these IDs.
   * Omit to leave eligibility unchanged. Legacy alias for `serviceAssignments`
   * with no per-stylist prices (all prices inherit the service base price).
   */
  serviceIds?: string[];
  /**
   * Full replacement set of services this stylist can perform, each with an
   * optional per-stylist price (`priceAmount` in major currency units;
   * `null`/omitted inherits the service base price). When provided, replaces the
   * stylist's eligibility AND prices. Takes precedence over `serviceIds`.
   */
  serviceAssignments?: { serviceId: string; priceAmount?: number | null }[];
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
  /** IANA timezone (e.g. 'Europe/London'). Defaults server-side when unset. */
  timezone?: string;
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
  /** IANA timezone (e.g. 'Europe/London'). */
  timezone?: string;
  /** Staff self-editable bio. Ignored for non-staff accounts. */
  bio?: string | null;
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
  /**
   * Catalogue service IDs backing this appointment, in booking order. Lets the
   * book's "Edit appointment" editor pre-select the current services (names alone
   * can't be mapped back to IDs reliably). Optional — not every summary builder
   * populates it.
   */
  serviceIds?: string[];
  durationMinutes?: number;
  depositRequiredAmount?: number;
  depositStatus?: string;
  clientNote?: string;
  patchTest?: StaffBookingPatchTestSummary;
  completedAt?: string;
  completedByUserProfileId?: string;
  completedByStaffProfileId?: string;
  /**
   * The location's cancellation-notice window in hours (from
   * `core.location_settings.cancellation_notice_hours`). Lets the client app show
   * the policy and decide refund-vs-forfeit. Only populated on client-facing
   * summaries.
   */
  cancellationWindowHours?: number;
  /**
   * ISO deadline (= `startsAt − cancellationWindowHours`). Cancelling on or before
   * this refunds the deposit and rebooking is allowed; after it, a cancel forfeits
   * the deposit and rebooking is blocked. Only populated on client-facing summaries.
   */
  refundCutoffAt?: string;
}

export interface StaffBookingDetail extends StaffBookingSummary {
  communicationPreference?: string;
  internalNote?: string;
}

export interface AppointmentCompletionLineItem {
  lineType: 'service' | 'product_usage' | string;
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
    productUsageTotalCents: number;
    depositPaidCents: number;
    totalCents: number;
    balanceDueCents: number;
    currencyCode: string;
    /**
     * Location tax rollup for this bill. Always present; `enabled: false` when the
     * location has no active tax configuration. `totalCents`/`balanceDueCents`
     * above remain the tax-exclusive figures for backward compatibility — consume
     * `tax` to render inc/ex-tax figures per the configured display mode.
     */
    tax: AppointmentBillingTax;
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

// --- Client booking acceptance (owner/manager approve or reject) ---
// Appointments a client books start as 'awaiting_acceptance'. An owner or
// manager accepts (→ 'confirmed', client confirmation + reminders scheduled) or
// rejects (→ 'cancelled', any paid deposit auto-refunded).

export interface AcceptBookingResponse {
  appointment: StaffBookingDetail;
}

export interface RejectBookingRequest {
  reason?: string;
}

export interface RejectBookingResponse {
  appointment: StaffBookingDetail;
  /** True when a paid deposit was refunded via Stripe as part of the rejection. */
  depositRefunded: boolean;
  /** Set when a refund was attempted but failed — the appointment is still cancelled. */
  refundError?: string;
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

// --- Appointment book actions (staff-facing day calendar) ---
// Surfaced from the tile action menu: arrive a client (check-in), cancel a
// confirmed booking, or reschedule/reassign it. Check-out reuses the existing
// complete → confirm-payment flow above.

export interface CheckInAppointmentResponse {
  appointment: StaffBookingDetail;
}

export interface CancelAppointmentRequest {
  reason?: string;
}

export interface CancelAppointmentResponse {
  appointment: StaffBookingDetail;
  /** True when a paid deposit was refunded via Stripe as part of the cancellation. */
  depositRefunded: boolean;
  /** Set when a refund was attempted but failed — the appointment is still cancelled. */
  refundError?: string;
  /**
   * True when a paid deposit was deliberately NOT refunded because the customer
   * cancelled inside the salon's cancellation window (deposit forfeited). Only set
   * on customer-initiated cancellations.
   */
  depositForfeited?: boolean;
}

export interface RescheduleAppointmentRequest {
  /**
   * New ISO start time for the appointment. Duration is preserved unless
   * `serviceIds` changes the service list (then it's recomputed from the new
   * services).
   */
  scheduledStartAt: string;
  /** Optional new assigned stylist. Omit to keep the current stylist. */
  staffProfileId?: string;
  /**
   * Optional replacement service list (catalogue service IDs). When provided, the
   * appointment's services — and therefore its price, deposit and total duration —
   * are replaced with these. Omit to keep the current services unchanged. The
   * assigned stylist must be eligible for every service in the list.
   */
  serviceIds?: string[];
}

export interface RescheduleAppointmentResponse {
  appointment: StaffBookingDetail;
}

// ---------------------------------------------------------------------------
// Cancellation policy (owner/manager-configured, per location)
//
// Controls how far ahead of an appointment a customer may self-cancel with a
// deposit refund, and rebook. Persisted as `core.location_settings
// .cancellation_notice_hours`; this contract is expressed in whole days because
// that is how the policy is configured and communicated.
// ---------------------------------------------------------------------------

export interface LocationCancellationPolicy {
  locationId: string;
  /**
   * Days before the appointment start that a customer may cancel (with a deposit
   * refund) or rebook. Cancelling inside this window forfeits the deposit and
   * rebooking is blocked.
   */
  cancellationWindowDays: number;
}

export interface GetCancellationPolicyResponse {
  settings: LocationCancellationPolicy;
}

export interface UpdateCancellationPolicyRequest {
  locationId: string;
  cancellationWindowDays: number;
}

export interface UpdateCancellationPolicyResponse {
  settings: LocationCancellationPolicy;
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

// Canonical appointment lifecycle: pending → accepted / rejected →
// checked_in → awaiting_payment → paid, plus the terminal states cancelled
// (customer/salon cancellation) and no_show. Backed by
// booking.appointment_status_enum.
export type AppointmentStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'checked_in'
  | 'awaiting_payment'
  | 'paid'
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
  /** The member's role for this location — drives lab capabilities on unlock. */
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
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
  /** PIN-eligible members (owners, managers and stylists) across the scope. */
  credentials: LabPinCredentialStatus[];
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

export type SheerLabAnalyticsRange = 'today' | 'week' | 'month' | 'custom';

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
// KPI engine
//
// Trusted, per-stylist KPI outputs computed entirely from persisted business
// data (rota hours, billing visits + line items, rebooking outcomes, retail
// stock movements). These are the authoritative inputs the commission engine
// will consume — `allKpisMet` is the commission lock/unlock gate.
//
// Money is expressed in integer minor units (cents) everywhere for parity
// with the billing tables. Percentages are integers (e.g. 50 == 50%).
// ---------------------------------------------------------------------------

/** Named reporting windows the dashboards already use. */
export type KpiPeriod = 'today' | 'week' | 'month';

/**
 * Data-quality markers attached to a stylist result so dashboards never
 * present a misleading number as if it were authoritative.
 */
export type KpiDataNote =
  | 'no_hours_worked' // no rostered hours in the window → no service/retail target
  | 'no_completed_visits' // rebooking / average-bill denominators are zero
  | 'missing_benchmark' // stylist has no owner-defined average-bill benchmark
  | 'retail_attribution_approximate'; // retail derived from inventory movements (see notes)

/** Rebooking KPI — rate of completed source visits that led to a real follow-up. */
export interface RebookingKpiResult {
  completedVisits: number;
  rebookedVisits: number;
  /** Of the rebooked visits, the split by who initiated it (both count equally). */
  stylistRebookedVisits: number;
  clientRebookedVisits: number;
  rebookingRatePercent: number;
  thresholdPercent: number; // 50
  met: boolean;
}

/** Retail KPI — actual retail sales vs the retail target (10% of service target). */
export interface RetailKpiResult {
  retailTargetCents: number;
  actualRetailSalesCents: number;
  /** actual − target: positive is a surplus, negative is a shortfall. */
  varianceCents: number;
  met: boolean;
}

/** Average-bill KPI — stylist's realised average bill vs their owner-set benchmark. */
export interface AverageBillKpiResult {
  benchmarkCents: number; // 0 when unset
  hasBenchmark: boolean;
  paidVisits: number;
  actualAverageBillCents: number;
  /** actual − benchmark. */
  varianceCents: number;
  met: boolean;
}

/**
 * Commission tier for the period, by service-revenue multiple of labour cost.
 *  - `below_3x`        multiple < 3.0          → 0%
 *  - `tier_3x`         3.0 ≤ multiple < 3.5    → 10%
 *  - `tier_3_5x`       multiple ≥ 3.5, KPIs not all met → 15%
 *  - `tier_3_5x_unlocked` multiple ≥ 3.5 AND all KPIs met → 30% (replaces 15%)
 */
export type CommissionTier = 'below_3x' | 'tier_3x' | 'tier_3_5x' | 'tier_3_5x_unlocked';

/**
 * Commission engine output for one stylist over one period (V1 rules).
 *
 * Base = service revenue only, where service revenue INCLUDES the formula/colour
 * charge (product_usage) but EXCLUDES retail and deposits. Tiers are decided by
 * the multiple of that base over labour cost (hourly rate × hours worked); the
 * all-KPIs gate only promotes the 3.5x tier from 15% → 30%.
 */
export interface CommissionResult {
  /** Labour cost = hourly rate × hours worked (the 1.0x reference). */
  laborCostCents: number;
  /** Service revenue used as the commission base (service + colour, no retail). */
  commissionBaseCents: number;
  /** commissionBase ÷ labourCost, e.g. 3.42. 0 when there is no labour cost. */
  serviceMultiple: number;
  tier: CommissionTier;
  /** 0 | 10 | 15 | 30. */
  ratePercent: number;
  /** Payable commission = base × rate%. */
  commissionAmountCents: number;
  /** True when all-KPIs-met promoted the 3.5x tier from 15% to 30%. */
  kpiUnlockApplied: boolean;
  /**
   * If not already on the top tier, what the next step needs. Helps dashboards
   * show "X away from the next tier" without re-deriving the rules.
   */
  nextTier?: {
    tier: CommissionTier;
    ratePercent: number;
    /** Extra service-revenue (cents) needed to reach the next multiple, if any. */
    additionalServiceRevenueCents?: number;
    /** True when the next tier additionally requires all KPIs to be met. */
    requiresAllKpis?: boolean;
  };
}

/** The full KPI snapshot for one stylist over one period. */
export interface StylistKpiResult {
  staffProfileId: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  currencyCode: string;

  // Target engine outputs
  hoursWorked: number; // net of breaks, approved leave and absence
  hourlyRateCents: number;
  serviceTargetCents: number; // hourlyRate × 3 × hoursWorked
  retailTargetCents: number; // 10% of service target

  // Realised actuals (from paid visits + retail movements)
  actualServiceRevenueCents: number;
  actualRetailRevenueCents: number;
  serviceTargetProgressPercent: number;
  retailTargetProgressPercent: number;

  // KPI categories
  rebooking: RebookingKpiResult;
  retail: RetailKpiResult;
  averageBill: AverageBillKpiResult;

  // Convenience mirrors of the per-category outcomes
  rebookingKpiMet: boolean;
  retailKpiMet: boolean;
  averageBillKpiMet: boolean;

  /** Commission lock/unlock gate: true only when all three KPIs are met. */
  allKpisMet: boolean;

  /** Commission engine output derived from the targets, revenue and KPI gate. */
  commission: CommissionResult;

  notes: KpiDataNote[];
}

export interface StylistKpiResponse {
  periodStart: string; // ISO
  periodEnd: string; // ISO (exclusive)
  period?: KpiPeriod;
  scope: 'owner' | 'manager' | 'stylist';
  selectedLocationId?: string;
  stylist: StylistKpiResult;
}

export interface StylistKpiListResponse {
  periodStart: string; // ISO
  periodEnd: string; // ISO (exclusive)
  period?: KpiPeriod;
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  locations: DashboardLocationSummary[];
  stylists: StylistKpiResult[];
  /** Stylists whose every KPI is met — i.e. eligible for commission unlock. */
  commissionReadyCount: number;
}

// ---------------------------------------------------------------------------
// Retail sales — first-class retail revenue
//
// Stylist-attributed product sales with stock deduction. The authoritative
// source for the retail KPI and (indirectly) commission. Money in cents.
// ---------------------------------------------------------------------------

export type RetailPaymentMethod = 'cash' | 'card_reader' | 'other';

export interface RetailSale {
  id: string;
  businessId: string;
  locationId: string;
  staffProfileId?: string;
  productId: string;
  productName?: string;
  clientProfileId?: string;
  visitId?: string;
  quantity: number;
  unitPriceCents: number;
  totalAmountCents: number;
  currencyCode: string;
  paymentMethod?: RetailPaymentMethod;
  soldAt: string; // ISO
  notes?: string;
  createdAt: string; // ISO
}

export interface RecordRetailSaleRequest {
  locationId: string;
  productId: string;
  /** Selling stylist credited for the retail KPI. Optional for desk sales. */
  staffProfileId?: string;
  clientProfileId?: string;
  visitId?: string;
  quantity: number;
  /** Omit to default to the product's configured retail price. */
  unitPriceCents?: number;
  paymentMethod?: RetailPaymentMethod;
  /** ISO timestamp of the sale; defaults to now server-side. */
  soldAt?: string;
  notes?: string;
}

export interface RecordRetailSaleResponse {
  sale: RetailSale;
}

export interface RetailSalesListResponse {
  scope: 'owner' | 'manager';
  selectedLocationId?: string;
  rangeStart?: string; // ISO
  rangeEnd?: string; // ISO
  sales: RetailSale[];
  totalAmountCents: number;
  currencyCode: string;
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

// Client-facing lab/colour history: a cost-stripped view of a customer's own
// saved formulas so they can see what colour and products were used on them.
// Salon cost, waste, billing and inventory data are intentionally omitted — the
// raw FormulaHistoryRecord (in @sheer/lab-core) must never be returned to clients.
export interface ClientLabFormulaItem {
  productName: string;
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  // Note: item `notes` are intentionally excluded — that free-text field can
  // carry stylist-internal remarks and is not safe to surface to clients.
}

export interface ClientLabFormulaSummary {
  id: string;
  savedAt: string;
  serviceType?: string;
  appointmentId?: string;
  visitId?: string;
  items: ClientLabFormulaItem[];
}

export interface ClientLabHistoryResponse {
  formulas: ClientLabFormulaSummary[];
}

/** One service performed during a visit (snapshot taken at booking time). */
export interface ClientVisitServiceLine {
  name: string;
  priceAmount?: number;
  durationMinutes?: number;
}

/**
 * A single colour product used in a visit's formula. Unlike the cost-stripped
 * `ClientLabFormulaItem` (client Lab tab), the visit detail also exposes the
 * amount used and its recorded cost.
 */
export interface ClientVisitColourItem {
  productName: string;
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  /** Grams of product used in the finalized mix. */
  grams?: number;
  /** Recorded cost for this colour, in major currency units. */
  priceAmount?: number;
}

export interface ClientVisitColourFormula {
  id: string;
  savedAt?: string;
  items: ClientVisitColourItem[];
}

/**
 * Full detail for a single past visit shown when a client taps a row in their
 * visit history: the services performed, the stylist, the colour products used,
 * and how much was paid.
 */
export interface ClientVisitDetail {
  id: string;
  status: string;
  occurredAt: string;
  stylistName?: string;
  serviceSummary?: string;
  services: ClientVisitServiceLine[];
  /** Saved colour formulas recorded against this visit; each lists its products. */
  colourFormulas: ClientVisitColourFormula[];
  /** Total count of colour products used across every formula on the visit. */
  colourCount: number;
  /**
   * Tax label (e.g. "VAT") when the location applies tax and all displayed
   * service/colour prices are tax-inclusive; undefined when tax is disabled.
   */
  taxLabel?: string;
  /** Full bill (services + colours, VAT-inclusive), in major currency units. */
  totalAmount?: number;
  /** Deposit paid at booking (= total − balance collected at checkout). */
  depositAmount?: number;
  /** Balance collected at checkout (salon_payments), in major currency units. */
  amountPaid?: number;
  currencyCode?: string;
  paymentMethod?: string;
  paidAt?: string;
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
  /** FK to the inventory category, or undefined when uncategorised. */
  categoryId?: string;
  /** Resolved category name for display; undefined when uncategorised. */
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
  categoryId?: string | null;
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

export interface InventoryCategory {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ListInventoryCategoriesResponse {
  categories: InventoryCategory[];
}

export interface InventoryCategoryResponse {
  category: InventoryCategory;
}

export interface CreateInventoryCategoryRequest {
  name: string;
  description?: string | null;
  isActive?: boolean;
}

export interface UpdateInventoryCategoryRequest {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Service catalogue (managed services + service categories)
//
// Service categories live in the `booking` schema and are completely
// independent from product categories (`inventory.categories`). Services may
// only belong to a ServiceCategory; products may only belong to an
// InventoryCategory. The two never overlap.
// ---------------------------------------------------------------------------

export interface ServiceCategory {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  /** #RRGGBB tile colour for the appointment book; undefined uses the neutral default. */
  colorHex?: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListServiceCategoriesResponse {
  categories: ServiceCategory[];
}

export interface ServiceCategoryResponse {
  category: ServiceCategory;
}

export interface CreateServiceCategoryRequest {
  name: string;
  description?: string | null;
  colorHex?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateServiceCategoryRequest {
  name?: string;
  description?: string | null;
  colorHex?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export type ServiceDepositType = 'none' | 'fixed_amount' | 'percentage';

/**
 * An ordered step within a service (e.g. "Apply colour"), with its own time to
 * complete. When a service has segments, its total duration is the sum of its
 * segment durations.
 */
export interface ServiceSegment {
  id: string;
  businessId: string;
  serviceId: string;
  name: string;
  /** Time to complete this segment, in minutes (always ≥ 1). */
  durationMinutes: number;
  /** Position within the service, 0-based; the display order. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A segment to persist as part of an upsert. Order is taken from the array
 * position, so no explicit sortOrder is sent.
 */
export interface ServiceSegmentInput {
  name: string;
  durationMinutes: number;
}

/** A bookable service in the managed catalogue. */
export interface ManagedService {
  id: string;
  businessId: string;
  /** Null/undefined means the service applies to every location. */
  locationId?: string;
  name: string;
  description?: string;
  /** FK to the service category, or undefined when uncategorised. */
  serviceCategoryId?: string;
  /** Resolved category name for display; undefined when uncategorised. */
  category?: string;
  estimatedDurationMinutes: number;
  processingTimeMinutes: number;
  /** Price in major currency units (e.g. pounds), matching numeric(12,2). */
  basePrice: number;
  depositType: ServiceDepositType;
  depositValue: number;
  requiresPatchTest: boolean;
  isActive: boolean;
  sortOrder: number;
  currencyCode: string;
  /**
   * Ordered segments that make up the service. Empty when the service has no
   * breakdown, in which case estimatedDurationMinutes is a manual value.
   */
  segments: ServiceSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface ListManagedServicesResponse {
  services: ManagedService[];
}

/**
 * Active services that currently have no bookable stylist qualified to perform
 * them. Surfaced as a dashboard warning so owners can assign stylists — an
 * unassigned service cannot be booked.
 */
export interface UnassignedServicesResponse {
  services: ManagedService[];
}

export interface ManagedServiceResponse {
  service: ManagedService;
}

export interface UpsertServiceRequest {
  name: string;
  description?: string | null;
  serviceCategoryId?: string | null;
  locationId?: string | null;
  estimatedDurationMinutes: number;
  processingTimeMinutes?: number;
  basePrice?: number;
  depositType?: ServiceDepositType;
  depositValue?: number;
  requiresPatchTest?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  /**
   * Ordered segments to replace the service's current set (array order = display
   * order). When non-empty, estimatedDurationMinutes is derived server-side from
   * the sum of these segments. An empty array clears all segments (the manual
   * estimatedDurationMinutes then applies). Omit the field entirely to leave the
   * service's existing segments unchanged.
   */
  segments?: ServiceSegmentInput[];
}

/**
 * Persist a new display order for the catalogue. `ids` are the rows in the
 * desired order; the server assigns sort_order by index and pushes any rows not
 * listed (e.g. inactive rows hidden in the UI) after them. Shared shape for both
 * service categories and services.
 */
export interface ReorderCatalogueRequest {
  ids: string[];
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
  /** FK to the managed service category; undefined when uncategorised. */
  serviceCategoryId?: string;
  /** Resolved category name, used to group services in the booking flow. */
  category?: string;
  /** #RRGGBB tint for the category, for section headers. */
  categoryColorHex?: string;
  /** Category display order (lower sorts first); undefined when uncategorised. */
  categorySortOrder?: number;
  estimatedDurationMinutes: number;
  startingPriceAmount: number;
  depositRequiredAmount: number;
  /**
   * Deposit policy for this service. Carried so a per-stylist price change can
   * recompute a percentage deposit off the effective price (see
   * {@link depositForServicePrice}). Undefined on summaries built before this
   * field existed (treated as a non-recomputable deposit).
   */
  depositType?: ServiceDepositType;
  /** Deposit value: a fixed amount for `fixed_amount`, a percent for `percentage`. */
  depositValue?: number;
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
  /**
   * This stylist's effective price for each selected service — the per-stylist
   * override where set, otherwise the service base price. Lets the selection UI
   * show the stylist's price the moment they are picked, without a round-trip.
   * See booking.staff_service_eligibility.price_amount.
   */
  servicePrices?: { serviceId: string; priceAmount: number }[];
  /** Sum of this stylist's effective per-service prices for the selected services. */
  totalPriceAmount?: number;
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
  /**
   * Estimated total for the selected services. When the query targets a specific
   * stylist, `services[].startingPriceAmount` and this total reflect that
   * stylist's per-service prices; otherwise they are the service base prices.
   */
  totalPriceAmount: number;
  totalDepositRequiredAmount: number;
  slots: PublicBookingAvailabilitySlot[];
  /**
   * Per-stylist effective prices for the bookable stylists behind `slots`, so a
   * "next available" selection can show + charge the stylist actually resolved
   * for the chosen slot. Look the stylist up by the selected slot's
   * staffProfileId, then feed `servicePrices` to {@link applyStylistServicePrices}.
   * Present for both specific-stylist and next-available queries.
   */
  stylists?: PublicBookingStylistSummary[];
}

/**
 * The deposit due for a service at a (possibly stylist-overridden) price. A
 * `percentage` deposit follows the effective price; `fixed_amount` and `none`
 * deposits do not depend on price, so the service's existing
 * `depositRequiredAmount` is kept. Mirrors the server's calculateServiceDeposit
 * so the deposit is resolved identically on API + clients once a per-stylist
 * price override is applied. Rounds percentage deposits to the nearest whole
 * unit, matching the server.
 */
export function depositForServicePrice(
  service: PublicBookingServiceSummary,
  priceAmount: number,
): number {
  if (service.depositType === 'percentage' && service.depositValue !== undefined) {
    return Math.max(0, Math.round((priceAmount * service.depositValue) / 100));
  }
  return service.depositRequiredAmount;
}

/**
 * Returns a copy of `services` with each `startingPriceAmount` replaced by the
 * stylist's effective price for that service (from
 * PublicBookingStylistSummary.servicePrices), and `depositRequiredAmount`
 * recomputed for percentage deposits off that price (see
 * {@link depositForServicePrice}). Services without an entry keep their base
 * price + deposit. Shared by web + mobile so per-stylist estimate pricing is
 * resolved identically everywhere. Returns the original array when there are no
 * per-stylist prices (e.g. "any available" / next-available before a slot is
 * resolved).
 */
export function applyStylistServicePrices(
  services: PublicBookingServiceSummary[],
  servicePrices?: { serviceId: string; priceAmount: number }[] | null,
): PublicBookingServiceSummary[] {
  if (!servicePrices || servicePrices.length === 0) return services;
  const byServiceId = new Map(servicePrices.map((p) => [p.serviceId, p.priceAmount]));
  return services.map((service) => {
    const price = byServiceId.get(service.id);
    return price === undefined
      ? service
      : { ...service, startingPriceAmount: price, depositRequiredAmount: depositForServicePrice(service, price) };
  });
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

// ---------------------------------------------------------------------------
// Staff (internal) booking
//
// Owner/manager/front-desk/stylist create appointments on behalf of clients —
// walk-ins, phone bookings, manual appointments. This reuses the SAME
// availability engine, appointment schema, and notification pipeline as the
// public/client flow; it differs only in who books (a staff member, not the
// client), the booking channel/source, internal notes, and flexible payment
// handling that does not force the public Stripe deposit path.
// ---------------------------------------------------------------------------

/** How an internal booking originated. Maps onto booking.booking_channel_enum. */
export type StaffBookingSource = 'walk_in' | 'phone_booking' | 'staff_booking';

/**
 * Internal payment handling for a staff-created booking. Unlike the public flow
 * (which forces a Stripe deposit when one is configured), staff record how the
 * booking will be settled without necessarily collecting anything up front.
 */
export type StaffBookingPaymentMode =
  | 'pay_in_salon' // settle at the salon via the normal completion flow
  | 'deposit_waived' // a deposit is configured but the staff member waived it
  | 'deposit_due' // deposit owed; not collected yet (follow up later)
  | 'paid_in_full' // already settled (e.g. cash taken up front)
  | 'no_deposit'; // no deposit configured for the selected services

export interface CreateStaffBookingRequest {
  locationId: string;
  serviceIds: string[];
  staffProfileId: string;
  selectedStartAt: string;
  staffRequestMode: 'specific_staff' | 'next_available';
  /** Existing CRM client to book for. Quick-create a client first if needed. */
  clientProfileId: string;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
  bookingSource: StaffBookingSource;
  paymentMode: StaffBookingPaymentMode;
  /** Client-facing note (may surface to the client). */
  clientNote?: string;
  /** Internal, staff-only note. Never sent to the client. */
  internalNote?: string;
  /** Send the client a confirmation now (still subject to location comms settings). Defaults to true. */
  sendConfirmation?: boolean;
}

export interface CreateStaffBookingResponse {
  appointment: PublicBookingAppointmentSummary;
  bookingSource: StaffBookingSource;
  paymentMode: StaffBookingPaymentMode;
  depositRequiredAmount: number;
  /**
   * Whether a client confirmation send was requested for this booking. Actual
   * delivery still depends on the location's communication settings and the
   * client having a reachable phone/email.
   */
  confirmationScheduled: boolean;
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

export interface CrmClientsPagination {
  /** Total clients matching the query across all pages. */
  total: number;
  /** 1-based index of the returned page. */
  page: number;
  /** Page size used for this response. */
  pageSize: number;
  /** Total number of pages (>= 1, even when total is 0). */
  pageCount: number;
}

export interface ListCrmClientsResponse {
  clients: CrmClientSummary[];
  scope: 'owner' | 'manager' | 'stylist';
  /**
   * Present on the CRM Client Hub listing (server-side paginated). The staff
   * booking client search reuses this response shape but omits it.
   */
  pagination?: CrmClientsPagination;
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
