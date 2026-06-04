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
  RecordRetailSaleResponse,
  RetailPaymentMethod,
  RetailSale,
  RetailSalesListResponse,
} from '@sheer/domain';
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
}

const SALE_COLUMNS =
  'id,business_id,location_id,staff_profile_id,product_id,client_profile_id,visit_id,quantity,unit_price_cents,total_amount_cents,currency_code,payment_method,sold_at,notes,created_at';

@Injectable()
export class RetailSalesService {
  private readonly logger = new Logger(RetailSalesService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Record a retail sale (atomic with stock deduction via the DB function). */
  async record(actor: AuthUser, dto: RecordRetailSaleDto): Promise<RecordRetailSaleResponse> {
    const accessible = await this.accessibleLocationIds(actor);
    if (!accessible.includes(dto.locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }

    // Stylists may only attribute sales to themselves; owners/managers choose.
    const staffProfileId = actor.role === 'stylist' ? actor.staffProfileId : dto.staffProfileId;

    const { data, error } = await this.admin.schema('billing').rpc('record_retail_sale', {
      p_payload: {
        businessId: actor.businessId,
        locationId: dto.locationId,
        productId: dto.productId,
        staffProfileId: staffProfileId ?? null,
        clientProfileId: dto.clientProfileId ?? null,
        visitId: dto.visitId ?? null,
        quantity: dto.quantity,
        unitPriceCents: dto.unitPriceCents ?? null,
        paymentMethod: dto.paymentMethod ?? null,
        soldAt: dto.soldAt ?? null,
        notes: dto.notes ?? null,
        createdBy: actor.id,
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

  /** List retail sales for the actor's scope, optionally windowed. */
  async list(actor: AuthUser, query: RetailSalesQueryDto): Promise<RetailSalesListResponse> {
    if (actor.role !== 'owner' && actor.role !== 'manager') {
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
        scope: actor.role,
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
      scope: actor.role,
      selectedLocationId: query.locationId,
      rangeStart: query.from,
      rangeEnd: query.to,
      sales,
      totalAmountCents,
      currencyCode: sales[0]?.currencyCode ?? 'GBP',
    };
  }

  private async accessibleLocationIds(actor: AuthUser): Promise<string[]> {
    if (actor.role === 'owner') {
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
    };
  }
}
