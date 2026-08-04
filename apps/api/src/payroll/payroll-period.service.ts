/**
 * Pay-period lifecycle: create -> generate -> ready_for_review -> approved ->
 * locked -> paid.
 *
 * The DATABASE only blocks backwards moves from locked/paid and born-locked
 * inserts; the full one-step-forward ladder lives HERE (docs/V1.1/3-2 plan.md
 * W3.2-F). Locked/paid writes are refused with 403 in this service BEFORE the
 * DB trigger raises — a trigger error would surface as an opaque 500.
 *
 * Generation is select-then-insert (NEVER upsert: the live-summary unique
 * index is partial, the 0049 42P10 trap) and regeneration deletes-then-inserts
 * inside draft/ready_for_review/approved periods only.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  PayPeriod,
  PayPeriodStatus,
  PayrollReadiness,
  PayrollWarning,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { PayrollInputsService } from './payroll-inputs.service';
import { calculatePaySummary } from './payroll.calc';
import { isBefore, isLocalDate, resolveAnchoredWindow, resolvePeriodWindow } from './period-dates';

interface PeriodRow {
  id: string;
  business_id: string;
  location_id: string | null;
  kind: string;
  frequency: string;
  period_start: string;
  period_end: string;
  label: string | null;
  status: PayPeriodStatus;
  parent_payment_period_id: string | null;
  generated_by_user_profile_id: string | null;
  generated_at: string | null;
  approved_by_user_profile_id: string | null;
  approved_at: string | null;
  locked_by_user_profile_id: string | null;
  locked_at: string | null;
  marked_paid_by_user_profile_id: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const PERIOD_COLUMNS =
  'id,business_id,location_id,kind,frequency,period_start,period_end,label,status,parent_payment_period_id,generated_by_user_profile_id,generated_at,approved_by_user_profile_id,approved_at,locked_by_user_profile_id,locked_at,marked_paid_by_user_profile_id,paid_at,notes,created_at,updated_at';

/** The only legal single-step transitions. Everything else is a 409. */
const NEXT_STATUS: Record<string, PayPeriodStatus> = {
  ready: 'ready_for_review',
  approve: 'approved',
  lock: 'locked',
  'mark-paid': 'paid',
};
const REQUIRED_CURRENT: Record<string, PayPeriodStatus> = {
  ready: 'draft',
  approve: 'ready_for_review',
  lock: 'approved',
  'mark-paid': 'locked',
};

export type PayPeriodTransition = keyof typeof NEXT_STATUS;

