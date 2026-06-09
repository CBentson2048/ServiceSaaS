import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  InventoryCategoryResponse,
  InventoryProductResponse,
  InventoryStockMutationResponse,
  ListInventoryCategoriesResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabSessionService } from '../lab-session/lab-session.service';
import {
  AdjustInventoryStockDto,
  CategoryQueryDto,
  CreateInventoryCategoryDto,
  InitializeInventoryStockDto,
  InventoryQueryDto,
  MovementQueryDto,
  StockQueryDto,
  UpdateInventoryCategoryDto,
  UpdateInventoryStockThresholdDto,
  UpsertInventoryProductDto,
} from './dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
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
}
