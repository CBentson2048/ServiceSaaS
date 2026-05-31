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
  AuthUser,
  LocationProductBillingSettings,
  ProductBillingRule,
  UpdateLocationProductBillingSettingsRequest,
} from '@sheer/domain';

interface BillingRulesRow {
  id: string;
  location_id: string;
  product_billing_enabled: boolean;
  product_billing_rule: string;
  product_markup_percent: number | null;
  product_fixed_uplift_amount: number | null;
}

const PRODUCT_BILLING_COLUMNS =
  'id,location_id,product_billing_enabled,product_billing_rule,product_markup_percent,product_fixed_uplift_amount';

@Injectable()
export class OwnerBillingSettingsService {
  private readonly logger = new Logger(OwnerBillingSettingsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getProductBillingSettings(
    actor: AuthUser,
    locationId: string,
  ): Promise<LocationProductBillingSettings> {
    this.assertManagementAccess(actor, locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, locationId);

    const row = await this.fetchBillingRulesRow(actor.businessId, locationId);
    return toSettings(row, locationId);
  }

  async updateProductBillingSettings(
    actor: AuthUser,
    input: UpdateLocationProductBillingSettingsRequest,
  ): Promise<LocationProductBillingSettings> {
    this.assertManagementAccess(actor, input.locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, input.locationId);
    this.validateInput(input);

    const existing = await this.fetchBillingRulesRow(actor.businessId, input.locationId);

    const merged = mergeSettings(existing, input);

    const { error } = await this.admin
      .schema('billing')
      .from('billing_rules')
      .update({
        product_billing_enabled: merged.productBillingEnabled,
        product_billing_rule: merged.productBillingRule,
        product_markup_percent: merged.productMarkupPercent,
        product_fixed_uplift_amount: merged.productFixedUpliftAmount,
      })
      .eq('id', existing.id)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`updateProductBillingSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update product billing settings');
    }

    return this.getProductBillingSettings(actor, input.locationId);
  }

  private validateInput(input: UpdateLocationProductBillingSettingsRequest): void {
    const rule = input.productBillingRule;
    if (!rule) return;

    if (rule === 'cost_plus_markup_percent') {
      if (input.productMarkupPercent === null || input.productMarkupPercent === undefined) {
        throw new BadRequestException(
          'productMarkupPercent is required when productBillingRule is cost_plus_markup_percent',
        );
      }
      if (input.productMarkupPercent < 0) {
        throw new BadRequestException('productMarkupPercent must be >= 0');
      }
    }

    if (rule === 'fixed_uplift') {
      if (input.productFixedUpliftAmount === null || input.productFixedUpliftAmount === undefined) {
        throw new BadRequestException(
          'productFixedUpliftAmount is required when productBillingRule is fixed_uplift',
        );
      }
      if (input.productFixedUpliftAmount < 0) {
        throw new BadRequestException('productFixedUpliftAmount must be >= 0');
      }
    }
  }

  private async fetchBillingRulesRow(
    businessId: string,
    locationId: string,
  ): Promise<BillingRulesRow> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('billing_rules')
      .select(PRODUCT_BILLING_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<BillingRulesRow>();

    if (error) {
      this.logger.error(`fetchBillingRulesRow failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load billing rules');
    }
    if (!data) {
      throw new NotFoundException(
        `No billing rules found for location ${locationId}. Ensure the location has been fully provisioned.`,
      );
    }
    return data;
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
    if (actor.role === 'owner') return;
    if (actor.role === 'manager' && actor.allowedLocationIds.includes(locationId)) return;
    throw new ForbiddenException('You do not have permission to manage billing settings for this location');
  }
}

function toSettings(row: BillingRulesRow, locationId: string): LocationProductBillingSettings {
  return {
    locationId,
    productBillingEnabled: row.product_billing_enabled,
    productBillingRule: row.product_billing_rule as ProductBillingRule,
    productMarkupPercent: row.product_markup_percent !== undefined ? row.product_markup_percent : null,
    productFixedUpliftAmount:
      row.product_fixed_uplift_amount !== undefined ? row.product_fixed_uplift_amount : null,
  };
}

function mergeSettings(
  existing: BillingRulesRow,
  input: UpdateLocationProductBillingSettingsRequest,
): LocationProductBillingSettings {
  const rule: ProductBillingRule =
    (input.productBillingRule as ProductBillingRule | undefined) ??
    (existing.product_billing_rule as ProductBillingRule);

  return {
    locationId: existing.location_id,
    productBillingEnabled: input.productBillingEnabled ?? existing.product_billing_enabled,
    productBillingRule: rule,
    productMarkupPercent:
      rule === 'cost_plus_markup_percent'
        ? (input.productMarkupPercent ?? existing.product_markup_percent ?? null)
        : null,
    productFixedUpliftAmount:
      rule === 'fixed_uplift'
        ? (input.productFixedUpliftAmount ?? existing.product_fixed_uplift_amount ?? null)
        : null,
  };
}
