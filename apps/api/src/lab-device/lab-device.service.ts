import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, LabDeviceRegistrationResponse, LabDeviceResolveResponse, SharedDevice } from '@sheer/domain';
import type { PairScaleDto, RegisterLabDeviceDto } from './dto';

interface SharedDeviceRow {
  id: string;
  business_id: string;
  location_id: string;
  device_name: string;
  device_type: 'ipad' | 'tablet' | 'browser';
  station_label: string | null;
  app_mode: 'sheer_lab';
  status: 'registered' | 'active' | 'inactive' | 'revoked';
  registered_at: string;
  last_seen_at: string | null;
}

interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  slug: string | null;
}

@Injectable()
export class LabDeviceService {
  private readonly logger = new Logger(LabDeviceService.name);
  private readonly admin: SupabaseClient;
  private readonly deviceTokenPepper: string;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.deviceTokenPepper = config.get<string>('SHEER_LAB_DEVICE_TOKEN_PEPPER') ?? serviceRoleKey;
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async register(actor: AuthUser, dto: RegisterLabDeviceDto): Promise<LabDeviceRegistrationResponse> {
    this.assertCanManageDevice(actor, dto.businessId, dto.locationId);
    const token = generateDeviceToken();
    const tokenHash = this.hashDeviceToken(token);
    const { data, error } = await this.admin
      .schema('core')
      .from('shared_devices')
      .insert({
        business_id: dto.businessId,
        location_id: dto.locationId,
        device_name: dto.deviceName.trim(),
        device_type: 'ipad',
        station_label: dto.stationLabel?.trim() || null,
        app_mode: 'sheer_lab',
        status: 'active',
        device_session_token_hash: tokenHash,
        device_session_issued_at: new Date().toISOString(),
      })
      .select(SHARED_DEVICE_COLUMNS)
      .single<SharedDeviceRow>();

    if (error || !data) {
      this.logger.error(`register failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to register Sheer Lab device');
    }

    await this.writeAuditEvent(data, 'device_registered');

    return {
      device: toSharedDevice(data),
      deviceSessionToken: token,
    };
  }

  async resolve(deviceSessionToken: string | undefined): Promise<LabDeviceResolveResponse> {
    if (!deviceSessionToken) throw new UnauthorizedException('Missing device session token');

    const { data, error } = await this.admin
      .schema('core')
      .from('shared_devices')
      .select(SHARED_DEVICE_COLUMNS)
      .eq('device_session_token_hash', this.hashDeviceToken(deviceSessionToken))
      .maybeSingle<SharedDeviceRow>();

    if (error) {
      this.logger.error(`resolve failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve Sheer Lab device');
    }
    if (!data) throw new UnauthorizedException('Invalid device session token');
    if (data.status === 'revoked' || data.status === 'inactive') {
      await this.writeAuditEvent(data, 'device_resolve_blocked', { status: data.status });
      throw new UnauthorizedException(`Sheer Lab device is ${data.status}`);
    }

    const location = await this.fetchLocation(data.business_id, data.location_id);
    await Promise.all([
      this.admin
        .schema('core')
        .from('shared_devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', data.id),
      this.writeAuditEvent(data, 'device_resolved'),
    ]);

    return {
      device: toSharedDevice(data),
      location: {
        id: location.id,
        name: location.name,
        code: location.code ?? undefined,
        slug: location.slug ?? undefined,
      },
    };
  }

  getStatus(): SharedDevice {
    throw new UnauthorizedException('Use /lab/device/resolve with a device session token');
  }

  pairScale(dto: PairScaleDto) {
    // TODO: store lab.device_pairings row and mark prior pairing revoked/disconnected transactionally.
    return {
      pairingStatus: 'paired',
      bleDeviceIdentifier: dto.bleDeviceIdentifier,
      bleDeviceName: dto.bleDeviceName,
      deviceModel: dto.deviceModel,
    };
  }

  unpairScale() {
    // TODO: mark active pairing as revoked and audit manager/device action.
    return { pairingStatus: 'unpaired' };
  }

  private assertCanManageDevice(actor: AuthUser, businessId: string, locationId: string): void {
    if (actor.role !== 'owner' && actor.role !== 'manager') {
      throw new ForbiddenException('Role is not allowed to register Sheer Lab devices');
    }
    if (actor.businessId !== businessId) {
      throw new ForbiddenException('Cannot register a device outside your business');
    }
    if (actor.role === 'owner') return;

    const allowedLocationIds = actor.locationScope?.locationIds ?? [];
    if (!allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Cannot register a device outside your location scope');
    }
  }

  private async fetchLocation(businessId: string, locationId: string): Promise<LocationRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,code,slug')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<LocationRow>();

    if (error) {
      this.logger.error(`fetchLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve Sheer Lab location');
    }
    if (!data) throw new UnauthorizedException('Sheer Lab device location is no longer valid');
    return data;
  }

  private hashDeviceToken(token: string): string {
    return createHash('sha256').update(`${token}:${this.deviceTokenPepper}`).digest('hex');
  }

  private async writeAuditEvent(
    device: Pick<SharedDeviceRow, 'id' | 'business_id' | 'location_id'>,
    eventType: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.admin.schema('audit').from('lab_access_events').insert({
      business_id: device.business_id,
      location_id: device.location_id,
      shared_device_id: device.id,
      event_type: eventType,
      metadata_json: metadata,
    });

    if (error) {
      this.logger.warn(`writeAuditEvent failed: ${error.message}`);
    }
  }
}

const SHARED_DEVICE_COLUMNS =
  'id,business_id,location_id,device_name,device_type,station_label,app_mode,status,registered_at,last_seen_at';

function generateDeviceToken(): string {
  return `sld_${randomBytes(32).toString('base64url')}`;
}

function toSharedDevice(row: SharedDeviceRow): SharedDevice {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    deviceName: row.device_name,
    deviceType: row.device_type,
    stationLabel: row.station_label ?? undefined,
    appMode: row.app_mode,
    status: row.status,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}
