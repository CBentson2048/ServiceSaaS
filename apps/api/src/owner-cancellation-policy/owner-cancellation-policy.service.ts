import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  LocationCancellationPolicy,
  UpdateCancellationPolicyRequest,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';

const HOURS_PER_DAY = 24;
// Matches the core.location_settings.cancellation_notice_hours column default.
const DEFAULT_NOTICE_HOURS = 24;

interface LocationSettingsRow {
  cancellation_notice_hours: number | null;
}

/**
 * Owner/manager configuration of the per-location cancellation window. Backed by
 * core.location_settings.cancellation_notice_hours (the same value the booking
 * flow already shows as the cancellation-notice policy). The contract is in whole
 * days; we convert to/from the stored hours.
 */
@Injectable()
export class OwnerCancellationPolicyService {
  private readonly logger = new Logger(OwnerCancellationPolicyService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getPolicy(actor: AuthUser, locationId: string): Promise<LocationCancellationPolicy> {
    this.assertManagementAccess(actor, locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, locationId);
    const hours = await this.fetchNoticeHours(actor.businessId, locationId);
    return { locationId, cancellationWindowDays: hoursToDays(hours) };
  }

  async updatePolicy(
    actor: AuthUser,
    input: UpdateCancellationPolicyRequest,
  ): Promise<LocationCancellationPolicy> {
    this.assertManagementAccess(actor, input.locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, input.locationId);
    if (!Number.isFinite(input.cancellationWindowDays) || input.cancellationWindowDays < 0) {
      throw new BadRequestException('cancellationWindowDays must be a number >= 0');
    }
    const hours = Math.round(input.cancellationWindowDays * HOURS_PER_DAY);

    // Upsert on the unique location_id; on conflict only these columns are written,
    // so the location's other booking settings are left untouched.
    const { error } = await this.admin
      .schema('core')
      .from('location_settings')
      .upsert(
        {
          business_id: actor.businessId,
          location_id: input.locationId,
          cancellation_notice_hours: hours,
        },
        { onConflict: 'location_id' },
      );
    if (error) {
      this.logger.error(`updatePolicy failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update cancellation policy');
    }
    return this.getPolicy(actor, input.locationId);
  }

  private async fetchNoticeHours(businessId: string, locationId: string): Promise<number> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('cancellation_notice_hours')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<LocationSettingsRow>();
    if (error) {
      this.logger.error(`fetchNoticeHours failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load cancellation policy');
    }
    const hours = data?.cancellation_notice_hours;
    return typeof hours === 'number' && hours >= 0 ? hours : DEFAULT_NOTICE_HOURS;
  }

  private async assertLocationBelongsToBusiness(
    businessId: string,
    locationId: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to verify location');
    if (!data) throw new BadRequestException('Location does not belong to this business');
  }

  private assertManagementAccess(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (userHasRole(actor, 'manager') && actor.allowedLocationIds.includes(locationId)) return;
    throw new ForbiddenException(
      'You do not have permission to manage the cancellation policy for this location',
    );
  }
}

// Stored hours are presented as days. Existing values divisible by 24 map cleanly
// (24→1, 48→2); anything else is rounded to 2dp so it round-trips legibly.
function hoursToDays(hours: number): number {
  return Math.round((hours / HOURS_PER_DAY) * 100) / 100;
}
