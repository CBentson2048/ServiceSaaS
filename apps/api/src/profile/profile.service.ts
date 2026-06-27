import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AdminUpdateProfileRequest,
  AuthLocation,
  AuthUser,
  ClientProfileDetails,
  CommunicationPreference,
  ListProfilesResponse,
  StaffProfileDetails,
  UpdateCurrentProfileRequest,
  UpdateProfileResponse,
  UserProfileIdentity,
  UserProfileResponse,
  UserRole,
} from '@sheer/domain';
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import type { ListProfilesQueryDto } from './dto';

interface UserProfileRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  display_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  is_active: boolean | null;
  timezone: string | null;
}

interface MembershipRow {
  business_id: string;
  location_id: string | null;
  user_profile_id: string;
  role: UserRole;
  status: string;
}

interface ClientProfileRow {
  id: string;
  business_id: string;
  user_profile_id: string | null;
  primary_location_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  communication_preference: CommunicationPreference | null;
  notes: string | null;
  client_code: string;
  source: string | null;
  tags: string[];
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
  color_hex: string | null;
  bio: string | null;
  is_bookable: boolean;
}

interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  slug: string | null;
}

const ROLE_PRIORITY: Record<UserRole, number> = {
  owner: 0,
  manager: 1,
  stylist: 2,
  client: 3,
};

const PROFILE_COLUMNS =
  'id,email,first_name,last_name,full_name,display_name,phone,avatar_url,is_active,timezone';
const CLIENT_COLUMNS =
  'id,business_id,user_profile_id,primary_location_id,first_name,last_name,email,phone,communication_preference,notes,client_code,source,tags';
