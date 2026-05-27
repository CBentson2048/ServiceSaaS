import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
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
  CreateAccountRequest,
  CreateAccountResponse,
  LoginResponse,
  PasswordResetCompleteResponse,
  PasswordResetInspectResponse,
  PasswordResetRequestResponse,
  PasswordResetTokenStatus,
  UserRole,
} from '@sheer/domain';
import type { ClientBookingAccountDto, ClientBookingLoginDto } from './dto';
import { EmailService } from '../email/email.service';
import { renderPasswordResetEmail } from '../email/templates/password-reset.template';

type RuntimeSurface = Extract<AppSurface, 'api' | 'web_dashboard' | 'sheer_app' | 'sheer_lab'>;

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
}

interface MembershipRow {
  business_id: string;
  location_id: string | null;
  role: UserRole;
  status: string;
}

interface BusinessRow {
  id: string;
  name: string;
  slug: string;
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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private readonly anon: SupabaseClient;
  private readonly admin: SupabaseClient;
  private readonly resetBaseUrl: string;

  constructor(
    config: ConfigService,
    private readonly email: EmailService,
  ) {
    this.supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    this.anonKey = config.getOrThrow<string>('SUPABASE_ANON_KEY');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');

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

  async createClientBookingAccount(input: ClientBookingAccountDto): Promise<LoginResponse> {
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
      await this.ensureClientMembership(location.business_id, createdUserId);
      await this.ensureClientProfile(location.business_id, input.locationId, createdUserId, {
        firstName,
        lastName,
        email,
        phone: input.phone,
        communicationPreference: input.communicationPreference,
      });

      return this.login(email, input.password, 'sheer_app');
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

  async loginClientForBooking(input: ClientBookingLoginDto): Promise<LoginResponse> {
    const location = await this.fetchBookingLocation(input.locationId);
    const email = input.email.trim().toLowerCase();
    const { data, error } = await this.anon.auth.signInWithPassword({
      email,
      password: input.password,
    });

    if (error || !data.user || !data.session) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const profile = await this.fetchProfile(data.user.id);
    await this.ensureClientMembership(location.business_id, data.user.id);
    await this.ensureClientProfile(location.business_id, input.locationId, data.user.id, {
      firstName: firstNameFromFullName(profile.full_name),
      lastName: lastNameFromFullName(profile.full_name),
      email,
      phone: input.phone ?? profile.phone ?? undefined,
    });
    if (input.phone?.trim()) {
      await this.updateUserProfilePhone(data.user.id, input.phone);
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.assertSurfaceAccess(user, 'sheer_app');

    return {
      session: this.toAuthSession(data.session),
      user,
    };
  }

  async login(email: string, password: string, surface: RuntimeSurface = 'api'): Promise<LoginResponse> {
    const { data, error } = await this.anon.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user || !data.session) {
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
    const { data, error } = await this.anon.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.user || !data.session) {
      throw new UnauthorizedException('Session refresh failed');
    }

    const user = await this.resolveAuthUser(data.user.id);
    this.assertSurfaceAccess(user, surface);

    return {
      session: this.toAuthSession(data.session),
      user,
    };
  }

  async logout(accessToken?: string, refreshToken?: string): Promise<void> {
    if (accessToken && refreshToken) {
      const sessionClient = createClient(this.supabaseUrl, this.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      await sessionClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      await sessionClient.auth.signOut();
      return;
    }

    if (accessToken) {
      await this.admin.auth.admin.signOut(accessToken, 'global');
    }
  }

  async verifyAccessToken(accessToken: string): Promise<AuthUser> {
    const { data, error } = await this.anon.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    return this.resolveAuthUser(data.user.id);
  }

  async resolveAuthUser(userId: string): Promise<AuthUser> {
    const [profile, memberships] = await Promise.all([
      this.fetchProfile(userId),
      this.fetchMemberships(userId),
    ]);

    const activeMemberships = memberships.filter((m) => m.status === 'active');
    if (activeMemberships.length === 0) {
      throw new ForbiddenException('User has no active business membership');
    }

    const primaryMembership = [...activeMemberships].sort(
      (a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role],
    )[0];
    const sameBusinessMemberships = activeMemberships.filter(
      (m) => m.business_id === primaryMembership.business_id,
    );

    const [business, businessLocations, staffProfile, clientProfile] = await Promise.all([
      this.fetchBusiness(primaryMembership.business_id),
      this.fetchLocations(primaryMembership.business_id),
      this.fetchStaffProfile(primaryMembership.business_id, userId),
      this.fetchClientProfile(
        primaryMembership.business_id,
        userId,
        primaryMembership.role === 'client'
          ? sameBusinessMemberships.map((membership) => membership.location_id).filter(isString)
          : undefined,
      ),
    ]);

    const allowedLocationIds = this.resolveAllowedLocationIds(
      primaryMembership.role,
      sameBusinessMemberships,
      businessLocations,
    );
    const visibleLocations = businessLocations.filter((location) =>
      allowedLocationIds.includes(location.id),
    );

    await this.admin
      .schema('core')
      .from('user_profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userId);

    return {
      id: profile.id,
      role: primaryMembership.role,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      allowedLocationIds,
      locationScope:
        primaryMembership.role === 'owner'
          ? { kind: 'all', locationIds: allowedLocationIds }
          : primaryMembership.role === 'stylist' || primaryMembership.role === 'client'
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
        fullName: profile.full_name,
        phone: profile.phone ?? undefined,
        avatarUrl: profile.avatar_url ?? undefined,
      },
      staffProfileId: staffProfile?.id,
      clientProfileId: clientProfile?.id,
      clientCode: clientProfile?.client_code,
      clientCommunicationPreference: clientProfile?.communication_preference ?? undefined,
    };
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
    return user.role === 'owner' || user.allowedLocationIds.includes(locationId);
  }

  canAccessOwnStaffProfile(user: AuthUser, staffProfileId: string): boolean {
    return user.role === 'owner' || user.role === 'manager' || user.staffProfileId === staffProfileId;
  }

  private assertSurfaceAccess(user: AuthUser, surface: RuntimeSurface): void {
    if (surface === 'web_dashboard' && user.role !== 'owner' && user.role !== 'manager') {
      throw new ForbiddenException('Web dashboard access is limited to owners and managers');
    }

    if (
      surface === 'sheer_app' &&
      user.role !== 'owner' &&
      user.role !== 'manager' &&
      user.role !== 'stylist' &&
      user.role !== 'client'
    ) {
      throw new ForbiddenException('Sheer App access is limited to active Sheer accounts');
    }

    if (
      surface === 'sheer_lab' &&
      user.role !== 'owner' &&
      user.role !== 'manager' &&
      user.role !== 'stylist'
    ) {
      throw new ForbiddenException('Sheer Lab access is limited to staff accounts');
    }
  }

  private resolveAllowedLocationIds(
    role: UserRole,
    memberships: MembershipRow[],
    businessLocations: LocationRow[],
  ): string[] {
    if (role === 'owner') {
      return businessLocations.filter((l) => l.is_active).map((l) => l.id);
    }

    return [
      ...new Set(
        memberships
          .filter((m) => m.role === role && m.location_id)
          .map((m) => m.location_id as string),
      ),
    ];
  }

  private async fetchProfile(userId: string): Promise<ProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,full_name,phone,avatar_url')
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
      .select('id,email,full_name,phone,avatar_url')
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
  ): Promise<void> {
    const { error } = await this.admin.schema('core').from('user_profiles').insert({
      id: userId,
      email,
      full_name: fullName,
      phone: phone?.trim() || null,
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
    const { data: existing, error: lookupError } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,client_code,first_name,last_name,email,phone,communication_preference')
      .eq('business_id', businessId)
      .eq('user_profile_id', userId)
      .maybeSingle<ClientProfileRow>();

    if (lookupError) {
      throw new InternalServerErrorException('Unable to load client profile');
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
      .select('business_id,location_id,role,status')
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
      .select('id,name,slug')
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
