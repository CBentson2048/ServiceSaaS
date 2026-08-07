/**
 * Read side of the payroll workflow: settings, data sources, structures,
 * period lists with totals, summaries and the explainability breakdown.
 *
 * Tenancy: every query carries business_id (the service-role client bypasses
 * RLS — the API layer IS the access control). Manager location scoping is
 * applied by filtering summaries to staff whose primary location is inside
 * the manager's allowedLocationIds — permissions carry no location dimension
 * and pay_summaries has no location column (docs/V1.1/3-2 plan.md §6.4).
 *
 * Self-view: resolveOwnSummaries derives the staff profile SERVER-SIDE from
 * the actor. No staffProfileId parameter exists on that path by construction.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  ListPayPeriodsResponse,
  ListPaySummariesResponse,
  MyPayPeriod,
  MyPaySummariesResponse,
  MyPaySummaryListItem,
  PayPeriodDetailResponse,
  PayrollBusinessDataSource,
  PayrollDataSource,
  PaySummaryBreakdown,
  PaySummaryDetailResponse,
  PaySummaryListItem,
  PayrollSettingsResponse,
  PayrollWarning,
} from '@sheer/domain';
import { SELF_VIEW_PAY_PERIOD_STATUSES, userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { PayrollInputsService, type TrustedStaff } from './payroll-inputs.service';
import { PayrollPeriodService, toPayPeriod } from './payroll-period.service';
import { PayrollReadinessService } from './payroll-readiness.service';
import { numOrNull, numOrZero } from './payroll-money';

interface SummaryRow {
  id: string;
  business_id: string;
  pay_period_id: string;
  staff_profile_id: string;
  employment_type_snapshot: string;
  structure_id: string | null;
  structure_version_id: string | null;
  currency_code: string;
  service_revenue_cents: number | string;
  retail_revenue_cents: number | string;
  total_collected_cents: number | string;
  base_pay_cents: number | string;
  commission_cents: number | string;
  revenue_split_cents: number | string;
  bonus_cents: number | string;
  chair_rent_cents: number | string;
  deductions_cents: number | string;
  tips_paid_out_cents: number | string;
  tips_owed_cents: number | string;
  adjustments_cents: number | string;
  net_payable_cents: number | string;
  business_retained_cents: number | string;
  greater_of_applied: boolean;
  greater_of_winner: string | null;
  is_stale: boolean;
  stale_reason: string | null;
  superseded_by_id: string | null;
  inputs_snapshot: Record<string, unknown>;
  generated_by_user_profile_id: string | null;
  generated_at: string;
  exported_at: string | null;
  emailed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SUMMARY_COLUMNS =
  'id,business_id,pay_period_id,staff_profile_id,employment_type_snapshot,structure_id,structure_version_id,currency_code,service_revenue_cents,retail_revenue_cents,total_collected_cents,base_pay_cents,commission_cents,revenue_split_cents,bonus_cents,chair_rent_cents,deductions_cents,tips_paid_out_cents,tips_owed_cents,adjustments_cents,net_payable_cents,business_retained_cents,greater_of_applied,greater_of_winner,is_stale,stale_reason,superseded_by_id,inputs_snapshot,generated_by_user_profile_id,generated_at,exported_at,emailed_at,created_at,updated_at';

interface LineRow {
  id: string;
  summary_id: string;
  sequence_no: number | string;
  line_type: string;
  stage_id: string | null;
  band_id: string | null;
  label: string | null;
  source_type: string | null;
  source_id: string | null;
  occurred_on: string | null;
  quantity: number | string | null;
  basis_amount_cents: number | string | null;
  vat_rate_percent_snapshot: number | string | null;
  rate_percent: number | string | null;
  amount_cents: number | string;
  structure_version_id: string | null;
  source_unavailable: boolean;
  unavailable_source: string | null;
  created_at: string;
}

interface HoursRow {
  id: string;
  summary_id: string;
  category: string;
  hours: number | string;
  counted_toward_target: boolean;
  counted_as_paid: boolean;
  notes: string | null;
  created_at: string;
}

@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly inputs: PayrollInputsService,
    private readonly periods: PayrollPeriodService,
    private readonly readiness: PayrollReadinessService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Settings / data sources / structures
  // ---------------------------------------------------------------------------

  async getSettings(actor: AuthUser): Promise<PayrollSettingsResponse> {
    const settings = await this.inputs.loadSettings(actor.businessId);
    const { rows } = await this.inputs.loadCaptureMatrix(actor.businessId);
    return {
      settings: {
        businessId: settings.businessId,
        weekStartDay: settings.weekStartDay,
        defaultCalculationFrequency: settings.defaultCalculationFrequency,
        defaultPaymentFrequency: settings.defaultPaymentFrequency,
        timezone: settings.timezone,
        createdAt: settings.createdAt,
        updatedAt: settings.updatedAt,
      },
      dataSources: rows,
    };
  }

  async listStructures(actor: AuthUser): Promise<{
    structures: Array<{
      id: string;
      name: string;
      description: string | null;
      isSystem: boolean;
      isActive: boolean;
      assignedStaffCount: number;
    }>;
  }> {
    const [{ data: structures, error }, { data: assignments, error: assignmentsError }] =
      await Promise.all([
        this.admin
          .schema('payroll')
          .from('pay_structures')
          .select('id,name,description,is_system,is_active')
          .eq('business_id', actor.businessId)
          .order('name'),
        this.admin
          .schema('payroll')
          .from('staff_pay_assignments')
          .select('structure_id,staff_profile_id,effective_from,effective_to')
          .eq('business_id', actor.businessId),
      ]);
    if (error || assignmentsError) {
      this.logger.error(`listStructures failed: ${error?.message ?? assignmentsError?.message}`);
      throw new InternalServerErrorException('Unable to load pay structures');
    }
    const today = new Date().toISOString().slice(0, 10);
    const activeAssignments = (assignments ?? []).filter(
      (a) => a.effective_from <= today && (a.effective_to === null || a.effective_to > today),
    );
    return {
      structures: (structures ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        isSystem: s.is_system === true,
        isActive: s.is_active === true,
        assignedStaffCount: activeAssignments.filter((a) => a.structure_id === s.id).length,
      })),
    };
  }

  async getDataSources(actor: AuthUser) {
    const { rows } = await this.inputs.loadCaptureMatrix(actor.businessId);
    return { dataSources: rows };
  }

  /**
   * Flip a source's capture flag. Only sources with a REAL capture path may
   * ever be marked captured — flipping retail on silences every "not
   * captured" warning, so it must reflect the truth: the till panel exists
   * and the team records sales through it. Tips/refunds/cancellation fees
   * have no capture path anywhere in the product yet, so marking them
   * captured is refused outright (it would turn honest warnings into
   * confident £0s — the exact failure principle 4 exists to prevent).
   */
  async updateDataSource(
    actor: AuthUser,
    source: PayrollDataSource,
    isCaptured: boolean,
  ): Promise<{ dataSources: PayrollBusinessDataSource[] }> {
    const CAPTURABLE: PayrollDataSource[] = ['retail_sales'];
    if (isCaptured && !CAPTURABLE.includes(source)) {
      throw new BadRequestException(
        `${source} cannot be marked captured: the product has no capture path for it yet`,
      );
    }
    const { error } = await this.admin
      .schema('payroll')
      .from('business_data_sources')
      .update({
        is_captured: isCaptured,
        notes: isCaptured
          ? 'Enabled from the web app (retail sale recording panel).'
          : 'Disabled from the web app.',
      })
      .eq('business_id', actor.businessId)
      .eq('source', source);
    if (error) {
      this.logger.error(`updateDataSource failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update the data source');
    }
    await this.audit.record(actor, {
      entityType: 'pay_structure',
      entityId: actor.businessId,
      action: 'payroll.data_source_updated',
      after: { source, isCaptured },
    });
    return this.getDataSources(actor);
  }

  // ---------------------------------------------------------------------------
  // Periods
  // ---------------------------------------------------------------------------

  async listPeriods(
    actor: AuthUser,
    query: { kind?: string; status?: string; from?: string; to?: string },
  ): Promise<ListPayPeriodsResponse> {
    let request = this.admin
      .schema('payroll')
      .from('pay_periods')
      .select(
        'id,business_id,location_id,kind,frequency,period_start,period_end,label,status,parent_payment_period_id,generated_by_user_profile_id,generated_at,approved_by_user_profile_id,approved_at,locked_by_user_profile_id,locked_at,marked_paid_by_user_profile_id,paid_at,notes,created_at,updated_at',
      )
      .eq('business_id', actor.businessId)
      .order('period_start', { ascending: false })
      .limit(100);
    if (query.kind) request = request.eq('kind', query.kind);
    if (query.status) request = request.eq('status', query.status);
    if (query.from) request = request.gte('period_start', query.from);
    if (query.to) request = request.lt('period_start', query.to);
    const { data, error } = await request;
    if (error) {
      this.logger.error(`listPeriods failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay periods');
    }

    const visible = (data ?? []).filter(
      (row) =>
        !row.location_id ||
        userHasRole(actor, 'owner') ||
        actor.allowedLocationIds.includes(row.location_id),
    );

    const periodIds = visible.map((row) => row.id);
    const totalsByPeriod = await this.loadTotals(actor, periodIds);

    return {
      periods: visible.map((row) => ({
        period: toPayPeriod(row as never),
        totals: totalsByPeriod.get(row.id) ?? null,
      })),
    };
  }

  private async loadTotals(actor: AuthUser, periodIds: string[]) {
    const totals = new Map<
      string,
      {
        staffCount: number;
        totalNetPayableCents: number;
        totalBasePayCents: number;
        totalCommissionCents: number;
        staleCount: number;
        currencyCode: string;
      }
    >();
    if (periodIds.length === 0) return totals;
    const scoped = await this.scopedStaffIds(actor);
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .select(
        'pay_period_id,staff_profile_id,net_payable_cents,base_pay_cents,commission_cents,is_stale,currency_code',
      )
      .in('pay_period_id', periodIds)
      .eq('business_id', actor.businessId)
      .is('superseded_by_id', null);
    if (error) {
      this.logger.error(`loadTotals failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay period totals');
    }
    for (const row of data ?? []) {
      if (scoped !== null && !scoped.has(row.staff_profile_id)) continue;
      const entry = totals.get(row.pay_period_id) ?? {
        staffCount: 0,
        totalNetPayableCents: 0,
        totalBasePayCents: 0,
        totalCommissionCents: 0,
        staleCount: 0,
        currencyCode: row.currency_code ?? 'GBP',
      };
      entry.staffCount += 1;
      entry.totalNetPayableCents += numOrZero(row.net_payable_cents);
      entry.totalBasePayCents += numOrZero(row.base_pay_cents);
      entry.totalCommissionCents += numOrZero(row.commission_cents);
      if (row.is_stale === true) entry.staleCount += 1;
      totals.set(row.pay_period_id, entry);
    }
    return totals;
  }

  async getPeriodDetail(actor: AuthUser, periodId: string): Promise<PayPeriodDetailResponse> {
    const period = await this.periods.fetchPeriodForBusiness(actor, periodId);
    const totals = await this.loadTotals(actor, [period.id]);
    const readiness =
      period.status === 'draft'
        ? await this.readiness.assess({
            actor,
            periodStart: period.period_start,
            periodEnd: period.period_end,
            locationId: period.location_id,
          })
        : null;
    return {
      period: toPayPeriod(period),
      totals: totals.get(period.id) ?? null,
      readiness,
    };
  }

  async getReadiness(actor: AuthUser, periodId: string) {
    const period = await this.periods.fetchPeriodForBusiness(actor, periodId);
    return this.readiness.assess({
      actor,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      locationId: period.location_id,
    });
  }

  // ---------------------------------------------------------------------------
  // Summaries
  // ---------------------------------------------------------------------------

  async listSummaries(actor: AuthUser, periodId: string): Promise<ListPaySummariesResponse> {
    const period = await this.periods.fetchPeriodForBusiness(actor, periodId);
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .select(SUMMARY_COLUMNS)
      .eq('pay_period_id', period.id)
      .eq('business_id', actor.businessId)
      .is('superseded_by_id', null)
      .returns<SummaryRow[]>();
    if (error) {
      this.logger.error(`listSummaries failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay summaries');
    }

    const scoped = await this.scopedStaffIds(actor);
    const staff = await this.inputs.loadStaff(actor.businessId);
    const staffById = new Map(staff.map((s) => [s.staffProfileId, s]));
    const structureNames = await this.structureNames(actor.businessId);

    const summaries: PaySummaryListItem[] = [];
    const periodWarnings: PayrollWarning[] = [];
    for (const row of data ?? []) {
      if (scoped !== null && !scoped.has(row.staff_profile_id)) continue;
      summaries.push(
        this.toListItem(row, staffById.get(row.staff_profile_id) ?? null, structureNames),
      );
    }
    return { period: toPayPeriod(period), summaries, periodWarnings };
  }

  async getSummaryBreakdown(actor: AuthUser, summaryId: string): Promise<PaySummaryDetailResponse> {
    const row = await this.fetchSummary(actor.businessId, summaryId);
    const scoped = await this.scopedStaffIds(actor);
    if (scoped !== null && !scoped.has(row.staff_profile_id)) {
      // 404, not 403 — no existence oracle for out-of-scope pay records.
      throw new NotFoundException('Pay summary not found');
    }
    return { breakdown: await this.buildBreakdown(actor, row) };
  }

  // ---------------------------------------------------------------------------
  // Stylist self-view — staff profile resolved from the ACTOR, never a param.
  // ---------------------------------------------------------------------------

  async listOwnSummaries(actor: AuthUser): Promise<MyPaySummariesResponse> {
    const staffProfileId = actor.staffProfileId;
    if (!staffProfileId) {
      throw new ForbiddenException('Your account has no staff profile');
    }
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .select(SUMMARY_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('staff_profile_id', staffProfileId)
      .is('superseded_by_id', null)
      .order('generated_at', { ascending: false })
      .limit(52)
      .returns<SummaryRow[]>();
    if (error) {
      this.logger.error(`listOwnSummaries failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load your pay summaries');
    }
    // Rows in unapproved periods are dropped AFTER the limit — the list may
    // return fewer than 52, never a draft figure.
    const visiblePeriods = await this.selfVisiblePeriods(actor.businessId, [
      ...new Set((data ?? []).map((row) => row.pay_period_id)),
    ]);
    const staff = await this.inputs.loadStaff(actor.businessId);
    const me = staff.find((s) => s.staffProfileId === staffProfileId) ?? null;
    const structureNames = await this.structureNames(actor.businessId);
    const summaries: MyPaySummaryListItem[] = [];
    for (const row of data ?? []) {
      const period = visiblePeriods.get(row.pay_period_id);
      if (!period) continue;
      summaries.push({ ...this.toListItem(row, me, structureNames), period });
    }
    return { summaries };
  }

  async getOwnSummaryBreakdown(
    actor: AuthUser,
    summaryId: string,
  ): Promise<PaySummaryDetailResponse> {
    const staffProfileId = actor.staffProfileId;
    if (!staffProfileId) {
      throw new ForbiddenException('Your account has no staff profile');
    }
    const row = await this.fetchSummary(actor.businessId, summaryId);
    if (row.staff_profile_id !== staffProfileId) {
      // A colleague's summary id is a 404, not a 403 — no existence oracle.
      throw new NotFoundException('Pay summary not found');
    }
    const visiblePeriods = await this.selfVisiblePeriods(actor.businessId, [row.pay_period_id]);
    if (!visiblePeriods.has(row.pay_period_id)) {
      // Same 404 as nonexistent: an unapproved statement is not published yet.
      throw new NotFoundException('Pay summary not found');
    }
    return { breakdown: await this.buildBreakdown(actor, row) };
  }

  /**
   * The parent periods a stylist may see, keyed by id. Only approved, locked
   * or paid periods qualify — draft and ready-for-review figures are the
   * owner's unreviewed working numbers (docs/V1.1/3-2 plan.md §6.3).
   */
  private async selfVisiblePeriods(
    businessId: string,
    periodIds: string[],
  ): Promise<Map<string, MyPayPeriod>> {
    if (periodIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_periods')
      .select('id,kind,period_start,period_end,label,status')
      .eq('business_id', businessId)
      .in('id', periodIds)
      .in('status', [...SELF_VIEW_PAY_PERIOD_STATUSES])
      .returns<
        {
          id: string;
          kind: string;
          period_start: string;
          period_end: string;
          label: string | null;
          status: string;
        }[]
      >();
    if (error) {
      this.logger.error(`selfVisiblePeriods failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load your pay summaries');
    }
    return new Map(
      (data ?? []).map((row) => [
        row.id,
        {
          payPeriodId: row.id,
          kind: row.kind as MyPayPeriod['kind'],
          periodStart: row.period_start,
          periodEnd: row.period_end,
          label: row.label,
          status: row.status as MyPayPeriod['status'],
        },
      ]),
    );
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Null = unscoped (owner). Managers see only staff at their locations. */
  private async scopedStaffIds(actor: AuthUser): Promise<Set<string> | null> {
    if (userHasRole(actor, 'owner')) return null;
    const staff = await this.inputs.loadStaff(actor.businessId);
    return new Set(
      staff
        .filter(
          (s) =>
            s.primaryLocationId !== null && actor.allowedLocationIds.includes(s.primaryLocationId),
        )
        .map((s) => s.staffProfileId),
    );
  }

  private async fetchSummary(businessId: string, summaryId: string): Promise<SummaryRow> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .select(SUMMARY_COLUMNS)
      .eq('id', summaryId)
      .eq('business_id', businessId)
      .maybeSingle<SummaryRow>();
    if (error) {
      this.logger.error(`fetchSummary failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay summary');
    }
    if (!data) throw new NotFoundException('Pay summary not found');
    return data;
  }

  private async structureNames(businessId: string): Promise<Map<string, string>> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_structures')
      .select('id,name')
      .eq('business_id', businessId);
    if (error) {
      this.logger.error(`structureNames failed: ${error.message}`);
      return new Map();
    }
    return new Map((data ?? []).map((s) => [s.id, s.name]));
  }

  private toListItem(
    row: SummaryRow,
    staff: TrustedStaff | null,
    structureNames: Map<string, string>,
  ): PaySummaryListItem {
    const snapshot = row.inputs_snapshot ?? {};
    const warnings = (snapshot['warnings'] as PayrollWarning[] | undefined) ?? [];
    const accelerator = snapshot['accelerator'] as { achieved?: boolean | null } | null;
    const rule = snapshot['rule'] as { versionNo?: number } | undefined;
    return {
      summaryId: row.id,
      staffProfileId: row.staff_profile_id,
      staffName: staff?.staffName ?? 'Former staff member',
      employmentTypeSnapshot: row.employment_type_snapshot,
      structureName: row.structure_id ? (structureNames.get(row.structure_id) ?? null) : null,
      structureVersionNo: rule?.versionNo ?? null,
      payableHours: numOrZero(snapshot['payableHours'] as never),
      workedHours: numOrZero(
        ((snapshot['hours'] as { category: string; hours: number }[] | undefined) ?? []).find(
          (h) => h.category === 'worked',
        )?.hours as never,
      ),
      serviceRevenueTargetCents: numOrNull(
        (snapshot['target'] as { targetCents?: number | null } | undefined)?.targetCents as never,
      ),
      serviceRevenueCents: numOrZero(row.service_revenue_cents),
      retailRevenueCents: numOrZero(row.retail_revenue_cents),
      basePayCents: numOrZero(row.base_pay_cents),
      commissionCents: numOrZero(row.commission_cents),
      revenueSplitCents: numOrZero(row.revenue_split_cents),
      chairRentCents: numOrZero(row.chair_rent_cents),
      deductionsCents: numOrZero(row.deductions_cents),
      bonusCents: numOrZero(row.bonus_cents),
      adjustmentsCents: numOrZero(row.adjustments_cents),
      netPayableCents: numOrZero(row.net_payable_cents),
      businessRetainedCents: numOrZero(row.business_retained_cents),
      greaterOfApplied: row.greater_of_applied === true,
      greaterOfWinner: (row.greater_of_winner as PaySummaryListItem['greaterOfWinner']) ?? null,
      acceleratorAchieved: accelerator ? (accelerator.achieved ?? null) : null,
      isStale: row.is_stale === true,
      staleReason: row.stale_reason,
      warnings,
      currencyCode: row.currency_code,
    };
  }

  private async buildBreakdown(actor: AuthUser, row: SummaryRow): Promise<PaySummaryBreakdown> {
    const [linesResult, hoursResult, adjustmentsResult, targetAdjustmentsResult] =
      await Promise.all([
        this.admin
          .schema('payroll')
          .from('pay_summary_lines')
          .select(
            'id,summary_id,sequence_no,line_type,stage_id,band_id,label,source_type,source_id,occurred_on,quantity,basis_amount_cents,vat_rate_percent_snapshot,rate_percent,amount_cents,structure_version_id,source_unavailable,unavailable_source,created_at',
          )
          .eq('summary_id', row.id)
          .order('sequence_no')
          .returns<LineRow[]>(),
        this.admin
          .schema('payroll')
          .from('pay_summary_hours')
          .select(
            'id,summary_id,category,hours,counted_toward_target,counted_as_paid,notes,created_at',
          )
          .eq('summary_id', row.id)
          .returns<HoursRow[]>(),
        this.admin
          .schema('payroll')
          .from('pay_adjustments')
          .select(
            'id,business_id,staff_profile_id,origin_pay_period_id,applied_in_pay_period_id,reason,amount_cents,description,source_type,source_id,created_by_user_profile_id,created_at,applied_at',
          )
          .eq('business_id', actor.businessId)
          .eq('staff_profile_id', row.staff_profile_id)
          .eq('applied_in_pay_period_id', row.pay_period_id),
        this.admin
          .schema('payroll')
          .from('target_adjustments')
          .select(
            'id,business_id,staff_profile_id,pay_period_id,summary_id,original_target_cents,adjusted_target_cents,reason,adjusted_by_user_profile_id,adjusted_at,notes',
          )
          .eq('business_id', actor.businessId)
          .eq('pay_period_id', row.pay_period_id)
          .eq('staff_profile_id', row.staff_profile_id),
      ]);
    if (linesResult.error || hoursResult.error) {
      this.logger.error(
        `buildBreakdown failed: ${linesResult.error?.message ?? hoursResult.error?.message}`,
      );
      throw new InternalServerErrorException('Unable to load pay summary breakdown');
    }

    const snapshot = row.inputs_snapshot ?? {};
    const staff = await this.inputs.loadStaff(actor.businessId);
    const staffName =
      staff.find((s) => s.staffProfileId === row.staff_profile_id)?.staffName ??
      ((snapshot['staff'] as { staffName?: string } | undefined)?.staffName ||
        'Former staff member');

    const target = (snapshot['target'] as PaySummaryBreakdown['target'] | undefined) ?? {
      targetCents: null,
      basis: null,
      derivation: 'Not recorded.',
      adjustments: [],
    };
    target.adjustments = (targetAdjustmentsResult.data ?? []).map((adjustment) => ({
      id: adjustment.id,
      businessId: adjustment.business_id,
      staffProfileId: adjustment.staff_profile_id,
      payPeriodId: adjustment.pay_period_id,
      summaryId: adjustment.summary_id,
      originalTargetCents: numOrZero(adjustment.original_target_cents),
      adjustedTargetCents: numOrZero(adjustment.adjusted_target_cents),
      reason: adjustment.reason,
      adjustedByUserProfileId: adjustment.adjusted_by_user_profile_id,
      adjustedAt: adjustment.adjusted_at,
      notes: adjustment.notes,
    }));

    return {
      summary: {
        id: row.id,
        businessId: row.business_id,
        payPeriodId: row.pay_period_id,
        staffProfileId: row.staff_profile_id,
        employmentTypeSnapshot: row.employment_type_snapshot,
        structureId: row.structure_id,
        structureVersionId: row.structure_version_id,
        currencyCode: row.currency_code,
        serviceRevenueCents: numOrZero(row.service_revenue_cents),
        retailRevenueCents: numOrZero(row.retail_revenue_cents),
        totalCollectedCents: numOrZero(row.total_collected_cents),
        basePayCents: numOrZero(row.base_pay_cents),
        commissionCents: numOrZero(row.commission_cents),
        revenueSplitCents: numOrZero(row.revenue_split_cents),
        bonusCents: numOrZero(row.bonus_cents),
        chairRentCents: numOrZero(row.chair_rent_cents),
        deductionsCents: numOrZero(row.deductions_cents),
        tipsPaidOutCents: numOrZero(row.tips_paid_out_cents),
        tipsOwedCents: numOrZero(row.tips_owed_cents),
        adjustmentsCents: numOrZero(row.adjustments_cents),
        netPayableCents: numOrZero(row.net_payable_cents),
        businessRetainedCents: numOrZero(row.business_retained_cents),
        greaterOfApplied: row.greater_of_applied === true,
        greaterOfWinner: (row.greater_of_winner as never) ?? null,
        isStale: row.is_stale === true,
        staleReason: row.stale_reason,
        supersededById: row.superseded_by_id,
        generatedByUserProfileId: row.generated_by_user_profile_id,
        generatedAt: row.generated_at,
        exportedAt: row.exported_at,
        emailedAt: row.emailed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      staffName,
      hours: (hoursResult.data ?? []).map((h) => ({
        id: h.id,
        summaryId: h.summary_id,
        category: h.category as never,
        hours: numOrZero(h.hours),
        countedTowardTarget: h.counted_toward_target === true,
        countedAsPaid: h.counted_as_paid === true,
        notes: h.notes,
        createdAt: h.created_at,
      })),
      lines: (linesResult.data ?? []).map((l) => ({
        id: l.id,
        summaryId: l.summary_id,
        sequenceNo: numOrZero(l.sequence_no),
        lineType: l.line_type as never,
        stageId: l.stage_id,
        bandId: l.band_id,
        label: l.label,
        sourceType: (l.source_type as never) ?? null,
        sourceId: l.source_id,
        occurredOn: l.occurred_on,
        quantity: numOrNull(l.quantity),
        basisAmountCents: numOrNull(l.basis_amount_cents),
        vatRatePercentSnapshot: numOrNull(l.vat_rate_percent_snapshot),
        ratePercent: numOrNull(l.rate_percent),
        amountCents: numOrZero(l.amount_cents),
        structureVersionId: l.structure_version_id,
        sourceUnavailable: l.source_unavailable === true,
        unavailableSource: (l.unavailable_source as never) ?? null,
        createdAt: l.created_at,
      })),
      target,
      accelerator:
        (snapshot['accelerator'] as PaySummaryBreakdown['accelerator'] | undefined) ?? null,
      bands: (snapshot['bands'] as PaySummaryBreakdown['bands'] | undefined) ?? [],
      greaterOf: (snapshot['greaterOf'] as PaySummaryBreakdown['greaterOf'] | undefined) ?? null,
      adjustments: (adjustmentsResult.data ?? []).map((a) => ({
        id: a.id,
        businessId: a.business_id,
        staffProfileId: a.staff_profile_id,
        originPayPeriodId: a.origin_pay_period_id,
        appliedInPayPeriodId: a.applied_in_pay_period_id,
        reason: a.reason,
        amountCents: numOrZero(a.amount_cents),
        description: a.description,
        sourceType: (a.source_type as never) ?? null,
        sourceId: a.source_id,
        createdByUserProfileId: a.created_by_user_profile_id,
        createdAt: a.created_at,
        appliedAt: a.applied_at,
      })),
      warnings: (snapshot['warnings'] as PayrollWarning[] | undefined) ?? [],
    };
  }
}
