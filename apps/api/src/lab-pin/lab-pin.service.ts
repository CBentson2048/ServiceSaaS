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
import { createHash } from 'node:crypto';
import type {
  AuthUser,
  LabPinCredentialStatus,
  LabPinMutationResponse,
  ListLabPinStatusesResponse,
  UserRole,
} from '@sheer/domain';
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import type { AssignLabPinDto, PinStatusQueryDto, ResetLabPinDto } from './dto';

type PinRole = Extract<UserRole, 'owner' | 'manager' | 'stylist'>;

interface StaffPinRow {
  user_profile_id: string;
  display_name: string | null;
  primary_location_id: string;
  id: string;
  user_profiles: { email: string; full_name: string } | { email: string; full_name: string }[] | null;
  locations: { name: string } | { name: string }[] | null;
}

interface MembershipRow {
  user_profile_id: string;
  role: PinRole;
  location_id: string | null;
}

interface PinCredentialRow {
  user_profile_id: string;
  location_id: string;
  status: 'active' | 'inactive' | 'locked' | 'rotation_required';
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  last_verified_at: string | null;
  last_rotated_at: string | null;
  updated_at: string;
}

// A single PIN-manageable person at a specific location, regardless of whether
// they come from a bookable staff profile (stylist) or a role membership
// (owner/manager).
interface PinEligibleEntry {
  userProfileId: string;
  staffProfileId?: string;
  role: PinRole;
  displayName: string;
  email: string;
  locationId: string;
  locationName: string;
}

const STAFF_PIN_COLUMNS =
  'id,user_profile_id,display_name,primary_location_id,user_profiles(email,full_name),locations(name)';

const ROLE_PRIORITY: Record<PinRole, number> = { owner: 3, manager: 2, stylist: 1 };

@Injectable()
export class LabPinService {
  private readonly logger = new Logger(LabPinService.name);
  private readonly admin: SupabaseClient;
  private readonly pinPepper: string;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.pinPepper = config.get<string>('SHEER_LAB_PIN_PEPPER') ?? serviceRoleKey;
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async assign(actor: AuthUser, dto: AssignLabPinDto): Promise<LabPinMutationResponse> {
    this.assertManagerOrOwner(actor);
    await this.assertLocationScope(actor, dto.locationId);
    const target = await this.resolveTarget(actor, dto.userProfileId, dto.locationId);

    const { error: deactivateError } = await this.admin
      .schema('core')
      .from('stylist_pin_credentials')
      .update({ is_active: false, status: 'rotation_required' })
      .eq('business_id', actor.businessId)
      .eq('location_id', dto.locationId)
      .eq('user_profile_id', dto.userProfileId)
      .eq('is_active', true);

    if (deactivateError) {
      this.logger.error(`assign deactivate existing failed: ${deactivateError.message}`);
      throw new InternalServerErrorException('Unable to assign Lab PIN');
    }

    const { error: insertError } = await this.admin.schema('core').from('stylist_pin_credentials').insert({
      business_id: actor.businessId,
      location_id: dto.locationId,
      user_profile_id: dto.userProfileId,
      role: target.role,
      pin_hash: this.hashPin(actor.businessId, dto.locationId, dto.pin),
      is_active: true,
      status: 'active',
      failed_attempts: 0,
      locked_until: null,
      last_rotated_at: new Date().toISOString(),
    });

    if (insertError) {
      this.logger.error(`assign insert failed: ${insertError.message}`);
      throw new InternalServerErrorException('Unable to assign Lab PIN');
    }

    await this.writeAuditEvent(actor, dto.locationId, 'pin_set', dto.userProfileId);
    const credential = await this.fetchCredential(actor.businessId, dto.userProfileId, dto.locationId);
    return { credential: toPinStatus(target, credential) };
  }

