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
  EffectiveRetailPricing,
  ListSellableProductsResponse,
  RecordRetailSaleResponse,
  RetailPaymentMethod,
  RetailPricingMode,
  RetailPricingSource,
  RetailSale,
  RetailSalesListResponse,
} from '@sheer/domain';
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import { PRODUCT_COLUMNS, toProduct, type ProductRow } from '../inventory/inventory.service';
import { RetailPricingService } from '../retail-pricing/retail-pricing.service';
import type { RecordRetailSaleDto, RetailSalesQueryDto } from './dto';

interface RetailSaleRow {
  id: string;
  business_id: string;
  location_id: string;
  staff_profile_id: string | null;
  product_id: string;
  client_profile_id: string | null;
  visit_id: string | null;
  quantity: number | string;
  unit_price_cents: number | string;
  total_amount_cents: number | string;
  currency_code: string;
  payment_method: RetailPaymentMethod | null;
  sold_at: string;
  notes: string | null;
  created_at: string;
  unit_cost_cents: number | null;
  pricing_mode: RetailPricingMode | null;
  pricing_source: RetailPricingSource | null;
  pricing_configured_value: number | string | null;
  effective_markup_percent: number | string | null;
}

const SALE_COLUMNS =
  'id,business_id,location_id,staff_profile_id,product_id,client_profile_id,visit_id,quantity,unit_price_cents,total_amount_cents,currency_code,payment_method,sold_at,notes,created_at,unit_cost_cents,pricing_mode,pricing_source,pricing_configured_value,effective_markup_percent';

