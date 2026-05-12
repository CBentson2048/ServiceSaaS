import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import type {
  AccountCreationNextAction,
  AccountCreationTargetSurface,
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  AuthUser,
  BusinessLocationSummary,
  CreateStaffInvitationRequest,
  InvitableRole,
  InvitationLookupResponse,
  InvitationStatus,
  ListStaffResponse,
  MembershipStatus,
  StaffInvitation,
  StaffInvitationWithToken,
  StaffMember,
  UpdateStaffMemberRequest,
  UpdateStaffMemberResponse,
  UserRole,
} from '@sheer/domain';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { renderStaffInvitationEmail } from '../email/templates/staff-invitation.template';

const DEFAULT_INVITE_EXPIRY_HOURS = 14 * 24;

interface InvitationRow {
  id: string;
  business_id: string;
  location_id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: InvitableRole;
  status: InvitationStatus;
  expires_at: string;
  invited_by_user_profile_id: string;
  accepted_by_user_profile_id: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  slug: string | null;
}

interface MembershipRow {
  id: string;
  business_id: string;
  location_id: string | null;
  user_profile_id: string;
  role: 'owner' | 'manager' | 'stylist' | 'client';
  status: MembershipStatus;
  invited_by_user_profile_id: string | null;
  activated_at: string | null;
  suspended_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface UserProfileRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
}

interface StaffProfileRow {
  id: string;
  business_id: string;
  user_profile_id: string;
  primary_location_id: string;
  display_name: string;
  employment_status: 'active' | 'on_leave' | 'notice' | 'terminated';
  is_bookable: boolean;
  color_hex: string | null;
  bio: string | null;
}

