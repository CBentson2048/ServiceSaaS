import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import type {
  AccountCreationNextAction,
  AccountCreationTargetSurface,
  AppSurface,
  AuthSession,
  AuthUser,
  BusinessTier,
  ClientBookingLoginResponse,
  CommunicationPreference,
  CreateAccountRequest,
  CreateAccountResponse,
  LoginResponse,
  PasswordResetCompleteResponse,
  PasswordResetInspectResponse,
  PasswordResetRequestResponse,
  PasswordResetTokenStatus,
  Permission,
  UserRole,
} from '@sheer/domain';
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  expandPermissions,
  sortRolesByPriority,
  userHasAnyRole,
  userHasRole,
} from '@sheer/domain';
import type { ClientBookingAccountDto, ClientBookingLoginDto, CreateCustomerAccountDto } from './dto';
import { normalizeE164 } from '../communications/phone';
import { VerifiedTokenCache } from './verified-token.cache';
import { resolveMembershipGrants, type GrantSecurityLevel } from './membership-grants';
import { EmailService } from '../email/email.service';
import { renderPasswordResetEmail } from '../email/templates/password-reset.template';

type RuntimeSurface = Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;

interface ProfileRow {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name: string;
  display_name?: string | null;
  phone: string | null;
  avatar_url: string | null;
  is_active?: boolean | null;
  timezone?: string | null;
  is_customer?: boolean | null;
}

interface MembershipRow {
  business_id: string;
  location_id: string | null;
  role: UserRole;
  status: string;
  security_level_id: string | null;
}

interface SecurityLevelPermissionsRow {
  id: string;
  business_id: string;
  permissions: unknown;
}

interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  tier?: BusinessTier | null;
}

interface LocationRow {
  id: string;
  business_id?: string;
  name: string;
  code: string | null;
  slug: string | null;
  is_active: boolean;
}

interface StaffProfileRow {
  id: string;
}

interface ClientProfileRow {
  id: string;
  client_code?: string;
  primary_location_id?: string | null;
  first_name?: string;
  last_name?: string;
  email?: string | null;
  phone?: string | null;
  communication_preference?: 'whatsapp' | 'sms' | 'email' | null;
}

interface BookingLocationRow {
  id: string;
  business_id: string;
  name: string;
}

const ROLE_PRIORITY: Record<UserRole, number> = {
  owner: 0,
  manager: 1,
  stylist: 2,
  client: 3,
};

interface PasswordResetRow {
  id: string;
  user_profile_id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

const PASSWORD_RESET_EXPIRY_HOURS = 1;
const PASSWORD_RESET_MIN_LENGTH = 8;

/**
 * Did Supabase ANSWER "these credentials are not valid", or did we merely fail
 * to ask it?
 *
 * Only the first proves a session is dead, and the difference is load-bearing:
 * every client in this repo reads a 401/403 from the auth endpoints as proof
 * that the stored session is gone and deletes it. Reporting "we could not tell"
 * as 401 therefore signs every signed-in user out over a redeploy, a dropped
 * connection or a rate-limit answer — none of which say anything about the
 * user's credentials.
 *
 * A 4xx is GoTrue's verdict (400 `invalid_grant` for a spent refresh token,
 * 401/403 for a bad or expired JWT). A timeout, a 429 from the per-IP auth
 * budget the whole platform shares, a 5xx, or a transport failure with no
 * status at all are all outages, and callers should be told to try again.
 */
export function isAuthoritativeRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly anon: SupabaseClient;
  private readonly admin: SupabaseClient;
  private readonly resetBaseUrl: string;
  /** Short-lived verified-token cache; see verified-token.cache.ts. */
  private readonly verifiedTokens = new VerifiedTokenCache();

