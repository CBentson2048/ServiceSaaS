import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, StylistKpiListResponse, StylistKpiResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { KpiService } from './kpi.service';
import { KpiQueryDto } from './dto';

@Controller('kpi')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
export class KpiController {
  constructor(private readonly kpi: KpiService) {}

  /** Owner / manager: per-stylist KPI status across the in-scope locations. */
  @Get('stylists')
  @RequireRoles('owner', 'manager')
  @RequirePermissions('report.commission.view')
  stylists(@CurrentUser() actor: AuthUser, @Query() query: KpiQueryDto): Promise<StylistKpiListResponse> {
    return this.kpi.stylistList(actor, query);
  }

  /** Stylist-facing: the caller's own KPI progress and unlock state. */
  @Get('me')
  @RequireRoles('owner', 'manager', 'stylist')
  me(@CurrentUser() actor: AuthUser, @Query() query: KpiQueryDto): Promise<StylistKpiResponse> {
    return this.kpi.myKpi(actor, query);
  }
}