interface AcceptRpcRow {
  user_profile_id: string;
  business_id: string;
  location_id: string;
  membership_id: string;
  staff_profile_id: string | null;
}

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);
  private readonly admin: SupabaseClient;
  private readonly inviteBaseUrl: string;

  constructor(
    config: ConfigService,
    private readonly auth: AuthService,
    private readonly email: EmailService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    const explicit = config.get<string>('STAFF_INVITE_BASE_URL');
    this.inviteBaseUrl = (explicit ?? corsOrigins[0] ?? 'http://localhost:5173').replace(/\/$/, '');
  }

  // -------------------------------------------------------------------------
  // Owner-driven invitation lifecycle
  // -------------------------------------------------------------------------

  async createInvitation(
    actor: AuthUser,
    input: CreateStaffInvitationRequest,
  ): Promise<StaffInvitationWithToken> {
    this.assertOwner(actor);

    if (input.role !== 'manager' && input.role !== 'stylist') {
      throw new BadRequestException('Invitable roles are limited to manager and stylist');
    }
    await this.assertLocationInBusiness(actor.businessId, input.locationId);

    const email = input.email.trim().toLowerCase();
    if (!email) throw new BadRequestException('Email is required');

    await this.assertEmailNotMemberOfBusiness(actor.businessId, email);
    await this.assertNoPendingInvitation(actor.businessId, email);

    const { token, hash } = generateInviteToken();
    const expiresAt = new Date(
      Date.now() + (input.expiresInHours ?? DEFAULT_INVITE_EXPIRY_HOURS) * 3600 * 1000,
    ).toISOString();

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_invitations')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId,
        email,
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        phone: input.phone?.trim() || null,
        role: input.role,
        status: 'pending',
        invite_token_hash: hash,
        expires_at: expiresAt,
        invited_by_user_profile_id: actor.id,
        metadata: {
          ...(input.displayName ? { displayName: input.displayName.trim() } : {}),
          ...(input.colorHex ? { colorHex: input.colorHex } : {}),
          ...(input.bio ? { bio: input.bio.trim() } : {}),
        },
      })
      .select('*')
      .single<InvitationRow>();

    if (error || !data) {
      this.logger.error(`createInvitation insert failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create invitation');
    }

    const invitation = await this.hydrateInvitation(data);
    const inviteUrl = this.buildInviteUrl(token);
    await this.sendInvitationEmail(actor, invitation, inviteUrl);
    return { ...invitation, inviteToken: token, inviteUrl };
  }

  async listInvitations(
    actor: AuthUser,
    statusFilter?: InvitationStatus | 'all',
  ): Promise<StaffInvitation[]> {
    this.assertOwner(actor);
    let query = this.admin
      .schema('core')
      .from('staff_invitations')
      .select('*')
      .eq('business_id', actor.businessId)
      .order('created_at', { ascending: false });

    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    const { data, error } = await query.returns<InvitationRow[]>();
    if (error) {
      this.logger.error(`listInvitations failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to list invitations');
    }

    return this.hydrateInvitations(data ?? []);
  }

  async resendInvitation(actor: AuthUser, invitationId: string): Promise<StaffInvitationWithToken> {
    this.assertOwner(actor);
    const existing = await this.fetchInvitation(actor.businessId, invitationId);

    if (existing.status === 'accepted') {
      throw new ConflictException('Invitation has already been accepted');
    }

    const { token, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + DEFAULT_INVITE_EXPIRY_HOURS * 3600 * 1000).toISOString();

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_invitations')
      .update({
        status: 'pending',
        invite_token_hash: hash,
        expires_at: expiresAt,
        revoked_at: null,
        accepted_at: null,
        accepted_by_user_profile_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', invitationId)
      .eq('business_id', actor.businessId)
      .select('*')
      .single<InvitationRow>();

    if (error || !data) {
      this.logger.error(`resendInvitation failed: ${error?.message}`);
      throw new InternalServerErrorException('Unable to resend invitation');
    }

    const invitation = await this.hydrateInvitation(data);
    const inviteUrl = this.buildInviteUrl(token);
    await this.sendInvitationEmail(actor, invitation, inviteUrl);
    return { ...invitation, inviteToken: token, inviteUrl };
  }

  async revokeInvitation(actor: AuthUser, invitationId: string): Promise<StaffInvitation> {
    this.assertOwner(actor);
    const existing = await this.fetchInvitation(actor.businessId, invitationId);

    if (existing.status === 'accepted') {
      throw new ConflictException('Cannot revoke an invitation that has already been accepted');
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_invitations')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', invitationId)
      .eq('business_id', actor.businessId)
      .select('*')
      .single<InvitationRow>();

    if (error || !data) {
      this.logger.error(`revokeInvitation failed: ${error?.message}`);
      throw new InternalServerErrorException('Unable to revoke invitation');
    }

    return this.hydrateInvitation(data);
  }

  // -------------------------------------------------------------------------
  // Public invitation acceptance
  // -------------------------------------------------------------------------

  async inspectInvitationByToken(token: string): Promise<InvitationLookupResponse> {
    const invitation = await this.findInvitationByToken(token);

    let businessName = '';
    let locationName = '';

    const [{ data: business }, { data: location }] = await Promise.all([
      this.admin
        .schema('core')
        .from('businesses')
        .select('name')
        .eq('id', invitation.business_id)
        .maybeSingle<{ name: string }>(),
      this.admin
        .schema('core')
        .from('locations')
        .select('name')
        .eq('id', invitation.location_id)
        .maybeSingle<{ name: string }>(),
    ]);
    businessName = business?.name ?? '';
    locationName = location?.name ?? '';

    return {
      invitationId: invitation.id,
      businessName,
      locationName,
      role: invitation.role,
      email: invitation.email,
      firstName: invitation.first_name,
      lastName: invitation.last_name,
      expiresAt: invitation.expires_at,
      status: invitation.status,
    };
  }

  async acceptInvitation(input: AcceptStaffInvitationRequest): Promise<AcceptStaffInvitationResponse> {
    const invitation = await this.findInvitationByToken(input.token);

    if (invitation.status !== 'pending') {
      throw new ConflictException(`This invitation is ${invitation.status}`);
    }
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      await this.markInvitationExpired(invitation.id);
      throw new ConflictException('This invitation has expired');
    }

    const email = invitation.email.toLowerCase();
    const firstName = (input.firstName ?? invitation.first_name).trim();
    const lastName = (input.lastName ?? invitation.last_name).trim();
    const phone = (input.phone ?? invitation.phone ?? '').trim();

    let userId = await this.findAuthUserIdByEmail(email);
    let createdNewAuthUser = false;

    if (!userId) {
      const { data: createdUser, error: createError } = await this.admin.auth.admin.createUser({
        email,
        password: input.password,
        email_confirm: true,
        phone: phone || undefined,
        user_metadata: {
          full_name: `${firstName} ${lastName}`.trim(),
          first_name: firstName,
          last_name: lastName,
          invited_role: invitation.role,
        },
      });
      if (createError || !createdUser.user) {
        const message = createError?.message ?? 'Could not create account';
        if (/already|exists|registered/i.test(message)) {
          // Race: someone else just registered the email — refetch.
          userId = await this.findAuthUserIdByEmail(email);
          if (!userId) throw new ConflictException('An account already exists for this email');
        } else {
          throw new BadRequestException(message);
        }
      } else {
        userId = createdUser.user.id;
        createdNewAuthUser = true;
      }
    }

    if (!userId) {
      throw new InternalServerErrorException('Could not resolve auth user');
    }

    const displayName = (input.displayName ?? '').trim() || `${firstName} ${lastName}`.trim();

    try {
      const { data: rpcRows, error: rpcError } = await this.admin
        .schema('core')
        .rpc('accept_staff_invitation', {
          p_invitation_id: invitation.id,
          p_user_id: userId,
          p_email: email,
          p_first_name: firstName,
          p_last_name: lastName,
          p_phone: phone,
          p_display_name: displayName,
        });

      if (rpcError || !rpcRows) {
        throw this.translateAcceptError(rpcError?.message ?? 'Acceptance failed');
      }

      const row = pickAcceptRow(rpcRows);
      if (!row) throw new InternalServerErrorException('Invitation acceptance returned no rows');

      const role: UserRole = invitation.role;
      const targetSurface: AccountCreationTargetSurface = isWebSurfaceRole(role) ? 'web' : 'mobile';

      // Owner / manager continue into the dashboard; we still try to issue
      // a session so they don't have to type their password again. Stylist
      // and client have no business in the dashboard, so we deliberately
      // skip the auto sign-in (which would 403 anyway against the
      // `web_dashboard` surface) and send them straight to the completion
      // page that points them at the Sheer App.
      const session =
        targetSurface === 'web' ? await this.tryAutoSignIn(email, input.password) : undefined;

      const nextAction: AccountCreationNextAction =
        targetSurface === 'web' ? 'redirect_to_dashboard' : 'show_completion_page';

      const redirectTo =
        targetSurface === 'mobile'
          ? `/auth/account-created?role=${encodeURIComponent(role)}`
          : session
            ? '/dashboard'
            : '/login?invitation=accepted';

      return {
        userProfileId: row.user_profile_id,
        businessId: row.business_id,
        locationId: row.location_id,
        membershipId: row.membership_id,
        staffProfileId: row.staff_profile_id ?? undefined,
        nextStep: session ? 'dashboard' : 'sign_in',
        redirectTo,
        role,
        targetSurface,
        nextAction,
        session: session?.session,
        user: session?.user,
      };
    } catch (error) {
      // We only roll back the auth user if **we** created it for this
      // invitation; never delete a pre-existing user we merely linked to.
      if (createdNewAuthUser) {
        await this.admin.auth.admin.deleteUser(userId).catch(() => undefined);
      }
      throw this.toHttpError(error);
    }
  }

  // -------------------------------------------------------------------------
  // Owner-driven staff management
  // -------------------------------------------------------------------------

  async listStaff(actor: AuthUser): Promise<ListStaffResponse> {
    this.assertOwner(actor);

    const [{ data: memberships, error: membershipsError }, locations, pendingInvitations] = await Promise.all([
      this.admin
        .schema('core')
        .from('user_memberships')
        .select(
          'id,business_id,location_id,user_profile_id,role,status,invited_by_user_profile_id,activated_at,suspended_at,revoked_at,created_at',
        )
        .eq('business_id', actor.businessId)
        .in('role', ['owner', 'manager', 'stylist'])
        .returns<MembershipRow[]>(),
      this.fetchBusinessLocations(actor.businessId),
      this.listInvitations(actor, 'pending'),
    ]);

    if (membershipsError) {
      this.logger.error(`listStaff memberships failed: ${membershipsError.message}`);
      throw new InternalServerErrorException('Unable to load staff');
    }

    const userIds = Array.from(new Set((memberships ?? []).map((m) => m.user_profile_id)));
    const [profiles, staffProfiles] = await Promise.all([
      this.fetchUserProfiles(userIds),
      this.fetchStaffProfiles(actor.businessId, userIds),
    ]);

    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const staffProfileByUser = new Map(staffProfiles.map((s) => [s.user_profile_id, s]));
    const locationById = new Map(locations.map((l) => [l.id, l]));

    const staff: StaffMember[] = (memberships ?? [])
      .map((m) => this.toStaffMember(m, profileById, staffProfileByUser, locationById))
      .filter((s): s is StaffMember => Boolean(s))
      .sort((a, b) => roleOrder(a.role) - roleOrder(b.role));

    return { staff, pendingInvitations, locations };
  }

  async updateStaffMember(
    actor: AuthUser,
    targetUserId: string,
    input: UpdateStaffMemberRequest,
  ): Promise<UpdateStaffMemberResponse> {
    this.assertOwner(actor);
    if (targetUserId === actor.id) {
      throw new ForbiddenException('Owners cannot edit their own membership through this endpoint');
    }

    const target = await this.fetchTargetMembership(actor.businessId, targetUserId);
    if (target.role === 'owner') {
      throw new ForbiddenException('Owner accounts cannot be modified via the staff endpoint');
    }

    const newRole = input.role ?? (target.role as InvitableRole);
    if (newRole !== 'manager' && newRole !== 'stylist') {
      throw new BadRequestException('Role must be manager or stylist');
    }

    const newLocationId = input.locationId ?? target.location_id ?? undefined;
    if (!newLocationId) throw new BadRequestException('Location is required for staff');
    await this.assertLocationInBusiness(actor.businessId, newLocationId);

    const newStatus = input.membershipStatus ?? (target.status === 'invited' ? 'active' : target.status);
    if (newStatus !== 'active' && newStatus !== 'suspended' && newStatus !== 'revoked') {
      throw new BadRequestException('Invalid membership status');
    }

    const { data, error } = await this.admin.schema('core').rpc('update_staff_member', {
      p_actor_user_id: actor.id,
      p_business_id: actor.businessId,
      p_user_profile_id: targetUserId,
      p_new_role: newRole,
      p_new_location_id: newLocationId,
      p_new_status: newStatus,
      p_display_name: input.displayName ?? '',
      p_color_hex: input.colorHex ?? '',
      p_bio: input.bio ?? '',
      p_is_bookable: input.isBookable ?? null,
    });

    if (error) {
      this.logger.error(`update_staff_member RPC failed: ${error.message}`);
      throw this.translateUpdateError(error.message);
    }

    const updated = await this.findStaffMember(actor.businessId, targetUserId);
    if (!updated) throw new NotFoundException('Staff member not found after update');

    void data;
    return { staff: updated };
  }

  async deactivateStaff(actor: AuthUser, targetUserId: string): Promise<UpdateStaffMemberResponse> {
    return this.updateStaffMember(actor, targetUserId, { membershipStatus: 'suspended' });
  }

  async reactivateStaff(actor: AuthUser, targetUserId: string): Promise<UpdateStaffMemberResponse> {
    return this.updateStaffMember(actor, targetUserId, { membershipStatus: 'active' });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private assertOwner(actor: AuthUser): void {
    if (actor.role !== 'owner') {
      throw new ForbiddenException('Only owners can manage staff');
    }
  }

  private async assertLocationInBusiness(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertLocationInBusiness failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate location');
    }
    if (!data) {
      throw new ForbiddenException('Location does not belong to this business');
    }
  }

  private async assertEmailNotMemberOfBusiness(businessId: string, email: string): Promise<void> {
    const { data: profile, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertEmailNotMember query failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify email');
    }
    if (!profile) return;

    const { data: existing, error: membershipError } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('id,role,status')
      .eq('business_id', businessId)
      .eq('user_profile_id', profile.id)
      .in('status', ['active', 'invited', 'suspended']);
    if (membershipError) {
      this.logger.error(`assertEmailNotMember membership lookup failed: ${membershipError.message}`);
      throw new InternalServerErrorException('Unable to verify membership');
    }
    if ((existing ?? []).length > 0) {
      throw new ConflictException('This email already belongs to a member of your business');
    }
  }

  private async assertNoPendingInvitation(businessId: string, email: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_invitations')
      .select('id')
      .eq('business_id', businessId)
      .eq('email', email)
      .eq('status', 'pending')
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertNoPendingInvitation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify pending invitations');
    }
    if (data) {
      throw new ConflictException(
        'There is already a pending invitation for this email. Resend or revoke it first.',
      );
    }
  }

  private async fetchInvitation(businessId: string, invitationId: string): Promise<InvitationRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_invitations')
      .select('*')
      .eq('id', invitationId)
      .eq('business_id', businessId)
      .maybeSingle<InvitationRow>();
    if (error) {
      this.logger.error(`fetchInvitation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load invitation');
    }
    if (!data) throw new NotFoundException('Invitation not found');
    return data;
  }

  private async findInvitationByToken(token: string): Promise<InvitationRow> {
    const hash = hashInviteToken(token);
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_invitations')
      .select('*')
      .eq('invite_token_hash', hash)
      .maybeSingle<InvitationRow>();
    if (error) {
      this.logger.error(`findInvitationByToken failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to look up invitation');
    }
    if (!data) throw new NotFoundException('Invitation not found');
    return data;
  }

  private async markInvitationExpired(id: string): Promise<void> {
    await this.admin
      .schema('core')
      .from('staff_invitations')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', id);
  }

  private async fetchBusinessLocations(businessId: string): Promise<BusinessLocationSummary[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,code,slug')
      .eq('business_id', businessId)
      .order('sort_order', { ascending: true })
      .returns<LocationRow[]>();
    if (error) {
      this.logger.error(`fetchBusinessLocations failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load business locations');
    }
    return (data ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      code: l.code ?? undefined,
      slug: l.slug ?? undefined,
    }));
  }

  private async fetchUserProfiles(ids: string[]): Promise<UserProfileRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,full_name,phone,avatar_url')
      .in('id', ids)
      .returns<UserProfileRow[]>();
    if (error) {
      this.logger.error(`fetchUserProfiles failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load user profiles');
    }
    return data ?? [];
  }

  private async fetchStaffProfiles(businessId: string, ids: string[]): Promise<StaffProfileRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(
        'id,business_id,user_profile_id,primary_location_id,display_name,employment_status,is_bookable,color_hex,bio',
      )
      .eq('business_id', businessId)
      .in('user_profile_id', ids)
      .returns<StaffProfileRow[]>();
    if (error) {
      this.logger.error(`fetchStaffProfiles failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load staff profiles');
    }
    return data ?? [];
  }

  private async fetchTargetMembership(
    businessId: string,
    userProfileId: string,
  ): Promise<MembershipRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select(
        'id,business_id,location_id,user_profile_id,role,status,invited_by_user_profile_id,activated_at,suspended_at,revoked_at,created_at',
      )
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .order('role', { ascending: true })
      .returns<MembershipRow[]>();
    if (error) {
      this.logger.error(`fetchTargetMembership failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load target membership');
    }
    if (!data || data.length === 0) {
      throw new NotFoundException('Staff member not found');
    }
    return data.sort((a, b) => roleOrder(a.role) - roleOrder(b.role))[0];
  }

  private async findStaffMember(businessId: string, userProfileId: string): Promise<StaffMember | null> {
    const membership = await this.fetchTargetMembership(businessId, userProfileId);
    const [profiles, staffProfiles, locations] = await Promise.all([
      this.fetchUserProfiles([userProfileId]),
      this.fetchStaffProfiles(businessId, [userProfileId]),
      this.fetchBusinessLocations(businessId),
    ]);
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const staffProfileByUser = new Map(staffProfiles.map((s) => [s.user_profile_id, s]));
    const locationById = new Map(locations.map((l) => [l.id, l]));
    return this.toStaffMember(membership, profileById, staffProfileByUser, locationById);
  }

  private toStaffMember(
    membership: MembershipRow,
    profileById: Map<string, UserProfileRow>,
    staffProfileByUser: Map<string, StaffProfileRow>,
    locationById: Map<string, BusinessLocationSummary>,
  ): StaffMember | null {
    const profile = profileById.get(membership.user_profile_id);
    if (!profile) return null;
    const staffProfile = staffProfileByUser.get(membership.user_profile_id);
    const location = membership.location_id ? locationById.get(membership.location_id) : undefined;
    return {
      userProfileId: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone ?? undefined,
      avatarUrl: profile.avatar_url ?? undefined,
      role: membership.role,
      membershipId: membership.id,
      membershipStatus: membership.status,
      location,
      staffProfile: staffProfile
        ? {
            id: staffProfile.id,
            displayName: staffProfile.display_name,
            employmentStatus: staffProfile.employment_status,
            isBookable: staffProfile.is_bookable,
            colorHex: staffProfile.color_hex ?? undefined,
            bio: staffProfile.bio ?? undefined,
          }
        : undefined,
      invitedAt: membership.invited_by_user_profile_id ? membership.created_at : undefined,
      activatedAt: membership.activated_at ?? undefined,
      suspendedAt: membership.suspended_at ?? undefined,
      revokedAt: membership.revoked_at ?? undefined,
    };
  }

  private async hydrateInvitations(rows: InvitationRow[]): Promise<StaffInvitation[]> {
    if (rows.length === 0) return [];
    const businessId = rows[0].business_id;
    const locationIds = Array.from(new Set(rows.map((r) => r.location_id)));
    const inviterIds = Array.from(new Set(rows.map((r) => r.invited_by_user_profile_id)));

    const [{ data: locations }, { data: inviters }] = await Promise.all([
      this.admin
        .schema('core')
        .from('locations')
        .select('id,name,code,slug')
        .eq('business_id', businessId)
        .in('id', locationIds)
        .returns<LocationRow[]>(),
      this.admin
        .schema('core')
        .from('user_profiles')
        .select('id,full_name,email')
        .in('id', inviterIds)
        .returns<{ id: string; full_name: string; email: string }[]>(),
    ]);

    const locationsById = new Map((locations ?? []).map((l) => [l.id, l]));
    const invitersById = new Map((inviters ?? []).map((i) => [i.id, i]));

    return rows.map((row) => this.shapeInvitation(row, locationsById, invitersById));
  }

  private async hydrateInvitation(row: InvitationRow): Promise<StaffInvitation> {
    const [list] = await this.hydrateInvitations([row]);
    return list;
  }

  private shapeInvitation(
    row: InvitationRow,
    locationsById: Map<string, LocationRow>,
    invitersById: Map<string, { id: string; full_name: string; email: string }>,
  ): StaffInvitation {
    const location = locationsById.get(row.location_id);
    const inviter = invitersById.get(row.invited_by_user_profile_id);
    return {
      id: row.id,
      businessId: row.business_id,
      locationId: row.location_id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone ?? undefined,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      invitedByUserProfileId: row.invited_by_user_profile_id,
      acceptedByUserProfileId: row.accepted_by_user_profile_id ?? undefined,
      acceptedAt: row.accepted_at ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
      location: location
        ? { id: location.id, name: location.name, code: location.code ?? undefined, slug: location.slug ?? undefined }
        : undefined,
      invitedBy: inviter
        ? { id: inviter.id, fullName: inviter.full_name, email: inviter.email }
        : undefined,
    };
  }

  private async findAuthUserIdByEmail(email: string): Promise<string | undefined> {
    const lower = email.toLowerCase();
    let page = 1;
    const perPage = 200;
    for (;;) {
      const { data, error } = await this.admin.auth.admin.listUsers({ page, perPage });
      if (error) {
        this.logger.error(`auth.admin.listUsers failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to look up existing user');
      }
      const found = data.users.find((u) => u.email?.toLowerCase() === lower);
      if (found) return found.id;
      if (data.users.length < perPage) return undefined;
      page += 1;
      if (page > 50) return undefined;
    }
  }

  private async tryAutoSignIn(email: string, password: string) {
    try {
      const result = await this.auth.login(email, password, 'web_dashboard');
      return { session: result.session, user: result.user };
    } catch (error) {
      this.logger.warn(
        `Invitation auto sign-in failed for ${email}: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  private buildInviteUrl(token: string): string {
    return `${this.inviteBaseUrl}/staff/accept-invite?token=${encodeURIComponent(token)}`;
  }

  /**
   * Sends the invitation email via Resend. Failures are logged but never thrown:
   * the invitation row already exists, the API still returns the inviteUrl, and
   * the owner can copy/resend it from /team if delivery fell through.
   */
  private async sendInvitationEmail(
    actor: AuthUser,
    invitation: StaffInvitation,
    inviteUrl: string,
  ): Promise<void> {
    const rendered = renderStaffInvitationEmail({
      recipientFirstName: invitation.firstName,
      inviterName: actor.profile.fullName,
      inviterEmail: actor.profile.email,
      businessName: actor.businessName,
      locationName: invitation.location?.name,
      role: invitation.role,
      inviteUrl,
      expiresAt: invitation.expiresAt,
    });

    const result = await this.email.send({
      to: invitation.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: actor.profile.email,
      tags: [
        { name: 'category', value: 'staff_invitation' },
        { name: 'business_id', value: actor.businessId },
        { name: 'invitation_id', value: invitation.id },
      ],
    });

    if (result.delivered) {
      this.logger.log(
        `Invitation email delivered to ${invitation.email} (resend_id=${result.id ?? 'n/a'}, invitation=${invitation.id})`,
      );
    } else if (result.skipped) {
      this.logger.warn(
        `Invitation email skipped for ${invitation.email} — RESEND_API_KEY not configured (invitation=${invitation.id}). Owner can copy the inviteUrl manually.`,
      );
    } else {
      this.logger.warn(
        `Invitation email failed for ${invitation.email}: ${result.error ?? 'unknown'} (invitation=${invitation.id}). Owner can resend from /team.`,
      );
    }
  }

  private translateAcceptError(message: string): Error {
    const normalized = message.toLowerCase();
    if (normalized.includes('invitation_not_found')) return new NotFoundException('Invitation not found');
    if (normalized.includes('invitation_expired')) return new ConflictException('Invitation has expired');
    if (normalized.includes('invitation_status_')) {
      return new ConflictException('Invitation can no longer be accepted');
    }
    this.logger.error(`accept_staff_invitation RPC failed: ${message}`);
    return new InternalServerErrorException('Unable to accept invitation');
  }

  private translateUpdateError(message: string): Error {
    const normalized = message.toLowerCase();
    if (normalized.includes('actor_not_owner')) return new ForbiddenException('Only owners can update staff');
    if (normalized.includes('cannot_modify_owner'))
      return new ForbiddenException('Owner accounts cannot be modified via this endpoint');
    if (normalized.includes('target_membership_not_found'))
      return new NotFoundException('Staff member not found');
    if (normalized.includes('invalid_role_target'))
      return new BadRequestException('Role must be manager or stylist');
    if (normalized.includes('invalid_status_target'))
      return new BadRequestException('Invalid membership status');
    if (normalized.includes('location_required'))
      return new BadRequestException('Location is required');
    if (normalized.includes('location_outside_business'))
      return new ForbiddenException('Location does not belong to this business');
    return new InternalServerErrorException('Unable to update staff member');
  }

  private toHttpError(error: unknown): Error {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      error instanceof InternalServerErrorException ||
      error instanceof NotFoundException
    ) {
      return error;
    }
    this.logger.error(`Unhandled staff error: ${(error as Error).message ?? error}`);
    return new InternalServerErrorException('Staff operation failed unexpectedly');
  }
}

function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  const hash = hashInviteToken(token);
  return { token, hash };
}

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function pickAcceptRow(value: unknown): AcceptRpcRow | undefined {
  if (Array.isArray(value)) return value[0] as AcceptRpcRow | undefined;
  if (value && typeof value === 'object') return value as AcceptRpcRow;
  return undefined;
}

/**
 * Roles whose primary product surface is the web dashboard. Stylists and
 * clients are allowed to *claim* their account on the web (invitation /
 * password setup), but the day-to-day product for them lives in the
 * Sheer App, so they should never be auto-logged into the dashboard.
 */
function isWebSurfaceRole(role: UserRole): boolean {
  return role === 'owner' || role === 'manager';
}

function roleOrder(role: 'owner' | 'manager' | 'stylist' | 'client'): number {
  switch (role) {
    case 'owner':
      return 0;
    case 'manager':
      return 1;
    case 'stylist':
      return 2;
    case 'client':
      return 3;
    default:
      return 99;
  }
}