const STAFF_COLUMNS =
  'id,business_id,user_profile_id,primary_location_id,display_name,employment_status,hourly_rate,contracted_hours,average_bill_benchmark,sheer_lab_pin_enabled,leave_notes,color_hex,bio,is_bookable';

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getCurrentProfile(actor: AuthUser): Promise<UserProfileResponse> {
    return this.buildProfileForUser(actor, actor.id, { allowAdminFields: true });
  }

  async updateCurrentProfile(
    actor: AuthUser,
    input: UpdateCurrentProfileRequest,
  ): Promise<UpdateProfileResponse> {
    const identityPatch = this.identityPatch({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      avatarUrl: input.avatarUrl,
    });
    if (Object.keys(identityPatch).length > 0) {
      await this.updateUserProfile(actor.id, identityPatch);
    }

    if (userHasRole(actor, 'client') && actor.clientProfileId) {
      await this.updateOwnClientProfile(actor, actor.clientProfileId, input);
    }

    // Staff may self-edit their bio only. Pay/hours stay employer-controlled
    // and are not exposed on this endpoint.
    if (input.bio !== undefined && actor.staffProfileId) {
      await this.updateOwnStaffBio(actor.staffProfileId, input.bio);
    }

    return { profile: await this.getCurrentProfile(actor) };
  }

  private async updateOwnStaffBio(staffProfileId: string, bio: string | null): Promise<void> {
    const { error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .update({ bio: cleanOptional(bio), updated_at: new Date().toISOString() })
      .eq('id', staffProfileId);
    if (error) {
      this.logger.error(`updateOwnStaffBio failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update staff profile');
    }
  }

  /**
   * Permanently deletes the caller's own account (App Store Guideline 5.1.1(v)).
   *
   * Only clients may self-delete from the app. Staff/owner/manager accounts are
   * provisioned and managed by the salon, and deleting their auth user would
   * cascade-delete the staff_profile — an HR action, not self-service.
   */
  async deleteCurrentAccount(actor: AuthUser): Promise<void> {
    if (!userHasRole(actor, 'client')) {
      throw new ForbiddenException(
        'Only client accounts can be deleted from the app. Staff accounts are managed by your salon.',
      );
    }

    // booking.booking_attempts.user_profile_id is ON DELETE RESTRICT, so any past
    // deposit checkout would block the auth-user cascade below. Remove the caller's
    // attempts first; booking.deposits.booking_attempt_id is ON DELETE SET NULL, so
    // the financial deposit records are retained, just detached.
    const { error: attemptsError } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .delete()
      .eq('user_profile_id', actor.id);
    if (attemptsError) {
      this.logger.error(`deleteCurrentAccount: clearing booking attempts failed: ${attemptsError.message}`);
      throw new InternalServerErrorException('Unable to delete account');
    }

    // Deleting the Supabase auth user cascades to core.user_profiles (→ memberships)
    // and detaches core.client_profiles (user_profile_id ON DELETE SET NULL), so the
    // salon's booking/visit history is preserved but no longer linked to a login.
    const { error: authError } = await this.admin.auth.admin.deleteUser(actor.id);
    if (authError) {
      this.logger.error(`deleteCurrentAccount: auth user delete failed: ${authError.message}`);
      throw new InternalServerErrorException('Unable to delete account');
    }

    this.logger.log(`Deleted account for user ${actor.id}`);
  }

  async listProfiles(actor: AuthUser, query: ListProfilesQueryDto): Promise<ListProfilesResponse> {
    this.assertManagerOrOwner(actor);
    if (query.locationId) this.assertLocationScope(actor, query.locationId);

    const profiles: UserProfileResponse[] = [];
    if (!query.kind || query.kind === 'staff') {
      const staffRows = await this.listStaffRows(actor, query);
      for (const row of staffRows) {
        profiles.push(await this.buildProfileForUser(actor, row.user_profile_id, { staffRow: row, allowAdminFields: true }));
      }
    }
    if (!query.kind || query.kind === 'client') {
      const clientRows = await this.listClientRows(actor, query);
      for (const row of clientRows) {
        if (row.user_profile_id) {
          profiles.push(
            await this.buildProfileForUser(actor, row.user_profile_id, { clientRow: row, allowAdminFields: true }),
          );
        } else {
          profiles.push(await this.buildClientOnlyProfile(actor, row));
        }
      }
    }

    return { profiles, scope: userHasRole(actor, 'owner') ? 'owner' : 'manager' };
  }

  async getClientProfile(actor: AuthUser, clientProfileId: string): Promise<UserProfileResponse> {
    const client = await this.fetchClientForActor(actor, clientProfileId);
    if (client.user_profile_id) {
      return this.buildProfileForUser(actor, client.user_profile_id, { clientRow: client, allowAdminFields: true });
    }
    return this.buildClientOnlyProfile(actor, client);
  }

  async getClientProfileByEmail(actor: AuthUser, email: string): Promise<UserProfileResponse> {
    const cleaned = email.trim().toLowerCase();
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('email', cleaned)
      .limit(1)
      .maybeSingle<ClientProfileRow>();
    if (error) {
      this.logger.error(`getClientProfileByEmail failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load client profile');
    }
    if (!data) throw new NotFoundException('Client profile not found');
    this.assertClientAccess(actor, data);
    return this.getClientProfile(actor, data.id);
  }

  async getStaffProfile(actor: AuthUser, staffProfileId: string): Promise<UserProfileResponse> {
    const staff = await this.fetchStaffForActor(actor, staffProfileId);
    return this.buildProfileForUser(actor, staff.user_profile_id, {
      staffRow: staff,
      allowAdminFields: userHasAnyRole(actor, ['owner', 'manager']),
    });
  }

  async updateProfileAsAdmin(
    actor: AuthUser,
    userProfileId: string,
    input: AdminUpdateProfileRequest,
  ): Promise<UpdateProfileResponse> {
    this.assertManagerOrOwner(actor);
    const targetMembership = await this.fetchTargetMembership(actor.businessId, userProfileId);
    if (!targetMembership) throw new NotFoundException('Profile not found in this business');
    if (userHasRole(actor, 'manager')) {
      if (!targetMembership.location_id || !actor.allowedLocationIds.includes(targetMembership.location_id)) {
        throw new ForbiddenException('Profile is outside your location scope');
      }
      if (targetMembership.role === 'owner' || targetMembership.role === 'manager') {
        throw new ForbiddenException('Managers cannot edit owner or manager profiles');
      }
    }

    const identityPatch = this.identityPatch({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      avatarUrl: input.avatarUrl,
    });
    if (Object.keys(identityPatch).length > 0) {
      await this.updateUserProfile(userProfileId, identityPatch);
    }

    if (targetMembership.role === 'client') {
      const client = await this.fetchClientByUser(actor.businessId, userProfileId);
      if (client) {
        this.assertClientAccess(actor, client);
        await this.updateClientProfile(client, input);
      }
    }

    const staff = await this.fetchStaffByUser(actor.businessId, userProfileId);
    if (staff) {
      this.assertStaffAccess(actor, staff);
      await this.updateStaffProfile(actor, staff, input);
    }

    return {
      profile: await this.buildProfileForUser(actor, userProfileId, { allowAdminFields: true }),
    };
  }

  private async buildProfileForUser(
    actor: AuthUser,
    userProfileId: string,
    options: { clientRow?: ClientProfileRow; staffRow?: StaffProfileRow; allowAdminFields?: boolean } = {},
  ): Promise<UserProfileResponse> {
    const [profile, memberships, client, staff] = await Promise.all([
      this.fetchUserProfile(userProfileId),
      this.fetchMemberships(userProfileId),
      options.clientRow !== undefined ? Promise.resolve(options.clientRow) : this.fetchClientByUser(actor.businessId, userProfileId),
      options.staffRow !== undefined ? Promise.resolve(options.staffRow) : this.fetchStaffByUser(actor.businessId, userProfileId),
    ]);
    const businessMemberships = memberships.filter((m) => m.business_id === actor.businessId && m.status === 'active');
    const role = this.primaryRole(businessMemberships) ?? actor.primaryRole;

    if (client) this.assertClientAccess(actor, client);
    if (staff) this.assertStaffAccess(actor, staff, userProfileId === actor.id);
    if (!client && !staff && userProfileId !== actor.id && !userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Profile is outside your scope');
    }

    const locations = await this.fetchLocationsForMemberships(businessMemberships);
    return {
      identity: this.toIdentity(profile, role),
      clientProfile: client ? await this.toClientDetails(client) : undefined,
      staffProfile: staff ? await this.toStaffDetails(staff, options.allowAdminFields ?? false) : undefined,
      locations,
      scope: actor.locationScope,
      editableFields: this.editableFields(actor, role, userProfileId === actor.id, Boolean(staff), Boolean(client)),
    };
  }

  private async buildClientOnlyProfile(actor: AuthUser, client: ClientProfileRow): Promise<UserProfileResponse> {
    this.assertClientAccess(actor, client);
    return {
      identity: {
        userProfileId: client.id,
        email: client.email ?? '',
        firstName: client.first_name,
        lastName: client.last_name,
        fullName: `${client.first_name} ${client.last_name}`.trim(),
        displayName: `${client.first_name} ${client.last_name}`.trim(),
        phone: client.phone ?? undefined,
        role: 'client',
        isActive: true,
      },
      clientProfile: await this.toClientDetails(client),
      locations: client.primary_location_id ? await this.fetchLocationsByIds([client.primary_location_id]) : [],
      scope: actor.locationScope,
      editableFields: userHasAnyRole(actor, ['owner', 'manager']) ? ['clientNotes', 'communicationPreference'] : [],
    };
  }

  private async updateUserProfile(userProfileId: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', userProfileId);
    if (error) {
      this.logger.error(`updateUserProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update user profile');
    }
  }

  private async updateOwnClientProfile(
    actor: AuthUser,
    clientProfileId: string,
    input: UpdateCurrentProfileRequest,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.firstName !== undefined) patch.first_name = cleanRequired(input.firstName, 'firstName');
    if (input.lastName !== undefined) patch.last_name = cleanRequired(input.lastName, 'lastName');
    if (input.phone !== undefined) patch.phone = cleanOptional(input.phone);
    if (input.communicationPreference !== undefined) {
      patch.communication_preference = input.communicationPreference;
    }
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', clientProfileId)
      .eq('business_id', actor.businessId)
      .eq('user_profile_id', actor.id);
    if (error) {
      this.logger.error(`updateOwnClientProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update client profile');
    }
  }

  private async updateClientProfile(client: ClientProfileRow, input: AdminUpdateProfileRequest): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.firstName !== undefined) patch.first_name = cleanRequired(input.firstName, 'firstName');
    if (input.lastName !== undefined) patch.last_name = cleanRequired(input.lastName, 'lastName');
    if (input.phone !== undefined) patch.phone = cleanOptional(input.phone);
    if (input.communicationPreference !== undefined) patch.communication_preference = input.communicationPreference;
    if (input.clientNotes !== undefined) patch.notes = cleanOptional(input.clientNotes);
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', client.id);
    if (error) {
      this.logger.error(`updateClientProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update client profile');
    }
  }

  private async updateStaffProfile(
    actor: AuthUser,
    staff: StaffProfileRow,
    input: AdminUpdateProfileRequest,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.assignedLocationId !== undefined) {
      this.assertLocationScope(actor, input.assignedLocationId);
      patch.primary_location_id = input.assignedLocationId;
    }
    if (input.staffDisplayName !== undefined) patch.display_name = cleanRequired(input.staffDisplayName, 'staffDisplayName');
    if (input.hourlyRate !== undefined) patch.hourly_rate = input.hourlyRate;
    if (input.contractedHours !== undefined) patch.contracted_hours = input.contractedHours;
    if (input.averageBillBenchmark !== undefined) patch.average_bill_benchmark = input.averageBillBenchmark;
    if (input.leaveNotes !== undefined) patch.leave_notes = cleanOptional(input.leaveNotes);
    if (input.isBookable !== undefined) patch.is_bookable = input.isBookable;
    if (Object.keys(patch).length === 0) return;
    const { error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', staff.id);
    if (error) {
      this.logger.error(`updateStaffProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update staff profile');
    }
  }

  private identityPatch(input: UpdateCurrentProfileRequest): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (input.firstName !== undefined) patch.first_name = cleanRequired(input.firstName, 'firstName');
    if (input.lastName !== undefined) patch.last_name = cleanRequired(input.lastName, 'lastName');
    if (input.phone !== undefined) patch.phone = cleanOptional(input.phone);
    if (input.avatarUrl !== undefined) patch.avatar_url = cleanOptional(input.avatarUrl);
    if (input.timezone !== undefined) patch.timezone = assertValidTimezone(input.timezone);
    return patch;
  }

  private async fetchUserProfile(userProfileId: string): Promise<UserProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userProfileId)
      .single<UserProfileRow>();
    if (error || !data) throw new NotFoundException('User profile not found');
    return data;
  }

  private async fetchMemberships(userProfileId: string): Promise<MembershipRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('business_id,location_id,user_profile_id,role,status')
      .eq('user_profile_id', userProfileId)
      .returns<MembershipRow[]>();
    if (error) throw new InternalServerErrorException('Unable to load profile memberships');
    return data ?? [];
  }

  private async fetchTargetMembership(businessId: string, userProfileId: string): Promise<MembershipRow | null> {
    const memberships = await this.fetchMemberships(userProfileId);
    const scoped = memberships.filter((m) => m.business_id === businessId && m.status === 'active');
    return scoped.sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role])[0] ?? null;
  }

  private async fetchClientByUser(businessId: string, userProfileId: string): Promise<ClientProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle<ClientProfileRow>();
    if (error) throw new InternalServerErrorException('Unable to load client profile');
    return data ?? undefined;
  }

  private async fetchStaffByUser(businessId: string, userProfileId: string): Promise<StaffProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .maybeSingle<StaffProfileRow>();
    if (error) throw new InternalServerErrorException('Unable to load staff profile');
    return data ?? undefined;
  }

  private async fetchClientForActor(actor: AuthUser, clientProfileId: string): Promise<ClientProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('id', clientProfileId)
      .eq('business_id', actor.businessId)
      .maybeSingle<ClientProfileRow>();
    if (error) throw new InternalServerErrorException('Unable to load client profile');
    if (!data) throw new NotFoundException('Client profile not found');
    this.assertClientAccess(actor, data);
    return data;
  }

  private async fetchStaffForActor(actor: AuthUser, staffProfileId: string): Promise<StaffProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('id', staffProfileId)
      .eq('business_id', actor.businessId)
      .maybeSingle<StaffProfileRow>();
    if (error) throw new InternalServerErrorException('Unable to load staff profile');
    if (!data) throw new NotFoundException('Staff profile not found');
    this.assertStaffAccess(actor, data, data.user_profile_id === actor.id);
    return data;
  }

  private async listStaffRows(actor: AuthUser, query: ListProfilesQueryDto): Promise<StaffProfileRow[]> {
    let request = this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('business_id', actor.businessId)
      .neq('employment_status', 'terminated')
      .order('display_name', { ascending: true });
    if (query.locationId) request = request.eq('primary_location_id', query.locationId);
    else if (userHasRole(actor, 'manager')) request = request.in('primary_location_id', actor.allowedLocationIds);
    if (query.q?.trim()) request = request.ilike('display_name', `%${escapeLike(query.q.trim())}%`);
    const { data, error } = await request.returns<StaffProfileRow[]>();
    if (error) throw new InternalServerErrorException('Unable to list staff profiles');
    return data ?? [];
  }

  private async listClientRows(actor: AuthUser, query: ListProfilesQueryDto): Promise<ClientProfileRow[]> {
    let request = this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (query.locationId) request = request.eq('primary_location_id', query.locationId);
    else if (userHasRole(actor, 'manager')) request = request.in('primary_location_id', actor.allowedLocationIds);
    if (query.q?.trim()) {
      const q = escapeLike(query.q.trim());
      request = request.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    }
    const { data, error } = await request.returns<ClientProfileRow[]>();
    if (error) throw new InternalServerErrorException('Unable to list client profiles');
    return data ?? [];
  }

  private async toClientDetails(row: ClientProfileRow): Promise<ClientProfileDetails> {
    const [visitCount, lastVisitAt, activeAllergies, expiredPatchTests] = await Promise.all([
      this.countRows('booking', 'visits', 'client_profile_id', row.id),
      this.latestVisitAt(row.id),
      this.countRows('crm', 'allergy_records', 'client_profile_id', row.id, { is_active: true }),
      this.countExpiredPatchTests(row.id),
    ]);
    return {
      id: row.id,
      businessId: row.business_id,
      userProfileId: row.user_profile_id ?? undefined,
      primaryLocationId: row.primary_location_id ?? undefined,
      clientCode: row.client_code,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: `${row.first_name} ${row.last_name}`.trim(),
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      communicationPreference: row.communication_preference ?? undefined,
      notes: row.notes ?? undefined,
      source: row.source ?? undefined,
      tags: row.tags ?? [],
      lastVisitAt,
      visitCount,
      activeAllergies,
      expiredPatchTests,
    };
  }

  private async toStaffDetails(row: StaffProfileRow, allowAdminFields: boolean): Promise<StaffProfileDetails> {
    const [pendingLeaveRequests, openAbsences] = await Promise.all([
      this.countRows('rota', 'leave_requests', 'staff_profile_id', row.id, { status: 'pending' }),
      this.countOpenAbsences(row.id),
    ]);
    return {
      id: row.id,
      businessId: row.business_id,
      userProfileId: row.user_profile_id,
      assignedLocationId: row.primary_location_id,
      displayName: row.display_name,
      employmentStatus: row.employment_status,
      isBookable: row.is_bookable,
      colorHex: row.color_hex ?? undefined,
      bio: row.bio ?? undefined,
      hourlyRate: allowAdminFields ? Number(row.hourly_rate) : 0,
      contractedHours: allowAdminFields ? Number(row.contracted_hours) : 0,
      averageBillBenchmark: allowAdminFields ? Number(row.average_bill_benchmark) : 0,
      sheerLabPinEnabled: row.sheer_lab_pin_enabled,
      leaveNotes: allowAdminFields ? row.leave_notes ?? undefined : undefined,
      pendingLeaveRequests,
      openAbsences,
    };
  }

  private toIdentity(row: UserProfileRow, role: UserRole): UserProfileIdentity {
    const names = splitName(row.full_name);
    return {
      userProfileId: row.id,
      email: row.email,
      firstName: row.first_name ?? names.firstName,
      lastName: row.last_name ?? names.lastName,
      fullName: row.full_name,
      displayName: row.display_name ?? row.full_name,
      phone: row.phone ?? undefined,
      avatarUrl: row.avatar_url ?? undefined,
      role,
      isActive: row.is_active ?? true,
      timezone: row.timezone ?? undefined,
    };
  }

  private async countRows(
    schema: string,
    table: string,
    column: string,
    value: string,
    eq: Record<string, string | boolean> = {},
  ): Promise<number> {
    let request = this.admin.schema(schema).from(table).select('id', { count: 'exact', head: true }).eq(column, value);
    for (const [key, match] of Object.entries(eq)) request = request.eq(key, match);
    const { count, error } = await request;
    if (error) return 0;
    return count ?? 0;
  }

  private async latestVisitAt(clientProfileId: string): Promise<string | undefined> {
    const { data } = await this.admin
      .schema('booking')
      .from('visits')
      .select('completed_at,created_at')
      .eq('client_profile_id', clientProfileId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ completed_at: string | null; created_at: string }>();
    return data?.completed_at ?? data?.created_at ?? undefined;
  }

  private async countExpiredPatchTests(clientProfileId: string): Promise<number> {
    const { count, error } = await this.admin
      .schema('crm')
      .from('patch_tests')
      .select('id', { count: 'exact', head: true })
      .eq('client_profile_id', clientProfileId)
      .lt('expires_at', new Date().toISOString());
    if (error) return 0;
    return count ?? 0;
  }

  private async countOpenAbsences(staffProfileId: string): Promise<number> {
    const { count, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .select('id', { count: 'exact', head: true })
      .eq('staff_profile_id', staffProfileId)
      .or(`ends_at.is.null,ends_at.gte.${new Date().toISOString()}`);
    if (error) return 0;
    return count ?? 0;
  }

  private primaryRole(memberships: MembershipRow[]): UserRole | undefined {
    return [...memberships].sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role])[0]?.role;
  }

  private async fetchLocationsForMemberships(memberships: MembershipRow[]): Promise<AuthLocation[]> {
    const ids = Array.from(new Set(memberships.map((m) => m.location_id).filter(isString)));
    return this.fetchLocationsByIds(ids);
  }

  private async fetchLocationsByIds(ids: string[]): Promise<AuthLocation[]> {
    if (ids.length === 0) return [];
    const { data } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,code,slug')
      .in('id', ids)
      .returns<LocationRow[]>();
    return (data ?? []).map((location) => ({
      id: location.id,
      name: location.name,
      code: location.code ?? undefined,
      slug: location.slug ?? undefined,
    }));
  }

  private editableFields(
    actor: AuthUser,
    role: UserRole,
    isSelf: boolean,
    hasStaff: boolean,
    hasClient: boolean,
  ): string[] {
    if (isSelf) {
      return [
        'firstName',
        'lastName',
        'phone',
        'avatarUrl',
        ...(role === 'client' && hasClient ? ['communicationPreference'] : []),
      ];
    }
    if (userHasRole(actor, 'owner')) {
      return [
        'firstName',
        'lastName',
        'phone',
        'avatarUrl',
        ...(hasClient ? ['communicationPreference', 'clientNotes'] : []),
        ...(hasStaff
          ? ['assignedLocationId', 'staffDisplayName', 'hourlyRate', 'contractedHours', 'averageBillBenchmark', 'leaveNotes', 'isBookable']
          : []),
      ];
    }
    if (userHasRole(actor, 'manager') && role === 'stylist') {
      return ['staffDisplayName', 'isBookable', 'leaveNotes'];
    }
    return [];
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('This profile action requires owner or manager access');
    }
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your profile scope');
    }
  }

  private assertClientAccess(actor: AuthUser, client: ClientProfileRow): void {
    if (userHasRole(actor, 'owner')) return;
    if (userHasRole(actor, 'client') && client.user_profile_id === actor.id) return;
    if (client.primary_location_id && actor.allowedLocationIds.includes(client.primary_location_id)) return;
    throw new ForbiddenException('Client profile is outside your scope');
  }

  private assertStaffAccess(actor: AuthUser, staff: StaffProfileRow, isSelf = false): void {
    if (userHasRole(actor, 'owner') || isSelf) return;
    if (userHasRole(actor, 'manager') && actor.allowedLocationIds.includes(staff.primary_location_id)) return;
    throw new ForbiddenException('Staff profile is outside your scope');
  }
}

function cleanRequired(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException(`${label} is required`);
  return trimmed;
}

function cleanOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() || null;
}

function assertValidTimezone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException('timezone is required');
  try {
    // Throws RangeError for an unknown/invalid IANA zone.
    new Intl.DateTimeFormat('en-GB', { timeZone: trimmed });
  } catch {
    throw new BadRequestException(`Invalid timezone: ${value}`);
  }
  return trimmed;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? 'User',
    lastName: parts.slice(1).join(' ') || 'Profile',
  };
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function isString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}
