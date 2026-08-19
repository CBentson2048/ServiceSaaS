import {
  BadRequestException,
  ConflictException,
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
  InventoryCategory,
  InventoryCategoryResponse,
  InventoryLocationStock,
  InventoryLowStockAlert,
  InventoryProduct,
  InventoryProductResponse,
  InventoryStockMovement,
  InventoryStockMutationResponse,
  BarcodeLookupResponse,
  RecordProductConsumptionResponse,
  StockUnit,
  ListInventoryCategoriesResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
} from '@sheer/domain';
import { userHasPermission, userHasRole } from '@sheer/domain';
import { resolveStockUnit, roundBaseQuantity, toBaseQuantity } from './unit-conversion';
import { AuditService } from '../audit/audit.service';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';
import type {
  AdjustInventoryStockDto,
  CategoryQueryDto,
  CreateInventoryCategoryDto,
  InitializeInventoryStockDto,
  InventoryQueryDto,
  MovementQueryDto,
  StockQueryDto,
  UpdateInventoryCategoryDto,
  UpdateInventoryStockThresholdDto,
  RecordProductConsumptionDto,
  UpsertInventoryProductDto,
} from './dto';

interface ProductRow {
  id: string;
  business_id: string;
  brand: string | null;
  name: string;
  category_id: string | null;
  sku: string | null;
  size_value: number | string | null;
  size_unit: string;
  default_unit: string;
  default_cost_per_gram_cents: number | null;
  retail_price_cents: number | null;
  low_stock_threshold_grams: number | string;
  is_active: boolean;
  stock_unit: string | null;
  pack_size: number | string | null;
  barcode: string | null;
  is_salon_use: boolean;
  is_lab_use: boolean;
  is_retail: boolean;
  lab_markup_percent: number | string | null;
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

interface CategoryRow {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const PRODUCT_COLUMNS =
  'id,business_id,brand,name,category_id,sku,size_value,size_unit,default_unit,default_cost_per_gram_cents,retail_price_cents,low_stock_threshold_grams,is_active,stock_unit,pack_size,barcode,is_salon_use,is_lab_use,is_retail,lab_markup_percent,created_at,updated_at';
const STOCK_COLUMNS =
  'id,business_id,location_id,product_id,quantity_on_hand_grams,low_stock_threshold_grams,is_active,updated_at';
const MOVEMENT_COLUMNS =
  'id,business_id,location_id,product_id,location_stock_id,movement_type,quantity_delta_grams,unit_cost_cents,total_cost_cents,reference_type,reference_id,reason,notes,created_by,created_at';
const CATEGORY_COLUMNS = 'id,business_id,name,description,is_active,created_at,updated_at';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
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
    this.assertManagerOrOwner(actor);
    if (dto.categoryId) await this.assertCategory(actor.businessId, dto.categoryId);
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
    return { product: toProduct(data, await this.fetchCategoryNames(actor.businessId, [data.category_id])) };
  }

  async updateProduct(actor: AuthUser, productId: string, dto: UpsertInventoryProductDto): Promise<InventoryProductResponse> {
    this.assertManagerOrOwner(actor);
    if (dto.categoryId) await this.assertCategory(actor.businessId, dto.categoryId);
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
    return { product: toProduct(data, await this.fetchCategoryNames(actor.businessId, [data.category_id])) };
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
    return { product: toProduct(data, await this.fetchCategoryNames(actor.businessId, [data.category_id])) };
  }

  async listStock(actor: AuthUser, query: StockQueryDto): Promise<ListInventoryStockResponse> {
    this.assertManagerOrOwner(actor);
    const locationIds = await this.resolveLocationScope(actor, query.locationId);
    const { stock, locations } = await this.loadStock(actor.businessId, locationIds, query);
    return { stock, locations, scope: userHasRole(actor, 'owner') ? 'owner' : 'manager' };
  }

