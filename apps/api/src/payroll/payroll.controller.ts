/**
 * Owner/manager payroll workflow.
 *
 * Guard notes (docs/V1.1/3-2 plan.md §6.4):
 *  - `getAllAndOverride` means a handler-level @RequirePermissions REPLACES the
 *    class-level one, so EVERY handler re-lists 'payroll.view' alongside its
 *    specific key. Do not remove the "redundant" entries.
 *  - Locked/paid-period writes are refused in the service with 403 before any
 *    DB trigger can surface as a 500.
 *  - Manager location scoping is applied inside the services (permissions have
 *    no location dimension).
 * Self-view endpoints live on PayrollSelfController — stylists are deliberately
 * NOT in this controller's role list.
 */

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ListPayPeriodsResponse,
  ListPaySummariesResponse,
  PayPeriodDetailResponse,
  PayrollReadiness,
  PaySummaryDetailResponse,
  PayrollSettingsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  CreatePayPeriodDto,
  DataSourceParamDto,
  ListPayPeriodsQueryDto,
  PayPeriodIdParamDto,
  PaySummaryIdParamDto,
  UpdateDataSourceDto,
} from './dto';
import {
  AssignPayStructureDto,
  CreatePayStructureDto,
  PayStructureIdParamDto,
  PayStructurePreviewDto,
  PayStructureRulesDto,
  StaffProfileIdParamDto,
} from './structures.dto';
import { PayrollPeriodService } from './payroll-period.service';
import { PayrollStructuresService } from './payroll-structures.service';
import { PayrollService } from './payroll.service';

