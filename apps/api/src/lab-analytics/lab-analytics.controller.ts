import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, SheerLabAnalyticsRange, SheerLabAnalyticsResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabAnalyticsService } from './lab-analytics.service';

@Controller('lab/analytics')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
export class LabAnalyticsController {
  constructor(private readonly labAnalytics: LabAnalyticsService) {}

  @Get('summary')
  summary(
    @CurrentUser() actor: AuthUser,
    @Query('range') range: SheerLabAnalyticsRange = 'today',
    @Query('locationId') locationId?: string,
  ): Promise<SheerLabAnalyticsResponse> {
    return this.labAnalytics.summary(actor, range, locationId);
  }
}
