/**
 * Stylist self-view. A SEPARATE controller because the management
 * controller's role list excludes stylists, and merging them would force a
 * role union broad enough to leak (docs/V1.1/3-2 plan.md W3.2-H).
 *
 * The staff profile is resolved SERVER-SIDE from the verified actor. There is
 * no staffProfileId parameter on any handler — a colleague's pay is
 * unrequestable by construction, and a colleague's summary id returns 404
 * (not 403) so the endpoint is not an existence oracle.
 */

import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type { AuthUser, MyPaySummariesResponse, PaySummaryDetailResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PaySummaryIdParamDto } from './dto';
import { PayrollService } from './payroll.service';

@Controller('payroll/me')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('payroll.self.view')
export class PayrollSelfController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('summaries')
  @RequirePermissions('payroll.self.view')
  async listMySummaries(@CurrentUser() actor: AuthUser): Promise<MyPaySummariesResponse> {
    return this.payroll.listOwnSummaries(actor);
  }

  @Get('summaries/:summaryId')
  @RequirePermissions('payroll.self.view')
  async getMySummary(
    @CurrentUser() actor: AuthUser,
    @Param() params: PaySummaryIdParamDto,
  ): Promise<PaySummaryDetailResponse> {
    return this.payroll.getOwnSummaryBreakdown(actor, params.summaryId);
  }
}