@Controller('payroll')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('payroll.view')
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly periods: PayrollPeriodService,
    private readonly structures: PayrollStructuresService,
  ) {}

  // ---- Read/review (payroll.view) ----

  @Get('settings')
  @RequirePermissions('payroll.view')
  async getSettings(@CurrentUser() actor: AuthUser): Promise<PayrollSettingsResponse> {
    return this.payroll.getSettings(actor);
  }

  @Get('data-sources')
  @RequirePermissions('payroll.view')
  async getDataSources(@CurrentUser() actor: AuthUser) {
    return this.payroll.getDataSources(actor);
  }

  @Patch('data-sources/:source')
  @RequireRoles('owner')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async updateDataSource(
    @CurrentUser() actor: AuthUser,
    @Param() params: DataSourceParamDto,
    @Body() body: UpdateDataSourceDto,
  ) {
    return this.payroll.updateDataSource(actor, params.source, body.isCaptured);
  }

  @Get('structures')
  @RequirePermissions('payroll.view')
  async listStructures(@CurrentUser() actor: AuthUser) {
    return this.payroll.listStructures(actor);
  }

  @Get('periods')
  @RequirePermissions('payroll.view')
  async listPeriods(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListPayPeriodsQueryDto,
  ): Promise<ListPayPeriodsResponse> {
    return this.payroll.listPeriods(actor, query);
  }

  @Get('periods/:periodId')
  @RequirePermissions('payroll.view')
  async getPeriod(
    @CurrentUser() actor: AuthUser,
    @Param() params: PayPeriodIdParamDto,
  ): Promise<PayPeriodDetailResponse> {
    return this.payroll.getPeriodDetail(actor, params.periodId);
  }

  @Get('periods/:periodId/readiness')
  @RequirePermissions('payroll.view')
  async getReadiness(
    @CurrentUser() actor: AuthUser,
    @Param() params: PayPeriodIdParamDto,
  ): Promise<PayrollReadiness> {
    return this.payroll.getReadiness(actor, params.periodId);
  }

  @Get('periods/:periodId/summaries')
  @RequirePermissions('payroll.view')
  async listSummaries(
    @CurrentUser() actor: AuthUser,
    @Param() params: PayPeriodIdParamDto,
  ): Promise<ListPaySummariesResponse> {
    return this.payroll.listSummaries(actor, params.periodId);
  }

  @Get('summaries/:summaryId')
  @RequirePermissions('payroll.view')
  async getSummary(
    @CurrentUser() actor: AuthUser,
    @Param() params: PaySummaryIdParamDto,
  ): Promise<PaySummaryDetailResponse> {
    return this.payroll.getSummaryBreakdown(actor, params.summaryId);
  }

  // ---- Pay-structure authoring (OWNER-only + payroll.view + payroll.edit).
  // Handler-level @RequireRoles REPLACES the class list (getAllAndOverride):
  // that narrowing to 'owner' is deliberate — managers never author rules. ----

  @Get('structures/:structureId')
  @RequirePermissions('payroll.view')
  async getStructure(@CurrentUser() actor: AuthUser, @Param() params: PayStructureIdParamDto) {
    return this.structures.getDetail(actor, params.structureId);
  }

  @Post('structures')
  @RequireRoles('owner')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async createStructure(@CurrentUser() actor: AuthUser, @Body() body: CreatePayStructureDto) {
    return this.structures.create(actor, body);
  }

  @Post('structures/preview')
  @RequireRoles('owner')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async previewStructure(@CurrentUser() actor: AuthUser, @Body() body: PayStructurePreviewDto) {
    void actor; // preview is pure; guards still gate who may exercise it
    return this.structures.preview(body);
  }

  @Post('structures/:structureId/versions')
  @RequireRoles('owner')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async createStructureVersion(
    @CurrentUser() actor: AuthUser,
    @Param() params: PayStructureIdParamDto,
    @Body() body: PayStructureRulesDto,
  ) {
    return this.structures.createVersion(actor, params.structureId, body);
  }

  // ---- Assignment (owner or manager-within-location, + payroll.edit) ----

  @Post('staff/:staffProfileId/assignment')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async assignStructure(
    @CurrentUser() actor: AuthUser,
    @Param() params: StaffProfileIdParamDto,
    @Body() body: AssignPayStructureDto,
  ) {
    return this.structures.assign(actor, params.staffProfileId, body);
  }

  // ---- Create / generate / ready (payroll.view + payroll.edit) ----

  @Post('periods')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async createPeriod(@CurrentUser() actor: AuthUser, @Body() body: CreatePayPeriodDto) {
    return { period: await this.periods.createPeriod(actor, body) };
  }

  @Post('periods/:periodId/generate')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async generate(@CurrentUser() actor: AuthUser, @Param() params: PayPeriodIdParamDto) {
    return this.periods.generate(actor, params.periodId);
  }

  @Post('periods/:periodId/ready')
  @RequirePermissions('payroll.view', 'payroll.edit')
  async markReady(@CurrentUser() actor: AuthUser, @Param() params: PayPeriodIdParamDto) {
    return { period: await this.periods.transition(actor, params.periodId, 'ready') };
  }

  // ---- Approve (payroll.view + payroll.approve) ----

  @Post('periods/:periodId/approve')
  @RequirePermissions('payroll.view', 'payroll.approve')
  async approve(@CurrentUser() actor: AuthUser, @Param() params: PayPeriodIdParamDto) {
    return { period: await this.periods.transition(actor, params.periodId, 'approve') };
  }

  // ---- Lock & mark-paid (payroll.view + payroll.lock — plan Q8 decision) ----

  @Post('periods/:periodId/lock')
  @RequirePermissions('payroll.view', 'payroll.lock')
  async lock(@CurrentUser() actor: AuthUser, @Param() params: PayPeriodIdParamDto) {
    return { period: await this.periods.transition(actor, params.periodId, 'lock') };
  }

  @Post('periods/:periodId/mark-paid')
  @RequirePermissions('payroll.view', 'payroll.lock')
  async markPaid(@CurrentUser() actor: AuthUser, @Param() params: PayPeriodIdParamDto) {
    return { period: await this.periods.transition(actor, params.periodId, 'mark-paid') };
  }
}
