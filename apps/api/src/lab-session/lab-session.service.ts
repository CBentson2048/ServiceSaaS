import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import type { PinUnlockResponse, UserRole } from '@sheer/domain';
import { LAB_INACTIVITY_TIMEOUT_MS } from '@sheer/auth';
import type { LabSessionIdDto, UnlockLabSessionDto } from './dto';

interface SharedDeviceRow {
  id: string;
  business_id: string;
  location_id: string;
  device_name: string;
  status: 'registered' | 'active' | 'inactive' | 'revoked';
}

interface PinCredentialRow {
  id: string;
  business_id: string;
  location_id: string;
  user_profile_id: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  status: 'active' | 'inactive' | 'locked' | 'rotation_required';
  failed_attempts: number;
  locked_until: string | null;
  user_profiles: { full_name: string } | { full_name: string }[] | null;
}

interface StaffProfileRow {
  id: string;
  display_name: string | null;
}

interface FormulaSessionRow {
  id: string;
  business_id: string;
  location_id: string;
  shared_device_id: string;
  user_profile_id: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
  status: 'unlocking' | 'active' | 'locked' | 'expired' | 'logged_out';
  expires_at: string;
}

export interface LabRuntimeSession {
  sessionId: string;
  businessId: string;
  locationId: string;
  sharedDeviceId: string;
  userProfileId: string;
  staffProfileId?: string;
  role: Extract<UserRole, 'owner' | 'manager' | 'stylist'>;
}

const PIN_LOCK_THRESHOLD = 5;
const PIN_LOCK_MINUTES = 15;
const PIN_CREDENTIAL_COLUMNS =
  'id,business_id,location_id,user_profile_id,role,status,failed_attempts,locked_until,user_profiles(full_name)';

@Injectable()
export class LabSessionService {
  private readonly logger = new Logger(LabSessionService.name);
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

  async unlock(dto: UnlockLabSessionDto): Promise<PinUnlockResponse> {
    const device = await this.fetchActiveSharedDevice(dto.deviceId, dto.locationId);
    const credential = await this.fetchCredential(device, dto.pin);

    const now = new Date();
    if (credential.locked_until && new Date(credential.locked_until) > now) {
      await this.writeAuditEvent(device, 'pin_unlock_locked', credential.user_profile_id);
      throw new ForbiddenException('PIN is temporarily locked');
    }

    if (credential.status !== 'active') {
      await this.recordFailedPinAttempt(device, credential);
      throw new ForbiddenException('PIN is not active');
    }

    const staffProfile = await this.fetchStaffProfileForCredential(credential);
    const expiresAt = new Date(Date.now() + LAB_INACTIVITY_TIMEOUT_MS).toISOString();
    const { data: session, error } = await this.admin
      .schema('lab')
      .from('formula_sessions')
      .insert({
        business_id: device.business_id,
        location_id: device.location_id,
        shared_device_id: device.id,
        user_profile_id: credential.user_profile_id,
        role: credential.role,
        status: 'active',
        expires_at: expiresAt,
      })
      .select('id,business_id,location_id,shared_device_id,user_profile_id,role,status,expires_at')
      .single<FormulaSessionRow>();

    if (error || !session) {
      this.logger.error(`unlock create session failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to start Sheer Lab session');
    }

    await Promise.all([
      this.admin
        .schema('core')
        .from('stylist_pin_credentials')
        .update({ failed_attempts: 0, locked_until: null, last_verified_at: now.toISOString() })
        .eq('id', credential.id),
      this.admin.schema('core').from('shared_devices').update({ status: 'active', last_seen_at: now.toISOString() }).eq('id', device.id),
      this.writeAuditEvent(device, 'pin_unlock_success', credential.user_profile_id, { sessionId: session.id }),
    ]);

    return {
      sessionId: session.id,
      status: session.status,
      businessId: session.business_id,
      locationId: session.location_id,
      sharedDeviceId: session.shared_device_id,
      userProfileId: session.user_profile_id,
      staffProfileId: staffProfile?.id,
      displayName: staffProfile?.display_name ?? first(credential.user_profiles)?.full_name ?? 'Stylist',
      role: session.role,
      expiresAt: session.expires_at,
    };
  }

  async heartbeat(dto: LabSessionIdDto) {
    const session = await this.assertActiveSession(dto.sessionId);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LAB_INACTIVITY_TIMEOUT_MS).toISOString();
    const { error } = await this.admin
      .schema('lab')
      .from('formula_sessions')
      .update({ last_activity_at: now, expires_at: expiresAt })
      .eq('id', session.sessionId);

    if (error) {
      this.logger.error(`heartbeat failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to refresh Sheer Lab session');
    }

    return {
      sessionId: dto.sessionId,
      lastActivityAt: now,
    };
  }

  async logout(dto: LabSessionIdDto) {
    const endedAt = new Date().toISOString();
    const { data: session } = await this.admin
      .schema('lab')
      .from('formula_sessions')
      .select('business_id,location_id,shared_device_id,user_profile_id')
      .eq('id', dto.sessionId)
      .maybeSingle<{
        business_id: string;
        location_id: string;
        shared_device_id: string;
        user_profile_id: string;
      }>();

    const { error } = await this.admin
      .schema('lab')
      .from('formula_sessions')
      .update({ status: 'logged_out', ended_at: endedAt, end_reason: 'manual_logout' })
      .eq('id', dto.sessionId);

    if (error) {
      this.logger.error(`logout failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to end Sheer Lab session');
    }

    if (session) {
      await this.writeAuditEvent(
        {
          id: session.shared_device_id,
          business_id: session.business_id,
          location_id: session.location_id,
        },
        'manual_logout',
        session.user_profile_id,
        { sessionId: dto.sessionId },
      );
    }

    return {
      sessionId: dto.sessionId,
      status: 'logged_out',
    };
  }

  me() {
    return null;
  }

  async assertActiveSession(sessionId: string): Promise<LabRuntimeSession> {
    const { data, error } = await this.admin
      .schema('lab')
      .from('formula_sessions')
      .select('id,business_id,location_id,shared_device_id,user_profile_id,role,status,expires_at')
      .eq('id', sessionId)
      .maybeSingle<FormulaSessionRow>();

    if (error) {
      this.logger.error(`assertActiveSession failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate Sheer Lab session');
    }
    if (!data) throw new UnauthorizedException('Sheer Lab session was not found');

    if (data.status !== 'active') throw new UnauthorizedException('Sheer Lab session is not active');
    if (new Date(data.expires_at).getTime() <= Date.now()) {
      await this.admin
        .schema('lab')
        .from('formula_sessions')
        .update({ status: 'expired', ended_at: new Date().toISOString(), end_reason: 'inactivity_timeout' })
        .eq('id', sessionId);
      throw new UnauthorizedException('Sheer Lab session expired');
    }

    return {
      sessionId: data.id,
      businessId: data.business_id,
      locationId: data.location_id,
      sharedDeviceId: data.shared_device_id,
      userProfileId: data.user_profile_id,
      staffProfileId: await this.fetchStaffProfileId(data),
      role: data.role,
    };
  }

  private async fetchStaffProfileId(session: FormulaSessionRow): Promise<string | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id')
      .eq('business_id', session.business_id)
      .eq('primary_location_id', session.location_id)
      .eq('user_profile_id', session.user_profile_id)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`fetchStaffProfileId failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve stylist profile');
    }
    return data?.id;
  }

  private async fetchActiveSharedDevice(deviceId: string, locationId: string): Promise<SharedDeviceRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('shared_devices')
      .select('id,business_id,location_id,device_name,status')
      .eq('id', deviceId)
      .eq('location_id', locationId)
      .in('status', ['registered', 'active'])
      .maybeSingle<SharedDeviceRow>();

    if (error) {
      this.logger.error(`fetchActiveSharedDevice failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate shared device');
    }
    if (!data) throw new UnauthorizedException('Shared device is not registered for this location');
    return data;
  }

