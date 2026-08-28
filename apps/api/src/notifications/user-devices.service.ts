import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  userHasJoinedSalon,
  type AuthUser,
  type ListUserDevicesResponse,
  type RegisterUserDeviceResponse,
  type UserDeviceDto,
} from '@sheer/domain';
import type { RegisterDeviceDto } from './dto';
import { USER_DEVICE_COLUMNS, toUserDeviceDto, type UserDeviceRow } from './notification-mapping';

/**
 * User/device targeting foundation.
 *
 * SCOPE: this registers WHICH devices belong to WHICH user so a future push
 * delivery step has somewhere to look. It does not send anything — there is no
 * APNs/FCM integration in this ticket, deliberately. When push does land it should
 * follow the existing durable pattern (a persisted queue drained by a claim-based
 * poller, as NotificationDispatchService already does for outbound messaging) and
 * never an in-memory timer, so nothing is lost on restart.
 *
 * SECURITY: every method derives the owning user from the authenticated actor. No
 * endpoint accepts a userId, so User A cannot register, disable or enumerate a
 * device for User B. Cross-business assignment is additionally impossible inside
 * comms.register_user_device, which re-checks membership atomically.
 *
 * TOKEN HANDLING: push tokens are written but never returned, never logged, and
 * excluded from the `authenticated` column grants in migration 0099. Log lines here
 * carry device ids only. (They are stored unhashed, unlike
 * core.shared_devices.device_session_token_hash, because a push token is a delivery
 * address the server must transmit — not a credential it verifies.)
 */
@Injectable()
export class UserDevicesService {
  private readonly logger = new Logger(UserDevicesService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Register or refresh the acting user's device. Safe to call on every app launch:
   * the same installation upserts one row, rotates its token, re-enables it and
   * stamps last_seen_at. If the token was live on another device row it is taken
   * over, so one handset can never be pushed to twice.
   */
  async register(actor: AuthUser, body: RegisterDeviceDto): Promise<RegisterUserDeviceResponse> {
    // A device is registered against a business. A customer who has not joined a
    // salon has businessId '' and nothing to register against — refuse clearly
    // rather than passing an empty string where a uuid belongs.
    if (!userHasJoinedSalon(actor)) {
      throw new BadRequestException('Join a salon before registering a device');
    }

    const { data, error } = await this.admin.schema('comms').rpc('register_user_device', {
      p_business_id: actor.businessId,
      p_user_profile_id: actor.id,
      p_device_identifier: body.deviceIdentifier,
      p_platform: body.platform,
      p_push_token: body.pushToken ?? null,
    });

    if (error) {
      // Deliberately does not echo error.message to the client: it can contain the
      // statement, and the statement contains the push token.
      this.logger.error(
        `register device failed for user ${actor.id} business ${actor.businessId}: ${error.message}`,
      );
      throw new InternalServerErrorException('Unable to register device');
    }

    const deviceId = (Array.isArray(data) ? data[0] : data) as string | null;
    if (!deviceId) {
      throw new InternalServerErrorException('Unable to register device');
    }

    const device = await this.fetchOwnDevice(actor, deviceId);
    if (!device) {
      throw new InternalServerErrorException('Unable to register device');
    }
    return { device };
  }

  /** The acting user's own devices in this business. Never anyone else's. */
  async list(actor: AuthUser): Promise<ListUserDevicesResponse> {
    if (!userHasJoinedSalon(actor)) return { devices: [] };

    const { data, error } = await this.admin
      .schema('comms')
      .from('user_devices')
      .select(USER_DEVICE_COLUMNS)
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId)
      .order('last_seen_at', { ascending: false, nullsFirst: false })
      .returns<UserDeviceRow[]>();

    if (error) {
      this.logger.error(`list devices failed for user ${actor.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to load devices');
    }

    return { devices: (data ?? []).map(toUserDeviceDto) };
  }

  /**
   * Disable a device — the sign-out / "stop notifying this phone" path. The row is
   * kept (so a returning device keeps its identity and history) and its token is
   * cleared, which both stops delivery and frees the token for re-registration
   * elsewhere without tripping the one-enabled-row-per-token index.
   */
  async disable(actor: AuthUser, deviceId: string): Promise<RegisterUserDeviceResponse> {
    if (!userHasJoinedSalon(actor)) {
      throw new NotFoundException('Device not found');
    }

    const { data, error } = await this.admin
      .schema('comms')
      .from('user_devices')
      .update({ enabled: false, push_token: null })
      .eq('id', deviceId)
      // Scoped to the actor: another user's device id is indistinguishable from a
      // non-existent one, which is what a 404 should mean here.
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId)
      .select(USER_DEVICE_COLUMNS)
      .maybeSingle<UserDeviceRow>();

    if (error) {
      this.logger.error(`disable device ${deviceId} failed for user ${actor.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to update device');
    }
    if (!data) {
      throw new NotFoundException('Device not found');
    }

    return { device: toUserDeviceDto(data) };
  }

  private async fetchOwnDevice(actor: AuthUser, deviceId: string): Promise<UserDeviceDto | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('user_devices')
      .select(USER_DEVICE_COLUMNS)
      .eq('id', deviceId)
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId)
      .maybeSingle<UserDeviceRow>();

    if (error) {
      this.logger.error(`load device ${deviceId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load device');
    }
    return data ? toUserDeviceDto(data) : null;
  }
}
