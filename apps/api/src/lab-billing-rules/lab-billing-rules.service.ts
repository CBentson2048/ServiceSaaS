import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ChargingStrategy,
  ResetServiceBillingRulesResponse,
  ServiceBillingCategory,
  ServiceBillingGlobalParameters,
  ServiceBillingRule,
  ServiceBillingRulesResponse,
  UpdateServiceBillingRulesResponse,
} from '@sheer/domain';

import type { LabRuntimeSession } from '../lab-session/lab-session.service';
import type { UpdateServiceBillingRulesDto } from './dto';

interface ServiceBillingRuleRow {
  id: string;
  location_id: string;
  category: ServiceBillingCategory;
  charging_strategy: ChargingStrategy;
  standard_allowance_grams: number | string;
  salon_markup_percent: number | string;
}

interface ServiceBillingSettingsRow {
  location_id: string;
  sample_usage_grams: number | string;
  base_cost_per_gram_cents: number | string;
  currency_code: string;
  default_markup_percent: number | string;
}

interface CategoryMeta {
  label: string;
  description: string;
  chargingStrategy: ChargingStrategy;
  standardAllowanceGrams: number;
  salonMarkupPercent: number;
}

// Fixed colour-service catalogue + the "smart defaults" that seed every new
// location (and back the Restore Defaults action). Order here is the display
// order used in the response.
const CATEGORY_META: Record<ServiceBillingCategory, CategoryMeta> = {
  permanent_colour: {
    label: 'Permanent Colour',
    description: 'Standard single-process applications',
    chargingStrategy: 'overage',
    standardAllowanceGrams: 40,
    salonMarkupPercent: 200,
  },
  lightener_bleach: {
    label: 'Lightener / Bleach',
    description: 'Pre-lift and lightening services',
    chargingStrategy: 'charge_all',
    standardAllowanceGrams: 60,
    salonMarkupPercent: 250,
  },
  semi_toners: {
    label: 'Semi & Toners',
    description: 'Glossing and post-lightening toning',
    chargingStrategy: 'overage',
    standardAllowanceGrams: 20,
    salonMarkupPercent: 150,
  },
  special_treatments: {
    label: 'Special Treatments',
    description: 'Bond builders and deep conditioning',
    chargingStrategy: 'track_only',
    standardAllowanceGrams: 15,
    salonMarkupPercent: 300,
  },
};

const CATEGORY_ORDER = Object.keys(CATEGORY_META) as ServiceBillingCategory[];

const GLOBAL_DEFAULTS = {
  sampleUsageGrams: 65,
  baseCostPerGramCents: 18,
  currencyCode: 'GBP',
  defaultMarkupPercent: 200,
};

const RULE_COLUMNS =
  'id,location_id,category,charging_strategy,standard_allowance_grams,salon_markup_percent';
const SETTINGS_COLUMNS =
  'location_id,sample_usage_grams,base_cost_per_gram_cents,currency_code,default_markup_percent';