  constructor(
    config: ConfigService,
    private readonly email: EmailService,
  ) {
    this.supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    this.anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');

    // NOTE: this shared client is for STATELESS calls only — `getUser(jwt)`,
    // which auth-js answers with a direct request and no session handling. Every
    // call that RETURNS a session goes through `sessionClient()` instead; see
    // the comment there for why sharing one is unsafe.
    this.anon = createClient(this.supabaseUrl, this.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.admin = createClient(this.supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Where the reset link points to. Falls back to the first CORS origin
    // (same convention used by the staff invitation flow), then localhost.
    const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const explicit = config.get<string>('PASSWORD_RESET_BASE_URL');
    this.resetBaseUrl = (explicit ?? corsOrigins[0] ?? 'http://localhost:5173').replace(/\/$/, '');
  }

  async createAccount(input: CreateAccountRequest): Promise<CreateAccountResponse> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    const businessName = input.businessName.trim();
    let createdUserId: string | undefined;
    let createdBusinessId: string | undefined;

    const existingProfile = await this.findProfileByEmail(email);
    if (existingProfile) {
      throw new ConflictException('An account already exists for this email');
    }

    try {
      const { data: createdUser, error: createUserError } = await this.admin.auth.admin.createUser({
        email,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      });

      if (createUserError || !createdUser.user) {
        throw new ConflictException(createUserError?.message ?? 'Unable to create account');
      }

      createdUserId = createdUser.user.id;
      const business = await this.createBusiness(businessName);
      createdBusinessId = business.id;

      await this.createUserProfile(createdUserId, email, fullName);
      await this.createOwnerMembership(createdBusinessId, createdUserId);

      return this.login(email, input.password, input.surface ?? 'web_dashboard');
    } catch (error) {
      await this.rollbackCreatedAccount(createdUserId, createdBusinessId);
      if (error instanceof ConflictException) {
        throw error;
      }
      throw new InternalServerErrorException('Unable to create account');
    }
  }

  async createClientBookingAccount(
    input: ClientBookingAccountDto,
  ): Promise<ClientBookingLoginResponse> {
    const location = await this.fetchBookingLocation(input.locationId);
    const email = input.email.trim().toLowerCase();
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const fullName = `${firstName} ${lastName}`.trim();
    let createdUserId: string | undefined;

    const existingProfile = await this.findProfileByEmail(email);
    if (existingProfile) {
      throw new ConflictException('An account already exists for this email. Sign in to continue.');
    }

    try {
      const { data: createdUser, error: createUserError } = await this.admin.auth.admin.createUser({
        email,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      });

      if (createUserError || !createdUser.user) {
        throw new ConflictException(createUserError?.message ?? 'Unable to create account');
      }

      createdUserId = createdUser.user.id;
      await this.createUserProfile(createdUserId, email, fullName, input.phone);
      const client = await this.ensureClientForBusiness(
        location.business_id,
        input.locationId,
        createdUserId,
        {
          firstName,
          lastName,
          email,
          phone: input.phone,
          communicationPreference: input.communicationPreference,
        },
      );

      const login = await this.login(email, input.password, 'sheer_app');
      return { ...login, bookingClient: toBookingClient(location.business_id, client) };
    } catch (error) {
      if (createdUserId) {
        await this.rollbackCreatedClientAccount(createdUserId, location.business_id);
      }
      if (error instanceof ConflictException) {
        throw error;
      }
      this.logger.error(`createClientBookingAccount failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new InternalServerErrorException('Unable to create client account');
    }
  }

  /**
   * Salon-agnostic customer sign-up (QLOOQO app). Creates the auth user + a
   * user_profile flagged `is_customer`, with NO membership or client profile —
   * those are created lazily on the customer's first booking at each salon
   * (see PublicBookingService). Returns a `sheer_app` session, like login.
   */
  async createCustomerAccount(input: CreateCustomerAccountDto): Promise<LoginResponse> {
    const email = input.email.trim().toLowerCase();
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const fullName = `${firstName} ${lastName}`.trim();
    let createdUserId: string | undefined;

    const existingProfile = await this.findProfileByEmail(email);
    if (existingProfile) {
      throw new ConflictException('An account already exists for this email. Sign in to continue.');
    }

    try {
      const { data: createdUser, error: createUserError } = await this.admin.auth.admin.createUser({
        email,
        password: input.password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      });

      if (createUserError || !createdUser.user) {
        throw new ConflictException(createUserError?.message ?? 'Unable to create account');
      }

      createdUserId = createdUser.user.id;
      await this.createUserProfile(createdUserId, email, fullName, input.phone, true);

      return this.login(email, input.password, 'sheer_app');
    } catch (error) {
      if (createdUserId) {
        await this.rollbackCreatedCustomerAccount(createdUserId);
      }
      if (error instanceof ConflictException) {
        throw error;
      }
      this.logger.error(
        `createCustomerAccount failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new InternalServerErrorException('Unable to create customer account');
    }
  }

  /**
   * Ensure a customer holds a client membership + client profile at the given
   * salon, creating them (with a fresh, auto-assigned client code) if this is
   * their first interaction with that business. Idempotent — returns the
   * existing profile on repeat calls. Used by the booking flow to lazily join a
   * customer to each salon they book. Returns the client profile id + code.
   */
  async ensureClientForBusiness(
    businessId: string,
    locationId: string,
    userId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      communicationPreference?: 'whatsapp' | 'sms' | 'email';
    },
  ): Promise<{
    id: string;
    clientCode?: string;
    communicationPreference?: CommunicationPreference;
  }> {
    await this.ensureClientMembership(businessId, userId);
    await this.ensureClientProfile(businessId, locationId, userId, input);

    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,client_code,communication_preference')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .maybeSingle<{
        id: string;
        client_code?: string;
        communication_preference?: CommunicationPreference | null;
      }>();

    if (error || !data) {
      this.logger.error(`ensureClientForBusiness lookup failed: ${error?.message ?? 'not found'}`);
      throw new InternalServerErrorException('Unable to resolve client profile');
    }

    return {
      id: data.id,
      clientCode: data.client_code,
      communicationPreference: data.communication_preference ?? undefined,
    };
  }

  private async rollbackCreatedCustomerAccount(userId: string): Promise<void> {
    await this.admin.schema('core').from('user_profiles').delete().eq('id', userId);
    await this.admin.auth.admin.deleteUser(userId);
  }

