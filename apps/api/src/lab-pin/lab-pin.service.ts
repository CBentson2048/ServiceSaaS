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
} from '@sheer/domain';
import type { AssignLabPinDto, PinStatusQueryDto, ResetLabPinDto } from './dto';

interface StaffPinRow {
  user_profile_id: string;
  display_name: string | null;
  primary_location_id: string;
  id: string;
  user_profiles: { email: string; full_name: string } | { email: string; full_name: string }[] | null;
  locations: { name: string } | { name: string }[] | null;
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

const STAFF_PIN_COLUMNS =
  'id,user_profile_id,display_name,primary_location_id,user_profiles(email,full_name),locations(name)';

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
    const stylist = await this.fetchManagedStylist(actor, dto.userProfileId, dto.locationId);

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
      role: 'stylist',
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
    return { credential: toPinStatus(stylist, credential) };
  }

  async reset(actor: AuthUser, dto: ResetLabPinDto): Promise<LabPinMutationResponse> {
    this.assertManagerOrOwner(actor);
    await this.assertLocationScope(actor, dto.locationId);
    const stylist = await this.fetchManagedStylist(actor, dto.userProfileId, dto.locationId);
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
    return { credential: toPinStatus(stylist, credential) };
  }

  async status(actor: AuthUser, query: PinStatusQueryDto): Promise<ListLabPinStatusesResponse> {
    this.assertManagerOrOwner(actor);
    if (query.locationId) await this.assertLocationScope(actor, query.locationId);

    let staffQuery = this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_PIN_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('employment_status', 'active')
      .order('display_name', { ascending: true });
    if (query.locationId) {
      staffQuery = staffQuery.eq('primary_location_id', query.locationId);
    } else if (actor.role === 'manager') {
      staffQuery = staffQuery.in('primary_location_id', actor.allowedLocationIds);
    }

    const { data: stylists, error: staffError } = await staffQuery.returns<StaffPinRow[]>();
    if (staffError) {
      this.logger.error(`status staff query failed: ${staffError.message}`);
      throw new InternalServerErrorException('Unable to load stylists');
    }

    let credentialQuery = this.admin
      .schema('core')
      .from('stylist_pin_credentials')
      .select(
        'user_profile_id,location_id,status,is_active,failed_attempts,locked_until,last_verified_at,last_rotated_at,updated_at',
      )
      .eq('business_id', actor.businessId);
    if (query.locationId) {
      credentialQuery = credentialQuery.eq('location_id', query.locationId);
    } else if (actor.role === 'manager') {
      credentialQuery = credentialQuery.in('location_id', actor.allowedLocationIds);
    }

    const { data: credentials, error } = await credentialQuery.returns<PinCredentialRow[]>();
    if (error) {
      this.logger.error(`status failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load Lab PIN status');
    }

    const credentialByUserLocation = new Map(
      (credentials ?? []).map((credential) => [`${credential.user_profile_id}:${credential.location_id}`, credential]),
    );
    return {
      stylists: (stylists ?? []).map((stylist) =>
        toPinStatus(
          stylist,
          credentialByUserLocation.get(`${stylist.user_profile_id}:${stylist.primary_location_id}`),
        ),
      ),
      scope: actor.role === 'owner' ? 'owner' : 'manager',
    };
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (actor.role !== 'owner' && actor.role !== 'manager') {
      throw new ForbiddenException('Only owners and managers can manage Lab PINs');
    }
  }

  private async assertLocationScope(actor: AuthUser, locationId: string): Promise<void> {
    if (actor.role !== 'owner' && !actor.allowedLocationIds.includes(locationId)) {
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

  private async fetchManagedStylist(
    actor: AuthUser,
    userProfileId: string,
    locationId: string,
  ): Promise<StaffPinRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_PIN_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('user_profile_id', userProfileId)
      .eq('primary_location_id', locationId)
      .maybeSingle<StaffPinRow>();

    if (error) {
      this.logger.error(`fetchManagedStylist failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate stylist');
    }
    if (!data) throw new NotFoundException('Stylist not found for this location');
    return data;
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
        actorRole: actor.role,
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

function toPinStatus(
  stylist: StaffPinRow,
  credential?: PinCredentialRow,
): LabPinCredentialStatus {
  const user = first(stylist.user_profiles);
  const location = first(stylist.locations);
  return {
    userProfileId: stylist.user_profile_id,
    staffProfileId: stylist.id,
    displayName: stylist.display_name ?? user?.full_name ?? 'Stylist',
    email: user?.email ?? '',
    locationId: stylist.primary_location_id,
    locationName: location?.name ?? 'Location',
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