@Injectable()
export class LabBillingRulesService {
  private readonly logger = new Logger(LabBillingRulesService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getRulesForLabSession(session: LabRuntimeSession): Promise<ServiceBillingRulesResponse> {
    this.assertManagement(session);
    await this.ensureSeeded(session, { overwrite: false });
    return this.loadResponse(session);
  }

  async updateRulesForLabSession(
    session: LabRuntimeSession,
    dto: UpdateServiceBillingRulesDto,
  ): Promise<UpdateServiceBillingRulesResponse> {
    this.assertManagement(session);
    await this.ensureSeeded(session, { overwrite: false });

    for (const rule of dto.rules ?? []) {
      const patch: Record<string, unknown> = {};
      if (rule.chargingStrategy !== undefined) patch.charging_strategy = rule.chargingStrategy;
      if (rule.standardAllowanceGrams !== undefined) {
        patch.standard_allowance_grams = rule.standardAllowanceGrams;
      }
      if (rule.salonMarkupPercent !== undefined) patch.salon_markup_percent = rule.salonMarkupPercent;
      if (Object.keys(patch).length === 0) continue;

      const { error } = await this.admin
        .schema('billing')
        .from('service_billing_rules')
        .update(patch)
        .eq('business_id', session.businessId)
        .eq('location_id', session.locationId)
        .eq('category', rule.category);
      if (error) {
        this.logger.error(`update service_billing_rules failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to update billing rules');
      }
    }

    if (dto.globalParameters) {
      const g = dto.globalParameters;
      const patch: Record<string, unknown> = {};
      if (g.sampleUsageGrams !== undefined) patch.sample_usage_grams = g.sampleUsageGrams;
      if (g.baseCostPerGramCents !== undefined) patch.base_cost_per_gram_cents = g.baseCostPerGramCents;
      if (g.currencyCode !== undefined) patch.currency_code = g.currencyCode.toUpperCase();
      if (g.defaultMarkupPercent !== undefined) patch.default_markup_percent = g.defaultMarkupPercent;
      if (Object.keys(patch).length > 0) {
        const { error } = await this.admin
          .schema('billing')
          .from('service_billing_settings')
          .update(patch)
          .eq('business_id', session.businessId)
          .eq('location_id', session.locationId);
        if (error) {
          this.logger.error(`update service_billing_settings failed: ${error.message}`);
          throw new InternalServerErrorException('Unable to update billing parameters');
        }
      }
    }

    return this.loadResponse(session);
  }

  async resetRulesForLabSession(session: LabRuntimeSession): Promise<ResetServiceBillingRulesResponse> {
    this.assertManagement(session);
    await this.ensureSeeded(session, { overwrite: true });
    return this.loadResponse(session);
  }

  // ---------------------------------------------------------------------------

  private assertManagement(session: LabRuntimeSession): void {
    if (session.role !== 'owner' && session.role !== 'manager') {
      throw new ForbiddenException('Billing & revenue rules are limited to owners and managers');
    }
  }

  /**
   * Guarantees the location has all four category rules and a settings row.
   * `overwrite: true` resets every value back to the smart defaults; otherwise
   * existing rows are left untouched and only missing ones are inserted.
   */
  private async ensureSeeded(
    session: LabRuntimeSession,
    { overwrite }: { overwrite: boolean },
  ): Promise<void> {
    const ruleRows = CATEGORY_ORDER.map((category) => {
      const meta = CATEGORY_META[category];
      return {
        business_id: session.businessId,
        location_id: session.locationId,
        category,
        charging_strategy: meta.chargingStrategy,
        standard_allowance_grams: meta.standardAllowanceGrams,
        salon_markup_percent: meta.salonMarkupPercent,
      };
    });

    const { error: ruleError } = await this.admin
      .schema('billing')
      .from('service_billing_rules')
      .upsert(ruleRows, { onConflict: 'location_id,category', ignoreDuplicates: !overwrite });
    if (ruleError) {
      this.logger.error(`seed service_billing_rules failed: ${ruleError.message}`);
      throw new InternalServerErrorException('Unable to initialise billing rules');
    }

    const settingsRow = {
      business_id: session.businessId,
      location_id: session.locationId,
      sample_usage_grams: GLOBAL_DEFAULTS.sampleUsageGrams,
      base_cost_per_gram_cents: GLOBAL_DEFAULTS.baseCostPerGramCents,
      currency_code: GLOBAL_DEFAULTS.currencyCode,
      default_markup_percent: GLOBAL_DEFAULTS.defaultMarkupPercent,
    };

    const { error: settingsError } = await this.admin
      .schema('billing')
      .from('service_billing_settings')
      .upsert(settingsRow, { onConflict: 'location_id', ignoreDuplicates: !overwrite });
    if (settingsError) {
      this.logger.error(`seed service_billing_settings failed: ${settingsError.message}`);
      throw new InternalServerErrorException('Unable to initialise billing parameters');
    }
  }

  private async loadResponse(session: LabRuntimeSession): Promise<ServiceBillingRulesResponse> {
    const [{ data: ruleData, error: ruleError }, { data: settingsData, error: settingsError }] =
      await Promise.all([
        this.admin
          .schema('billing')
          .from('service_billing_rules')
          .select(RULE_COLUMNS)
          .eq('business_id', session.businessId)
          .eq('location_id', session.locationId),
        this.admin
          .schema('billing')
          .from('service_billing_settings')
          .select(SETTINGS_COLUMNS)
          .eq('business_id', session.businessId)
          .eq('location_id', session.locationId)
          .maybeSingle<ServiceBillingSettingsRow>(),
      ]);

    if (ruleError) {
      this.logger.error(`load service_billing_rules failed: ${ruleError.message}`);
      throw new InternalServerErrorException('Unable to load billing rules');
    }
    if (settingsError) {
      this.logger.error(`load service_billing_settings failed: ${settingsError.message}`);
      throw new InternalServerErrorException('Unable to load billing parameters');
    }

    const byCategory = new Map<ServiceBillingCategory, ServiceBillingRuleRow>();
    for (const row of (ruleData ?? []) as ServiceBillingRuleRow[]) {
      byCategory.set(row.category, row);
    }

    const rules: ServiceBillingRule[] = CATEGORY_ORDER.filter((category) =>
      byCategory.has(category),
    ).map((category) => {
      const row = byCategory.get(category)!;
      const meta = CATEGORY_META[category];
      return {
        id: row.id,
        locationId: row.location_id,
        category,
        categoryLabel: meta.label,
        categoryDescription: meta.description,
        chargingStrategy: row.charging_strategy,
        standardAllowanceGrams: Number(row.standard_allowance_grams),
        salonMarkupPercent: Number(row.salon_markup_percent),
      };
    });

    const globalParameters: ServiceBillingGlobalParameters = settingsData
      ? {
          locationId: session.locationId,
          sampleUsageGrams: Number(settingsData.sample_usage_grams),
          baseCostPerGramCents: Number(settingsData.base_cost_per_gram_cents),
          currencyCode: settingsData.currency_code,
          defaultMarkupPercent: Number(settingsData.default_markup_percent),
        }
      : { locationId: session.locationId, ...GLOBAL_DEFAULTS };

    return { rules, globalParameters };
  }
}
