import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, SheerLabAnalyticsRange, SheerLabAnalyticsResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LabSessionService } from '../lab-session/lab-session.service';
import { LabAnalyticsService } from './lab-analytics.service';

@Controller('lab/analytics')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('report.lab_analytics.view')
export class LabAnalyticsController {
  constructor(private readonly labAnalytics: LabAnalyticsService) {}

  @Get('summary')
  summary(
    @CurrentUser() actor: AuthUser,
    @Query('range') range: SheerLabAnalyticsRange = 'today',
    @Query('locationId') locationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SheerLabAnalyticsResponse> {
    return this.labAnalytics.summary(actor, range, locationId, from, to);
  }
}

// Lab-session-token authenticated variant for the dedicated Sheer Lab app.
// The station's location and the actor's role come from the active session;
// the service rejects stylist sessions so insights stay owner/manager-only.
@Controller('lab/analytics/session')
export class LabSessionAnalyticsController {
  constructor(
    private readonly labAnalytics: LabAnalyticsService,
    private readonly labSessionService: LabSessionService,
  ) {}

  @Get(':sessionId/summary')
  async summary(
    @Param('sessionId') sessionId: string,
    @Query('range') range: SheerLabAnalyticsRange = 'today',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SheerLabAnalyticsResponse> {
    const session = await this.labSessionService.assertActiveSession(sessionId);
    return this.labAnalytics.summaryForLabSession(session, range, from, to);
  }
}
