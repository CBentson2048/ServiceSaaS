import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, RecordRetailSaleResponse, RetailSalesListResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { RetailSalesService } from './retail-sales.service';
import { RecordRetailSaleDto, RetailSalesQueryDto } from './dto';

@Controller('retail-sales')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class RetailSalesController {
  constructor(private readonly retailSales: RetailSalesService) {}

  /** Record a retail sale. Stylists attribute to themselves; owners/managers choose. */
  @Post()
  @RequireRoles('owner', 'manager', 'stylist')
  record(@CurrentUser() actor: AuthUser, @Body() dto: RecordRetailSaleDto): Promise<RecordRetailSaleResponse> {
    return this.retailSales.record(actor, dto);
  }

  /** List retail sales for the scope, optionally windowed by sold_at. */
  @Get()
  @RequireRoles('owner', 'manager')
  list(@CurrentUser() actor: AuthUser, @Query() query: RetailSalesQueryDto): Promise<RetailSalesListResponse> {
    return this.retailSales.list(actor, query);
  }
}
