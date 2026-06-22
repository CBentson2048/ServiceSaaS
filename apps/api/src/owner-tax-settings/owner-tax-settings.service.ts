import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  defaultLocationTaxSettings,
  userHasRole,
  type AuthUser,
  type LocationTaxSettings,
  type TaxAppliesTo,
  type TaxDisplayMode,
  type UpdateLocationTaxSettingsRequest,
} from '@sheer/domain';

/**
 * The platform manages a single "primary" tax configuration per location. We pin
 * tax_code + effective_from to stable sentinels so the pre-existing
 *   unique (business_id, location_id, tax_code, effective_from)
 * constraint on billing.tax_settings reduces to "one row per location", giving a
 * clean upsert target. The effective-dating columns remain available for future
 * multi-jurisdiction support.
 */
const TAX_PRIMARY_CODE = 'primary';
const TAX_PRIMARY_EFFECTIVE_FROM = '2000-01-01';
const TAX_CONFLICT_TARGET = 'business_id,location_id,tax_code,effective_from';
const TAX_COLUMNS =
  'id,location_id,is_active,tax_name,rate_percentage,applies_to,display_mode';

interface TaxSettingsRow {
  id: string;
  location_id: string | null;
  is_active: boolean;
  tax_name: string | null;
  rate_percentage: number | string | null;
  applies_to: TaxAppliesTo | null;
  display_mode: TaxDisplayMode | null;
}

@Injectable()
export class OwnerTaxSettingsService {
  private readonly logger = new Logger(OwnerTaxSettingsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getTaxSettings(actor: AuthUser, locationId: string): Promise<LocationTaxSettings> {
    this.assertManagementAccess(actor, locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, locationId);
    return this.resolveLocationTaxSettings(actor.businessId, locationId);
  }

  async updateTaxSettings(
    actor: AuthUser,
    input: UpdateLocationTaxSettingsRequest,
  ): Promise<LocationTaxSettings> {
    this.assertManagementAccess(actor, input.locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, input.locationId);

    const existing = await this.fetchPrimaryRow(actor.businessId, input.locationId);
    const merged = mergeSettings(input.locationId, existing, input);
    this.validateMerged(merged);

    const { error } = await this.admin
      .schema('billing')
      .from('tax_settings')
      .upsert(
        {
          business_id: actor.businessId,
          location_id: input.locationId,
          tax_code: TAX_PRIMARY_CODE,
          effective_from: TAX_PRIMARY_EFFECTIVE_FROM,
          is_active: merged.taxEnabled,
          tax_name: merged.taxLabel,
          rate_percentage: merged.taxRatePercent,
          applies_to: merged.appliesTo,
          display_mode: merged.displayMode,
          // Keep the legacy boolean columns coherent with the richer enums so any
          // pre-existing consumer of billing.tax_settings still reads truthfully.
          is_price_inclusive: merged.displayMode === 'inc_tax',
          applies_to_services: merged.appliesTo !== 'retail',
        },
        { onConflict: TAX_CONFLICT_TARGET },
      );

    if (error) {
      this.logger.error(`updateTaxSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update tax settings');
    }

    return this.getTaxSettings(actor, input.locationId);
  }

  /**
   * Reusable, actor-less resolver for downstream modules (e.g. billing summaries).
   * Returns a tax-disabled default when the location has no configuration yet.
   */
  async resolveLocationTaxSettings(
    businessId: string,
    locationId: string,
  ): Promise<LocationTaxSettings> {
    const row = await this.fetchPrimaryRow(businessId, locationId);
    return row ? toSettings(row, locationId) : defaultLocationTaxSettings(locationId);
  }

  private validateMerged(merged: LocationTaxSettings): void {
    if (merged.taxRatePercent < 0) {
      throw new BadRequestException('taxRatePercent must be >= 0');
    }
    if (merged.taxEnabled && !(merged.taxLabel && merged.taxLabel.trim())) {
      throw new BadRequestException('taxLabel is required when tax is enabled');
    }
  }

  private async fetchPrimaryRow(
    businessId: string,
    locationId: string,
  ): Promise<TaxSettingsRow | null> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('tax_settings')
      .select(TAX_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .eq('tax_code', TAX_PRIMARY_CODE)
      .maybeSingle<TaxSettingsRow>();

    if (error) {
      this.logger.error(`fetchPrimaryRow failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load tax settings');
    }
    return data ?? null;
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
      'You do not have permission to manage tax settings for this location',
    );
  }
}

function toSettings(row: TaxSettingsRow, locationId: string): LocationTaxSettings {
  const rate =
    typeof row.rate_percentage === 'string'
      ? Number.parseFloat(row.rate_percentage)
      : row.rate_percentage ?? 0;
  return {
    locationId,
    taxEnabled: row.is_active,
    taxLabel: row.tax_name ?? null,
    taxRatePercent: Number.isFinite(rate) ? rate : 0,
    appliesTo: row.applies_to ?? 'both',
    displayMode: row.display_mode ?? 'ex_tax',
  };
}

function mergeSettings(
  locationId: string,
  existing: TaxSettingsRow | null,
  input: UpdateLocationTaxSettingsRequest,
): LocationTaxSettings {
  const current = existing ? toSettings(existing, locationId) : defaultLocationTaxSettings(locationId);
  return {
    locationId,
    taxEnabled: input.taxEnabled ?? current.taxEnabled,
    taxLabel:
      input.taxLabel !== undefined
        ? input.taxLabel === null || input.taxLabel.trim() === ''
          ? null
          : input.taxLabel.trim()
        : current.taxLabel,
    taxRatePercent: input.taxRatePercent ?? current.taxRatePercent,
    appliesTo: input.appliesTo ?? current.appliesTo,
    displayMode: input.displayMode ?? current.displayMode,
  };
}
