import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ClientVisitDetail,
  MobileClientDashboardResponse,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  MobileStylistDashboardResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MobileDashboardService } from './mobile-dashboard.service';

@Controller('mobile-dashboard')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
export class MobileDashboardController {
  constructor(private readonly mobileDashboard: MobileDashboardService) {}

  @Get('client')
  @RequireRoles('client')
  client(@CurrentUser() actor: AuthUser): Promise<MobileClientDashboardResponse> {
    return this.mobileDashboard.client(actor);
  }

  @Get('client/visits/:visitId')
  @RequireRoles('client')
  clientVisitDetail(
    @CurrentUser() actor: AuthUser,
    @Param('visitId') visitId: string,
  ): Promise<ClientVisitDetail> {
    return this.mobileDashboard.clientVisitDetail(actor, visitId);
  }

  @Get('stylist')
  @RequireRoles('stylist')
  stylist(@CurrentUser() actor: AuthUser): Promise<MobileStylistDashboardResponse> {
    return this.mobileDashboard.stylist(actor);
  }

  @Get('manager')
  @RequireRoles('manager')
  @RequirePermissions('report.dashboard.view')
  manager(@CurrentUser() actor: AuthUser): Promise<MobileManagerDashboardResponse> {
    return this.mobileDashboard.manager(actor);
  }

  @Get('owner')
  @RequireRoles('owner')
  @RequirePermissions('report.dashboard.view')
  owner(@CurrentUser() actor: AuthUser): MobileOwnerDashboardResponse {
    return this.mobileDashboard.owner(actor);
  }
}