  async loginClientForBooking(input: ClientBookingLoginDto): Promise<ClientBookingLoginResponse> {
    const location = await this.fetchBookingLocation(input.locationId);
    const email = input.email.trim().toLowerCase();
    const { data, error } = await this.sessionClient().auth.signInWithPassword({
      email,
      password: input.password,
    });

    if (error || !data.user || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const profile = await this.fetchProfile(data.user.id);
    const client = await this.ensureClientForBusiness(
      location.business_id,
      input.locationId,
      data.user.id,
      {
        firstName: firstNameFromFullName(profile.full_name),
        lastName: lastNameFromFullName(profile.full_name),
        email,
        phone: input.phone ?? profile.phone ?? undefined,
      },
    );
    if (input.phone?.trim()) {
      await this.updateUserProfilePhone(data.user.id, input.phone);
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.assertSurfaceAccess(user, 'sheer_app');

    return {
      session: this.toAuthSession(data.session),
      user,
      bookingClient: toBookingClient(location.business_id, client),
    };
  }

  async login(email: string, password: string, surface: RuntimeSurface = 'api'): Promise<LoginResponse> {
    const { data, error } = await this.sessionClient().auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user || !data.session) {
      this.assertUpstreamAnswered(error, 'sign-in');
      throw new UnauthorizedException('Invalid email or password');
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.assertSurfaceAccess(user, surface);

    return {
      session: this.toAuthSession(data.session),
      user,
    };
  }

  async refresh(refreshToken: string, surface: RuntimeSurface = 'api'): Promise<LoginResponse> {
    const { data, error } = await this.sessionClient().auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.user || !data.session) {
      this.assertUpstreamAnswered(error, 'session refresh');
      throw new UnauthorizedException('Session refresh failed');
    }

    // Supabase has now ROTATED the refresh token: the one the caller sent is
    // spent, and only the session in `data` can be used again. Anything that
    // fails from here on therefore strands the caller with a dead credential,
    // so a transient failure gets one immediate retry rather than becoming a
    // silent sign-out. (A caller that still loses the race recovers by retrying
    // quickly: Supabase honours a spent token for `refresh_token_reuse_interval`
    // and answers with the same rotated session.)
    const user = await this.resolveAuthUserWithRetry(data.user.id);
    this.assertSurfaceAccess(user, surface);

    return {
      session: this.toAuthSession(data.session),
      user,
    };
  }

  /**
   * End THIS session — and only this one.
   *
   * `scope: 'local'` is the whole point. auth-js defaults to `'global'`, which
   * revokes every session the person holds, so signing out of the dashboard
   * used to sign the same person out of the phone app and the Lab tablet as
   * well. Each surface signs in separately and should sign out separately;
   * "sign out everywhere" would be a deliberate, separate action.
   *
   * Best effort by design — the caller has already forgotten the session — but
   * not fire-and-forget: each branch below exists because a real client reaches
   * it, and a sign-out that quietly revokes nothing leaves a live credential
   * behind.
   */
  async logout(accessToken?: string, refreshToken?: string): Promise<void> {
    if (accessToken) this.verifiedTokens.invalidate(accessToken);
    if (!accessToken && !refreshToken) return;

    const client = this.sessionClient();
    try {
      if (accessToken && refreshToken) {
        // `setSession` refreshes first when the access token has already
        // expired, so an expired-but-refreshable session still gets revoked.
        const { error } = await client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (!error) {
          await client.auth.signOut({ scope: 'local' });
          return;
        }
      }

      if (refreshToken) {
        // No usable access token: trade the refresh token for one rather than
        // return 204 having revoked nothing.
        const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
        if (!error && data.session) {
          await client.auth.signOut({ scope: 'local' });
          return;
        }
      }

      if (accessToken) {
        await this.admin.auth.admin.signOut(accessToken, 'local');
      }
    } catch (error) {
      this.logger.warn(`Sign-out could not be completed upstream: ${describeError(error)}`);
    }
  }

  async verifyAccessToken(accessToken: string): Promise<AuthUser> {
    const cached = this.verifiedTokens.get(accessToken);
    if (cached) return cached;

    // `getUser(jwt)` is the one auth-js call that carries no session state: with
    // an explicit token it is a plain request, so the shared client is safe here.
    const { data, error } = await this.anon.auth.getUser(accessToken);
    if (error || !data.user) {
      this.assertUpstreamAnswered(error, 'token verification');
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.verifiedTokens.set(accessToken, user);
    return user;
  }

  /**
   * A throwaway auth client for ONE session-bearing call.
   *
   * `signInWithPassword` and `refreshSession` both STORE the resulting session
   * on the client they were called on (auth-js keeps an in-memory store even
   * with `persistSession: false`). A later `refreshSession` on that same client
   * loads that stored session first and, if it is near expiry, refreshes it —
   * so on one process-wide client a refresh for user B issues an extra token
   * grant carrying user A's refresh token, and concurrent refreshes are
   * serialised behind a single shared in-flight promise.
   *
   * Supabase's parent-token rule means that stray rotation does not lock user A
   * out today, but it is another user's credential being spent, an extra call
   * against a per-IP rate limit the whole platform shares, and a session-killing
   * bug the moment this API runs more than one replica. A client per call costs
   * an object and no network, and the session dies with the request.
   */
  private sessionClient(): SupabaseClient {
    return createClient(this.supabaseUrl, this.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Refuse to turn an outage into a sign-out. See {@link isAuthoritativeRejection}.
   */
  private assertUpstreamAnswered(error: unknown, action: string): void {
    if (!error || isAuthoritativeRejection(error)) return;
    this.logger.error(`Supabase auth ${action} did not answer: ${describeError(error)}`);
    throw new ServiceUnavailableException(
      'The sign-in service is temporarily unavailable. Please try again.',
    );
  }

  /**
   * `resolveAuthUser`, with one immediate retry for failures that are not a
   * verdict about the user. Used on the refresh path, where the credential has
   * already been rotated and giving up means signing the caller out.
   */
  private async resolveAuthUserWithRetry(userId: string): Promise<AuthUser> {
    try {
      return await this.resolveAuthUser(userId);
    } catch (error) {
      // A membership verdict (403) or a missing profile (404) is an answer, not
      // an outage: retrying would only produce the same answer.
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
      this.logger.warn(
        `Re-resolving ${userId} after a transient failure on the refresh path: ${describeError(error)}`,
      );
      return this.resolveAuthUser(userId);
    }
  }

  async resolveAuthUser(userId: string): Promise<AuthUser> {
    const [profile, memberships] = await Promise.all([
      this.fetchProfile(userId),
      this.fetchMemberships(userId),
    ]);

    const activeMemberships = memberships.filter((m) => m.status === 'active');
    if (activeMemberships.length === 0) {
      // A self-registered customer holds no salon membership until their first
      // booking creates one. Resolve them to a salon-less `client` identity so
      // they can sign in and browse. Everyone else with no active membership
      // (e.g. a deactivated staff member) is still denied.
      if (profile.is_customer) {
        return this.buildSalonlessCustomer(profile);
      }
      throw new ForbiddenException('User has no active business membership');
    }

    const primaryMembership = [...activeMemberships].sort(
      (a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role],
    )[0];
    const sameBusinessMemberships = activeMemberships.filter(
      (m) => m.business_id === primaryMembership.business_id,
    );

    // A user can hold several roles in the same business (owner + manager +
    // stylist). Expose ALL of them (highest-privilege first) and keep the
    // primary one only for surface routing / display.
    const roles = sortRolesByPriority(sameBusinessMemberships.map((m) => m.role));
    const primaryRole = roles[0];

    const [business, businessLocations, staffProfile, clientProfile] = await Promise.all([
      this.fetchBusiness(primaryMembership.business_id),
      this.fetchLocations(primaryMembership.business_id),
      this.fetchStaffProfile(primaryMembership.business_id, userId),
      this.fetchClientProfile(
        primaryMembership.business_id,
        userId,
        roles.includes('client')
          ? sameBusinessMemberships.map((membership) => membership.location_id).filter(isString)
          : undefined,
      ),
    ]);

    const allowedLocationIds = this.resolveAllowedLocationIds(
      roles,
      sameBusinessMemberships,
      businessLocations,
    );
    const visibleLocations = businessLocations.filter((location) =>
      allowedLocationIds.includes(location.id),
    );

    const securityLevels = await this.fetchMembershipSecurityLevels(roles, sameBusinessMemberships);
    const permissions = this.resolveEffectivePermissions(
      roles,
      sameBusinessMemberships,
      securityLevels,
    );
    // Reporting reads these, never `permissions`: see membership-grants.ts.
    const membershipGrants = resolveMembershipGrants({
      businessId: business.id,
      roles,
      memberships: sameBusinessMemberships,
      levels: securityLevels,
      businessLocationIds: new Set(businessLocations.map((location) => location.id)),
    });

    await this.admin
      .schema('core')
      .from('user_profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userId);

    return {
      id: profile.id,
      roles,
      primaryRole,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      businessTier: business.tier ?? 'spark',
      allowedLocationIds,
      // Scope kind follows the highest-privilege role: owner sees everything,
      // a manager (anywhere in the set) gets multi-location scope, otherwise
      // the user is limited to their own locations.
      locationScope:
        primaryRole === 'owner'
          ? { kind: 'all', locationIds: allowedLocationIds }
          : primaryRole === 'stylist' || primaryRole === 'client'
            ? { kind: 'self', locationIds: allowedLocationIds }
            : { kind: 'locations', locationIds: allowedLocationIds },
      locations: visibleLocations.map((location) => ({
        id: location.id,
        name: location.name,
        code: location.code ?? undefined,
        slug: location.slug ?? undefined,
      })),
      profile: {
        id: profile.id,
        email: profile.email,
        firstName: profile.first_name ?? undefined,
        lastName: profile.last_name ?? undefined,
        fullName: profile.full_name,
        displayName: profile.display_name ?? profile.full_name,
        phone: profile.phone ?? undefined,
        avatarUrl: profile.avatar_url ?? undefined,
        isActive: profile.is_active ?? true,
      },
      staffProfileId: staffProfile?.id,
      clientProfileId: clientProfile?.id,
      clientCode: clientProfile?.client_code,
      clientCommunicationPreference: clientProfile?.communication_preference ?? undefined,
      timezone: profile.timezone ?? undefined,
      permissions,
      ...(membershipGrants ? { membershipGrants } : {}),
    };
  }

  /**
   * Build the AuthUser for a self-registered customer who has not joined any
   * salon yet (no membership). They get a `client` identity with no business
   * context — `businessId` is '' and there is no clientProfile/clientCode until
   * their first booking. Business-scoped endpoints are unreachable for them;
   * app surfaces branch on {@link userHasJoinedSalon}.
   */
  private buildSalonlessCustomer(profile: ProfileRow): AuthUser {
    void this.admin
      .schema('core')
      .from('user_profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', profile.id)
      .then(undefined, () => undefined);

    return {
      id: profile.id,
      roles: ['client'],
      primaryRole: 'client',
      businessId: '',
      allowedLocationIds: [],
      locationScope: { kind: 'self', locationIds: [] },
      locations: [],
      profile: {
        id: profile.id,
        email: profile.email,
        firstName: profile.first_name ?? undefined,
        lastName: profile.last_name ?? undefined,
        fullName: profile.full_name,
        displayName: profile.display_name ?? profile.full_name,
        phone: profile.phone ?? undefined,
        avatarUrl: profile.avatar_url ?? undefined,
        isActive: profile.is_active ?? true,
      },
      timezone: profile.timezone ?? undefined,
      permissions: [],
    };
  }

  /**
   * Resolve the effective permission set for the current business. Owners always
   * hold every permission (they can never lock themselves out). For everyone
   * else we union, across their active memberships, the permissions of an
   * assigned security level — or the base-role defaults when no level is set
   * (which is exactly V1 behaviour for un-migrated members).
   */
  private resolveEffectivePermissions(
    roles: UserRole[],
    memberships: MembershipRow[],
    levels: ReadonlyMap<string, GrantSecurityLevel>,
  ): Permission[] {
    if (roles.includes('owner')) {
      return [...ALL_PERMISSIONS];
    }

    const effective = new Set<Permission>();
    for (const membership of memberships) {
      // An explicitly assigned level must fail closed. Falling back to the base
      // role when the referenced level is missing would silently restore broader
      // V1 manager access after a stale/deleted assignment.
      const perms = membership.security_level_id
        ? (levels.get(membership.security_level_id)?.permissions ?? [])
        : (DEFAULT_ROLE_PERMISSIONS[membership.role] ?? []);
      for (const perm of perms) effective.add(perm);
    }

    // Close over the dependency tree so a held permission always carries its
    // prerequisites (e.g. `bookings.manage` implies the read side of clients,
    // services and rota). Returns catalogue order for stable output.
    return expandPermissions(effective);
  }

  /**
   * The security levels referenced by a non-owner's memberships. Owners resolve
   * every permission through their role, so no level is read for them.
   */
  private async fetchMembershipSecurityLevels(
    roles: UserRole[],
    memberships: MembershipRow[],
  ): Promise<Map<string, GrantSecurityLevel>> {
    if (roles.includes('owner')) {
      return new Map();
    }
    const levelIds = [
      ...new Set(memberships.map((m) => m.security_level_id).filter(isString)),
    ];
    return levelIds.length ? this.fetchSecurityLevelPermissions(levelIds) : new Map();
  }

  private async fetchSecurityLevelPermissions(
    levelIds: string[],
  ): Promise<Map<string, GrantSecurityLevel>> {
    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .select('id,business_id,permissions')
      .in('id', levelIds)
      .returns<SecurityLevelPermissionsRow[]>();

    const map = new Map<string, GrantSecurityLevel>();
    if (error || !data) {
      throw new ForbiddenException('Unable to resolve security level permissions');
    }
    const valid = new Set<string>(ALL_PERMISSIONS);
    for (const row of data) {
      const perms = Array.isArray(row.permissions)
        ? (row.permissions.filter((p): p is Permission => typeof p === 'string' && valid.has(p)))
        : [];
      map.set(row.id, { businessId: row.business_id, permissions: perms });
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Password reset (self-serve, web)
  //
  // Mirrors the staff invitation token shape: a high-entropy plaintext token
  // is emailed to the user; we only store its sha256 hash. Acceptance is
  // single-use and rotates the password via supabase.auth.admin.updateUserById,
  // which means we never see the user's old password and never put one in
  // application logs.
  // ---------------------------------------------------------------------------

  async requestPasswordReset(
    rawEmail: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<PasswordResetRequestResponse> {
    const email = rawEmail.trim().toLowerCase();

    // Look up the profile but do NOT reveal whether it exists. The endpoint
    // ALWAYS responds 'accepted' so the response cannot be used as an email
    // enumeration oracle.
    const profile = await this.findProfileByEmail(email);
    if (!profile) {
      return { accepted: true };
    }

    const { token, hash } = generateResetToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 3600 * 1000).toISOString();

    // Invalidate previous outstanding tokens for this account so the most
    // recent email is the only one that works (defence against double-clicks
    // and against an attacker who phished a stale token).
    await this.admin
      .schema('core')
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('user_profile_id', profile.id)
      .is('used_at', null);

    const { error: insertError } = await this.admin.schema('core').from('password_reset_tokens').insert({
      user_profile_id: profile.id,
      email,
      token_hash: hash,
      expires_at: expiresAt,
      request_ip: meta.ip ?? null,
      request_user_agent: meta.userAgent ?? null,
    });

    if (insertError) {
      this.logger.error(`Unable to persist password reset token: ${insertError.message}`);
      // Still respond 'accepted' to avoid leaking infra problems to anonymous
      // callers. Operators see the error in logs.
      return { accepted: true };
    }

    const resetUrl = this.buildResetUrl(token);
    const rendered = renderPasswordResetEmail({
      recipientName: profile.full_name?.split(' ')[0],
      resetUrl,
      expiresAt,
      requestIp: meta.ip,
    });

    const result = await this.email.send({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: [
        { name: 'category', value: 'password_reset' },
        { name: 'user_profile_id', value: profile.id },
      ],
    });

    if (result.delivered) {
      this.logger.log(
        `Password reset email delivered to ${email} (resend_id=${result.id ?? 'n/a'})`,
      );
    } else if (result.skipped) {
      this.logger.warn(
        `Password reset email skipped for ${email} — RESEND_API_KEY not configured. Reset URL: ${resetUrl}`,
      );
    } else {
      this.logger.warn(
        `Password reset email failed for ${email}: ${result.error ?? 'unknown'}.`,
      );
    }

    return { accepted: true };
  }

  async inspectPasswordResetToken(token: string): Promise<PasswordResetInspectResponse> {
    const row = await this.findPasswordResetToken(token);
    if (!row) {
      return { status: 'unknown' };
    }
    const status = this.evaluateResetStatus(row);
    if (status === 'expired') {
      // Mark it used so a one-time link can never be reactivated by waiting.
      await this.markResetTokenUsed(row.id);
    }
    return {
      status,
      emailMasked: maskEmail(row.email),
      expiresAt: row.expires_at,
    };
  }

  async completePasswordReset(token: string, newPassword: string): Promise<PasswordResetCompleteResponse> {
    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_RESET_MIN_LENGTH) {
      throw new BadRequestException(
        `Password must be at least ${PASSWORD_RESET_MIN_LENGTH} characters`,
      );
    }

    const row = await this.findPasswordResetToken(token);
    if (!row) {
      throw new NotFoundException('Reset link is invalid');
    }

    const status = this.evaluateResetStatus(row);
    if (status === 'expired') {
      await this.markResetTokenUsed(row.id);
      throw new BadRequestException('Reset link has expired');
    }
    if (status === 'used') {
      throw new BadRequestException('Reset link has already been used');
    }
    if (status !== 'valid') {
      throw new BadRequestException('Reset link is invalid');
    }

    const { error: updateError } = await this.admin.auth.admin.updateUserById(row.user_profile_id, {
      password: newPassword,
    });
    if (updateError) {
      this.logger.error(`updateUserById failed for password reset: ${updateError.message}`);
      throw new InternalServerErrorException('Unable to reset password');
    }

    await this.markResetTokenUsed(row.id);

    // Derive the role from the *primary* active membership (source of
    // truth) so we can return a role-aware completion contract that
    // matches the staff-invitation acceptance flow. Any role is allowed
    // to reset their password on the web; only the *destination*
    // differs.
    const role = await this.resolvePrimaryRole(row.user_profile_id);
    const targetSurface: AccountCreationTargetSurface = isWebSurfaceRole(role) ? 'web' : 'mobile';
    const nextAction: AccountCreationNextAction =
      targetSurface === 'web' ? 'redirect_to_dashboard' : 'show_completion_page';
    const redirectTo =
      targetSurface === 'mobile'
        ? `/auth/password-reset-complete?role=${encodeURIComponent(role)}`
        : '/login?password=reset';

    return {
      success: true,
      redirectTo,
      role,
      targetSurface,
      nextAction,
    };
  }

  /**
   * Resolve the user's "primary" role for surface routing. We pick the
   * highest-privilege active membership, mirroring `resolveAuthUser`.
   * Falls back to `'client'` if the user has no active membership at all
   * (e.g. a freshly-created client profile pending activation) so the
   * password-reset completion flow always has a target surface; it never
   * 403s like the dashboard-resolving path does.
   */
  private async resolvePrimaryRole(userId: string): Promise<UserRole> {
    const memberships = await this.fetchMemberships(userId);
    const active = memberships.filter((m) => m.status === 'active');
    if (active.length === 0) {
      return 'client';
    }
    return [...active].sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role])[0].role;
  }

  private async findPasswordResetToken(token: string): Promise<PasswordResetRow | null> {
    if (!token || token.length < 20) return null;
    const hash = hashResetToken(token);
    const { data, error } = await this.admin
      .schema('core')
      .from('password_reset_tokens')
      .select('id,user_profile_id,email,token_hash,expires_at,used_at,created_at')
      .eq('token_hash', hash)
      .maybeSingle<PasswordResetRow>();

    if (error) {
      this.logger.error(`Unable to look up password reset token: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify reset link');
    }
    return data ?? null;
  }

  private evaluateResetStatus(row: PasswordResetRow): PasswordResetTokenStatus {
    if (row.used_at) return 'used';
    if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
    return 'valid';
  }

  private async markResetTokenUsed(id: string): Promise<void> {
    await this.admin
      .schema('core')
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id);
  }

  private buildResetUrl(token: string): string {
    return `${this.resetBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
  }

  canAccessLocation(user: AuthUser, locationId: string): boolean {
    return userHasRole(user, 'owner') || user.allowedLocationIds.includes(locationId);
  }

  canAccessOwnStaffProfile(user: AuthUser, staffProfileId: string): boolean {
    return userHasAnyRole(user, ['owner', 'manager']) || user.staffProfileId === staffProfileId;
  }

  private assertSurfaceAccess(user: AuthUser, surface: RuntimeSurface): void {
    if (surface === 'web_dashboard' && !userHasAnyRole(user, ['owner', 'manager'])) {
      throw new ForbiddenException('Web dashboard access is limited to owners and managers');
    }

    if (surface === 'sheer_app' && !userHasAnyRole(user, ['owner', 'manager', 'stylist', 'client'])) {
      throw new ForbiddenException('Sheer App access is limited to active Sheer accounts');
    }

    if (surface === 'sheer_lab' && !userHasAnyRole(user, ['owner', 'manager', 'stylist'])) {
      throw new ForbiddenException('Qlooqo Lab access is limited to staff accounts');
    }
  }

  private resolveAllowedLocationIds(
    roles: UserRole[],
    memberships: MembershipRow[],
    businessLocations: LocationRow[],
  ): string[] {
    if (roles.includes('owner')) {
      return businessLocations.filter((l) => l.is_active).map((l) => l.id);
    }

    // Union the locations across EVERY role the user holds — a manager@A who is
    // also a stylist@B must see both A and B, not just their primary role's
    // locations.
    const membershipLocationIds = new Set(
      memberships.filter((m) => m.location_id).map((m) => m.location_id as string),
    );

    // Order by the business's own `sort_order` rather than by whatever order the
    // membership rows came back in (that query is unordered). Callers treat
    // `allowedLocationIds[0]` as a stable default location, and it has to agree
    // with `locations[0]` — which is sorted — instead of drifting between logins.
    const ordered = businessLocations
      .filter((location) => membershipLocationIds.has(location.id))
      .map((location) => location.id);

    // A membership pointing at a location the business no longer lists keeps its
    // place in the scope; dropping it here would silently narrow access.
    const orphans = [...membershipLocationIds].filter((id) => !ordered.includes(id));
    return [...ordered, ...orphans];
  }

  private async fetchProfile(userId: string): Promise<ProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,first_name,last_name,full_name,display_name,phone,avatar_url,is_active,timezone,is_customer')
      .eq('id', userId)
      .single<ProfileRow>();

    if (error || !data) {
      throw new ForbiddenException('User profile is not configured');
    }

    return data;
  }

  private async findProfileByEmail(email: string): Promise<ProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,first_name,last_name,full_name,display_name,phone,avatar_url,is_active,timezone,is_customer')
      .eq('email', email)
      .maybeSingle<ProfileRow>();

    if (error) {
      throw new InternalServerErrorException('Unable to check existing account');
    }

    return data ?? undefined;
  }

  private async createBusiness(name: string): Promise<BusinessRow> {
    const baseSlug = slugify(name);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`;
      const { data, error } = await this.admin
        .schema('core')
        .from('businesses')
        .insert({ name, slug })
        .select('id,name,slug')
        .single<BusinessRow>();

      if (!error && data) {
        return data;
      }

      if (!String(error?.message ?? '').toLowerCase().includes('duplicate')) {
        throw new InternalServerErrorException('Unable to create business');
      }
    }

    throw new ConflictException('Business name is already taken');
  }

  private async createUserProfile(
    userId: string,
    email: string,
    fullName: string,
    phone?: string,
    isCustomer = false,
  ): Promise<void> {
    const { error } = await this.admin.schema('core').from('user_profiles').insert({
      id: userId,
      email,
      first_name: firstNameFromFullName(fullName),
      last_name: lastNameFromFullName(fullName),
      full_name: fullName,
      display_name: fullName,
      phone: phone?.trim() || null,
      is_customer: isCustomer,
    });

    if (error) {
      throw new InternalServerErrorException('Unable to create user profile');
    }
  }

  private async updateUserProfilePhone(userId: string, phone: string): Promise<void> {
    const trimmed = phone.trim();
    if (!trimmed) return;
    const { error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .update({ phone: trimmed })
      .eq('id', userId);

    if (error) {
      throw new InternalServerErrorException('Unable to update user profile phone');
    }
  }

  private async createOwnerMembership(businessId: string, userId: string): Promise<void> {
    const { error } = await this.admin.schema('core').from('user_memberships').insert({
      business_id: businessId,
      user_profile_id: userId,
      role: 'owner',
      status: 'active',
      activated_at: new Date().toISOString(),
    });

    if (error) {
      throw new InternalServerErrorException('Unable to create owner membership');
    }
  }

  private async fetchBookingLocation(locationId: string): Promise<BookingLocationRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,business_id,name,location_settings(online_booking_enabled)')
      .eq('id', locationId)
      .eq('is_active', true)
      .maybeSingle<BookingLocationRow & { location_settings?: { online_booking_enabled: boolean }[] }>();

    if (error) {
      this.logger.error(`fetchBookingLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking location');
    }
    if (!data) throw new NotFoundException('Booking location not found');
    const settings = data.location_settings?.[0];
    if (settings && !settings.online_booking_enabled) {
      throw new NotFoundException('Online booking is not available for this location');
    }
    return { id: data.id, business_id: data.business_id, name: data.name };
  }

  private async ensureClientMembership(businessId: string, userId: string): Promise<void> {
    const { data: existing, error: lookupError } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('business_id')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .eq('role', 'client')
      .eq('status', 'active')
      .maybeSingle<{ business_id: string }>();

    if (lookupError) {
      throw new InternalServerErrorException('Unable to load client membership');
    }
    if (existing) return;

    const { error } = await this.admin.schema('core').from('user_memberships').insert({
      business_id: businessId,
      user_profile_id: userId,
      role: 'client',
      status: 'active',
      activated_at: new Date().toISOString(),
    });

    if (error) {
      throw new InternalServerErrorException('Unable to create client membership');
    }
  }

  private async ensureClientProfile(
    businessId: string,
    locationId: string,
    userId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      communicationPreference?: 'whatsapp' | 'sms' | 'email';
    },
  ): Promise<void> {
    const clientProfileColumns =
      'id,client_code,first_name,last_name,email,phone,communication_preference';
    const { data: linked, error: lookupError } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(clientProfileColumns)
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .maybeSingle<ClientProfileRow>();

    if (lookupError) {
      throw new InternalServerErrorException('Unable to load client profile');
    }

    // When no profile is linked to this account yet, adopt a pre-existing
    // UNLINKED profile with the same email (e.g. one a manager created manually
    // in the CRM before the client signed up) by linking it to this account,
    // instead of inserting a second profile. This keeps the manager's notes,
    // allergies and patch tests attached to the same client_profile_id.
    let existing = linked;
    if (!existing && input.email) {
      const { data: unlinked, error: adoptError } = await this.admin
        .schema('core')
        .from('client_profiles')
        .select(clientProfileColumns)
        .eq('business_id', businessId)
        .is('user_profile_id', null)
        .is('merged_into_id', null)
        .eq('email', input.email)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle<ClientProfileRow>();
      if (adoptError) {
        throw new InternalServerErrorException('Unable to load client profile');
      }
      if (unlinked) existing = unlinked;
    }

    // Email missed (staff recorded a different address, or none): fall back to
    // the phone number — the strongest identity signal a salon holds. Adopt
    // only on a SINGLE unambiguous match; two candidates mean a human must
    // merge instead, so a fresh profile is created rather than guessing.
    if (!existing && input.phone) {
      const normalizedPhone = normalizeE164(input.phone) ?? input.phone.trim();
      if (normalizedPhone) {
        const { data: byPhone, error: phoneAdoptError } = await this.admin
          .schema('core')
          .from('client_profiles')
          .select(clientProfileColumns)
          .eq('business_id', businessId)
          .is('user_profile_id', null)
          .is('merged_into_id', null)
          .eq('phone', normalizedPhone)
          .order('updated_at', { ascending: false })
          .limit(2)
          .returns<ClientProfileRow[]>();
        if (phoneAdoptError) {
          throw new InternalServerErrorException('Unable to load client profile');
        }
        if ((byPhone ?? []).length === 1) existing = byPhone![0];
      }
    }

    const payload = {
      business_id: businessId,
      primary_location_id: locationId,
      user_profile_id: userId,
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email,
      phone: input.phone?.trim() || existing?.phone || null,
      communication_preference: input.communicationPreference ?? existing?.communication_preference ?? null,
      source: 'public_booking_flow',
    };

    const request = existing
      ? this.admin.schema('core').from('client_profiles').update(payload).eq('id', existing.id)
      : this.admin.schema('core').from('client_profiles').insert(payload);

    const { error } = await request;
    if (error) {
      this.logger.error(`ensureClientProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save client profile');
    }
  }

  private async rollbackCreatedClientAccount(userId: string, businessId: string): Promise<void> {
    await this.admin
      .schema('core')
      .from('client_profiles')
      .delete()
      .eq('business_id', businessId)
      .eq('user_profile_id', userId);

    await this.admin
      .schema('core')
      .from('user_memberships')
      .delete()
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .eq('role', 'client');

    await this.admin.schema('core').from('user_profiles').delete().eq('id', userId);
    await this.admin.auth.admin.deleteUser(userId);
  }

  private async rollbackCreatedAccount(userId?: string, businessId?: string): Promise<void> {
    if (businessId) {
      await this.admin.schema('core').from('businesses').delete().eq('id', businessId);
    }

    if (userId) {
      await this.admin.auth.admin.deleteUser(userId);
    }
  }

  private async fetchMemberships(userId: string): Promise<MembershipRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('business_id,location_id,role,status,security_level_id')
      .eq('user_profile_id', userId)
      .returns<MembershipRow[]>();

    if (error) {
      throw new ForbiddenException('Unable to resolve user memberships');
    }

    return data ?? [];
  }

  private async fetchBusiness(businessId: string): Promise<BusinessRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('id,name,slug,tier')
      .eq('id', businessId)
      .single<BusinessRow>();

    if (error || !data) {
      throw new ForbiddenException('Business is not configured');
    }

    return data;
  }

  private async fetchLocations(businessId: string): Promise<LocationRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,code,slug,is_active')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .returns<LocationRow[]>();

    if (error) {
      throw new ForbiddenException('Unable to resolve location scope');
    }

    return data ?? [];
  }

  private async fetchStaffProfile(
    businessId: string,
    userId: string,
  ): Promise<StaffProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .maybeSingle<StaffProfileRow>();

    if (error) {
      throw new ForbiddenException('Unable to resolve staff profile');
    }

    return data ?? undefined;
  }

  private async fetchClientProfile(
    businessId: string,
    userId: string,
    locationIds?: string[],
  ): Promise<ClientProfileRow | undefined> {
    let query = this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,client_code,primary_location_id,communication_preference')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId);

    if (locationIds?.length) {
      query = query.in('primary_location_id', locationIds);
    }

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle<ClientProfileRow>();

    if (error) {
      throw new ForbiddenException('Unable to resolve client profile');
    }

    return data ?? undefined;
  }

  private toAuthSession(session: {
    access_token: string;
    refresh_token: string;
    expires_at?: number;
  }): AuthSession {
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : undefined,
    };
  }
}

/**
 * Generate a high-entropy URL-safe reset token plus its sha256 hash.
 *
 * The plaintext token is the bearer credential that goes into the email
 * link; only its hash is persisted, so a database leak alone cannot
 * reset anyone's password.
 */
/** A log-safe one-liner for an unknown thrown value. Never includes a token. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : String(error);
}

function generateResetToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashResetToken(token) };
}

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** `j***@example.com` style mask. Never returns a string the receiver can use to enumerate. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return '***';
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/**
 * Roles whose primary product surface is the web dashboard. Stylists and
 * clients are allowed to *reset* their password on the web (the link goes
 * there because we control the host), but their day-to-day surface is the
 * Sheer App, so we do not auto-sign them into the dashboard.
 */
function isWebSurfaceRole(role: UserRole): boolean {
  return role === 'owner' || role === 'manager';
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || `business-${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function toBookingClient(
  businessId: string,
  client: { id: string; clientCode?: string; communicationPreference?: CommunicationPreference },
): ClientBookingLoginResponse['bookingClient'] {
  return {
    businessId,
    clientProfileId: client.id,
    clientCode: client.clientCode,
    communicationPreference: client.communicationPreference,
  };
}

function firstNameFromFullName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'Client';
  return trimmed.split(/\s+/)[0] ?? 'Client';
}

function lastNameFromFullName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return 'Client';
  return parts.slice(1).join(' ');
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
