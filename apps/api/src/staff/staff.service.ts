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
  StaffPhotoUploadResponse,
  UpdateStaffMemberRequest,
  UpdateStaffMemberResponse,
  UserRole,
} from '@sheer/domain';
import {
  BUSINESS_TIER_LABELS,
  getBusinessTierLimits,
  suggestTierUpgrade,
  userHasPermission,
} from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { renderStaffInvitationEmail } from '../email/templates/staff-invitation.template';

const DEFAULT_INVITE_EXPIRY_HOURS = 14 * 24;

/** Provider photo storage (Wrike #4507280825 — drag & drop upload). */
const PROVIDER_PHOTO_BUCKET = 'provider-photos';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Minimal shape of a Multer-parsed upload; avoids depending on Express type augmentation. */
export interface UploadedPhotoFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

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
  security_level_id: string | null;
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
  hourly_rate: number | string;
  contracted_hours: number | string;
  average_bill_benchmark: number | string;
  sheer_lab_pin_enabled: boolean;
  leave_notes: string | null;
  is_bookable: boolean;
  color_hex: string | null;
  bio: string | null;
  employment_type: 'employed' | 'self_employed' | 'hybrid';
  commission_structure: 'tiered' | 'flat' | 'none';
  commission_flat_rate_percent: number | string;
  service_revenue_target_amount: number | string | null;
  service_revenue_target_mode: 'flat' | 'pro_rated';
  holiday_entitlement_days: number | string;
  colour_allowance_amount: number | string;
  photo_url: string | null;
  q_code: string;
  hire_date: string | null;
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
    private readonly audit: AuditService,
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
    this.assertStaffManage(actor);

    if (input.role !== 'manager' && input.role !== 'stylist') {
      throw new BadRequestException('Invitable roles are limited to manager and stylist');
    }
    await this.assertBookableColumnTierLimit(actor, input.role === 'stylist');
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
    this.assertStaffManage(actor);
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
    this.assertStaffManage(actor);
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
    this.assertStaffManage(actor);
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
    if (!userHasPermission(actor, 'staff.view')) {
      throw new ForbiddenException('You do not have permission to view staff');
    }

    const [{ data: memberships, error: membershipsError }, locations, pendingInvitations] = await Promise.all([
      this.admin
        .schema('core')
        .from('user_memberships')
        .select(
          'id,business_id,location_id,user_profile_id,role,status,invited_by_user_profile_id,activated_at,suspended_at,revoked_at,created_at,security_level_id',
        )
        .eq('business_id', actor.businessId)
        .in('role', ['owner', 'manager', 'stylist'])
        .returns<MembershipRow[]>(),
      this.fetchBusinessLocations(actor.businessId),
      userHasPermission(actor, 'staff.manage')
        ? this.listInvitations(actor, 'pending')
        : Promise.resolve([]),
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
    const eligibilityByStaffProfile = await this.fetchServiceEligibilityByStaffProfile(
      actor.businessId,
      staffProfiles.map((s) => s.id),
    );

    // Group every membership by user so a member who holds several roles
    // (e.g. manager + stylist at one location) appears as ONE row with roles[].
    const membershipsByUser = new Map<string, MembershipRow[]>();
    for (const m of memberships ?? []) {
      const list = membershipsByUser.get(m.user_profile_id) ?? [];
      list.push(m);
      membershipsByUser.set(m.user_profile_id, list);
    }

    const securityLevelNameById = await this.fetchSecurityLevelNames(actor.businessId);

    const staff: StaffMember[] = Array.from(membershipsByUser.values())
      .map((group) =>
        this.toStaffMember(
          group,
          profileById,
          staffProfileByUser,
          locationById,
          eligibilityByStaffProfile,
          securityLevelNameById,
          userHasPermission(actor, 'staff.pay.manage'),
        ),
      )
      .filter((s): s is StaffMember => Boolean(s))
      .sort((a, b) => roleOrder(a.roles[0]) - roleOrder(b.roles[0]));

    return { staff, pendingInvitations, locations };
  }

  async updateStaffMember(
    actor: AuthUser,
    targetUserId: string,
    input: UpdateStaffMemberRequest,
  ): Promise<UpdateStaffMemberResponse> {
    this.assertStaffManage(actor);
    this.assertSensitiveStaffFields(actor, input);
    const isSelf = targetUserId === actor.id;

    const memberships = await this.fetchUserMemberships(actor.businessId, targetUserId);
    if (memberships.length === 0) {
      throw new NotFoundException('Staff member not found');
    }
    // An owner may edit their OWN account — to add or drop the stylist role at a
    // location they work from — but never another owner's account. The owner
    // membership itself is always preserved (see syncMembershipRoles).
    const targetIsOwner = memberships.some((m) => m.role === 'owner');
    if (targetIsOwner && !isSelf) {
      throw new ForbiddenException('Owner accounts cannot be modified via the staff endpoint');
    }

    // Desired role SET at the member's (single) location. A member can hold both
    // manager and stylist. When `roles` is omitted, keep the current roles (e.g.
    // deactivate/reactivate only touch status). An explicitly empty set means "no
    // staff roles" — valid only for an owner reverting to owner-only.
    const currentRoles = memberships
      .map((m) => m.role)
      .filter((r): r is InvitableRole => r === 'manager' || r === 'stylist');
    const desiredRoles = Array.from(new Set(input.roles ?? currentRoles));
    for (const role of desiredRoles) {
      if (role !== 'manager' && role !== 'stylist') {
        throw new BadRequestException('Roles must be manager or stylist');
      }
    }
    if (desiredRoles.length === 0 && !targetIsOwner) {
      throw new BadRequestException('Select at least one role');
    }

    // Resolve which location(s) each desired role attaches to. Stylists are
    // single-location; managers may span several salons ("area manager"). We
    // then reconcile membership rows to exactly these (role, location) pairs.
    // An owner dropping to owner-only keeps no staff rows (their owner row is
    // business-wide, location_id NULL).
    const existingStylistLocation =
      memberships.find((m) => m.role === 'stylist' && m.location_id)?.location_id ?? undefined;
    const existingManagerLocations = memberships
      .filter((m) => m.role === 'manager' && m.location_id)
      .map((m) => m.location_id as string);
    const existingAnyLocation = memberships.find((m) => m.location_id)?.location_id ?? undefined;

    const stylistLocationId = desiredRoles.includes('stylist')
      ? input.locationId ?? existingStylistLocation ?? existingAnyLocation
      : undefined;
    if (desiredRoles.includes('stylist') && !stylistLocationId) {
      throw new BadRequestException('A location is required for a stylist');
    }

    let managerLocationIds: string[] = [];
    if (desiredRoles.includes('manager')) {
      const requested =
        input.managerLocationIds ??
        (input.locationId ? [input.locationId] : undefined) ??
        (existingManagerLocations.length > 0 ? existingManagerLocations : undefined) ??
        (existingAnyLocation ? [existingAnyLocation] : []);
      managerLocationIds = Array.from(new Set(requested));
      if (managerLocationIds.length === 0) {
        throw new BadRequestException('Select at least one location for a manager');
      }
    }

    // Validate every referenced location belongs to the business.
    const referencedLocationIds = Array.from(
      new Set([...(stylistLocationId ? [stylistLocationId] : []), ...managerLocationIds]),
    );
    for (const locationId of referencedLocationIds) {
      await this.assertLocationInBusiness(actor.businessId, locationId);
    }

    // The desired (role, location) membership pairs. A manager over 3 salons
    // yields 3 manager rows; a stylist yields exactly one.
    const desiredPairs: { role: InvitableRole; locationId: string }[] = [];
    if (stylistLocationId) desiredPairs.push({ role: 'stylist', locationId: stylistLocationId });
    for (const locationId of managerLocationIds) desiredPairs.push({ role: 'manager', locationId });

    // An owner can never suspend/revoke themselves through this endpoint; their
    // own edits always run as 'active'. For others, default to current status.
    const currentStatus = memberships[0].status;
    const newStatus = isSelf
      ? 'active'
      : input.membershipStatus ?? (currentStatus === 'invited' ? 'active' : currentStatus);
    if (newStatus !== 'active' && newStatus !== 'suspended' && newStatus !== 'revoked') {
      throw new BadRequestException('Invalid membership status');
    }

    // The stylist location drives the (single) staff profile; manager-only
    // members reuse their first location purely for internal bookkeeping.
    const profileLocationId = stylistLocationId ?? managerLocationIds[0] ?? existingAnyLocation ?? '';
    await this.syncMembershipRoles(actor, targetUserId, memberships, desiredPairs, newStatus);
    await this.syncStaffProfile(
      actor.businessId,
      targetUserId,
      profileLocationId,
      desiredRoles,
      newStatus,
      input,
    );

    await this.updateStaffBusinessFields(actor.businessId, targetUserId, input);

    if (input.securityLevelId !== undefined) {
      await this.applySecurityLevel(actor, targetUserId, input.securityLevelId);
    }

    // Replace the stylist's service eligibility (and per-stylist prices) when an
    // explicit set was sent. `serviceAssignments` carries prices; `serviceIds`
    // is the legacy id-only alias (all prices inherit the service base price).
    if (input.serviceAssignments !== undefined) {
      await this.setStaffServiceEligibility(actor.businessId, targetUserId, input.serviceAssignments);
    } else if (input.serviceIds !== undefined) {
      await this.setStaffServiceEligibility(
        actor.businessId,
        targetUserId,
        input.serviceIds.map((serviceId) => ({ serviceId, priceAmount: null })),
      );
    }

    const updated = await this.findStaffMember(actor, targetUserId);
    if (!updated) throw new NotFoundException('Staff member not found after update');

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

  private async updateStaffBusinessFields(
    businessId: string,
    userProfileId: string,
    input: UpdateStaffMemberRequest,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.hourlyRate !== undefined) patch.hourly_rate = input.hourlyRate;
    if (input.contractedHours !== undefined) patch.contracted_hours = input.contractedHours;
    if (input.averageBillBenchmark !== undefined) patch.average_bill_benchmark = input.averageBillBenchmark;
    if (input.leaveNotes !== undefined) patch.leave_notes = input.leaveNotes?.trim() || null;
    if (input.employmentType !== undefined) patch.employment_type = input.employmentType;
    // Applied after syncStaffProfile so an explicit status overrides the value
    // derived from membership status (keeps notice/terminated owner-controlled).
    if (input.employmentStatus !== undefined) patch.employment_status = input.employmentStatus;
    if (input.commissionStructure !== undefined) patch.commission_structure = input.commissionStructure;
    if (input.commissionFlatRatePercent !== undefined)
      patch.commission_flat_rate_percent = input.commissionFlatRatePercent;
    if (input.serviceRevenueTargetAmount !== undefined)
      patch.service_revenue_target_amount = input.serviceRevenueTargetAmount;
    if (input.serviceRevenueTargetMode !== undefined)
      patch.service_revenue_target_mode = input.serviceRevenueTargetMode;
    if (input.holidayEntitlementDays !== undefined)
      patch.holiday_entitlement_days = input.holidayEntitlementDays;
    if (input.colourAllowanceAmount !== undefined)
      patch.colour_allowance_amount = input.colourAllowanceAmount;
    if (input.photoUrl !== undefined) patch.photo_url = input.photoUrl?.trim() || null;
    if (input.startDate !== undefined) patch.hire_date = input.startDate || null;
    if (Object.keys(patch).length === 0) return;

    const { error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId);

    if (error) {
      this.logger.error(`updateStaffBusinessFields failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update staff business fields');
    }
  }

  /**
   * Replaces a stylist's service eligibility (booking.staff_service_eligibility)
   * with exactly `serviceIds`. Eligibility only applies to staff who have a
   * staff profile (stylists). The delete + insert run inside a single Postgres
   * function so the replacement is atomic — no partial state if anything fails.
   */
  private async setStaffServiceEligibility(
    businessId: string,
    userProfileId: string,
    assignments: { serviceId: string; priceAmount?: number | null }[],
  ): Promise<void> {
    const [profile] = await this.fetchStaffProfiles(businessId, [userProfileId]);
    const staffProfileId = profile?.id;
    if (!staffProfileId) {
      if (assignments.length === 0) return;
      throw new BadRequestException('This team member cannot be assigned services');
    }

    // Collapse to one assignment per service (last write wins), dropping blanks.
    const byServiceId = new Map<string, number | null>();
    for (const { serviceId, priceAmount } of assignments) {
      if (!serviceId) continue;
      byServiceId.set(serviceId, priceAmount ?? null);
    }
    const desiredIds = Array.from(byServiceId.keys());

    // Validate every service belongs to this business before we touch anything.
    if (desiredIds.length > 0) {
      const { data: validRows, error: validError } = await this.admin
        .schema('booking')
        .from('services')
        .select('id')
        .eq('business_id', businessId)
        .in('id', desiredIds)
        .returns<{ id: string }[]>();
      if (validError) {
        this.logger.error(`setStaffServiceEligibility validate failed: ${validError.message}`);
        throw new InternalServerErrorException('Unable to validate services');
      }
      const validIds = new Set((validRows ?? []).map((row) => row.id));
      if (desiredIds.some((id) => !validIds.has(id))) {
        throw new BadRequestException('One or more services are not valid for this business');
      }
    }

    const payload = desiredIds.map((serviceId) => ({
      service_id: serviceId,
      price_amount: byServiceId.get(serviceId) ?? null,
    }));

    const { error } = await this.admin.schema('booking').rpc('set_staff_service_eligibility', {
      p_business_id: businessId,
      p_staff_profile_id: staffProfileId,
      p_assignments: payload,
    });
    if (error) {
      this.logger.error(`set_staff_service_eligibility RPC failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update service eligibility');
    }
  }

  /**
   * Maps each given staff_profile_id to the IDs of services it can perform.
   * Junction lives in the booking schema while staff live in core, so this is a
   * separate query (PostgREST cannot embed across schemas).
   */
  private async fetchServiceEligibilityByStaffProfile(
    businessId: string,
    staffProfileIds: string[],
  ): Promise<Map<string, { serviceId: string; priceAmount: number | null }[]>> {
    const ids = Array.from(new Set(staffProfileIds.filter(Boolean)));
    if (ids.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('booking')
      .from('staff_service_eligibility')
      .select('service_id,staff_profile_id,price_amount')
      .eq('business_id', businessId)
      .in('staff_profile_id', ids)
      .returns<{ service_id: string; staff_profile_id: string; price_amount: number | string | null }[]>();
    if (error) {
      this.logger.error(`fetchServiceEligibilityByStaffProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service eligibility');
    }
    const byStaff = new Map<string, { serviceId: string; priceAmount: number | null }[]>();
    for (const row of data ?? []) {
      const list = byStaff.get(row.staff_profile_id) ?? [];
      list.push({
        serviceId: row.service_id,
        priceAmount: row.price_amount === null ? null : Number(row.price_amount),
      });
      byStaff.set(row.staff_profile_id, list);
    }
    return byStaff;
  }

  /**
   * Upload a provider photo (JPEG/PNG/WebP, ≤5 MB) to the `provider-photos` bucket
   * and return its public URL. The URL is persisted on the profile by the caller's
   * subsequent update (photoUrl), so cancelling the edit never mutates the record.
   */
  async uploadStaffPhoto(
    actor: AuthUser,
    targetUserId: string,
    file: UploadedPhotoFile | undefined,
  ): Promise<StaffPhotoUploadResponse> {
    this.assertStaffManage(actor);
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('No file uploaded');
    }
    const contentType = (file.mimetype || '').toLowerCase();
    const ext = PHOTO_EXT_BY_MIME[contentType];
    if (!ext) {
      throw new BadRequestException('Photo must be a JPEG, PNG or WebP image');
    }
    if (file.size > MAX_PHOTO_BYTES || file.buffer.length > MAX_PHOTO_BYTES) {
      throw new BadRequestException('Photo must be 5 MB or smaller');
    }

    // Confirm the target user belongs to this business before uploading. We check
    // business membership rather than an existing staff_profile row: the photo can
    // be uploaded while a stylist role is still being created (e.g. an owner taking
    // the stylist role, or a member being made bookable), where the profile row is
    // only written on the subsequent save. The returned URL is persisted as
    // photoUrl by that save, so an unsaved upload never orphans a profile.
    const { count, error: membershipError } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', actor.businessId)
      .eq('user_profile_id', targetUserId);
    if (membershipError) {
      this.logger.error(`load membership for photo failed: ${membershipError.message}`);
      throw new InternalServerErrorException('Unable to verify staff member');
    }
    if (!count) {
      throw new NotFoundException('Staff member not found');
    }

    const path = `${actor.businessId}/${targetUserId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await this.admin.storage
      .from(PROVIDER_PHOTO_BUCKET)
      .upload(path, file.buffer, { contentType, upsert: true });
    if (uploadError) {
      this.logger.error(`provider photo upload failed: ${uploadError.message}`);
      throw new InternalServerErrorException('Unable to upload photo');
    }

    const { data: publicUrl } = this.admin.storage.from(PROVIDER_PHOTO_BUCKET).getPublicUrl(path);
    return { photoUrl: publicUrl.publicUrl };
  }

  private assertStaffManage(actor: AuthUser): void {
    if (!userHasPermission(actor, 'staff.manage')) {
      throw new ForbiddenException('You do not have permission to manage staff');
    }
  }

  private assertSensitiveStaffFields(actor: AuthUser, input: UpdateStaffMemberRequest): void {
    const changesPay =
      input.hourlyRate !== undefined ||
      input.commissionStructure !== undefined ||
      input.commissionFlatRatePercent !== undefined ||
      input.serviceRevenueTargetAmount !== undefined ||
      input.serviceRevenueTargetMode !== undefined ||
      input.colourAllowanceAmount !== undefined;
    if (changesPay && !userHasPermission(actor, 'staff.pay.manage')) {
      throw new ForbiddenException('You do not have permission to manage staff pay');
    }
    if (input.securityLevelId !== undefined && !userHasPermission(actor, 'security.manage')) {
      throw new ForbiddenException('You do not have permission to assign security levels');
    }
  }

  /**
   * Block adding another *bookable column* (bookable service provider) when the
   * tier hard-caps them. Only Spark is hard-capped (1 column); on Pulse/Infinity
   * extra columns are permitted and billed separately, so this is a no-op there.
   * Non-bookable invites (managers/reception) never count and are always allowed.
   * Bookable columns = active bookable staff profiles + pending stylist invites.
   */
  private async assertBookableColumnTierLimit(
    actor: AuthUser,
    willBeBookable: boolean,
  ): Promise<void> {
    if (!willBeBookable) return;

    const tier = actor.businessTier ?? 'spark';
    const limits = getBusinessTierLimits(tier);
    if (!limits.bookableColumnsHardCapped || limits.includedBookableColumnsPerLocation === null) {
      return;
    }
    const included = limits.includedBookableColumnsPerLocation;

    const [bookable, invitations] = await Promise.all([
      this.admin
        .schema('core')
        .from('staff_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', actor.businessId)
        .eq('is_bookable', true)
        .eq('employment_status', 'active'),
      this.admin
        .schema('core')
        .from('staff_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', actor.businessId)
        .eq('status', 'pending')
        .eq('role', 'stylist'),
    ]);

    if (bookable.error || invitations.error) {
      this.logger.error(
        `assertBookableColumnTierLimit count failed: ${bookable.error?.message ?? invitations.error?.message}`,
      );
      throw new InternalServerErrorException('Unable to verify bookable column limit');
    }

    const bookableColumns = (bookable.count ?? 0) + (invitations.count ?? 0);
    if (bookableColumns >= included) {
      const upgradeTo = suggestTierUpgrade(tier, 'columns');
      const suffix = upgradeTo
        ? ` Upgrade to ${BUSINESS_TIER_LABELS[upgradeTo]} to add more of your team.`
        : '';
      throw new ForbiddenException(
        `Your ${BUSINESS_TIER_LABELS[tier]} plan includes ${included} bookable column(s).${suffix}`,
      );
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
        'id,business_id,user_profile_id,primary_location_id,display_name,employment_status,hourly_rate,contracted_hours,average_bill_benchmark,sheer_lab_pin_enabled,leave_notes,is_bookable,color_hex,bio,employment_type,commission_structure,commission_flat_rate_percent,service_revenue_target_amount,service_revenue_target_mode,holiday_entitlement_days,colour_allowance_amount,photo_url,q_code,hire_date',
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

  private async fetchUserMemberships(
    businessId: string,
    userProfileId: string,
  ): Promise<MembershipRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select(
        'id,business_id,location_id,user_profile_id,role,status,invited_by_user_profile_id,activated_at,suspended_at,revoked_at,created_at,security_level_id',
      )
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .in('role', ['owner', 'manager', 'stylist'])
      .returns<MembershipRow[]>();
    if (error) {
      this.logger.error(`fetchUserMemberships failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load staff memberships');
    }
    return data ?? [];
  }

  /**
   * Sync a member's memberships to exactly the given (role, location) pairs,
   * applying `status`. Rows that already match a desired pair are updated in
   * place (history preserved); rows no longer wanted — a dropped role, or a
   * location the manager no longer oversees — are removed. A member can hold
   * the stylist role at one location and the manager role across several
   * ("area manager").
   */
  private async syncMembershipRoles(
    actor: AuthUser,
    targetUserId: string,
    existing: MembershipRow[],
    desiredPairs: { role: InvitableRole; locationId: string }[],
    status: 'active' | 'suspended' | 'revoked',
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const keyOf = (role: string, locationId: string | null): string => `${role}:${locationId ?? ''}`;
    const existingByKey = new Map(existing.map((m) => [keyOf(m.role, m.location_id), m]));
    const keptIds = new Set<string>();
    // Newly-added rows (e.g. an extra manager location) inherit the member's
    // current security level so permissions stay consistent even when this
    // request doesn't touch the level. applySecurityLevel may override later.
    const currentLevelId = existing.find((m) => m.security_level_id)?.security_level_id ?? null;

    for (const pair of desiredPairs) {
      const current = existingByKey.get(keyOf(pair.role, pair.locationId));
      if (current) {
        keptIds.add(current.id);
        const { error } = await this.admin
          .schema('core')
          .from('user_memberships')
          .update({
            location_id: pair.locationId,
            status,
            activated_at: status === 'active' ? current.activated_at ?? nowIso : current.activated_at,
            suspended_at: status === 'suspended' ? nowIso : null,
            revoked_at: status === 'revoked' ? nowIso : null,
            updated_at: nowIso,
          })
          .eq('id', current.id);
        if (error) {
          this.logger.error(`syncMembershipRoles update failed: ${error.message}`);
          throw new InternalServerErrorException('Unable to update staff roles');
        }
      } else {
        const { error } = await this.admin
          .schema('core')
          .from('user_memberships')
          .insert({
            business_id: actor.businessId,
            location_id: pair.locationId,
            user_profile_id: targetUserId,
            role: pair.role,
            status,
            security_level_id: currentLevelId,
            invited_by_user_profile_id: actor.id,
            activated_at: status === 'active' ? nowIso : null,
            suspended_at: status === 'suspended' ? nowIso : null,
            revoked_at: status === 'revoked' ? nowIso : null,
          });
        if (error) {
          this.logger.error(`syncMembershipRoles insert failed: ${error.message}`);
          throw new InternalServerErrorException('Unable to add staff role');
        }
      }
    }

    // NEVER remove the owner membership (see staleMembershipIds): deleting the
    // owner row — which is never in `desiredRoles` — would strip ownership
    // mid-request when an owner edits their own staff roles.
    const staleIds = staleMembershipIds(existing, keptIds);
    if (staleIds.length > 0) {
      const { error } = await this.admin
        .schema('core')
        .from('user_memberships')
        .delete()
        .in('id', staleIds);
      if (error) {
        this.logger.error(`syncMembershipRoles delete failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to remove staff roles');
      }
    }
  }

  /**
   * Keep the member's single staff profile in step with their role set. When
   * they hold the stylist role the profile is (created and) kept bookable; when
   * they are manager-only the profile is retained for history but made
   * non-bookable. Mirrors the previous `update_staff_member` RPC behaviour,
   * preserving fields the caller did not send.
   */
  private async syncStaffProfile(
    businessId: string,
    userProfileId: string,
    locationId: string,
    desiredRoles: InvitableRole[],
    status: 'active' | 'suspended' | 'revoked',
    input: UpdateStaffMemberRequest,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const employmentStatus = status === 'active' ? 'active' : 'on_leave';
    const [existing] = await this.fetchStaffProfiles(businessId, [userProfileId]);

    if (desiredRoles.includes('stylist')) {
      if (existing) {
        const patch: Record<string, unknown> = {
          primary_location_id: locationId,
          employment_status: employmentStatus,
          is_bookable: input.isBookable ?? existing.is_bookable,
          updated_at: nowIso,
        };
        if (input.displayName?.trim()) patch.display_name = input.displayName.trim();
        if (input.colorHex?.trim()) patch.color_hex = input.colorHex.trim();
        if (input.bio?.trim()) patch.bio = input.bio.trim();
        const { error } = await this.admin
          .schema('core')
          .from('staff_profiles')
          .update(patch)
          .eq('business_id', businessId)
          .eq('user_profile_id', userProfileId);
        if (error) {
          this.logger.error(`syncStaffProfile update failed: ${error.message}`);
          throw new InternalServerErrorException('Unable to update staff profile');
        }
      } else {
        const [profile] = await this.fetchUserProfiles([userProfileId]);
        const { error } = await this.admin
          .schema('core')
          .from('staff_profiles')
          .insert({
            business_id: businessId,
            user_profile_id: userProfileId,
            primary_location_id: locationId,
            display_name: input.displayName?.trim() || profile?.full_name || 'Stylist',
            employment_status: employmentStatus,
            color_hex: input.colorHex?.trim() || null,
            bio: input.bio?.trim() || null,
            is_bookable: input.isBookable ?? true,
          });
        if (error) {
          this.logger.error(`syncStaffProfile insert failed: ${error.message}`);
          throw new InternalServerErrorException('Unable to create staff profile');
        }
      }
    } else if (existing) {
      // Manager-only: keep the profile for history but make it non-bookable.
      const { error } = await this.admin
        .schema('core')
        .from('staff_profiles')
        .update({ is_bookable: false, employment_status: employmentStatus, updated_at: nowIso })
        .eq('business_id', businessId)
        .eq('user_profile_id', userProfileId);
      if (error) {
        this.logger.error(`syncStaffProfile downgrade failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to update staff profile');
      }
    }
  }

  private async findStaffMember(actor: AuthUser, userProfileId: string): Promise<StaffMember | null> {
    const businessId = actor.businessId;
    const memberships = await this.fetchUserMemberships(businessId, userProfileId);
    if (memberships.length === 0) return null;
    const [profiles, staffProfiles, locations] = await Promise.all([
      this.fetchUserProfiles([userProfileId]),
      this.fetchStaffProfiles(businessId, [userProfileId]),
      this.fetchBusinessLocations(businessId),
    ]);
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const staffProfileByUser = new Map(staffProfiles.map((s) => [s.user_profile_id, s]));
    const locationById = new Map(locations.map((l) => [l.id, l]));
    const eligibilityByStaffProfile = await this.fetchServiceEligibilityByStaffProfile(
      businessId,
      staffProfiles.map((s) => s.id),
    );
    const securityLevelNameById = await this.fetchSecurityLevelNames(businessId);
    return this.toStaffMember(
      memberships,
      profileById,
      staffProfileByUser,
      locationById,
      eligibilityByStaffProfile,
      securityLevelNameById,
      userHasPermission(actor, 'staff.pay.manage'),
    );
  }

  /**
   * Assign (or clear, when `securityLevelId` is null) the security level on a
   * member's location-scoped memberships. Owner memberships are never touched —
   * owners always resolve with every permission.
   */
  private async applySecurityLevel(
    actor: AuthUser,
    targetUserId: string,
    securityLevelId: string | null,
  ): Promise<void> {
    const businessId = actor.businessId;
    if (securityLevelId) {
      const { data, error } = await this.admin
        .schema('core')
        .from('security_levels')
        .select('id')
        .eq('id', securityLevelId)
        .eq('business_id', businessId)
        .maybeSingle<{ id: string }>();
      if (error) {
        this.logger.error(`applySecurityLevel lookup failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to assign security level');
      }
      if (!data) {
        throw new BadRequestException('Unknown security level');
      }
    }

    // Capture the prior assignment so the audit entry has a before/after delta.
    const { data: current } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('security_level_id')
      .eq('business_id', businessId)
      .eq('user_profile_id', targetUserId)
      .in('role', ['manager', 'stylist'])
      .limit(1)
      .maybeSingle<{ security_level_id: string | null }>();
    const previousLevelId = current?.security_level_id ?? null;

    const { error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .update({ security_level_id: securityLevelId })
      .eq('business_id', businessId)
      .eq('user_profile_id', targetUserId)
      .in('role', ['manager', 'stylist']);

    if (error) {
      this.logger.error(`applySecurityLevel update failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to assign security level');
    }

    if (previousLevelId !== securityLevelId) {
      await this.audit.record(actor, {
        action: 'membership.security_level.changed',
        entityType: 'membership',
        entityId: targetUserId,
        before: { securityLevelId: previousLevelId },
        after: { securityLevelId },
      });
    }
  }

  private async fetchSecurityLevelNames(businessId: string): Promise<Map<string, string>> {
    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .select('id,name')
      .eq('business_id', businessId)
      .returns<{ id: string; name: string }[]>();
    const map = new Map<string, string>();
    if (error || !data) return map;
    for (const row of data) map.set(row.id, row.name);
    return map;
  }

  private toStaffMember(
    memberships: MembershipRow[],
    profileById: Map<string, UserProfileRow>,
    staffProfileByUser: Map<string, StaffProfileRow>,
    locationById: Map<string, BusinessLocationSummary>,
    eligibilityByStaffProfile: Map<string, { serviceId: string; priceAmount: number | null }[]>,
    securityLevelNameById: Map<string, string> = new Map(),
    includePayFields = false,
  ): StaffMember | null {
    if (memberships.length === 0) return null;
    // Highest-privilege membership represents the member; roles[] holds the set.
    const ordered = [...memberships].sort((a, b) => roleOrder(a.role) - roleOrder(b.role));
    const membership = ordered[0];
    const profile = profileById.get(membership.user_profile_id);
    if (!profile) return null;
    const roles = Array.from(new Set(ordered.map((m) => m.role))) as UserRole[];
    const staffProfile = staffProfileByUser.get(membership.user_profile_id);
    const locationId = membership.location_id ?? ordered.find((m) => m.location_id)?.location_id ?? null;
    const location = locationId ? locationById.get(locationId) : undefined;
    const managerLocationIds = Array.from(
      new Set(
        ordered
          .filter((m) => m.role === 'manager' && m.location_id)
          .map((m) => m.location_id as string),
      ),
    );
    const stylistLocationId =
      ordered.find((m) => m.role === 'stylist' && m.location_id)?.location_id ?? null;
    const locations = Array.from(
      new Set(ordered.map((m) => m.location_id).filter((id): id is string => Boolean(id))),
    )
      .map((id) => locationById.get(id))
      .filter((l): l is BusinessLocationSummary => Boolean(l));
    const securityLevelId = ordered.find((m) => m.security_level_id)?.security_level_id ?? null;
    return {
      userProfileId: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone ?? undefined,
      avatarUrl: profile.avatar_url ?? undefined,
      roles,
      membershipId: membership.id,
      membershipStatus: aggregateMembershipStatus(ordered.map((m) => m.status)),
      location,
      locations,
      managerLocationIds,
      stylistLocationId,
      securityLevelId,
      securityLevelName: securityLevelId ? securityLevelNameById.get(securityLevelId) ?? null : null,
      staffProfile: staffProfile
        ? {
            id: staffProfile.id,
            displayName: staffProfile.display_name,
            employmentStatus: staffProfile.employment_status,
            isBookable: staffProfile.is_bookable,
            contractedHours: Number(staffProfile.contracted_hours),
            averageBillBenchmark: Number(staffProfile.average_bill_benchmark),
            sheerLabPinEnabled: staffProfile.sheer_lab_pin_enabled,
            leaveNotes: staffProfile.leave_notes ?? undefined,
            colorHex: staffProfile.color_hex ?? undefined,
            bio: staffProfile.bio ?? undefined,
            employmentType: staffProfile.employment_type,
            holidayEntitlementDays: Number(staffProfile.holiday_entitlement_days),
            photoUrl: staffProfile.photo_url ?? undefined,
            qCode: staffProfile.q_code,
            startDate: staffProfile.hire_date ?? undefined,
            serviceIds: (eligibilityByStaffProfile.get(staffProfile.id) ?? []).map((e) => e.serviceId),
            servicePricing: eligibilityByStaffProfile.get(staffProfile.id) ?? [],
            ...(includePayFields
              ? {
                  hourlyRate: Number(staffProfile.hourly_rate),
                  commissionStructure: staffProfile.commission_structure,
                  commissionFlatRatePercent: Number(staffProfile.commission_flat_rate_percent),
                  serviceRevenueTargetAmount:
                    staffProfile.service_revenue_target_amount === null
                      ? null
                      : Number(staffProfile.service_revenue_target_amount),
                  serviceRevenueTargetMode: staffProfile.service_revenue_target_mode,
                  colourAllowanceAmount: Number(staffProfile.colour_allowance_amount),
                }
              : {}),
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

/**
 * Membership rows to delete when syncing a member's manager/stylist role SET.
 * The owner membership is ALWAYS preserved: it is never part of the desired
 * (manager/stylist) roles, so without this guard an owner editing their own
 * staff roles would have their ownership row deleted mid-request.
 */
export function staleMembershipIds(
  existing: ReadonlyArray<{ id: string; role: 'owner' | 'manager' | 'stylist' | 'client' }>,
  keptIds: ReadonlySet<string>,
): string[] {
  return existing
    .filter((m) => m.role !== 'owner' && !keptIds.has(m.id))
    .map((m) => m.id);
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

// A member's overall status across their role memberships (which are managed
// together). Prefers the "most active" status if they ever diverge.
function aggregateMembershipStatus(statuses: MembershipStatus[]): MembershipStatus {
  if (statuses.includes('active')) return 'active';
  if (statuses.includes('invited')) return 'invited';
  if (statuses.includes('suspended')) return 'suspended';
  return 'revoked';
}
