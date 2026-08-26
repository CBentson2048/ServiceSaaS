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
  EffectiveRetailPricing,
  EffectiveRetailPricingResponse,
  ListRetailPricingRulesResponse,
  RetailPricingCandidates,
  RetailPricingRule,
  RetailPricingRuleResponse,
  RetailPricingScope,
  StockUnit,
} from '@sheer/domain';
import { resolveRetailPricing, retailUnitCostCents, userHasPermission, userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import type { ListPricingRulesQueryDto, UpsertPricingRuleDto } from './dto';

interface RuleRow {
  id: string;
  business_id: string;
  scope: RetailPricingScope;
  product_id: string | null;
  category_id: string | null;
  location_id: string | null;
  pricing_mode: 'percentage_markup' | 'fixed_price';
  markup_percent: number | string | null;
  fixed_price_cents: number | null;
  created_at: string;
  updated_at: string;
}

interface PricingProductRow {
  id: string;
  business_id: string;
  category_id: string | null;
  stock_unit: string | null;
  pack_size: number | string | null;
  size_value: number | string | null;
  default_cost_per_gram_cents: number | null;
  retail_price_cents: number | null;
  is_active: boolean;
}

const RULE_COLUMNS =
  'id,business_id,scope,product_id,category_id,location_id,pricing_mode,markup_percent,fixed_price_cents,created_at,updated_at';

/** Which id fields each scope requires — the DB enforces the same shape. */
const SCOPE_SHAPE: Record<RetailPricingScope, { product: boolean; category: boolean; location: boolean }> = {
  location_product: { product: true, category: false, location: true },
  product: { product: true, category: false, location: false },
  location_category: { product: false, category: true, location: true },
  category: { product: false, category: true, location: false },
  location: { product: false, category: false, location: true },
};

/**
 * Configuration and resolution of retail selling prices. Resolution itself is
 * the pure domain resolver (resolveRetailPricing) — this service only loads
 * data and enforces tenancy/permission boundaries. Writes are gated on
 * settings.billing.manage; location-bound rules additionally require the
 * location to be inside the caller's scope.
 */
@Injectable()
export class RetailPricingService {
  private readonly logger = new Logger(RetailPricingService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async listRules(actor: AuthUser, query: ListPricingRulesQueryDto): Promise<ListRetailPricingRulesResponse> {
    this.assertCanConfigure(actor);
    let request = this.admin
      .schema('inventory')
      .from('retail_pricing_rules')
      .select(RULE_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('scope', { ascending: true })
      .limit(2000);
    if (query.productId) request = request.eq('product_id', query.productId);
    if (query.categoryId) request = request.eq('category_id', query.categoryId);
    if (query.locationId) request = request.eq('location_id', query.locationId);

    const { data, error } = await request.returns<RuleRow[]>();
    if (error) {
      this.logger.error(`listRules failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pricing rules');
    }
    return { rules: (data ?? []).map(toRule) };
  }

  /**
   * Create or replace the rule at one level for one target. Explicit-zero rule:
   * a markupPercent of 0 is stored as 0 (an intentional override); "inherit" is
   * expressed by DELETING the rule, never by writing 0 or null.
   */
  async upsertRule(actor: AuthUser, dto: UpsertPricingRuleDto): Promise<RetailPricingRuleResponse> {
    this.assertCanConfigure(actor);

    const shape = SCOPE_SHAPE[dto.scope];
    if (shape.product !== (dto.productId !== undefined)) {
      throw new BadRequestException(`scope ${dto.scope} ${shape.product ? 'requires' : 'must not carry'} productId`);
    }
    if (shape.category !== (dto.categoryId !== undefined)) {
      throw new BadRequestException(`scope ${dto.scope} ${shape.category ? 'requires' : 'must not carry'} categoryId`);
    }
    if (shape.location !== (dto.locationId !== undefined)) {
      throw new BadRequestException(`scope ${dto.scope} ${shape.location ? 'requires' : 'must not carry'} locationId`);
    }

    // Exactly one value, matching the mode. `!== undefined` throughout: 0 is real.
    if (dto.pricingMode === 'percentage_markup') {
      if (dto.markupPercent === undefined) {
        throw new BadRequestException('markupPercent is required for percentage_markup (0 is a valid value)');
      }
      if (dto.fixedPriceCents !== undefined) {
        throw new BadRequestException('fixedPriceCents must not be supplied with percentage_markup');
      }
    } else {
      if (dto.fixedPriceCents === undefined) {
        throw new BadRequestException('fixedPriceCents is required for fixed_price');
      }
      if (dto.markupPercent !== undefined) {
        throw new BadRequestException('markupPercent must not be supplied with fixed_price');
      }
    }

    // Tenancy: every referenced entity must belong to the caller's business,
    // and location-bound rules must sit inside the caller's location scope.
    if (dto.productId) await this.assertProduct(actor.businessId, dto.productId);
    if (dto.categoryId) await this.assertCategory(actor.businessId, dto.categoryId);
    if (dto.locationId) await this.assertLocationScope(actor, dto.locationId);

    const { data, error } = await this.admin
      .schema('inventory')
      .from('retail_pricing_rules')
      .upsert(
        {
          business_id: actor.businessId,
          scope: dto.scope,
          product_id: dto.productId ?? null,
          category_id: dto.categoryId ?? null,
          location_id: dto.locationId ?? null,
          pricing_mode: dto.pricingMode,
          markup_percent: dto.pricingMode === 'percentage_markup' ? dto.markupPercent : null,
          fixed_price_cents: dto.pricingMode === 'fixed_price' ? dto.fixedPriceCents : null,
          created_by: actor.id,
        },
        { onConflict: 'business_id,scope,product_id,category_id,location_id' },
      )
      .select(RULE_COLUMNS)
      .single<RuleRow>();

    if (error || !data) {
      this.logger.error(`upsertRule failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to save pricing rule');
    }

    await this.audit.record(actor, {
      action: 'retail_pricing.rule_set',
      entityType: 'retail_pricing_rule',
      entityId: data.id,
      locationId: dto.locationId,
      after: {
        scope: dto.scope,
        pricingMode: dto.pricingMode,
        markupPercent: dto.markupPercent ?? null,
        fixedPriceCents: dto.fixedPriceCents ?? null,
      },
      metadata: { productId: dto.productId ?? null, categoryId: dto.categoryId ?? null },
    });
    return { rule: toRule(data) };
  }

  /** Delete a rule = restore inheritance at that level. */
  async deleteRule(actor: AuthUser, ruleId: string): Promise<RetailPricingRuleResponse> {
    this.assertCanConfigure(actor);
    const { data: existing, error: readError } = await this.admin
      .schema('inventory')
      .from('retail_pricing_rules')
      .select(RULE_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('id', ruleId)
      .maybeSingle<RuleRow>();
    if (readError) {
      this.logger.error(`deleteRule read failed: ${readError.message}`);
      throw new InternalServerErrorException('Unable to delete pricing rule');
    }
    if (!existing) throw new NotFoundException('Pricing rule not found');
    if (existing.location_id) await this.assertLocationScope(actor, existing.location_id);

    const { error } = await this.admin
      .schema('inventory')
      .from('retail_pricing_rules')
      .delete()
      .eq('business_id', actor.businessId)
      .eq('id', ruleId);
    if (error) {
      this.logger.error(`deleteRule failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete pricing rule');
    }

    await this.audit.record(actor, {
      action: 'retail_pricing.rule_cleared',
      entityType: 'retail_pricing_rule',
      entityId: ruleId,
      locationId: existing.location_id ?? undefined,
      before: {
        scope: existing.scope,
        pricingMode: existing.pricing_mode,
        markupPercent: existing.markup_percent === null ? null : Number(existing.markup_percent),
        fixedPriceCents: existing.fixed_price_cents,
      },
    });
    return { rule: toRule(existing) };
  }

  async getEffective(actor: AuthUser, productId: string, locationId: string): Promise<EffectiveRetailPricingResponse> {
    this.assertCanConfigure(actor);
    await this.assertLocationScope(actor, locationId);
    const product = await this.fetchPricingProduct(actor.businessId, productId);
    const pricingByProduct = await this.resolveForProducts(actor.businessId, locationId, [product]);
    const pricing = pricingByProduct.get(productId);
    if (!pricing) throw new InternalServerErrorException('Unable to resolve pricing');
    return { pricing };
  }

  /**
   * Batch resolution for pickers/lists: ONE rules query for any number of
   * products, resolved in memory through the canonical resolver — never five
   * round-trips per product.
   */
  async resolveForProducts(
    businessId: string,
    locationId: string,
    products: PricingProductRow[],
  ): Promise<Map<string, EffectiveRetailPricing>> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('retail_pricing_rules')
      .select(RULE_COLUMNS)
      .eq('business_id', businessId)
      .limit(5000)
      .returns<RuleRow[]>();
    if (error) {
      this.logger.error(`resolveForProducts rules failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pricing rules');
    }
    const rules = data ?? [];

    const result = new Map<string, EffectiveRetailPricing>();
    for (const product of products) {
      const candidates: RetailPricingCandidates = {};
      for (const rule of rules) {
        const belongs =
          (rule.scope === 'location_product' && rule.product_id === product.id && rule.location_id === locationId) ||
          (rule.scope === 'product' && rule.product_id === product.id) ||
          (rule.scope === 'location_category' &&
            product.category_id !== null &&
            rule.category_id === product.category_id &&
            rule.location_id === locationId) ||
          (rule.scope === 'category' && product.category_id !== null && rule.category_id === product.category_id) ||
          (rule.scope === 'location' && rule.location_id === locationId);
        if (!belongs) continue;
        candidates[rule.scope] = {
          id: rule.id,
          pricingMode: rule.pricing_mode,
          markupPercent: rule.markup_percent === null ? undefined : Number(rule.markup_percent),
          fixedPriceCents: rule.fixed_price_cents ?? undefined,
        };
      }

      result.set(
        product.id,
        resolveRetailPricing({
          productId: product.id,
          locationId,
          unitCostCents: retailUnitCostCents({
            stockUnit: (product.stock_unit ?? 'gram') as StockUnit,
            packSize: product.pack_size === null ? null : Number(product.pack_size),
            sizeValue: product.size_value === null ? null : Number(product.size_value),
            defaultCostPerGramCents: product.default_cost_per_gram_cents,
          }),
          legacyRetailPriceCents: product.retail_price_cents,
          candidates,
        }),
      );
    }
    return result;
  }

  async fetchPricingProduct(businessId: string, productId: string): Promise<PricingProductRow> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select('id,business_id,category_id,stock_unit,pack_size,size_value,default_cost_per_gram_cents,retail_price_cents,is_active')
      .eq('business_id', businessId)
      .eq('id', productId)
      .maybeSingle<PricingProductRow>();
    if (error) {
      this.logger.error(`fetchPricingProduct failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load product');
    }
    if (!data) throw new NotFoundException('Product not found');
    return data;
  }

  private assertCanConfigure(actor: AuthUser): void {
    if (!userHasPermission(actor, 'settings.billing.manage')) {
      throw new ForbiddenException('You do not have permission to manage retail pricing');
    }
  }

  private async assertLocationScope(actor: AuthUser, locationId: string): Promise<void> {
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', actor.businessId)
      .eq('id', locationId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to validate location');
    if (!data) throw new BadRequestException('locationId is not valid for this business');
  }

  private async assertProduct(businessId: string, productId: string): Promise<void> {
    await this.fetchPricingProduct(businessId, productId);
  }

  private async assertCategory(businessId: string, categoryId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('categories')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', categoryId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to validate category');
    if (!data) throw new BadRequestException('categoryId is not valid for this business');
  }
}

export type { PricingProductRow };

function toRule(row: RuleRow): RetailPricingRule {
  return {
    id: row.id,
    businessId: row.business_id,
    scope: row.scope,
    productId: row.product_id ?? undefined,
    categoryId: row.category_id ?? undefined,
    locationId: row.location_id ?? undefined,
    pricingMode: row.pricing_mode,
    markupPercent: row.markup_percent === null ? undefined : Number(row.markup_percent),
    fixedPriceCents: row.fixed_price_cents ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