export function toPayPeriod(row: PeriodRow): PayPeriod {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    kind: row.kind as PayPeriod['kind'],
    frequency: row.frequency as PayPeriod['frequency'],
    periodStart: row.period_start,
    periodEnd: row.period_end,
    label: row.label,
    status: row.status,
    parentPaymentPeriodId: row.parent_payment_period_id,
    generatedByUserProfileId: row.generated_by_user_profile_id,
    generatedAt: row.generated_at,
    approvedByUserProfileId: row.approved_by_user_profile_id,
    approvedAt: row.approved_at,
    lockedByUserProfileId: row.locked_by_user_profile_id,
    lockedAt: row.locked_at,
    markedPaidByUserProfileId: row.marked_paid_by_user_profile_id,
    paidAt: row.paid_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class PayrollPeriodService {
  private readonly logger = new Logger(PayrollPeriodService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly inputs: PayrollInputsService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Fetch + scope
  // ---------------------------------------------------------------------------

  async fetchPeriodForBusiness(actor: AuthUser, periodId: string): Promise<PeriodRow> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_periods')
      .select(PERIOD_COLUMNS)
      .eq('id', periodId)
      .eq('business_id', actor.businessId)
      .maybeSingle<PeriodRow>();
    if (error) {
      this.logger.error(`fetchPeriod failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay period');
    }
    if (!data) throw new NotFoundException('Pay period not found in your business');
    // A location-scoped period is only visible to managers who cover it.
    // 404, not 403 — out-of-scope must be indistinguishable from nonexistent
    // so manager endpoints are not an existence oracle for other locations.
    if (
      data.location_id &&
      !userHasRole(actor, 'owner') &&
      !actor.allowedLocationIds.includes(data.location_id)
    ) {
      throw new NotFoundException('Pay period not found in your business');
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async createPeriod(
    actor: AuthUser,
    input: {
      kind?: 'calculation' | 'payment';
      frequency?: 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'custom';
      periodStart?: string;
      periodEnd?: string;
      referenceDate?: string;
      locationId?: string;
      label?: string;
    },
  ): Promise<PayPeriod> {
    const settings = await this.inputs.loadSettings(actor.businessId);
    const kind = input.kind ?? 'calculation';
    const frequency =
      input.frequency ??
      (kind === 'calculation'
        ? settings.defaultCalculationFrequency
        : settings.defaultPaymentFrequency);

    let periodStart: string;
    let periodEnd: string;
    if (input.periodStart || input.periodEnd) {
      if (!input.periodStart || !input.periodEnd) {
        throw new BadRequestException('periodStart and periodEnd must be provided together');
      }
      if (!isLocalDate(input.periodStart) || !isLocalDate(input.periodEnd)) {
        throw new BadRequestException('Period dates must be YYYY-MM-DD');
      }
      if (!isBefore(input.periodStart, input.periodEnd)) {
        throw new BadRequestException('periodEnd must be after periodStart (end is exclusive)');
      }
      periodStart = input.periodStart;
      periodEnd = input.periodEnd;
    } else if (frequency === 'custom') {
      throw new BadRequestException('A custom-frequency period needs explicit dates');
    } else {
      const reference = input.referenceDate ?? new Date().toISOString().slice(0, 10);
      if (!isLocalDate(reference)) {
        throw new BadRequestException('referenceDate must be YYYY-MM-DD');
      }
      // Fortnightly/four-weekly cadences have no natural anchor in the week
      // grid — phase-lock to the business's latest period of the same shape so
      // consecutive periods tile exactly with no gap weeks.
      const spanDays = frequency === 'fortnightly' ? 14 : frequency === 'four_weekly' ? 28 : null;
      let anchored: { periodStart: string; periodEnd: string } | null = null;
      if (spanDays !== null) {
        const { data: latest } = await this.admin
          .schema('payroll')
          .from('pay_periods')
          .select('period_start')
          .eq('business_id', actor.businessId)
          .eq('kind', kind)
          .eq('frequency', frequency)
          .order('period_start', { ascending: false })
          .limit(1)
          .maybeSingle<{ period_start: string }>();
        if (latest) {
          anchored = resolveAnchoredWindow(spanDays, latest.period_start, reference);
        }
      }
      const window = anchored ?? resolvePeriodWindow(frequency, settings.weekStartDay, reference);
      periodStart = window.periodStart;
      periodEnd = window.periodEnd;
    }

    // A manager can only create periods scoped to one of their own locations;
    // business-wide periods cover other locations' pay and are owner-only.
    if (!userHasRole(actor, 'owner')) {
      if (!input.locationId) {
        throw new ForbiddenException(
          'Only an owner can create a business-wide pay period; select one of your locations',
        );
      }
      if (!actor.allowedLocationIds.includes(input.locationId)) {
        throw new ForbiddenException('You do not have access to that location');
      }
    }

    // Select-then-insert (unique window index) with a friendly conflict.
    // Scope matches the DB exclusion constraints: same location, or the
    // business-wide (NULL location) scope — not each other.
    let overlapQuery = this.admin
      .schema('payroll')
      .from('pay_periods')
      .select('id,period_start,period_end,status')
      .eq('business_id', actor.businessId)
      .eq('kind', kind)
      .lt('period_start', periodEnd)
      .gt('period_end', periodStart);
    overlapQuery = input.locationId
      ? overlapQuery.eq('location_id', input.locationId)
      : overlapQuery.is('location_id', null);
    const { data: existing, error: existingError } = await overlapQuery;
    if (existingError) {
      this.logger.error(`createPeriod overlap check failed: ${existingError.message}`);
      throw new InternalServerErrorException('Unable to create pay period');
    }
    const overlapping = (existing ?? []).filter((row: { id: string }) => row);
    if (overlapping.length > 0) {
      throw new ConflictException('A pay period already covers part of that window');
    }

    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_periods')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId ?? null,
        kind,
        frequency,
        period_start: periodStart,
        period_end: periodEnd,
        label: input.label?.trim() || null,
        status: 'draft',
      })
      .select(PERIOD_COLUMNS)
      .single<PeriodRow>();
    if (error || !data) {
      this.logger.error(`createPeriod insert failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create pay period');
    }

    await this.audit.record(actor, {
      entityType: 'pay_period',
      entityId: data.id,
      action: 'pay_period.created',
      after: { periodStart, periodEnd, kind, frequency },
    });
    return toPayPeriod(data);
  }

  // ---------------------------------------------------------------------------
  // Generate (and regenerate)
  // ---------------------------------------------------------------------------

  async generate(
    actor: AuthUser,
    periodId: string,
  ): Promise<{ period: PayPeriod; generated: number; skipped: PayrollReadiness }> {
    const period = await this.fetchPeriodForBusiness(actor, periodId);
    this.assertWritablePeriod(period);
    if (period.kind !== 'calculation') {
      throw new BadRequestException('Only calculation periods can be generated');
    }
    // Generation deletes and rewrites EVERY summary in the period. A manager
    // regenerating a business-wide period would wipe other locations' pay
    // records, so business-wide generation is owner-only (refusal, never a
    // silently narrowed regenerate).
    if (!period.location_id && !userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only an owner can generate a business-wide pay period');
    }

    const settings = await this.inputs.loadSettings(actor.businessId);
    const { capture } = await this.inputs.loadCaptureMatrix(actor.businessId);
    const staff = await this.inputs.loadStaff(actor.businessId);
    const scopedStaff = period.location_id
      ? staff.filter((s) => s.primaryLocationId === period.location_id)
      : staff;
    const versions = await this.inputs.resolveRuleVersions(
      actor.businessId,
      scopedStaff.map((s) => s.staffProfileId),
      period.period_start,
    );
    const engineInputs = await this.inputs.buildEngineInputs({
      businessId: actor.businessId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      timezone: settings.effectiveTimezone,
      staff: scopedStaff,
      versions,
      capture,
      excludeOriginPayPeriodId: period.id,
    });

    // Run the pure engine for everyone first; only staff with an assigned
    // structure get a summary, and blocked staff surface as readiness errors.
    const results = new Map<string, ReturnType<typeof calculatePaySummary>>();
    const readiness: PayrollReadiness = { canGenerate: true, staff: [], warnings: [] };
    for (const member of scopedStaff) {
      const engineInput = engineInputs.get(member.staffProfileId);
      if (!engineInput) continue;
      if (!engineInput.version) {
        // No assignment => not on payroll this period. Skipped silently only
        // if they also had no revenue; otherwise flag it.
        if (engineInput.serviceLines.length > 0) {
          readiness.staff.push({
            staffProfileId: member.staffProfileId,
            staffName: member.staffName,
            canGenerate: false,
            warnings: [
              {
                kind: 'input_missing',
                input: 'pay_structure',
                staffProfileId: member.staffProfileId,
                message: `${member.staffName} took revenue this period but has no pay structure assigned.`,
              },
            ],
          });
        }
        continue;
      }
      const result = calculatePaySummary(engineInput);
      if (!result.ok) {
        readiness.staff.push({
          staffProfileId: member.staffProfileId,
          staffName: member.staffName,
          canGenerate: false,
          warnings: result.warnings,
        });
        continue;
      }
      results.set(member.staffProfileId, result);
    }

    if (readiness.staff.some((s) => !s.canGenerate)) {
      readiness.canGenerate = false;
      throw new UnprocessableEntityException({
        message: 'Some staff members are not ready for payroll generation',
        readiness,
      });
    }

    // Regenerate = delete existing summaries first (draft/ready/approved only,
    // enforced above). Order matters: lines/hours cascade from summaries.
    const { error: deleteError } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .delete()
      .eq('pay_period_id', period.id)
      .eq('business_id', actor.businessId);
    if (deleteError) {
      this.logger.error(`generate delete failed: ${deleteError.message}`);
      throw new InternalServerErrorException('Unable to regenerate pay period');
    }

    let generated = 0;
    for (const [staffProfileId, result] of results) {
      const figures = result.figures!;
      const version = engineInputs.get(staffProfileId)!.version!;
      const member = scopedStaff.find((s) => s.staffProfileId === staffProfileId)!;

      const { data: summary, error: summaryError } = await this.admin
        .schema('payroll')
        .from('pay_summaries')
        .insert({
          business_id: actor.businessId,
          pay_period_id: period.id,
          staff_profile_id: staffProfileId,
          employment_type_snapshot: member.employmentType,
          structure_id: version.structureId,
          structure_version_id: version.versionId,
          currency_code: 'GBP',
          service_revenue_cents: figures.serviceRevenueCents,
          retail_revenue_cents: figures.retailRevenueCents,
          total_collected_cents: figures.totalCollectedCents,
          base_pay_cents: figures.basePayCents,
          commission_cents: figures.commissionCents,
          revenue_split_cents: figures.revenueSplitCents,
          bonus_cents: figures.bonusCents,
          chair_rent_cents: figures.chairRentCents,
          deductions_cents: figures.deductionsCents,
          tips_paid_out_cents: figures.tipsPaidOutCents,
          tips_owed_cents: figures.tipsOwedCents,
          adjustments_cents: figures.adjustmentsCents,
          net_payable_cents: figures.netPayableCents,
          business_retained_cents: figures.businessRetainedCents,
          greater_of_applied: figures.greaterOfApplied,
          greater_of_winner: figures.greaterOfWinner,
          inputs_snapshot: result.inputsSnapshot,
          generated_by_user_profile_id: actor.id,
        })
        .select('id')
        .single<{ id: string }>();
      if (summaryError || !summary) {
        this.logger.error(`generate summary insert failed: ${summaryError?.message ?? 'no row'}`);
        throw new InternalServerErrorException('Unable to write pay summary');
      }

      if (result.lines.length > 0) {
        const { error: linesError } = await this.admin
          .schema('payroll')
          .from('pay_summary_lines')
          .insert(
            result.lines.map((line) => ({
              summary_id: summary.id,
              sequence_no: line.sequenceNo,
              line_type: line.lineType,
              stage_id: line.stageId,
              band_id: line.bandId,
              label: line.label,
              source_type: line.sourceType,
              source_id: line.sourceId,
              occurred_on: line.occurredOn,
              quantity: line.quantity,
              basis_amount_cents: line.basisAmountCents,
              vat_rate_percent_snapshot: line.vatRatePercentSnapshot,
              rate_percent: line.ratePercent,
              amount_cents: line.amountCents,
              structure_version_id: line.structureVersionId,
              source_unavailable: line.sourceUnavailable,
              unavailable_source: line.unavailableSource,
            })),
          );
        if (linesError) {
          this.logger.error(`generate lines insert failed: ${linesError.message}`);
          throw new InternalServerErrorException('Unable to write pay summary lines');
        }
      }

      const { error: hoursError } = await this.admin
        .schema('payroll')
        .from('pay_summary_hours')
        .insert(
          result.hours.map((row) => ({
            summary_id: summary.id,
            category: row.category,
            hours: row.hours,
            counted_toward_target: row.countedTowardTarget,
            counted_as_paid: row.countedAsPaid,
            notes: row.notes,
          })),
        );
      if (hoursError) {
        this.logger.error(`generate hours insert failed: ${hoursError.message}`);
        throw new InternalServerErrorException('Unable to write pay summary hours');
      }
      generated += 1;
    }

    const stampPatch: Record<string, unknown> = {
      generated_by_user_profile_id: actor.id,
      generated_at: new Date().toISOString(),
    };
    // Regenerating an approved period replaces every figure the approver
    // signed off. Drop it back to review so a payroll.approve holder must
    // sign the new numbers — otherwise payroll.edit silently bypasses the
    // approval gate. (approved -> ready_for_review is legal at DB level; the
    // ratchet only blocks rewinds from locked/paid.)
    if (period.status === 'approved') {
      stampPatch.status = 'ready_for_review';
      stampPatch.approved_by_user_profile_id = null;
      stampPatch.approved_at = null;
    }
    const { data: updated, error: stampError } = await this.admin
      .schema('payroll')
      .from('pay_periods')
      .update(stampPatch)
      .eq('id', period.id)
      .eq('business_id', actor.businessId)
      .select(PERIOD_COLUMNS)
      .single<PeriodRow>();
    if (stampError || !updated) {
      this.logger.error(`generate stamp failed: ${stampError?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to stamp pay period generation');
    }

    await this.audit.record(actor, {
      entityType: 'pay_period',
      entityId: period.id,
      action: 'pay_period.generated',
      after: { generated },
    });
    return { period: toPayPeriod(updated), generated, skipped: readiness };
  }

  // ---------------------------------------------------------------------------
  // Workflow transitions
  // ---------------------------------------------------------------------------

  async transition(
    actor: AuthUser,
    periodId: string,
    transition: PayPeriodTransition,
  ): Promise<PayPeriod> {
    const period = await this.fetchPeriodForBusiness(actor, periodId);
    const required = REQUIRED_CURRENT[transition];
    const next = NEXT_STATUS[transition];

    // Full ladder, one step at a time — the DB only stops locked/paid rewinds.
    if (period.status !== required) {
      throw new ConflictException(
        `This period is ${period.status}; '${transition}' requires it to be ${required}`,
      );
    }
    if (transition === 'ready') {
      const { count, error } = await this.admin
        .schema('payroll')
        .from('pay_summaries')
        .select('id', { count: 'exact', head: true })
        .eq('pay_period_id', period.id)
        .is('superseded_by_id', null);
      if (error) {
        this.logger.error(`transition summary count failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to verify pay period contents');
      }
      if (!count) {
        throw new ConflictException('Generate the period before marking it ready for review');
      }
    }

    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = { status: next };
    if (next === 'approved') {
      patch.approved_by_user_profile_id = actor.id;
      patch.approved_at = nowIso;
    } else if (next === 'locked') {
      patch.locked_by_user_profile_id = actor.id;
      patch.locked_at = nowIso;
    } else if (next === 'paid') {
      patch.marked_paid_by_user_profile_id = actor.id;
      patch.paid_at = nowIso;
    }

    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_periods')
      .update(patch)
      .eq('id', period.id)
      .eq('business_id', actor.businessId)
      .eq('status', required) // optimistic: no double transition on a race
      .select(PERIOD_COLUMNS)
      .maybeSingle<PeriodRow>();
    if (error) {
      this.logger.error(`transition ${transition} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update pay period status');
    }
    if (!data) {
      throw new ConflictException('The pay period changed while you were updating it');
    }

    // Locking finalises the period: stamp the adjustments it consumed so they
    // can never be double-applied (pay_adjustments freeze once applied_at set).
    if (next === 'locked') {
      await this.applyAdjustmentStamps(actor, period.id);
    }

    await this.audit.record(actor, {
      entityType: 'pay_period',
      entityId: period.id,
      action: `pay_period.${transition}`,
      before: { status: period.status },
      after: { status: next },
    });
    return toPayPeriod(data);
  }

  /**
   * Stamp every adjustment consumed by this period's live summaries.
   * A stamping failure after the status is already 'locked' cannot be rolled
   * back (the ratchet forbids rewinds), so it is surfaced loudly — an
   * unstamped adjustment would be double-paid next period. True atomicity
   * needs a DB-side lock function (deferred; would require a migration).
   */
  private async applyAdjustmentStamps(actor: AuthUser, periodId: string): Promise<void> {
    const { data: summaries, error } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .select('id,inputs_snapshot')
      .eq('pay_period_id', periodId)
      .eq('business_id', actor.businessId)
      .is('superseded_by_id', null);
    if (error) {
      this.logger.error(`applyAdjustmentStamps read failed: ${error.message}`);
      throw new InternalServerErrorException(
        'The period was locked but its adjustments could not be verified — contact support before the next pay run',
      );
    }
    const adjustmentIds = new Set<string>();
    for (const summary of summaries ?? []) {
      const snapshot = (summary.inputs_snapshot ?? {}) as Record<string, unknown>;
      const lines = (snapshot['adjustments'] as { id?: string }[] | undefined) ?? [];
      for (const line of lines) if (line?.id) adjustmentIds.add(line.id);
    }
    if (adjustmentIds.size === 0) return;
    const { data: stamped, error: stampError } = await this.admin
      .schema('payroll')
      .from('pay_adjustments')
      .update({ applied_in_pay_period_id: periodId, applied_at: new Date().toISOString() })
      .in('id', [...adjustmentIds])
      .eq('business_id', actor.businessId)
      .neq('origin_pay_period_id', periodId)
      .is('applied_at', null)
      .select('id');
    if (stampError || (stamped?.length ?? 0) !== adjustmentIds.size) {
      this.logger.error(
        `applyAdjustmentStamps failed: ${stampError?.message ?? `stamped ${stamped?.length ?? 0}/${adjustmentIds.size}`}`,
      );
      throw new InternalServerErrorException(
        'The period was locked but some adjustments could not be marked applied — contact support before the next pay run',
      );
    }
    await this.audit.record(actor, {
      entityType: 'pay_adjustment',
      entityId: periodId,
      action: 'pay_adjustment.applied',
      after: { periodId, adjustmentIds: [...adjustmentIds] },
    });
  }

  /** 403 (service-level) BEFORE any DB trigger turns into a 500. */
  assertWritablePeriod(period: PeriodRow): void {
    if (period.status === 'locked' || period.status === 'paid') {
      throw new ForbiddenException(
        `This pay period is ${period.status}; its figures can no longer be changed. Corrections go through pay adjustments in the next period.`,
      );
    }
  }
}
