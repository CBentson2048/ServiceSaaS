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
  BusinessLocationSummary,
  InventoryLocationStock,
  InventoryLowStockAlert,
  InventoryProduct,
  InventoryProductResponse,
  InventoryStockMovement,
  InventoryStockMutationResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
} from '@sheer/domain';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';
import type {
  AdjustInventoryStockDto,
  InitializeInventoryStockDto,
  InventoryQueryDto,
  MovementQueryDto,
  StockQueryDto,
  UpdateInventoryStockThresholdDto,
  UpsertInventoryProductDto,
} from './dto';

interface ProductRow {
  id: string;
  business_id: string;
  brand: string | null;
  name: string;
  category: string | null;
  sku: string | null;
  size_value: number | string | null;
  size_unit: string;
  default_unit: string;
  default_cost_per_gram_cents: number | null;
  retail_price_cents: number | null;
  low_stock_threshold_grams: number | string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface LocationRow {
  id: string;
  name: string;
}

interface StockRow {
  id: string;
  business_id: string;
  location_id: string;
  product_id: string;
  quantity_on_hand_grams: number | string;
  low_stock_threshold_grams: number | string | null;
  is_active: boolean;
  updated_at: string;
}

interface MovementRow {
  id: string;
  business_id: string;
  location_id: string;
  product_id: string;
  location_stock_id: string | null;
  movement_type: InventoryStockMovement['movementType'];
  quantity_delta_grams: number | string;
  unit_cost_cents: number | null;
  total_cost_cents: number | null;
  reference_type: string | null;
  reference_id: string | null;
  reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

interface AlertRow {
  id: string;
  location_id: string;
  product_id: string;
  remaining_quantity_grams: number | string;
  threshold_quantity_grams: number | string;
  status: 'open' | 'acknowledged' | 'resolved';
  last_triggered_at: string;
}

const PRODUCT_COLUMNS =
  'id,business_id,brand,name,category,sku,size_value,size_unit,default_unit,default_cost_per_gram_cents,retail_price_cents,low_stock_threshold_grams,is_active,created_at,updated_at';
const STOCK_COLUMNS =
  'id,business_id,location_id,product_id,quantity_on_hand_grams,low_stock_threshold_grams,is_active,updated_at';
const MOVEMENT_COLUMNS =
  'id,business_id,location_id,product_id,location_stock_id,movement_type,quantity_delta_grams,unit_cost_cents,total_cost_cents,reference_type,reference_id,reason,notes,created_by,created_at';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async listProducts(actor: AuthUser, query: InventoryQueryDto): Promise<ListInventoryProductsResponse> {
    this.assertManagerOrOwner(actor);
    return this.listProductsForBusiness(actor.businessId, query);
  }

  async listProductsForLabSession(
    session: LabRuntimeSession,
    query: InventoryQueryDto,
  ): Promise<ListInventoryProductsResponse> {
    return this.listProductsForBusiness(session.businessId, {
      ...query,
      includeInactive: false,
    });
  }