  // Lab-session-scoped variant: stock is restricted to the station's single
  // location, so no caller-supplied location scope is resolved.
  //
  // NOTE: intentionally NOT gated to owner/manager (unlike the JWT `listStock`
  // and unlike `LabAnalyticsService.summaryForLabSession`). A PIN-unlocked lab
  // session is a trusted staff member physically at the registered station, and
  // any role at that station — including a stylist — legitimately needs the
  // low-stock signal for the products they are mixing with. The data is
  // location-scoped operational stock (quantities only; no cost/valuation), so
  // this is a deliberate product decision, not an accidental permission gap.
  async listStockForLabSession(
    session: LabRuntimeSession,
    query: StockQueryDto,
  ): Promise<ListInventoryStockResponse> {
    const { stock, locations } = await this.loadStock(session.businessId, [session.locationId], query);
    return { stock, locations, scope: session.role === 'owner' ? 'owner' : 'manager' };
  }

  private async loadStock(
    businessId: string,
    locationIds: string[],
    query: StockQueryDto,
  ): Promise<{ stock: InventoryLocationStock[]; locations: BusinessLocationSummary[] }> {
    const locations = await this.fetchLocations(businessId, locationIds);
    if (locationIds.length === 0) return { stock: [], locations };

    const request = this.admin
      .schema('inventory')
      .from('location_stock')
      .select(STOCK_COLUMNS)
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .order('updated_at', { ascending: false });

    const { data, error } = await request.returns<StockRow[]>();
    if (error) {
      this.logger.error(`listStock failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location stock');
    }

    const products = await this.fetchProductsById(businessId, (data ?? []).map((row) => row.product_id));
    let stock = (data ?? []).map((row) => toStock(row, products, locations));
    const term = query.q?.trim().toLowerCase();
    if (term) {
      stock = stock.filter((row) => [row.productName, row.brand ?? '', row.sku ?? '', row.category ?? ''].join(' ').toLowerCase().includes(term));
    }
    if (query.lowStockOnly) stock = stock.filter((row) => row.isLowStock);
    return { stock, locations };
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

    const stock = await this.fetchStock(actor, dto.locationId, dto.productId);
    const afterGrams = stock.quantityOnHandGrams;
    await this.audit.record(actor, {
      action: 'stock.adjusted',
      entityType: 'stock',
      entityId: dto.productId,
      locationId: dto.locationId,
      before: { quantityOnHandGrams: afterGrams - dto.quantityDeltaGrams },
      after: { quantityOnHandGrams: afterGrams },
      metadata: {
        movementType: dto.movementType,
        quantityDeltaGrams: dto.quantityDeltaGrams,
        reason: dto.reason ?? null,
        notes: dto.notes ?? null,
        productName: stock.productName ?? null,
      },
    });
    return { stock };
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
    if (query.from) request = request.gte('created_at', query.from);
    if (query.to) request = request.lt('created_at', query.to);

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

  async listCategories(actor: AuthUser, query: CategoryQueryDto): Promise<ListInventoryCategoriesResponse> {
    this.assertManagerOrOwner(actor);
    let request = this.admin
      .schema('inventory')
      .from('categories')
      .select(CATEGORY_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('name', { ascending: true });

    if (!query.includeInactive) request = request.eq('is_active', true);
    if (query.q?.trim()) {
      const term = escapeSupabaseOr(query.q.trim());
      request = request.or(`name.ilike.%${term}%,description.ilike.%${term}%`);
    }

    const { data, error } = await request.returns<CategoryRow[]>();
    if (error) {
      this.logger.error(`listCategories failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load inventory categories');
    }
    return { categories: (data ?? []).map(toCategory) };
  }

  async createCategory(actor: AuthUser, dto: CreateInventoryCategoryDto): Promise<InventoryCategoryResponse> {
    this.assertManagerOrOwner(actor);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('name is required');

    const { data, error } = await this.admin
      .schema('inventory')
      .from('categories')
      .insert({
        business_id: actor.businessId,
        name,
        description: clean(dto.description),
        is_active: dto.isActive ?? true,
      })
      .select(CATEGORY_COLUMNS)
      .single<CategoryRow>();

    if (error || !data) {
      if (error?.code === '23505') {
        throw new ConflictException('A category with this name already exists');
      }
      this.logger.error(`createCategory failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create inventory category');
    }
    return { category: toCategory(data) };
  }

  async updateCategory(
    actor: AuthUser,
    categoryId: string,
    dto: UpdateInventoryCategoryDto,
  ): Promise<InventoryCategoryResponse> {
    this.assertManagerOrOwner(actor);
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('name must not be empty');
      patch.name = name;
    }
    if ('description' in dto) patch.description = clean(dto.description);
    if (dto.isActive !== undefined) patch.is_active = dto.isActive;
    if (Object.keys(patch).length === 0) throw new BadRequestException('No category fields to update');

    const { data, error } = await this.admin
      .schema('inventory')
      .from('categories')
      .update(patch)
      .eq('id', categoryId)
      .eq('business_id', actor.businessId)
      .select(CATEGORY_COLUMNS)
      .maybeSingle<CategoryRow>();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('A category with this name already exists');
      }
      this.logger.error(`updateCategory failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update inventory category');
    }
    if (!data) throw new NotFoundException('Inventory category not found');
    return { category: toCategory(data) };
  }

  async deleteCategory(actor: AuthUser, categoryId: string): Promise<InventoryCategoryResponse> {
    this.assertOwner(actor);
    const { data, error } = await this.admin
      .schema('inventory')
      .from('categories')
      .delete()
      .eq('id', categoryId)
      .eq('business_id', actor.businessId)
      .select(CATEGORY_COLUMNS)
      .maybeSingle<CategoryRow>();

    if (error) {
      this.logger.error(`deleteCategory failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete inventory category');
    }
    if (!data) throw new NotFoundException('Inventory category not found');
    return { category: toCategory(data) };
  }

  // ---------------------------------------------------------------------------
  // Lab-session inventory management (owner/manager only)
  //
  // The lab station authenticates with a PIN session, not a JWT, so it cannot
  // reach the JWT-gated InventoryController. To give owners/managers working at
  // a station the full management surface WITHOUT duplicating validation, we
  // project the runtime session into a minimal AuthUser scoped to the station's
  // single location and delegate to the exact same methods the web dashboard
  // uses. This keeps both surfaces behaviourally identical and means:
  //   - `assertManagerOrOwner` rejects stylist sessions (403) — management stays
  //     owner/manager-only, never stylists or clients.
  //   - every stock mutation is forced onto the station's own location.
  // ---------------------------------------------------------------------------

  listProductsForLabManagement(session: LabRuntimeSession, query: InventoryQueryDto): Promise<ListInventoryProductsResponse> {
    return this.listProducts(this.labActor(session), query);
  }

  listStockForLabManagement(session: LabRuntimeSession, query: StockQueryDto): Promise<ListInventoryStockResponse> {
    return this.listStock(this.labActor(session), { ...query, locationId: session.locationId });
  }

  listMovementsForLabSession(session: LabRuntimeSession, query: MovementQueryDto): Promise<ListInventoryMovementsResponse> {
    return this.listMovements(this.labActor(session), { ...query, locationId: session.locationId });
  }

  listLowStockForLabSession(session: LabRuntimeSession): Promise<ListInventoryLowStockResponse> {
    return this.listLowStock(this.labActor(session), session.locationId);
  }

  listCategoriesForLabSession(session: LabRuntimeSession, query: CategoryQueryDto): Promise<ListInventoryCategoriesResponse> {
    return this.listCategories(this.labActor(session), query);
  }

  createProductForLabSession(session: LabRuntimeSession, dto: UpsertInventoryProductDto): Promise<InventoryProductResponse> {
    return this.createProduct(this.labActor(session), dto);
  }

  updateProductForLabSession(
    session: LabRuntimeSession,
    productId: string,
    dto: UpsertInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    return this.updateProduct(this.labActor(session), productId, dto);
  }

  archiveProductForLabSession(session: LabRuntimeSession, productId: string): Promise<InventoryProductResponse> {
    return this.archiveProduct(this.labActor(session), productId);
  }

  createCategoryForLabSession(session: LabRuntimeSession, dto: CreateInventoryCategoryDto): Promise<InventoryCategoryResponse> {
    return this.createCategory(this.labActor(session), dto);
  }

  initializeStockForLabSession(
    session: LabRuntimeSession,
    dto: InitializeInventoryStockDto,
  ): Promise<InventoryStockMutationResponse> {
    return this.initializeStock(this.labActor(session), { ...dto, locationId: session.locationId });
  }

  adjustStockForLabSession(session: LabRuntimeSession, dto: AdjustInventoryStockDto): Promise<InventoryStockMutationResponse> {
    return this.adjustStock(this.labActor(session), { ...dto, locationId: session.locationId });
  }

  updateStockThresholdForLabSession(
    session: LabRuntimeSession,
    stockId: string,
    dto: UpdateInventoryStockThresholdDto,
  ): Promise<InventoryStockMutationResponse> {
    return this.updateStockThreshold(this.labActor(session), stockId, dto);
  }

  // ---------------------------------------------------------------------------
  // Week 6 — barcode consumption foundation
  //
  // The scan surface itself (wedge scanner field or camera) is Week 7 UI work.
  // What Week 6 owns is the path underneath it: resolve a scanned identifier to
  // exactly one product in the caller's business, then consume stock through the
  // SAME authoritative RPC every other deduction uses, so barcode usage lands in
  // the ledger with the same rules, alerts and provenance as everything else.
  // ---------------------------------------------------------------------------

  /**
   * Resolve a scanned barcode to a product and its stock at one location.
   * Fails loudly and distinguishably: an unknown code, an archived product and a
   * product outside the caller's business are three different answers, never a
   * silent empty result that a scanner UI would render as "nothing happened".
   */
  async lookupByBarcode(
    actor: AuthUser,
    barcode: string,
    locationId: string,
  ): Promise<BarcodeLookupResponse> {
    await this.assertLocationScope(actor, locationId);

    const code = barcode?.trim();
    if (!code) throw new BadRequestException('barcode is required');

    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('barcode', code)
      .maybeSingle<ProductRow>();

    if (error) {
      this.logger.error(`lookupByBarcode failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to look up barcode');
    }
    if (!data) throw new NotFoundException(`No product matches barcode ${code}`);
    if (!data.is_active) {
      throw new ConflictException(`${data.name} is archived and cannot be used`);
    }

    const { data: stock, error: stockError } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .select('quantity_on_hand_grams,low_stock_threshold_grams')
      .eq('location_id', locationId)
      .eq('product_id', data.id)
      .maybeSingle<{ quantity_on_hand_grams: number | string; low_stock_threshold_grams: number | string | null }>();

    if (stockError) {
      this.logger.error(`lookupByBarcode stock read failed: ${stockError.message}`);
      throw new InternalServerErrorException('Unable to look up barcode');
    }

    const product = toProduct(data);
    const threshold =
      stock?.low_stock_threshold_grams ?? product.lowStockThresholdGrams ?? null;

    return {
      product,
      locationId,
      quantityOnHandGrams: stock ? Number(stock.quantity_on_hand_grams) : 0,
      lowStockThresholdGrams: threshold === null ? undefined : Number(threshold),
    };
  }

  /**
   * Record salon consumption of a product — the action a barcode scan performs.
   *
   * Routes through `inventory.adjust_location_stock`, which owns the movement
   * ledger, the low-stock alerts and the location's negative-stock policy. An
   * `idempotencyKey` makes a retried scan safe: the RPC returns the original
   * movement instead of deducting a second time.
   */
  async recordConsumption(
    actor: AuthUser,
    dto: RecordProductConsumptionDto,
  ): Promise<RecordProductConsumptionResponse> {
    await this.assertLocationScope(actor, dto.locationId);

    if (!dto.productId && !dto.barcode) {
      throw new BadRequestException('Either productId or barcode is required');
    }

    const product = dto.productId
      ? await this.requireActiveProduct(actor.businessId, dto.productId)
      : (await this.lookupByBarcode(actor, dto.barcode as string, dto.locationId)).product;

    const baseQuantity = roundBaseQuantity(toBaseQuantity(product, dto.quantity, dto.unit ?? 'base'));

    const { data, error } = await this.admin.schema('inventory').rpc('adjust_location_stock', {
      p_payload: {
        businessId: actor.businessId,
        locationId: dto.locationId,
        productId: product.id,
        quantityDeltaGrams: -baseQuantity,
        movementType: 'salon_consumption',
        reason: dto.reason ?? 'salon_consumption',
        notes: dto.notes ?? null,
        referenceType: dto.barcode ? 'barcode_scan' : 'manual_consumption',
        createdBy: actor.id,
        idempotencyKey: dto.idempotencyKey ?? null,
        metadata: dto.barcode ? { barcode: dto.barcode } : {},
      },
    });

    if (error) {
      this.logger.error(`recordConsumption failed: ${error.message}`);
      // The RPC raises check_violation when a location forbids negative stock.
      if (/insufficient stock/i.test(error.message)) {
        throw new ConflictException(error.message);
      }
      throw new InternalServerErrorException('Unable to record product consumption');
    }

    const result = (data ?? {}) as {
      movementId?: string;
      quantityOnHandGrams?: number | string;
      lowStockThresholdGrams?: number | string | null;
      idempotentReplay?: boolean;
    };
    const replayed = result.idempotentReplay === true;

    if (!replayed) {
      await this.audit.record(actor, {
        action: 'stock.adjusted',
        entityType: 'stock',
        entityId: product.id,
        locationId: dto.locationId,
        after: { quantityOnHandGrams: Number(result.quantityOnHandGrams ?? 0) },
        metadata: {
          movementType: 'salon_consumption',
          quantityDeltaGrams: -baseQuantity,
          productName: product.name,
          barcode: dto.barcode ?? null,
          reason: dto.reason ?? 'salon_consumption',
        },
      });
    }

    return {
      movementId: result.movementId ?? '',
      productId: product.id,
      productName: product.name,
      locationId: dto.locationId,
      quantityDeductedGrams: replayed ? 0 : baseQuantity,
      quantityOnHandGrams: Number(result.quantityOnHandGrams ?? 0),
      lowStockThresholdGrams:
        result.lowStockThresholdGrams === null || result.lowStockThresholdGrams === undefined
          ? undefined
          : Number(result.lowStockThresholdGrams),
      idempotentReplay: replayed,
    };
  }

  private async requireActiveProduct(businessId: string, productId: string): Promise<InventoryProduct> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('business_id', businessId)
      .eq('id', productId)
      .maybeSingle<ProductRow>();

    if (error) {
      this.logger.error(`requireActiveProduct failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load product');
    }
    if (!data) throw new NotFoundException('Product was not found');
    if (!data.is_active) throw new ConflictException(`${data.name} is archived and cannot be used`);
    return toProduct(data);
  }

  private labActor(session: LabRuntimeSession): AuthUser {
    return {
      id: session.userProfileId,
      roles: [session.role],
      primaryRole: session.role,
      businessId: session.businessId,
      allowedLocationIds: [session.locationId],
      locationScope: { kind: 'locations', locationIds: [session.locationId] },
      locations: [],
      profile: { id: session.userProfileId, email: '', fullName: '' },
      staffProfileId: session.staffProfileId,
      permissions: session.permissions,
    };
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasPermission(actor, 'inventory.manage')) {
      throw new ForbiddenException('You do not have permission to manage inventory');
    }
  }

  private assertOwner(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) throw new ForbiddenException('Only owners can manage product catalogue');
  }

  private async assertLocationScope(actor: AuthUser, locationId: string): Promise<void> {
    this.assertManagerOrOwner(actor);
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
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
    // Owner wins: a user who holds an owner role (even alongside manager) sees
    // every business location; a manager-only user is scoped to their locations.
    if (userHasRole(actor, 'owner')) {
      const locations = await this.fetchLocations(actor.businessId);
      return locations.map((location) => location.id);
    }
    return actor.allowedLocationIds;
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
    if (query.categoryId) request = request.eq('category_id', query.categoryId);
    if (query.q?.trim()) {
      const term = escapeSupabaseOr(query.q.trim());
      request = request.or(`name.ilike.%${term}%,brand.ilike.%${term}%,sku.ilike.%${term}%`);
    }

    const { data, error } = await request.returns<ProductRow[]>();
    if (error) {
      this.logger.error(`listProducts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load inventory products');
    }
    const rows = data ?? [];
    const categoryNames = await this.fetchCategoryNames(businessId, rows.map((row) => row.category_id));
    return { products: rows.map((row) => toProduct(row, categoryNames)) };
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
    const rows = data ?? [];
    const categoryNames = await this.fetchCategoryNames(businessId, rows.map((row) => row.category_id));
    return new Map(rows.map((row) => [row.id, toProduct(row, categoryNames)]));
  }

  private async fetchCategoryNames(
    businessId: string,
    categoryIds: (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = Array.from(new Set(categoryIds.filter((id): id is string => Boolean(id))));
    if (ids.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('inventory')
      .from('categories')
      .select('id,name')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<{ id: string; name: string }[]>();
    if (error) {
      this.logger.error(`fetchCategoryNames failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load inventory categories');
    }
    return new Map((data ?? []).map((row) => [row.id, row.name]));
  }

  private async assertCategory(businessId: string, categoryId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('categories')
      .select('id')
      .eq('business_id', businessId)
      .eq('id', categoryId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`assertCategory failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate category');
    }
    if (!data) throw new BadRequestException('categoryId is not valid for this business');
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
    category_id: dto.categoryId ?? null,
    sku: clean(dto.sku),
    size_value: dto.sizeValue ?? null,
    size_unit: clean(dto.sizeUnit) ?? 'g',
    default_unit: clean(dto.defaultUnit) ?? 'g',
    default_cost_per_gram_cents: dto.defaultCostPerGramCents ?? null,
    retail_price_cents: dto.retailPriceCents ?? null,
    low_stock_threshold_grams: dto.lowStockThresholdGrams ?? 0,
    stock_unit: dto.stockUnit ?? 'gram',
    pack_size: dto.packSize ?? null,
    barcode: clean(dto.barcode),
    is_salon_use: dto.isSalonUse ?? false,
    is_lab_use: dto.isLabUse ?? false,
    is_retail: dto.isRetail ?? false,
    lab_markup_percent: dto.labMarkupPercent ?? null,
  };
}

function clean(value: string | null | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

function toProduct(row: ProductRow, categoryNames?: Map<string, string>): InventoryProduct {
  return {
    id: row.id,
    businessId: row.business_id,
    brand: row.brand ?? undefined,
    name: row.name,
    categoryId: row.category_id ?? undefined,
    category: row.category_id ? categoryNames?.get(row.category_id) : undefined,
    sku: row.sku ?? undefined,
    sizeValue: row.size_value === null ? undefined : Number(row.size_value),
    sizeUnit: row.size_unit,
    defaultUnit: row.default_unit,
    defaultCostPerGramCents: row.default_cost_per_gram_cents ?? undefined,
    retailPriceCents: row.retail_price_cents ?? undefined,
    lowStockThresholdGrams: Number(row.low_stock_threshold_grams),
    isActive: row.is_active,
    stockUnit: resolveStockUnit({
      stockUnit: row.stock_unit as StockUnit | null,
      packSize: row.pack_size === null ? null : Number(row.pack_size),
      sizeValue: row.size_value === null ? null : Number(row.size_value),
    }),
    packSize: row.pack_size === null ? undefined : Number(row.pack_size),
    barcode: row.barcode ?? undefined,
    isSalonUse: row.is_salon_use,
    isLabUse: row.is_lab_use,
    isRetail: row.is_retail,
    labMarkupPercent: row.lab_markup_percent === null ? undefined : Number(row.lab_markup_percent),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCategory(row: CategoryRow): InventoryCategory {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description ?? undefined,
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