@Injectable()
export class RetailSalesService {
  private readonly logger = new Logger(RetailSalesService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly pricing: RetailPricingService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Record a retail sale (atomic with stock deduction via the DB function).
   *
   * PRICE LOCK POINT: retail sales are single-shot — the effective price is
   * resolved HERE, through the canonical resolver, and snapshotted into the
   * sale row together with its provenance. Later configuration changes never
   * touch a recorded sale. A till-side unitPriceCents is a deliberate manual
   * override and is snapshotted as source "manual".
   */
  async record(actor: AuthUser, dto: RecordRetailSaleDto): Promise<RecordRetailSaleResponse> {
    const accessible = await this.accessibleLocationIds(actor);
    if (!accessible.includes(dto.locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }

    // Stylists may only attribute sales to themselves; owners/managers choose.
    // A user who is ALSO an owner/manager keeps the choose-any ability.
    const stylistOnly = userHasRole(actor, 'stylist') && !userHasAnyRole(actor, ['owner', 'manager']);
    const staffProfileId = stylistOnly ? actor.staffProfileId : dto.staffProfileId;

    // Canonical resolution (also validates the product belongs to the business).
    const pricingProduct = await this.pricing.fetchPricingProduct(actor.businessId, dto.productId);
    const resolved = (
      await this.pricing.resolveForProducts(actor.businessId, dto.locationId, [pricingProduct])
    ).get(dto.productId);

    // Explicit `!== undefined`: a manual price of 0 cents is a real override.
    const manual = dto.unitPriceCents !== undefined;
    const unitPriceCents = manual ? dto.unitPriceCents : (resolved?.sellingPriceCents ?? undefined);
    const snapshot = buildPricingSnapshot(manual, dto.unitPriceCents, resolved);

    const { data, error } = await this.admin.schema('billing').rpc('record_retail_sale', {
      p_payload: {
        businessId: actor.businessId,
        locationId: dto.locationId,
        productId: dto.productId,
        staffProfileId: staffProfileId ?? null,
        clientProfileId: dto.clientProfileId ?? null,
        visitId: dto.visitId ?? null,
        quantity: dto.quantity,
        unitPriceCents: unitPriceCents ?? null,
        paymentMethod: dto.paymentMethod ?? null,
        soldAt: dto.soldAt ?? null,
        notes: dto.notes ?? null,
        createdBy: actor.id,
        pricing: snapshot,
      },
    });

    if (error) {
      // Surface validation errors raised by the function as 400s.
      const message = error.message ?? 'Could not record retail sale';
      if (/required|positive|not active/i.test(message)) throw new BadRequestException(message);
      this.logger.error(`record_retail_sale failed: ${message}`);
      throw new InternalServerErrorException('Could not record retail sale');
    }

    const row = (Array.isArray(data) ? data[0] : data) as RetailSaleRow | null;
    if (!row) throw new InternalServerErrorException('Retail sale was not returned');
    return { sale: this.toRetailSale(row) };
  }

  /**
   * The retail picker: products the till may sell at THIS location.
   * A product appears only when it is classified Retail AND available at the
   * location (an active inventory.location_stock row) AND active — with its
   * effective price and provenance resolved canonically in one batch.
   * Classification and availability are independent: Retail=true at an
   * unavailable location shows nothing, and availability without the Retail
   * classification shows nothing.
   */
  async listSellable(actor: AuthUser, locationId: string): Promise<ListSellableProductsResponse> {
    const accessible = await this.accessibleLocationIds(actor);
    if (!accessible.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }

    const [{ data: productRows, error: productsError }, { data: stockRows, error: stockError }] =
      await Promise.all([
        this.admin
          .schema('inventory')
          .from('products')
          .select(PRODUCT_COLUMNS)
          .eq('business_id', actor.businessId)
          .eq('is_active', true)
          .eq('is_retail', true)
          .order('name', { ascending: true })
          .returns<ProductRow[]>(),
        this.admin
          .schema('inventory')
          .from('location_stock')
          .select('product_id,is_active')
          .eq('business_id', actor.businessId)
          .eq('location_id', locationId)
          .eq('is_active', true)
          .returns<{ product_id: string; is_active: boolean }[]>(),
      ]);
    if (productsError || stockError) {
      this.logger.error(`listSellable failed: ${(productsError ?? stockError)?.message}`);
      throw new InternalServerErrorException('Unable to load sellable products');
    }

    const availableIds = new Set((stockRows ?? []).map((row) => row.product_id));
    const sellableRows = (productRows ?? []).filter((row) => availableIds.has(row.id));
    const pricingByProduct = await this.pricing.resolveForProducts(
      actor.businessId,
      locationId,
      sellableRows.map((row) => ({
        id: row.id,
        business_id: row.business_id,
        category_id: row.category_id,
        stock_unit: row.stock_unit,
        pack_size: row.pack_size,
        size_value: row.size_value,
        default_cost_per_gram_cents: row.default_cost_per_gram_cents,
        retail_price_cents: row.retail_price_cents,
        is_active: row.is_active,
      })),
    );

    return {
      locationId,
      products: sellableRows.map((row) => ({
        product: toProduct(row),
        pricing: pricingByProduct.get(row.id) as EffectiveRetailPricing,
      })),
    };
  }

  /** List retail sales for the actor's scope, optionally windowed. */
  async list(actor: AuthUser, query: RetailSalesQueryDto): Promise<RetailSalesListResponse> {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Retail sales reports are limited to owners and managers');
    }
    const accessible = await this.accessibleLocationIds(actor);
    const locationIds =
      query.locationId !== undefined
        ? accessible.includes(query.locationId)
          ? [query.locationId]
          : []
        : accessible;

    if (locationIds.length === 0) {
      return {
        scope: userHasRole(actor, 'owner') ? 'owner' : 'manager',
        selectedLocationId: query.locationId,
        rangeStart: query.from,
        rangeEnd: query.to,
        sales: [],
        totalAmountCents: 0,
        currencyCode: 'GBP',
      };
    }

    let builder = this.admin
      .schema('billing')
      .from('retail_sales')
      .select(SALE_COLUMNS)
      .eq('business_id', actor.businessId)
      .in('location_id', locationIds)
      .order('sold_at', { ascending: false });
    if (query.staffProfileId) builder = builder.eq('staff_profile_id', query.staffProfileId);
    if (query.from) builder = builder.gte('sold_at', new Date(query.from).toISOString());
    if (query.to) builder = builder.lt('sold_at', new Date(query.to).toISOString());
    builder = builder.limit(query.limit ?? 200);

    const { data, error } = await builder.returns<RetailSaleRow[]>();
    if (error) {
      this.logger.error(`list retail sales failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load retail sales');
    }

    const rows = data ?? [];
    const productNames = await this.fetchProductNames(rows.map((r) => r.product_id));
    const sales = rows.map((row) => this.toRetailSale(row, productNames.get(row.product_id)));
    const totalAmountCents = sales.reduce((sum, s) => sum + s.totalAmountCents, 0);

    return {
      scope: userHasRole(actor, 'owner') ? 'owner' : 'manager',
      selectedLocationId: query.locationId,
      rangeStart: query.from,
      rangeEnd: query.to,
      sales,
      totalAmountCents,
      currencyCode: sales[0]?.currencyCode ?? 'GBP',
    };
  }

  private async accessibleLocationIds(actor: AuthUser): Promise<string[]> {
    if (userHasRole(actor, 'owner')) {
      const { data, error } = await this.admin
        .schema('core')
        .from('locations')
        .select('id')
        .eq('business_id', actor.businessId)
        .returns<{ id: string }[]>();
      if (error) {
        this.logger.error(`fetch locations failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to resolve locations');
      }
      return (data ?? []).map((l) => l.id);
    }
    return actor.allowedLocationIds;
  }

  // billing.retail_sales → inventory.products is a cross-schema relationship,
  // which PostgREST cannot embed, so product names are fetched and stitched.
  private async fetchProductNames(productIds: string[]): Promise<Map<string, string>> {
    const unique = Array.from(new Set(productIds));
    if (unique.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select('id,name')
      .in('id', unique)
      .returns<{ id: string; name: string }[]>();
    if (error) {
      this.logger.error(`fetch product names failed: ${error.message}`);
      return new Map();
    }
    return new Map((data ?? []).map((p) => [p.id, p.name]));
  }

  private toRetailSale(row: RetailSaleRow, productName?: string): RetailSale {
    return {
      id: row.id,
      businessId: row.business_id,
      locationId: row.location_id,
      staffProfileId: row.staff_profile_id ?? undefined,
      productId: row.product_id,
      productName,
      clientProfileId: row.client_profile_id ?? undefined,
      visitId: row.visit_id ?? undefined,
      quantity: Number(row.quantity),
      unitPriceCents: Number(row.unit_price_cents),
      totalAmountCents: Number(row.total_amount_cents),
      currencyCode: row.currency_code,
      paymentMethod: row.payment_method ?? undefined,
      soldAt: row.sold_at,
      notes: row.notes ?? undefined,
      createdAt: row.created_at,
      unitCostCents: row.unit_cost_cents ?? undefined,
      pricingMode: row.pricing_mode ?? undefined,
      pricingSource: row.pricing_source ?? undefined,
      pricingConfiguredValue:
        row.pricing_configured_value === null || row.pricing_configured_value === undefined
          ? undefined
          : Number(row.pricing_configured_value),
      effectiveMarkupPercent:
        row.effective_markup_percent === null || row.effective_markup_percent === undefined
          ? undefined
          : Number(row.effective_markup_percent),
    };
  }
}

/**
 * The immutable provenance recorded on the sale row. For a manual till-side
 * override the source is "manual" and the effective markup is derived from the
 * recorded cost; for a resolver price the resolver's own provenance is stored
 * verbatim. "none" (no rule, no legacy price) stores a null source.
 */
function buildPricingSnapshot(
  manual: boolean,
  manualUnitPriceCents: number | undefined,
  resolved: EffectiveRetailPricing | undefined,
): Record<string, unknown> {
  const cost = resolved?.unitCostCents ?? null;
  if (manual) {
    return {
      unitCostCents: cost,
      pricingMode: null,
      pricingSource: 'manual',
      configuredValue: null,
      effectiveMarkupPercent:
        cost !== null && cost > 0 && manualUnitPriceCents !== undefined
          ? Math.round(((manualUnitPriceCents - cost) / cost) * 10000) / 100
          : null,
    };
  }
  return {
    unitCostCents: cost,
    pricingMode: resolved?.pricingMode ?? null,
    pricingSource: resolved && resolved.source !== 'none' ? resolved.source : null,
    configuredValue: resolved?.configuredValue ?? null,
    effectiveMarkupPercent: resolved?.effectiveMarkupPercent ?? null,
  };
}
