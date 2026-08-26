import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  InventoryCategoryResponse,
  InventoryProductResponse,
  InventoryStockMutationResponse,
  InventorySupplierResponse,
  ProductAvailabilityResponse,
  ListInventoryCategoriesResponse,
  ListInventoryDeadStockResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
  ListInventorySuppliersResponse,
  BarcodeLookupResponse,
  RecordProductConsumptionResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabSessionService } from '../lab-session/lab-session.service';
import {
  AdjustInventoryStockDto,
  CategoryQueryDto,
  CreateInventoryCategoryDto,
  CreateInventorySupplierDto,
  DeadStockQueryDto,
  InitializeInventoryStockDto,
  InventoryQueryDto,
  MovementQueryDto,
  StockQueryDto,
  SupplierQueryDto,
  UpdateInventoryCategoryDto,
  UpdateInventoryStockThresholdDto,
  UpdateInventorySupplierDto,
  UpsertInventoryProductDto,
  BarcodeLookupQueryDto,
  RecordProductConsumptionDto,
  SetProductAvailabilityDto,
} from './dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('inventory.manage')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('products')
  listProducts(@CurrentUser() actor: AuthUser, @Query() query: InventoryQueryDto): Promise<ListInventoryProductsResponse> {
    return this.inventory.listProducts(actor, query);
  }

  @Post('products')
  createProduct(
    @CurrentUser() actor: AuthUser,
    @Body() dto: UpsertInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    return this.inventory.createProduct(actor, dto);
  }

  @Patch('products/:id')
  updateProduct(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpsertInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    return this.inventory.updateProduct(actor, id, dto);
  }

  @Get('products/:id/availability')
  getAvailability(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<ProductAvailabilityResponse> {
    return this.inventory.getProductAvailability(actor, id);
  }

  /** Where is this product stocked/sold? Independent of its use classification. */
  @Put('products/:id/availability')
  setAvailability(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetProductAvailabilityDto,
  ): Promise<ProductAvailabilityResponse> {
    return this.inventory.setProductAvailability(actor, id, dto);
  }

  @Post('products/:id/archive')
  archiveProduct(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<InventoryProductResponse> {
    return this.inventory.archiveProduct(actor, id);
  }

  @Get('stock')
  listStock(@CurrentUser() actor: AuthUser, @Query() query: StockQueryDto): Promise<ListInventoryStockResponse> {
    return this.inventory.listStock(actor, query);
  }

  @Post('stock/initialize')
  initializeStock(
    @CurrentUser() actor: AuthUser,
    @Body() dto: InitializeInventoryStockDto,
  ): Promise<InventoryStockMutationResponse> {
    return this.inventory.initializeStock(actor, dto);
  }

  @Post('stock/adjust')
  adjustStock(
    @CurrentUser() actor: AuthUser,
    @Body() dto: AdjustInventoryStockDto,
  ): Promise<InventoryStockMutationResponse> {
    return this.inventory.adjustStock(actor, dto);
  }

  @Patch('stock/:id')
  updateStockThreshold(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateInventoryStockThresholdDto,
  ): Promise<InventoryStockMutationResponse> {
    return this.inventory.updateStockThreshold(actor, id, dto);
  }

  @Get('movements')
  listMovements(
    @CurrentUser() actor: AuthUser,
    @Query() query: MovementQueryDto,
  ): Promise<ListInventoryMovementsResponse> {
    return this.inventory.listMovements(actor, query);
  }

  @Get('low-stock')
  listLowStock(@CurrentUser() actor: AuthUser, @Query('locationId') locationId?: string): Promise<ListInventoryLowStockResponse> {
    return this.inventory.listLowStock(actor, locationId);
  }

  // Week 6 ticket 7 — dead stock, computed on read (nothing is materialised).

  @Get('dead-stock')
  listDeadStock(
    @CurrentUser() actor: AuthUser,
    @Query() query: DeadStockQueryDto,
  ): Promise<ListInventoryDeadStockResponse> {
    return this.inventory.listDeadStock(actor, query.locationId);
  }

  // Week 6 — barcode consumption foundation. The scan surface (wedge scanner
  // field or camera) is Week 7 UI; these are the API and domain rules under it.

  @Get('scan')
  async scanBarcode(
    @CurrentUser() actor: AuthUser,
    @Query() query: BarcodeLookupQueryDto,
  ): Promise<BarcodeLookupResponse> {
    return this.inventory.lookupByBarcode(actor, query.barcode, query.locationId);
  }

  @Post('consumption')
  async recordConsumption(
    @CurrentUser() actor: AuthUser,
    @Body() body: RecordProductConsumptionDto,
  ): Promise<RecordProductConsumptionResponse> {
    return this.inventory.recordConsumption(actor, body);
  }

  @Get('categories')
  listCategories(
    @CurrentUser() actor: AuthUser,
    @Query() query: CategoryQueryDto,
  ): Promise<ListInventoryCategoriesResponse> {
    return this.inventory.listCategories(actor, query);
  }

  @Post('categories')
  createCategory(
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateInventoryCategoryDto,
  ): Promise<InventoryCategoryResponse> {
    return this.inventory.createCategory(actor, dto);
  }

  @Patch('categories/:id')
  updateCategory(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateInventoryCategoryDto,
  ): Promise<InventoryCategoryResponse> {
    return this.inventory.updateCategory(actor, id, dto);
  }

  @Delete('categories/:id')
  deleteCategory(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<InventoryCategoryResponse> {
    return this.inventory.deleteCategory(actor, id);
  }

  // Week 6 ticket 1 — supplier catalogue. Same permission surface as the rest
  // of inventory; the Week 7 ordering workflow gets its own orders.* keys.

  @Get('suppliers')
  listSuppliers(
    @CurrentUser() actor: AuthUser,
    @Query() query: SupplierQueryDto,
  ): Promise<ListInventorySuppliersResponse> {
    return this.inventory.listSuppliers(actor, query);
  }

  @Post('suppliers')
  createSupplier(
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateInventorySupplierDto,
  ): Promise<InventorySupplierResponse> {
    return this.inventory.createSupplier(actor, dto);
  }

  @Patch('suppliers/:id')
  updateSupplier(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateInventorySupplierDto,
  ): Promise<InventorySupplierResponse> {
    return this.inventory.updateSupplier(actor, id, dto);
  }

  @Delete('suppliers/:id')
  deleteSupplier(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<InventorySupplierResponse> {
    return this.inventory.deleteSupplier(actor, id);
  }
}

@Controller('lab/inventory/session')
export class LabSessionInventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly labSessionService: LabSessionService,
  ) {}

  @Get(':sessionId/products')
  async listProducts(
    @Param('sessionId') sessionId: string,
    @Query() query: InventoryQueryDto,
  ): Promise<ListInventoryProductsResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listProductsForLabSession(session, query);
  }

  @Get(':sessionId/stock')
  async listStock(
    @Param('sessionId') sessionId: string,
    @Query() query: StockQueryDto,
  ): Promise<ListInventoryStockResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listStockForLabSession(session, query);
  }

  // ---------------------------------------------------------------------------
  // Management surface (owner/manager only — enforced inside InventoryService).
  // These mirror the JWT InventoryController one-for-one so the qlooqo-lab app
  // and the web dashboard drive the same behaviour. Stock mutations are pinned
  // to the station's own location by the service.
  // ---------------------------------------------------------------------------

  @Get(':sessionId/manage/products')
  async manageListProducts(
    @Param('sessionId') sessionId: string,
    @Query() query: InventoryQueryDto,
  ): Promise<ListInventoryProductsResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listProductsForLabManagement(session, query);
  }

  @Get(':sessionId/manage/stock')
  async manageListStock(
    @Param('sessionId') sessionId: string,
    @Query() query: StockQueryDto,
  ): Promise<ListInventoryStockResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listStockForLabManagement(session, query);
  }

  @Get(':sessionId/manage/movements')
  async manageListMovements(
    @Param('sessionId') sessionId: string,
    @Query() query: MovementQueryDto,
  ): Promise<ListInventoryMovementsResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listMovementsForLabSession(session, query);
  }

  @Get(':sessionId/manage/low-stock')
  async manageListLowStock(@Param('sessionId') sessionId: string): Promise<ListInventoryLowStockResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listLowStockForLabSession(session);
  }

  @Get(':sessionId/manage/categories')
  async manageListCategories(
    @Param('sessionId') sessionId: string,
    @Query() query: CategoryQueryDto,
  ): Promise<ListInventoryCategoriesResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.listCategoriesForLabSession(session, query);
  }

  @Post(':sessionId/manage/products')
  async manageCreateProduct(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpsertInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.createProductForLabSession(session, dto);
  }

  @Patch(':sessionId/manage/products/:id')
  async manageUpdateProduct(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpsertInventoryProductDto,
  ): Promise<InventoryProductResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.updateProductForLabSession(session, id, dto);
  }

  @Post(':sessionId/manage/products/:id/archive')
  async manageArchiveProduct(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<InventoryProductResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.archiveProductForLabSession(session, id);
  }

  @Post(':sessionId/manage/stock/initialize')
  async manageInitializeStock(
    @Param('sessionId') sessionId: string,
    @Body() dto: InitializeInventoryStockDto,
  ): Promise<InventoryStockMutationResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.initializeStockForLabSession(session, dto);
  }

  @Post(':sessionId/manage/stock/adjust')
  async manageAdjustStock(
    @Param('sessionId') sessionId: string,
    @Body() dto: AdjustInventoryStockDto,
  ): Promise<InventoryStockMutationResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.adjustStockForLabSession(session, dto);
  }

  @Patch(':sessionId/manage/stock/:id')
  async manageUpdateStockThreshold(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateInventoryStockThresholdDto,
  ): Promise<InventoryStockMutationResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.updateStockThresholdForLabSession(session, id, dto);
  }

  @Post(':sessionId/manage/categories')
  async manageCreateCategory(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateInventoryCategoryDto,
  ): Promise<InventoryCategoryResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.inventory.createCategoryForLabSession(session, dto);
  }
}
