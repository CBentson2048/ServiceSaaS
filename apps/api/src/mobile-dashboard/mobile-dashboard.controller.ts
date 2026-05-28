import { Controller, Get, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  MobileClientDashboardResponse,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  MobileStylistDashboardResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MobileDashboardService } from './mobile-dashboard.service';

@Controller('mobile-dashboard')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class MobileDashboardController {
  constructor(private readonly mobileDashboard: MobileDashboardService) {}

  @Get('client')
  @RequireRoles('client')
  client(@CurrentUser() actor: AuthUser): Promise<MobileClientDashboardResponse> {
    return this.mobileDashboard.client(actor);
  }

  @Get('stylist')
  @RequireRoles('stylist')
  stylist(@CurrentUser() actor: AuthUser): Promise<MobileStylistDashboardResponse> {
    return this.mobileDashboard.stylist(actor);
  }

  @Get('manager')
  @RequireRoles('manager')
  manager(@CurrentUser() actor: AuthUser): Promise<MobileManagerDashboardResponse> {
    return this.mobileDashboard.manager(actor);
  }

  @Get('owner')
  @RequireRoles('owner')
  owner(@CurrentUser() actor: AuthUser): MobileOwnerDashboardResponse {
    return this.mobileDashboard.owner(actor);
  }
}
