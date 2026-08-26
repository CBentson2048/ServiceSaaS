import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ListSellableProductsResponse,
  RecordRetailSaleResponse,
  RetailSalesListResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RetailSalesService } from './retail-sales.service';
import { RecordRetailSaleDto, RetailSalesQueryDto, SellableProductsQueryDto } from './dto';

@Controller('retail-sales')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
export class RetailSalesController {
  constructor(private readonly retailSales: RetailSalesService) {}

  /** Record a retail sale. Stylists attribute to themselves; owners/managers choose. */
  @Post()
  @RequireRoles('owner', 'manager', 'stylist')
  @RequirePermissions('retail.record')
  record(@CurrentUser() actor: AuthUser, @Body() dto: RecordRetailSaleDto): Promise<RecordRetailSaleResponse> {
    return this.retailSales.record(actor, dto);
  }

  /**
   * The till's product picker: Retail-classified products available at the
   * location, with their canonical effective price and provenance. Same
   * permission as ringing a sale — stylists included.
   */
  @Get('sellable')
  @RequireRoles('owner', 'manager', 'stylist')
  @RequirePermissions('retail.record')
  sellable(
    @CurrentUser() actor: AuthUser,
    @Query() query: SellableProductsQueryDto,
  ): Promise<ListSellableProductsResponse> {
    return this.retailSales.listSellable(actor, query.locationId);
  }

  /** List retail sales for the scope, optionally windowed by sold_at. */
  @Get()
  @RequireRoles('owner', 'manager')
  @RequirePermissions('report.financials.view')
  list(@CurrentUser() actor: AuthUser, @Query() query: RetailSalesQueryDto): Promise<RetailSalesListResponse> {
    return this.retailSales.list(actor, query);
  }
}
