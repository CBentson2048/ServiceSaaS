import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  InventoryProductResponse,
  InventoryStockMutationResponse,
  ListInventoryLowStockResponse,
  ListInventoryMovementsResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  AdjustInventoryStockDto,
  InitializeInventoryStockDto,
  InventoryQueryDto,
  MovementQueryDto,
  StockQueryDto,
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
}