  async reset(actor: AuthUser, dto: ResetLabPinDto): Promise<LabPinMutationResponse> {
    this.assertManagerOrOwner(actor);
    await this.assertLocationScope(actor, dto.locationId);
    const target = await this.resolveTarget(actor, dto.userProfileId, dto.locationId);
    const { error } = await this.admin
      .schema('core')
      .from('stylist_pin_credentials')
      .update({ is_active: false, status: 'rotation_required' })
      .eq('business_id', actor.businessId)
      .eq('location_id', dto.locationId)
      .eq('user_profile_id', dto.userProfileId);

    if (error) {
      this.logger.error(`reset failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reset Lab PIN');
    }

    await this.writeAuditEvent(actor, dto.locationId, 'pin_reset', dto.userProfileId);
    const credential = await this.fetchCredential(actor.businessId, dto.userProfileId, dto.locationId);
    return { credential: toPinStatus(target, credential) };
  }

  async status(actor: AuthUser, query: PinStatusQueryDto): Promise<ListLabPinStatusesResponse> {
    this.assertManagerOrOwner(actor);
    if (query.locationId) await this.assertLocationScope(actor, query.locationId);

    const scope: 'owner' | 'manager' = userHasRole(actor, 'owner') ? 'owner' : 'manager';

    // Resolve the locations in play (and their names) up front: a specific
    // location when filtered, a manager's allowed locations, or every business
    // location for an owner.
    const requestedLocationIds = query.locationId
      ? [query.locationId]
      : !userHasRole(actor, 'owner')
        ? actor.allowedLocationIds
        : undefined;
    const locationNames = await this.fetchLocations(actor.businessId, requestedLocationIds);
    const scopeLocationIds = Array.from(locationNames.keys());
    if (scopeLocationIds.length === 0) return { credentials: [], scope };

    // Owners can manage every role; managers manage managers + stylists in
    // their locations but never owner PINs.
    const membershipRoles: PinRole[] = userHasRole(actor, 'owner') ? ['owner', 'manager'] : ['manager'];

    const [stylists, memberships, credentials] = await Promise.all([
      this.fetchBookableStylists(actor.businessId, scopeLocationIds),
      this.fetchMemberships(actor.businessId, membershipRoles),
      this.fetchCredentialsInScope(actor.businessId, scopeLocationIds),
    ]);

    // user_memberships has two FKs to user_profiles (member + inviter), so an
    // embedded join is ambiguous — resolve the member names/emails separately.
    const profiles = await this.fetchUserProfilesByIds(memberships.map((m) => m.user_profile_id));

    const entries = new Map<string, PinEligibleEntry>();

    // Bookable stylists keep their existing source-of-truth: the staff profile.
    for (const row of stylists) {
      const user = first(row.user_profiles);
      const key = `${row.user_profile_id}:${row.primary_location_id}`;
      entries.set(key, {
        userProfileId: row.user_profile_id,
        staffProfileId: row.id,
        role: 'stylist',
        displayName: row.display_name ?? user?.full_name ?? 'Stylist',
        email: user?.email ?? '',
        locationId: row.primary_location_id,
        locationName: locationNames.get(row.primary_location_id) ?? first(row.locations)?.name ?? 'Location',
      });
    }

    // Owners are business-wide, so they surface at every in-scope location;
    // managers surface at their own membership location. A higher-priority role
    // wins if the same person also appears as a stylist.
    for (const membership of memberships) {
      const user = profiles.get(membership.user_profile_id);
      const targetLocations =
        membership.role === 'owner'
          ? scopeLocationIds
          : membership.location_id && scopeLocationIds.includes(membership.location_id)
            ? [membership.location_id]
            : [];
      for (const locationId of targetLocations) {
        const key = `${membership.user_profile_id}:${locationId}`;
        const existing = entries.get(key);
        if (existing && ROLE_PRIORITY[existing.role] >= ROLE_PRIORITY[membership.role]) continue;
        entries.set(key, {
          userProfileId: membership.user_profile_id,
          staffProfileId: existing?.staffProfileId,
          role: membership.role,
          displayName: user?.full_name ?? existing?.displayName ?? 'Team member',
          email: user?.email ?? existing?.email ?? '',
          locationId,
          locationName: locationNames.get(locationId) ?? 'Location',
        });
      }
    }

    const credentialByUserLocation = new Map(
      credentials.map((credential) => [`${credential.user_profile_id}:${credential.location_id}`, credential]),
    );

    const result = Array.from(entries.values())
      .map((entry) => toPinStatus(entry, credentialByUserLocation.get(`${entry.userProfileId}:${entry.locationId}`)))
      .sort((a, b) => {
        const roleDelta = ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role];
        if (roleDelta !== 0) return roleDelta;
        return a.displayName.localeCompare(b.displayName);
      });

    return { credentials: result, scope };
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Only owners and managers can manage Lab PINs');
    }
  }

  private async assertLocationScope(actor: AuthUser, locationId: string): Promise<void> {
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your Lab PIN scope');
    }
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', actor.businessId)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`assertLocationScope failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate location');
    }
    if (!data) throw new BadRequestException('locationId is not valid for this business');
  }

  // Resolves the role + display details for the user a PIN is being assigned to
  // or reset for, and enforces who an actor may manage. The credential role is
  // taken from the user's authoritative membership (owner > manager > stylist),
  // falling back to a bookable staff profile for stylists without a membership
  // row. Managers may never manage an owner's PIN.
  private async resolveTarget(actor: AuthUser, userProfileId: string, locationId: string): Promise<PinEligibleEntry> {
    const memberships = await this.fetchUserMemberships(actor.businessId, userProfileId);
    const staff = await this.fetchStaffProfile(actor.businessId, userProfileId, locationId);

    let role: PinRole | undefined;
    if (memberships.some((m) => m.role === 'owner' && m.location_id === null)) {
      role = 'owner';
    } else if (memberships.some((m) => m.role === 'manager' && m.location_id === locationId)) {
      role = 'manager';
    } else if (memberships.some((m) => m.role === 'stylist' && m.location_id === locationId)) {
      role = 'stylist';
    } else if (staff) {
      role = 'stylist';
    }

    if (!role) throw new NotFoundException('Team member not found for this location');
    if (role === 'owner' && !userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only owners can manage owner Lab PINs');
    }

    const profile = await this.fetchUserProfile(userProfileId);
    const locationName = await this.fetchLocationName(actor.businessId, locationId);
    return {
      userProfileId,
      staffProfileId: staff?.id,
      role,
      displayName: staff?.display_name ?? profile?.full_name ?? 'Team member',
      email: profile?.email ?? '',
      locationId,
      locationName,
    };
  }

  private async fetchBookableStylists(businessId: string, locationIds: string[]): Promise<StaffPinRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_PIN_COLUMNS)
      .eq('business_id', businessId)
      .eq('employment_status', 'active')
      // Lab PINs are for bookable stylists; exclude residual (is_bookable = false)
      // profiles left behind when a stylist is converted to a manager — the
      // manager is surfaced from their membership instead.
      .eq('is_bookable', true)
      .in('primary_location_id', locationIds)
      .order('display_name', { ascending: true })
      .returns<StaffPinRow[]>();

