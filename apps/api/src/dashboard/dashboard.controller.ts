import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  DashboardInventoryAlertsResponse,
  DashboardKpisResponse,
  DashboardStylistPerformanceResponse,
  DashboardTopServicesResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { DashboardService } from './dashboard.service';
import { DashboardDateRangeQueryDto, DashboardInventoryAlertsQueryDto } from './dto';

@Controller('dashboard')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('report.dashboard.view')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('kpis')
  kpis(@CurrentUser() actor: AuthUser, @Query() query: DashboardDateRangeQueryDto): Promise<DashboardKpisResponse> {
    return this.dashboard.kpis(actor, query);
  }

  @Get('top-services')
  topServices(
    @CurrentUser() actor: AuthUser,
    @Query() query: DashboardDateRangeQueryDto,
  ): Promise<DashboardTopServicesResponse> {
    return this.dashboard.topServices(actor, query);
  }

  @Get('stylist-performance')
  stylistPerformance(
    @CurrentUser() actor: AuthUser,
    @Query() query: DashboardDateRangeQueryDto,
  ): Promise<DashboardStylistPerformanceResponse> {
    return this.dashboard.stylistPerformance(actor, query);
  }

  @Get('inventory-alerts')
  inventoryAlerts(
    @CurrentUser() actor: AuthUser,
    @Query() query: DashboardInventoryAlertsQueryDto,
  ): Promise<DashboardInventoryAlertsResponse> {
    return this.dashboard.inventoryAlerts(actor, query);
  }
}
