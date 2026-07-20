import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  LocationCommunicationSettings,
  UpdateLocationCommunicationSettingsRequest,
} from '@sheer/domain';
import {
  metadataToSettings,
  settingsToMetadata,
  type CommunicationMetadata,
} from './notification.types';

interface LocationSettingsRow {
  id: string;
  location_id: string;
  business_id: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Reads and writes the per-location communication / reminder rules stored under
 * `core.location_settings.metadata.communication`. Shared by the owner settings API
 * (write path) and the booking notification scheduler (read path), so there is a
 * single source of truth for how the JSON is interpreted.
 */
@Injectable()
export class CommunicationSettingsService {
  private readonly logger = new Logger(CommunicationSettingsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Resolve typed settings for a location, applying defaults for any unset fields. */
  async getForLocation(businessId: string, locationId: string): Promise<LocationCommunicationSettings> {
    const row = await this.fetchRow(businessId, locationId);
    return metadataToSettings(locationId, readCommunicationMetadata(row.metadata));
  }

  /**
   * Apply a partial update from the owner UI. Unspecified toggles are preserved.
   * Returns the resulting fully-resolved settings.
   */
  async update(
    businessId: string,
    input: UpdateLocationCommunicationSettingsRequest,
  ): Promise<LocationCommunicationSettings> {
    const row = await this.fetchRow(businessId, input.locationId);
    const existingMeta = readCommunicationMetadata(row.metadata);
    const current = metadataToSettings(input.locationId, existingMeta);

    const next: LocationCommunicationSettings = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      sendBookingConfirmation: input.sendBookingConfirmation ?? current.sendBookingConfirmation,
      reminder2hEnabled: input.reminder2hEnabled ?? current.reminder2hEnabled,
      reminder24hEnabled: input.reminder24hEnabled ?? current.reminder24hEnabled,
      reminder48hEnabled: input.reminder48hEnabled ?? current.reminder48hEnabled,
      reminder1wEnabled: input.reminder1wEnabled ?? current.reminder1wEnabled,
      emailFallbackEnabled: input.emailFallbackEnabled ?? current.emailFallbackEnabled,
      smsFallbackEnabled: input.smsFallbackEnabled ?? current.smsFallbackEnabled,
    };

    const nextMetadata = {
      ...(row.metadata ?? {}),
      communication: settingsToMetadata(next, existingMeta),
    };

    const { error } = await this.admin
      .schema('core')
      .from('location_settings')
      .update({ metadata: nextMetadata })
      .eq('id', row.id)
      .eq('business_id', businessId);

    if (error) {
      this.logger.error(`updateCommunicationSettings failed for ${input.locationId}: ${error.message}`);
      throw new InternalServerErrorException('Unable to update communication settings');
    }

    return next;
  }

  private async fetchRow(businessId: string, locationId: string): Promise<LocationSettingsRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('id,location_id,business_id,metadata')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<LocationSettingsRow>();

    if (error) {
      this.logger.error(`fetch location_settings failed for ${locationId}: ${error.message}`);
      throw new InternalServerErrorException('Unable to load communication settings');
    }
    if (!data) {
      throw new NotFoundException('Location settings not found for this location');
    }
    return data;
  }
}

function readCommunicationMetadata(
  metadata: Record<string, unknown> | null,
): CommunicationMetadata | null {
  const value = metadata?.['communication'];
  return value && typeof value === 'object' ? (value as CommunicationMetadata) : null;
}