    if (error) {
      this.logger.error(`status staff query failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stylists');
    }
    return data ?? [];
  }

  private async fetchMemberships(businessId: string, roles: PinRole[]): Promise<MembershipRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('user_profile_id,role,location_id')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .in('role', roles)
      .returns<MembershipRow[]>();

    if (error) {
      this.logger.error(`status membership query failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load team members');
    }
    return data ?? [];
  }

  private async fetchUserProfilesByIds(
    userProfileIds: string[],
  ): Promise<Map<string, { email: string; full_name: string }>> {
    const ids = Array.from(new Set(userProfileIds));
    if (ids.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,full_name')
      .in('id', ids)
      .returns<Array<{ id: string; email: string; full_name: string }>>();

    if (error) {
      this.logger.error(`fetchUserProfilesByIds failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load team members');
    }
    return new Map((data ?? []).map((row) => [row.id, { email: row.email, full_name: row.full_name }]));
  }

  private async fetchUserMemberships(
    businessId: string,
    userProfileId: string,
  ): Promise<Array<{ role: PinRole; location_id: string | null }>> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_memberships')
      .select('role,location_id')
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .eq('status', 'active')
      .returns<Array<{ role: PinRole; location_id: string | null }>>();

    if (error) {
      this.logger.error(`fetchUserMemberships failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate team member');
    }
    return data ?? [];
  }

  private async fetchStaffProfile(
    businessId: string,
    userProfileId: string,
    locationId: string,
  ): Promise<{ id: string; display_name: string | null } | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .eq('primary_location_id', locationId)
      .maybeSingle<{ id: string; display_name: string | null }>();

    if (error) {
      this.logger.error(`fetchStaffProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate team member');
    }
    return data ?? undefined;
  }

  private async fetchUserProfile(
    userProfileId: string,
  ): Promise<{ email: string; full_name: string } | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('email,full_name')
      .eq('id', userProfileId)
      .maybeSingle<{ email: string; full_name: string }>();

    if (error) {
      this.logger.error(`fetchUserProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load team member');
    }
    return data ?? undefined;
  }

  private async fetchLocations(businessId: string, locationIds?: string[]): Promise<Map<string, string>> {
    let request = this.admin.schema('core').from('locations').select('id,name').eq('business_id', businessId);
    if (locationIds) {
      if (locationIds.length === 0) return new Map();
      request = request.in('id', locationIds);
    }
    const { data, error } = await request.returns<Array<{ id: string; name: string }>>();
    if (error) {
      this.logger.error(`fetchLocations failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load locations');
    }
    return new Map((data ?? []).map((row) => [row.id, row.name]));
  }

  private async fetchLocationName(businessId: string, locationId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('name')
      .eq('business_id', businessId)
      .eq('id', locationId)
      .maybeSingle<{ name: string }>();
    if (error) {
      this.logger.error(`fetchLocationName failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location');
    }
    return data?.name ?? 'Location';
  }

  private async fetchCredentialsInScope(businessId: string, locationIds: string[]): Promise<PinCredentialRow[]> {
    if (locationIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('core')
      .from('stylist_pin_credentials')
      .select(
        'user_profile_id,location_id,status,is_active,failed_attempts,locked_until,last_verified_at,last_rotated_at,updated_at',
      )
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .returns<PinCredentialRow[]>();

    if (error) {
      this.logger.error(`status credential query failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load Lab PIN status');
    }
    return data ?? [];
  }

  private async fetchCredential(
    businessId: string,
    userProfileId: string,
    locationId: string,
  ): Promise<PinCredentialRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('stylist_pin_credentials')
      .select(
        'user_profile_id,location_id,status,is_active,failed_attempts,locked_until,last_verified_at,last_rotated_at,updated_at',
      )
      .eq('business_id', businessId)
      .eq('user_profile_id', userProfileId)
      .eq('location_id', locationId)
      .eq('is_active', true)
      .maybeSingle<PinCredentialRow>();

    if (error) {
      this.logger.error(`fetchCredential failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load Lab PIN credential');
    }
    return data ?? undefined;
  }

  private async writeAuditEvent(
    actor: AuthUser,
    locationId: string,
    eventType: string,
    targetUserProfileId: string,
  ): Promise<void> {
    const { error } = await this.admin.schema('audit').from('lab_access_events').insert({
      business_id: actor.businessId,
      location_id: locationId,
      user_profile_id: targetUserProfileId,
      event_type: eventType,
      metadata_json: {
        actorUserProfileId: actor.id,
        actorRole: actor.primaryRole,
      },
    });

    if (error) {
      this.logger.warn(`writeAuditEvent failed: ${error.message}`);
    }
  }

  private hashPin(businessId: string, locationId: string, pin: string): string {
    if (!/^\d{4}$/.test(pin)) throw new BadRequestException('PIN must be 4 digits');
    return createHash('sha256')
      .update(`${businessId}:${locationId}:${pin}:${this.pinPepper}`)
      .digest('hex');
  }
}

function toPinStatus(entry: PinEligibleEntry, credential?: PinCredentialRow): LabPinCredentialStatus {
  return {
    userProfileId: entry.userProfileId,
    staffProfileId: entry.staffProfileId,
    displayName: entry.displayName,
    email: entry.email,
    role: entry.role,
    locationId: entry.locationId,
    locationName: entry.locationName,
    status: credential?.is_active ? credential.status : 'not_set',
    isActive: Boolean(credential?.is_active),
    failedAttempts: credential?.failed_attempts ?? 0,
    lockedUntil: credential?.locked_until ?? undefined,
    lastVerifiedAt: credential?.last_verified_at ?? undefined,
    lastRotatedAt: credential?.last_rotated_at ?? undefined,
    updatedAt: credential?.updated_at,
  };
}

function first<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}
