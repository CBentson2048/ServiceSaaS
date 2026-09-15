import { Controller, Get, NotFoundException, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { ReportDefinition, ReportOptions, ReportResult } from '@sheer/domain';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ReportResultQueryDto } from './dto';
import { ReportAccessGuard } from './report-access.guard';
import { toReportActor, type ReportActor, type ReportRequest } from './report-actor';
import { ReportAvailabilityGuard } from './report-availability.guard';
import { reportHttpError } from './report-errors';
import { ReportScopeService } from './report-scope.service';
import { MoneyReportService } from './money/money-report.service';
import { CashUpReportService } from './cash-up/cash-up-report.service';

/**
 * QLOOQO 10 report foundation routes.
 *
 * Guard order is the contract: availability (404 before any auth work) →
 * authentication (401) → report access (403). No handler carries role or
 * permission metadata — reports.controller.spec.ts pins that, because those
 * guards fail open without it and handler metadata replaces class metadata.
 *
 * Report responses are per-user and financial, so they are never cached by a
 * shared front-desk browser or an intermediary.
 */
@Controller('reports/:reportKey')
@UseGuards(ReportAvailabilityGuard, SupabaseAuthGuard, ReportAccessGuard)
export class ReportsController {
  constructor(
    private readonly scope: ReportScopeService,
    private readonly money: MoneyReportService,
    private readonly cashUp: CashUpReportService,
  ) {}

  /** Takes no selection query: it cannot refuse a selection. */
  @Get('options')
  async options(
    @Req() request: ReportRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReportOptions> {
    response.setHeader('Cache-Control', 'no-store, private');
    const { actor, definition } = this.guarded(request);
    return this.scope.options(actor, definition);
  }

  @Get('result')
  async result(
    @Req() request: ReportRequest,
    @Query() query: ReportResultQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReportResult> {
    response.setHeader('Cache-Control', 'no-store, private');
    const { actor, definition } = this.guarded(request);
    // The one clock read for this request: every location resolves from it.
    const asOf = new Date();
    const scope = await this.scope.resolve(actor, definition, query, asOf);
    const cursor = query.cursor ?? null;
    if (definition.key === 'money') {
      const body = await this.money.build(scope, { cursor });
      return { reportKey: definition.key, filter: scope.resolved, body };
    }
    if (definition.key === 'cash-up') {
      const body = await this.cashUp.build(scope, { cursor });
      return { reportKey: definition.key, filter: scope.resolved, body };
    }
    // Only a report with a paged detail view accepts a cursor.
    if (cursor !== null) throw reportHttpError('report_cursor_invalid');
    return { reportKey: definition.key, filter: scope.resolved, body: null };
  }

  /** What the guards established. Missing means the guards did not run: refuse. */
  private guarded(request: ReportRequest): { actor: ReportActor; definition: ReportDefinition } {
    const definition = request.reportDefinition;
    if (!definition || !request.auth) {
      throw new NotFoundException();
    }
    return { actor: toReportActor(request.auth), definition };
  }
}