  private async fetchCredential(device: SharedDeviceRow, pin: string): Promise<PinCredentialRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('stylist_pin_credentials')
      .select(PIN_CREDENTIAL_COLUMNS)
      .eq('business_id', device.business_id)
      .eq('location_id', device.location_id)
      .eq('pin_hash', this.hashPin(device.business_id, device.location_id, pin))
      .eq('is_active', true)
      .maybeSingle<PinCredentialRow>();

    if (error) {
      this.logger.error(`fetchCredential failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate PIN');
    }
    if (!data) {
      await this.writeAuditEvent(device, 'pin_unlock_failed');
      throw new UnauthorizedException('Invalid PIN');
    }
    return data;
  }

  private async recordFailedPinAttempt(device: SharedDeviceRow, credential: PinCredentialRow): Promise<void> {
    const failedAttempts = credential.failed_attempts + 1;
    const lockedUntil =
      failedAttempts >= PIN_LOCK_THRESHOLD
        ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString()
        : credential.locked_until;

    await Promise.all([
      this.admin
        .schema('core')
        .from('stylist_pin_credentials')
        .update({
          failed_attempts: failedAttempts,
          locked_until: lockedUntil,
          status: lockedUntil ? 'locked' : credential.status,
        })
        .eq('id', credential.id),
      this.writeAuditEvent(device, 'pin_unlock_failed', credential.user_profile_id, {
        failedAttempts,
        lockedUntil,
      }),
    ]);
  }

  private async fetchStaffProfileForCredential(credential: PinCredentialRow): Promise<StaffProfileRow | undefined> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', credential.business_id)
      .eq('primary_location_id', credential.location_id)
      .eq('user_profile_id', credential.user_profile_id)
      .maybeSingle<StaffProfileRow>();

    if (error) {
      this.logger.error(`fetchStaffProfileForCredential failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve stylist profile');
    }
    return data ?? undefined;
  }

  private async writeAuditEvent(
    device: Pick<SharedDeviceRow, 'id' | 'business_id' | 'location_id'>,
    eventType: string,
    userProfileId?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.admin.schema('audit').from('lab_access_events').insert({
      business_id: device.business_id,
      location_id: device.location_id,
      shared_device_id: device.id,
      user_profile_id: userProfileId ?? null,
      event_type: eventType,
      metadata_json: metadata,
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

function first<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}