  async createProduct(actor: AuthUser, dto: UpsertInventoryProductDto): Promise<InventoryProductResponse> {
    this.assertOwner(actor);
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .insert(toProductInsert(actor.businessId, dto))
      .select(PRODUCT_COLUMNS)
      .single<ProductRow>();

    if (error || !data) {
      this.logger.error(`createProduct failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create inventory product');
    }
    return { product: toProduct(data) };
  }

  async updateProduct(actor: AuthUser, productId: string, dto: UpsertInventoryProductDto): Promise<InventoryProductResponse> {
    this.assertOwner(actor);
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .update(toProductPatch(dto))
      .eq('id', productId)
      .eq('business_id', actor.businessId)
      .select(PRODUCT_COLUMNS)
      .maybeSingle<ProductRow>();

    if (error) {
      this.logger.error(`updateProduct failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update inventory product');
    }
    if (!data) throw new NotFoundException('Inventory product not found');
    return { product: toProduct(data) };
  }

  async archiveProduct(actor: AuthUser, productId: string): Promise<InventoryProductResponse> {
    this.assertOwner(actor);
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .update({ is_active: false })
      .eq('id', productId)
      .eq('business_id', actor.businessId)
      .select(PRODUCT_COLUMNS)
      .maybeSingle<ProductRow>();

    if (error) {
      this.logger.error(`archiveProduct failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to archive inventory product');
    }
    if (!data) throw new NotFoundException('Inventory product not found');
    return { product: toProduct(data) };
  }

  async listStock(actor: AuthUser, query: StockQueryDto): Promise<ListInventoryStockResponse> {
    this.assertManagerOrOwner(actor);
    const locationIds = await this.resolveLocationScope(actor, query.locationId);
    const locations = await this.fetchLocations(actor.businessId, locationIds);
    if (locationIds.length === 0) return { stock: [], locations, scope: actor.role === 'owner' ? 'owner' : 'manager' };

    const request = this.admin
      .schema('inventory')
      .from('location_stock')
      .select(STOCK_COLUMNS)
      .eq('business_id', actor.businessId)
      .in('location_id', locationIds)
      .order('updated_at', { ascending: false });

    const { data, error } = await request.returns<StockRow[]>();
    if (error) {
      this.logger.error(`listStock failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location stock');
    }

    const products = await this.fetchProductsById(actor.businessId, (data ?? []).map((row) => row.product_id));
    let stock = (data ?? []).map((row) => toStock(row, products, locations));
    const term = query.q?.trim().toLowerCase();
    if (term) {
      stock = stock.filter((row) => [row.productName, row.brand ?? '', row.sku ?? '', row.category ?? ''].join(' ').toLowerCase().includes(term));
    }
    if (query.lowStockOnly) stock = stock.filter((row) => row.isLowStock);
    return { stock, locations, scope: actor.role === 'owner' ? 'owner' : 'manager' };
  }

  async initializeStock(actor: AuthUser, dto: InitializeInventoryStockDto): Promise<InventoryStockMutationResponse> {
    await this.assertLocationScope(actor, dto.locationId);
    await this.assertProduct(actor.businessId, dto.productId);

    const { error } = await this.admin.schema('inventory').from('location_stock').upsert(
      {
        business_id: actor.businessId,
        location_id: dto.locationId,
        product_id: dto.productId,
        quantity_on_hand_grams: 0,
        low_stock_threshold_grams: dto.lowStockThresholdGrams ?? null,
        is_active: true,
      },
      { onConflict: 'location_id,product_id' },
    );
    if (error) {
      this.logger.error(`initializeStock upsert failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to initialize stock');
    }

    if ((dto.quantityOnHandGrams ?? 0) > 0) {
      await this.adjustStock(actor, {
        locationId: dto.locationId,
        productId: dto.productId,
        quantityDeltaGrams: dto.quantityOnHandGrams ?? 0,
        movementType: 'opening_balance',
        reason: 'opening_balance',
      });
    }

    return { stock: await this.fetchStock(actor, dto.locationId, dto.productId) };
  }

  async adjustStock(actor: AuthUser, dto: AdjustInventoryStockDto): Promise<InventoryStockMutationResponse> {
    await this.assertLocationScope(actor, dto.locationId);
    await this.assertProduct(actor.businessId, dto.productId);
    if (dto.quantityDeltaGrams === 0) throw new BadRequestException('quantityDeltaGrams must not be zero');

    const { error } = await this.admin.schema('inventory').rpc('adjust_location_stock', {
      p_payload: {
        businessId: actor.businessId,
        locationId: dto.locationId,
        productId: dto.productId,
        quantityDeltaGrams: dto.quantityDeltaGrams,
        movementType: dto.movementType,
        reason: dto.reason,
        notes: dto.notes,
        createdBy: actor.id,
      },
    });
    if (error) {
      this.logger.error(`adjustStock failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to adjust stock');
    }
    return { stock: await this.fetchStock(actor, dto.locationId, dto.productId) };
  }

  async updateStockThreshold(
    actor: AuthUser,
    stockId: string,
    dto: UpdateInventoryStockThresholdDto,
  ): Promise<InventoryStockMutationResponse> {
    const existing = await this.fetchStockRowById(actor.businessId, stockId);
    await this.assertLocationScope(actor, existing.location_id);
    const patch: Record<string, unknown> = {};
    if ('lowStockThresholdGrams' in dto) patch.low_stock_threshold_grams = dto.lowStockThresholdGrams ?? null;
    if ('isActive' in dto) patch.is_active = dto.isActive;

    const { data, error } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .update(patch)
      .eq('id', stockId)
      .select(STOCK_COLUMNS)
      .single<StockRow>();

    if (error || !data) {
      this.logger.error(`updateStockThreshold failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to update stock threshold');
    }
    await this.maintainLowStockAlert(actor.businessId, data);
    return { stock: await this.fetchStock(actor, data.location_id, data.product_id) };
  }

  async listMovements(actor: AuthUser, query: MovementQueryDto): Promise<ListInventoryMovementsResponse> {
    this.assertManagerOrOwner(actor);
    const locationIds = await this.resolveLocationScope(actor, query.locationId);
    if (locationIds.length === 0) return { movements: [] };

    let request = this.admin
      .schema('inventory')
      .from('stock_movements')
      .select(MOVEMENT_COLUMNS)
      .eq('business_id', actor.businessId)
      .in('location_id', locationIds)
      .order('created_at', { ascending: false })
      .limit(Math.min(query.limit ?? 50, 200));
    if (query.productId) request = request.eq('product_id', query.productId);

    const { data, error } = await request.returns<MovementRow[]>();
    if (error) {
      this.logger.error(`listMovements failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stock movements');
    }
    const [products, locations] = await Promise.all([
      this.fetchProductsById(actor.businessId, (data ?? []).map((row) => row.product_id)),
      this.fetchLocations(actor.businessId, locationIds),
    ]);
    return { movements: (data ?? []).map((row) => toMovement(row, products, locations)) };
  }

  async listLowStock(actor: AuthUser, locationId?: string): Promise<ListInventoryLowStockResponse> {
    const locationIds = await this.resolveLocationScope(actor, locationId);
    if (locationIds.length === 0) return { alerts: [] };
    const { data, error } = await this.admin
      .schema('inventory')
      .from('low_stock_alerts')
      .select('id,location_id,product_id,remaining_quantity_grams,threshold_quantity_grams,status,last_triggered_at')
      .eq('business_id', actor.businessId)
      .in('location_id', locationIds)
      .eq('status', 'open')
      .order('last_triggered_at', { ascending: false })
      .returns<AlertRow[]>();
    if (error) {
      this.logger.error(`listLowStock failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load low-stock alerts');
    }
    const [products, locations] = await Promise.all([
      this.fetchProductsById(actor.businessId, (data ?? []).map((row) => row.product_id)),
      this.fetchLocations(actor.businessId, locationIds),
    ]);
    return { alerts: (data ?? []).map((row) => toAlert(row, products, locations)) };
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (actor.role !== 'owner' && actor.role !== 'manager') {
      throw new ForbiddenException('Inventory is limited to owners and managers');
    }
  }

  private assertOwner(actor: AuthUser): void {
    if (actor.role !== 'owner') throw new ForbiddenException('Only owners can manage product catalogue');
  }

  private async assertLocationScope(actor: AuthUser, locationId: string): Promise<void> {
    this.assertManagerOrOwner(actor);
    if (actor.role !== 'owner' && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your inventory scope');
    }
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', actor.businessId)
      .eq('id', locationId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertLocationScope failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate location');
    }
    if (!data) throw new BadRequestException('locationId is not valid for this business');
  }

  private async resolveLocationScope(actor: AuthUser, locationId?: string): Promise<string[]> {
    this.assertManagerOrOwner(actor);
    if (locationId) {
      await this.assertLocationScope(actor, locationId);
      return [locationId];
    }
    if (actor.role === 'manager') return actor.allowedLocationIds;
    const locations = await this.fetchLocations(actor.businessId);
    return locations.map((location) => location.id);
  }

  private async assertProduct(businessId: string, productId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', productId)
      .eq('is_active', true)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertProduct failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate product');
    }
    if (!data) throw new NotFoundException('Inventory product not found');
  }

  private async fetchStock(actor: AuthUser, locationId: string, productId: string): Promise<InventoryLocationStock> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .select(STOCK_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('location_id', locationId)
      .eq('product_id', productId)
      .single<StockRow>();
    if (error || !data) throw new InternalServerErrorException('Unable to load updated stock');
    const [products, locations] = await Promise.all([
      this.fetchProductsById(actor.businessId, [productId]),
      this.fetchLocations(actor.businessId, [locationId]),
    ]);
    return toStock(data, products, locations);
  }

  private async fetchStockRowById(businessId: string, stockId: string): Promise<StockRow> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .select(STOCK_COLUMNS)
      .eq('business_id', businessId)
      .eq('id', stockId)
      .maybeSingle<StockRow>();
    if (error) throw new InternalServerErrorException('Unable to load stock record');
    if (!data) throw new NotFoundException('Stock record not found');
    return data;
  }

  private async listProductsForBusiness(
    businessId: string,
    query: InventoryQueryDto,
  ): Promise<ListInventoryProductsResponse> {
    let request = this.admin
      .schema('inventory')
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('business_id', businessId)
      .order('brand', { ascending: true })
      .order('name', { ascending: true });

    if (!query.includeInactive) request = request.eq('is_active', true);
    if (query.category) request = request.ilike('category', `%${query.category.trim()}%`);
    if (query.q?.trim()) {
      const term = escapeSupabaseOr(query.q.trim());
      request = request.or(`name.ilike.%${term}%,brand.ilike.%${term}%,sku.ilike.%${term}%,category.ilike.%${term}%`);
    }

    const { data, error } = await request.returns<ProductRow[]>();
    if (error) {
      this.logger.error(`listProducts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load inventory products');
    }
    return { products: (data ?? []).map(toProduct) };
  }

  private async fetchProductsById(businessId: string, productIds: string[]): Promise<Map<string, InventoryProduct>> {
    const ids = Array.from(new Set(productIds));
    if (ids.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<ProductRow[]>();
    if (error) {
      this.logger.error(`fetchProductsById failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load inventory products');
    }
    return new Map((data ?? []).map((row) => [row.id, toProduct(row)]));
  }

  private async fetchLocations(businessId: string, locationIds?: string[]): Promise<BusinessLocationSummary[]> {
    let query = this.admin.schema('core').from('locations').select('id,name').eq('business_id', businessId);
    if (locationIds) {
      if (locationIds.length === 0) return [];
      query = query.in('id', locationIds);
    }
    const { data, error } = await query.order('name', { ascending: true }).returns<LocationRow[]>();
    if (error) throw new InternalServerErrorException('Unable to load locations');
    return (data ?? []).map((row) => ({ id: row.id, name: row.name }));
  }

  private async maintainLowStockAlert(businessId: string, stock: StockRow): Promise<void> {
    const product = (await this.fetchProductsById(businessId, [stock.product_id])).get(stock.product_id);
    const threshold = Number(stock.low_stock_threshold_grams ?? product?.lowStockThresholdGrams ?? 0);
    const remaining = Number(stock.quantity_on_hand_grams);
    if (threshold > 0 && remaining <= threshold) {
      await this.admin.schema('inventory').from('low_stock_alerts').upsert(
        {
          business_id: businessId,
          location_id: stock.location_id,
          product_id: stock.product_id,
          remaining_quantity_grams: remaining,
          threshold_quantity_grams: threshold,
          status: 'open',
          last_triggered_at: new Date().toISOString(),
        },
        { onConflict: 'location_id,product_id,status' },
      );
      return;
    }
    await this.admin
      .schema('inventory')
      .from('low_stock_alerts')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('location_id', stock.location_id)
      .eq('product_id', stock.product_id)
      .eq('status', 'open');
  }
}

function toProductInsert(businessId: string, dto: UpsertInventoryProductDto): Record<string, unknown> {
  return {
    business_id: businessId,
    ...toProductPatch(dto),
    is_active: true,
  };
}

function toProductPatch(dto: UpsertInventoryProductDto): Record<string, unknown> {
  return {
    brand: clean(dto.brand),
    name: dto.name.trim(),
    category: clean(dto.category),
    sku: clean(dto.sku),
    size_value: dto.sizeValue ?? null,
    size_unit: clean(dto.sizeUnit) ?? 'g',
    default_unit: clean(dto.defaultUnit) ?? 'g',
    default_cost_per_gram_cents: dto.defaultCostPerGramCents ?? null,
    retail_price_cents: dto.retailPriceCents ?? null,
    low_stock_threshold_grams: dto.lowStockThresholdGrams ?? 0,
  };
}

function clean(value: string | null | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

function toProduct(row: ProductRow): InventoryProduct {
  return {
    id: row.id,
    businessId: row.business_id,
    brand: row.brand ?? undefined,
    name: row.name,
    category: row.category ?? undefined,
    sku: row.sku ?? undefined,
    sizeValue: row.size_value === null ? undefined : Number(row.size_value),
    sizeUnit: row.size_unit,
    defaultUnit: row.default_unit,
    defaultCostPerGramCents: row.default_cost_per_gram_cents ?? undefined,
    retailPriceCents: row.retail_price_cents ?? undefined,
    lowStockThresholdGrams: Number(row.low_stock_threshold_grams),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStock(
  row: StockRow,
  products: Map<string, InventoryProduct>,
  locations: BusinessLocationSummary[],
): InventoryLocationStock {
  const product = products.get(row.product_id);
  const threshold = Number(row.low_stock_threshold_grams ?? product?.lowStockThresholdGrams ?? 0);
  const quantity = Number(row.quantity_on_hand_grams);
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: locations.find((location) => location.id === row.location_id)?.name ?? 'Unknown location',
    productId: row.product_id,
    productName: product?.name ?? 'Unknown product',
    brand: product?.brand,
    sku: product?.sku,
    category: product?.category,
    quantityOnHandGrams: quantity,
    lowStockThresholdGrams: row.low_stock_threshold_grams === null ? undefined : Number(row.low_stock_threshold_grams),
    effectiveLowStockThresholdGrams: threshold,
    isLowStock: threshold > 0 && quantity <= threshold,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}

function toMovement(
  row: MovementRow,
  products: Map<string, InventoryProduct>,
  locations: BusinessLocationSummary[],
): InventoryStockMovement {
  const product = products.get(row.product_id);
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: locations.find((location) => location.id === row.location_id)?.name ?? 'Unknown location',
    productId: row.product_id,
    productName: product?.name ?? 'Unknown product',
    brand: product?.brand,
    locationStockId: row.location_stock_id ?? undefined,
    movementType: row.movement_type,
    quantityDeltaGrams: Number(row.quantity_delta_grams),
    unitCostCents: row.unit_cost_cents ?? undefined,
    totalCostCents: row.total_cost_cents ?? undefined,
    referenceType: row.reference_type ?? undefined,
    referenceId: row.reference_id ?? undefined,
    reason: row.reason ?? undefined,
    notes: row.notes ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
  };
}

function toAlert(
  row: AlertRow,
  products: Map<string, InventoryProduct>,
  locations: BusinessLocationSummary[],
): InventoryLowStockAlert {
  const product = products.get(row.product_id);
  return {
    id: row.id,
    locationId: row.location_id,
    locationName: locations.find((location) => location.id === row.location_id)?.name ?? 'Unknown location',
    productId: row.product_id,
    productName: product?.name ?? 'Unknown product',
    brand: product?.brand,
    remainingQuantityGrams: Number(row.remaining_quantity_grams),
    thresholdQuantityGrams: Number(row.threshold_quantity_grams),
    status: row.status,
    lastTriggeredAt: row.last_triggered_at,
  };
}

function escapeSupabaseOr(value: string): string {
  return value.replace(/[%(),]/g, '');
}
