/**
 * QLOOQO Financial Rules Engine — pure calculation core.
 *
 * `calculatePaySummary(input)` is a deterministic pure function over
 * (inputs, resolved rule version, period): no I/O, no clock, no randomness
 * (docs/financial-rules-engine-principles.md §1). All I/O lives in
 * payroll-inputs.service.ts; persistence in payroll-period.service.ts.
 *
 * NEVER derived from kpi.calc.ts — that encodes the V1 retroactive model this
 * engine replaces (on Luke's worked example the two differ ~7x, see
 * docs/payroll-loh-template.md). Every rate, threshold, basis and ordering
 * here is RULE DATA resolved by effective date; there are no default rates in
 * this file, and there must never be.
 *
 * Honesty contract (principles §4, plan §5.1):
 *  - Uncaptured transaction source  -> zero-amount line with
 *    source_unavailable + a 'source_unavailable' warning. Never a silent 0.
 *  - Missing configuration input    -> 'input_missing' warning, which BLOCKS
 *    generation for that staff member (result.ok === false).
 *  - Unevaluable accelerator        -> NOT achieved (lower rate applies — the
 *    safe direction) + 'accelerator_unevaluable' warning. A staff benchmark of
 *    0 or null FAILS its condition; it must never pass trivially.
 *
 * Line-sum convention (the DB enforces no arithmetic invariant, so we do):
 *  - Evidence lines (service_revenue / retail_revenue) carry amountCents = 0
 *    with the observed figure in basisAmountCents — they are drill-down
 *    evidence, not pay.
 *  - Pay lines are signed (deductions / chair rent negative).
 *  - The final net_payable line equals the sum of all pay lines, and the
 *    engine asserts this before returning.
 */

import { taxWithinGross } from '@sheer/domain';
import type {
  AcceleratorBreakdown,
  AcceleratorConditionResult,
  AcceleratorEvaluation,
  AcceleratorMetric,
  CommissionBandBreakdown,
  ConditionBasis,
  DiscountBasis,
  DepositRecognition,
  GreaterOfBreakdown,
  GreaterOfWinner,
  HourCategory,
  PayLineSource,
  PayLineType,
  PayStageType,
  PayrollComparator,
  PayrollDataSource,
  PayrollRevenueStream,
  PayrollVatBasis,
  PayrollWarning,
  ProductCostMode,
  ServiceRevenueTargetBreakdown,
  StaffServiceRevenueTargetMode,
  ThresholdBasis,
  TierSemantics,
} from '@sheer/domain';
import { DEFAULT_CONTRACTED_HOURS_PER_WEEK } from '@sheer/domain';
import { rateAmountCents, roundMagnitude } from './payroll-money';

// =============================================================================
// Resolved rule shapes (plain data produced by payroll-inputs.service)
// =============================================================================

export interface ResolvedBand {
  id: string;
  sequenceNo: number;
  fromMultiple: number | null;
  fromAmountCents: number | null;
  fromPercent: number | null;
  ratePercent: number;
  acceleratorRatePercent: number | null;
}

export interface ResolvedAcceleratorCondition {
  sequenceNo: number;
  metric: AcceleratorMetric;
  comparator: PayrollComparator;
  basis: ConditionBasis;
  thresholdValue: number | null;
  weight: number;
}

export interface ResolvedAccelerator {
  evaluationMode: AcceleratorEvaluation;
  requiredConditionCount: number | null;
  requiredScore: number | null;
  conditions: ResolvedAcceleratorCondition[];
}

export interface ResolvedStage {
  id: string;
  sequenceNo: number;
  stageType: PayStageType;
  label: string | null;
  tierSemantics: TierSemantics | null;
  thresholdBasis: ThresholdBasis | null;
  revenueStream: PayrollRevenueStream | null;
  inGreaterOfComparison: boolean;
  requiresDataSource: PayrollDataSource | null;
  config: Record<string, unknown>;
  bands: ResolvedBand[];
  accelerator: ResolvedAccelerator | null;
}

export interface ResolvedHourRule {
  countsTowardTarget: boolean;
  countsAsPaid: boolean;
}

export interface ResolvedRuleVersion {
  versionId: string;
  structureId: string;
  structureName: string;
  versionNo: number;
  discountBasis: DiscountBasis;
  vatBasis: PayrollVatBasis;
  tipsIncludedInCommission: boolean;
  depositRecognition: DepositRecognition;
  productCostMode: ProductCostMode;
  cancellationFeeSharePercent: number | null;
  stages: ResolvedStage[];
  hourRules: Partial<Record<HourCategory, ResolvedHourRule>>;
}

// =============================================================================
// Engine inputs
// =============================================================================

/** One eligible revenue transaction, already attributed to this staff member. */
export interface EngineRevenueLine {
  sourceType: PayLineSource;
  sourceId: string;
  /** Local service date within the period (drives attribution). */
  occurredOn: string;
  label: string;
  /** Headline (pre-discount) amount, minor units. */
  headlineAmountCents: number;
  /** Actually-billed amount, minor units; null when no billing roll-up exists. */
  actualAmountCents: number | null;
  /** True when the stored amounts include VAT (location display_mode inc_tax). */
  amountsIncludeTax: boolean;
  /** The location's tax rate for snapshotting, e.g. 20. */
  taxRatePercent: number;
}

export interface EngineHoursRow {
  category: HourCategory;
  hours: number;
  notes: string | null;
}

export interface EngineStaffInput {
  staffProfileId: string;
  staffName: string;
  /** core.staff_profiles.employment_type — snapshotted onto the summary. */
  employmentType: string;
  /** Cents. Null or <= 0 counts as MISSING for hourly base-pay stages. */
  hourlyRateCents: number | null;
  contractedHours: number | null;
  /** Cents. Null or <= 0 => staff_benchmark conditions are unevaluable. */
  averageBillBenchmarkCents: number | null;
  /**
   * How the tracking target is applied. 'pro_rated' scales it by target-counted
   * hours against the contracted baseline (Luke's 13 Jul direction, 0072).
   * Band-derived targets are unaffected — multiple_of_base_pay already follows
   * hours through the base-pay figure.
   */
  serviceRevenueTargetMode: StaffServiceRevenueTargetMode;
}

/** Observed KPI metrics for accelerator conditions. Null = not derivable. */
export interface EngineMetrics {
  rebookingRatePercent: number | null;
  averageBillCents: number | null;
  utilisationPercent: number | null;
  /** Distinct clients served in the period (per_client thresholds). */
  clientCount: number | null;
}

export interface EngineAdjustmentInput {
  id: string;
  amountCents: number;
  description: string;
}

export interface EngineInput {
  period: { periodStart: string; periodEnd: string };
  currencyCode: string;
  staff: EngineStaffInput;
  /** Null => no pay structure assigned (blocking). */
  version: ResolvedRuleVersion | null;
  hours: EngineHoursRow[];
  serviceLines: EngineRevenueLine[];
  /** Sum of captured retail revenue; ignored unless retail_sales is captured. */
  retailRevenueCents: number;
  /** Actual QLAB product cost for the period; null = none recorded. */
  productCostCents: number | null;
  /** Per-business capture matrix (payroll.business_data_sources). */
  capture: Record<PayrollDataSource, boolean>;
  metrics: EngineMetrics;
  /** Unapplied pay_adjustments selected for this period. */
  adjustments: EngineAdjustmentInput[];
  /** Tracking target (payroll.targets) — DISPLAY ONLY, never moves money. */
  trackingTargetCents: number | null;
  /** Total actually collected through the till for this staff member. */
  totalCollectedCents: number;
  /** appointment_services vs visit_line_items variance, when they disagree. */
  serviceRevenueVariance: { expectedCents: number; actualCents: number } | null;
}

// =============================================================================
// Engine output
// =============================================================================

export interface EngineLine {
  sequenceNo: number;
  lineType: PayLineType;
  stageId: string | null;
  bandId: string | null;
  label: string | null;
  sourceType: PayLineSource | null;
  sourceId: string | null;
  occurredOn: string | null;
  quantity: number | null;
  basisAmountCents: number | null;
  vatRatePercentSnapshot: number | null;
  ratePercent: number | null;
  amountCents: number;
  structureVersionId: string | null;
  sourceUnavailable: boolean;
  unavailableSource: PayrollDataSource | null;
}

export interface EngineHoursOutput {
  category: HourCategory;
  hours: number;
  countedTowardTarget: boolean;
  countedAsPaid: boolean;
  notes: string | null;
}

export interface EngineSummaryFigures {
  serviceRevenueCents: number;
  retailRevenueCents: number;
  totalCollectedCents: number;
  basePayCents: number;
  commissionCents: number;
  revenueSplitCents: number;
  bonusCents: number;
  chairRentCents: number;
  deductionsCents: number;
  tipsPaidOutCents: number;
  tipsOwedCents: number;
  adjustmentsCents: number;
  netPayableCents: number;
  businessRetainedCents: number;
  greaterOfApplied: boolean;
  greaterOfWinner: GreaterOfWinner | null;
}

export interface EngineResult {
  /** False when a blocking input_missing warning prevents generation. */
  ok: boolean;
  warnings: PayrollWarning[];
  figures: EngineSummaryFigures | null;
  lines: EngineLine[];
  hours: EngineHoursOutput[];
  target: ServiceRevenueTargetBreakdown;
  accelerator: AcceleratorBreakdown | null;
  bands: CommissionBandBreakdown[];
  greaterOf: GreaterOfBreakdown | null;
  payableHours: number;
  workedHours: number;
  targetHours: number;
  /** Versioned snapshot for pay_summaries.inputs_snapshot. */
  inputsSnapshot: Record<string, unknown>;
}

// =============================================================================
// Internals
// =============================================================================

interface StageResult {
  stage: ResolvedStage;
  amountCents: number;
  lines: Omit<EngineLine, 'sequenceNo'>[];
  bands: CommissionBandBreakdown[];
  accelerator: AcceleratorBreakdown | null;
  unavailable: boolean;
}

function compare(actual: number, comparator: PayrollComparator, threshold: number): boolean {
  switch (comparator) {
    case 'gte':
      return actual >= threshold;
    case 'gt':
      return actual > threshold;
    case 'lte':
      return actual <= threshold;
    case 'lt':
      return actual < threshold;
    case 'eq':
      return actual === threshold;
  }
}

function configNumber(config: Record<string, unknown>, key: string): number | null {
  const value = config[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function configString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' ? value : null;
}

/** Commissionable basis of one revenue line under the version's policy. */
function lineBasis(
  line: EngineRevenueLine,
  discountBasis: DiscountBasis,
  vatBasis: PayrollVatBasis,
): { basisCents: number; vatSnapshot: number | null } {
  let amount =
    discountBasis === 'actual_after_discount' && line.actualAmountCents !== null
      ? line.actualAmountCents
      : line.headlineAmountCents;

  if (vatBasis === 'inclusive') {
    // Commission on the amount as charged; no de-grossing, snapshot null.
    return { basisCents: amount, vatSnapshot: null };
  }
  // vat_basis = 'exclusive': commission on the VAT-exclusive amount.
  if (line.amountsIncludeTax && line.taxRatePercent > 0) {
    amount -= taxWithinGross(amount, line.taxRatePercent);
  }
  return { basisCents: amount, vatSnapshot: line.taxRatePercent };
}

/** Resolve a band's lower bound to cents for the given context. */
function resolveThreshold(
  band: ResolvedBand,
  basis: ThresholdBasis,
  context: {
    /**
     * Base for multiple_of_base_pay thresholds: hourly rate x TARGET-counted
     * hours. Paid holiday/training are payable but must never raise the
     * target (docs/payroll-loh-template.md §4), so this is NOT the payable
     * base-pay figure. Fixed-amount guarantees fall back to the fixed amount.
     */
    targetBaseCents: number;
    serviceRevenueTargetCents: number | null;
    serviceRevenueCents: number;
    clientCount: number | null;
  },
): number | null {
  switch (basis) {
    case 'multiple_of_base_pay':
      return band.fromMultiple === null
        ? null
        : roundMagnitude(band.fromMultiple * context.targetBaseCents);
    case 'absolute':
      return band.fromAmountCents;
    case 'per_client':
      if (band.fromAmountCents === null) return null;
      if (context.clientCount === null) return null;
      return band.fromAmountCents * context.clientCount;
    case 'percent_of_service_target':
      if (band.fromPercent === null || context.serviceRevenueTargetCents === null) return null;
      return roundMagnitude((band.fromPercent / 100) * context.serviceRevenueTargetCents);
    case 'percent_of_service_revenue':
      if (band.fromPercent === null) return null;
      return roundMagnitude((band.fromPercent / 100) * context.serviceRevenueCents);
  }
}

function bandFromLabel(band: ResolvedBand, basis: ThresholdBasis): string {
  switch (basis) {
    case 'multiple_of_base_pay':
      return `${band.fromMultiple ?? 0}x base pay`;
    case 'absolute':
      return `from ${((band.fromAmountCents ?? 0) / 100).toFixed(2)}`;
    case 'per_client':
      return `${((band.fromAmountCents ?? 0) / 100).toFixed(2)} per client`;
    case 'percent_of_service_target':
      return `${band.fromPercent ?? 0}% of the Service Revenue Target`;
    case 'percent_of_service_revenue':
      return `${band.fromPercent ?? 0}% of service revenue`;
  }
}

// =============================================================================
// The engine
// =============================================================================

export function calculatePaySummary(input: EngineInput): EngineResult {
  const warnings: PayrollWarning[] = [];
  const staff = input.staff;

  const blockingBase: Omit<EngineResult, 'ok' | 'warnings'> = {
    figures: null,
    lines: [],
    hours: [],
    target: { targetCents: null, basis: null, derivation: 'Not calculated.', adjustments: [] },
    accelerator: null,
    bands: [],
    greaterOf: null,
    payableHours: 0,
    workedHours: 0,
    targetHours: 0,
    inputsSnapshot: {},
  };

  // ---- Configuration readiness (missing input => BLOCK, never a silent 0) ----
  const version = input.version;
  if (!version) {
    warnings.push({
      kind: 'input_missing',
      input: 'pay_structure',
      staffProfileId: staff.staffProfileId,
      message: `${staff.staffName} has no pay structure assigned for this period.`,
    });
    return { ok: false, warnings, ...blockingBase };
  }

  const hourRuleCategories = Object.keys(version.hourRules) as HourCategory[];
  if (hourRuleCategories.length === 0) {
    warnings.push({
      kind: 'input_missing',
      input: 'hour_rules',
      staffProfileId: staff.staffProfileId,
      message: `The pay rule version "${version.structureName} v${version.versionNo}" has no hour rules configured.`,
    });
  }

  const stages = version.stages.slice().sort((a, b) => a.sequenceNo - b.sequenceNo);

  const hourlyBasePayStage = stages.find(
    (s) =>
      s.stageType === 'base_pay' &&
      (configString(s.config, 'source') ?? 'hourly_rate_x_payable_hours') ===
        'hourly_rate_x_payable_hours',
  );
  const hourlyRateMissing = staff.hourlyRateCents === null || staff.hourlyRateCents <= 0;
  if (hourlyBasePayStage && hourlyRateMissing) {
    warnings.push({
      kind: 'input_missing',
      input: 'hourly_rate',
      staffProfileId: staff.staffProfileId,
      message: `${staff.staffName} has no hourly rate set, so base pay cannot be calculated.`,
    });
  }

  if (warnings.some((w) => w.kind === 'input_missing')) {
    return { ok: false, warnings, ...blockingBase };
  }

  // ---- Hours ----
  const hoursOut: EngineHoursOutput[] = input.hours.map((row) => {
    const rule = version.hourRules[row.category];
    return {
      category: row.category,
      hours: row.hours,
      countedTowardTarget: rule?.countsTowardTarget ?? false,
      countedAsPaid: rule?.countsAsPaid ?? false,
      notes: row.notes,
    };
  });
  const payableHours = round2(
    hoursOut.filter((h) => h.countedAsPaid).reduce((sum, h) => sum + h.hours, 0),
  );
  const targetHours = round2(
    hoursOut.filter((h) => h.countedTowardTarget).reduce((sum, h) => sum + h.hours, 0),
  );
  const workedHours = round2(
    hoursOut
      .filter((h) => h.category === 'worked' || h.category === 'additional')
      .reduce((sum, h) => sum + h.hours, 0),
  );

  // ---- Revenue bases ----
  const priced = input.serviceLines.map((line) => ({
    line,
    ...lineBasis(line, version.discountBasis, version.vatBasis),
  }));
  const serviceRevenueCents = priced.reduce((sum, p) => sum + p.basisCents, 0);
  if (version.discountBasis === 'custom_commissionable_value') {
    warnings.push({
      kind: 'source_variance',
      message:
        'This rule uses a custom commissionable value, which is not captured yet; headline prices were used instead.',
    });
  }
  if (input.serviceRevenueVariance) {
    warnings.push({
      kind: 'source_variance',
      message:
        'Per-service prices and the billed visit total disagree for this period (services may have been edited after checkout). Per-service prices were used.',
      expectedCents: input.serviceRevenueVariance.expectedCents,
      actualCents: input.serviceRevenueVariance.actualCents,
    });
  }

  const retailCaptured = input.capture.retail_sales === true;
  const retailRevenueCents = retailCaptured ? input.retailRevenueCents : 0;

  // ---- Base pay (needed before thresholds that are multiples of it) ----
  let basePayCents = 0;
  let basePayStageResult: StageResult | null = null;
  for (const stage of stages) {
    if (stage.stageType !== 'base_pay') continue;
    const source = configString(stage.config, 'source') ?? 'hourly_rate_x_payable_hours';
    let amount = 0;
    let quantity: number | null = null;
    let rate: number | null = null;
    if (source === 'fixed_amount') {
      amount = configNumber(stage.config, 'amount_cents') ?? 0;
    } else {
      amount = roundMagnitude((staff.hourlyRateCents ?? 0) * payableHours);
      quantity = payableHours;
      rate = null;
    }
    basePayCents = amount;
    basePayStageResult = {
      stage,
      amountCents: amount,
      lines: [
        {
          lineType: 'base_pay',
          stageId: stage.id,
          bandId: null,
          label: stage.label ?? 'Base pay',
          sourceType: null,
          sourceId: null,
          occurredOn: null,
          quantity,
          basisAmountCents: staff.hourlyRateCents,
          vatRatePercentSnapshot: null,
          ratePercent: rate,
          amountCents: amount,
          structureVersionId: version.versionId,
          sourceUnavailable: false,
          unavailableSource: null,
        },
      ],
      bands: [],
      accelerator: null,
      unavailable: false,
    };
    break; // one base-pay stage per pipeline
  }

  // Base for multiple_of_base_pay thresholds: TARGET-counted hours only.
  // A stylist on paid holiday keeps their base pay but their revenue target
  // must shrink with the hours they could actually sell.
  const hourlyBasePay = basePayStageResult
    ? (configString(basePayStageResult.stage.config, 'source') ?? 'hourly_rate_x_payable_hours') ===
      'hourly_rate_x_payable_hours'
    : false;
  const targetBaseCents = hourlyBasePay
    ? roundMagnitude((staff.hourlyRateCents ?? 0) * targetHours)
    : basePayCents;

  // ---- Service Revenue Target (derived from the service commission stage) ----
  const serviceCommissionStage = stages.find(
    (s) =>
      s.stageType === 'commission' &&
      (s.revenueStream === 'service' || s.revenueStream === 'service_and_retail'),
  );
  let serviceRevenueTargetCents: number | null = null;
  let targetDerivation = 'No service commission stage configured.';
  let targetBasis: ThresholdBasis | null = null;
  if (serviceCommissionStage) {
    targetBasis = serviceCommissionStage.thresholdBasis;
    const positiveBands = serviceCommissionStage.bands
      .map((band) => ({
        band,
        thresholdCents: resolveThreshold(band, serviceCommissionStage.thresholdBasis!, {
          targetBaseCents,
          serviceRevenueTargetCents: null,
          serviceRevenueCents,
          clientCount: input.metrics.clientCount,
        }),
      }))
      .filter((b) => b.thresholdCents !== null && b.thresholdCents > 0)
      .sort((a, b) => a.thresholdCents! - b.thresholdCents!);
    if (positiveBands.length > 0) {
      serviceRevenueTargetCents = positiveBands[0].thresholdCents!;
      targetDerivation =
        serviceCommissionStage.thresholdBasis === 'multiple_of_base_pay'
          ? `${positiveBands[0].band.fromMultiple}x base pay from target-counted hours (${formatCents(targetBaseCents)})`
          : `First commission band threshold (${bandFromLabel(positiveBands[0].band, serviceCommissionStage.thresholdBasis!)})`;
    } else {
      targetDerivation = 'Commission applies from the first pound (no positive band threshold).';
    }
  }
  if (serviceRevenueTargetCents === null && input.trackingTargetCents !== null) {
    if (staff.serviceRevenueTargetMode === 'pro_rated') {
      // A pro-rated target follows the hours the member could actually sell,
      // so a short week shrinks it. contracted_hours is a per-week figure and
      // periodEnd is exclusive — scale the baseline to the period length.
      const periodDays = Math.max(
        1,
        Math.round(
          (Date.parse(`${input.period.periodEnd}T00:00:00Z`) -
            Date.parse(`${input.period.periodStart}T00:00:00Z`)) /
            86_400_000,
        ),
      );
      const hasContracted = staff.contractedHours !== null && staff.contractedHours > 0;
      const weeklyContracted = hasContracted
        ? staff.contractedHours!
        : DEFAULT_CONTRACTED_HOURS_PER_WEEK;
      const baselineHours = weeklyContracted * (periodDays / 7);
      const factor = Math.max(0, targetHours) / baselineHours;
      serviceRevenueTargetCents = roundMagnitude(input.trackingTargetCents * factor);
      targetDerivation =
        `Tracking target ${formatCents(input.trackingTargetCents)} pro-rated by hours: ` +
        `${targetHours.toFixed(1)} target-counted / ${baselineHours.toFixed(1)} contracted` +
        (hasContracted ? '' : ' (assumed 40.0/week — set contracted hours for accuracy)') +
        ` = ${formatCents(serviceRevenueTargetCents)}`;
    } else {
      serviceRevenueTargetCents = input.trackingTargetCents;
      targetDerivation = 'Tracking target from payroll targets (no band-derived threshold).';
    }
  }

  // ---- Accelerator evaluation (PER STAGE — payroll.accelerators is keyed by
  // stage_id, and two commission stages may each carry their own accelerator
  // with different conditions; one stage's outcome must never gate another's
  // rates) ----
  // Retail target for 'target_met' conditions = first positive threshold of
  // the retail commission stage (period-level context, hoisted once).
  const retailStageForTarget = stages.find(
    (s) => s.stageType === 'commission' && s.revenueStream === 'retail',
  );
  let retailTargetCents: number | null = null;
  if (retailStageForTarget?.thresholdBasis) {
    const thresholds = retailStageForTarget.bands
      .map((band) =>
        resolveThreshold(band, retailStageForTarget.thresholdBasis!, {
          targetBaseCents,
          serviceRevenueTargetCents,
          serviceRevenueCents,
          clientCount: input.metrics.clientCount,
        }),
      )
      .filter((t): t is number => t !== null && t > 0)
      .sort((a, b) => a - b);
    retailTargetCents = thresholds[0] ?? null;
  }

  const evaluateAccelerator = (
    acc: ResolvedAccelerator,
  ): { breakdown: AcceleratorBreakdown; achieved: boolean } => {
    const conditions: AcceleratorConditionResult[] = acc.conditions
      .slice()
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
      .map((condition) => {
        const result: AcceleratorConditionResult = {
          metric: condition.metric,
          comparator: condition.comparator,
          basis: condition.basis,
          thresholdValue: condition.thresholdValue,
          actualValue: null,
          passed: null,
          unevaluableReason: null,
        };

        let actual: number | null = null;
        let threshold: number | null = condition.thresholdValue;

        switch (condition.metric) {
          case 'rebooking_rate_percent':
            actual = input.metrics.rebookingRatePercent;
            if (actual === null)
              result.unevaluableReason = 'Rebooking rate is not available for this period.';
            break;
          case 'average_bill':
            actual = input.metrics.averageBillCents;
            if (condition.basis === 'staff_benchmark') {
              const benchmark = staff.averageBillBenchmarkCents;
              if (benchmark === null || benchmark <= 0) {
                result.unevaluableReason = `${staff.staffName} has no average-bill benchmark set; this condition cannot pass without one.`;
                threshold = null;
              } else {
                threshold = benchmark;
              }
            }
            if (actual === null && result.unevaluableReason === null) {
              result.unevaluableReason = 'Average bill could not be derived for this period.';
            }
            break;
          case 'retail_revenue':
            if (!retailCaptured) {
              result.unevaluableReason =
                'This condition uses retail sales, but retail capture has not yet been enabled.';
            } else {
              actual = retailRevenueCents;
              if (condition.basis === 'target_met') {
                if (retailTargetCents === null) {
                  result.unevaluableReason = 'No retail target is configured to compare against.';
                } else {
                  threshold = retailTargetCents;
                }
              }
            }
            break;
          case 'service_revenue':
            actual = serviceRevenueCents;
            if (condition.basis === 'target_met') {
              if (serviceRevenueTargetCents === null) {
                result.unevaluableReason =
                  'No Service Revenue Target is available to compare against.';
              } else {
                threshold = serviceRevenueTargetCents;
              }
            }
            break;
          case 'utilisation_percent':
            actual = input.metrics.utilisationPercent;
            if (actual === null)
              result.unevaluableReason = 'Utilisation is not available for this period.';
            break;
        }

        result.actualValue = actual;
        result.thresholdValue = threshold;
        if (result.unevaluableReason === null && actual !== null && threshold !== null) {
          result.passed = compare(actual, condition.comparator, threshold);
        } else if (result.unevaluableReason === null) {
          result.unevaluableReason = 'Condition could not be evaluated.';
        }
        if (result.unevaluableReason !== null) {
          warnings.push({
            kind: 'accelerator_unevaluable',
            conditionMetric: condition.metric,
            message: result.unevaluableReason,
          });
        }
        return result;
      });

    const passedCount = conditions.filter((c) => c.passed === true).length;
    const failedCount = conditions.filter((c) => c.passed === false).length;
    const unknownCount = conditions.filter((c) => c.passed === null).length;

    let achieved: boolean | null;
    switch (acc.evaluationMode) {
      case 'all':
        achieved = failedCount > 0 ? false : unknownCount > 0 ? null : true;
        break;
      case 'any':
        achieved = passedCount > 0 ? true : unknownCount > 0 ? null : false;
        break;
      case 'at_least_n': {
        const needed = acc.requiredConditionCount ?? conditions.length;
        achieved =
          passedCount >= needed ? true : passedCount + unknownCount >= needed ? null : false;
        break;
      }
      case 'weighted': {
        const required = acc.requiredScore ?? 0;
        let sumPassed = 0;
        let sumUnknown = 0;
        acc.conditions
          .slice()
          .sort((a, b) => a.sequenceNo - b.sequenceNo)
          .forEach((condition, index) => {
            const outcome = conditions[index]?.passed;
            if (outcome === true) sumPassed += condition.weight;
            else if (outcome === null) sumUnknown += condition.weight;
          });
        achieved = sumPassed >= required ? true : sumPassed + sumUnknown >= required ? null : false;
        break;
      }
      case 'custom':
        achieved = null;
        warnings.push({
          kind: 'accelerator_unevaluable',
          conditionMetric: conditions[0]?.metric ?? 'service_revenue',
          message: 'Custom accelerator rules are not supported yet; treated as not achieved.',
        });
        break;
    }

    return {
      breakdown: {
        achieved,
        evaluationMode: acc.evaluationMode,
        requiredConditionCount: acc.requiredConditionCount,
        requiredScore: acc.requiredScore,
        conditions,
      },
      achieved: achieved === true,
    };
  };

  const acceleratorByStage = new Map<
    string,
    { breakdown: AcceleratorBreakdown; achieved: boolean }
  >();
  for (const stage of stages) {
    if (stage.accelerator) acceleratorByStage.set(stage.id, evaluateAccelerator(stage.accelerator));
  }
  // Top-level snapshot/list field: the service commission stage's accelerator
  // (the LOH shape), falling back to the first stage carrying one.
  const primaryAcceleratorStage =
    stages.find(
      (s) =>
        s.accelerator !== null &&
        s.stageType === 'commission' &&
        (s.revenueStream === 'service' || s.revenueStream === 'service_and_retail'),
    ) ?? stages.find((s) => s.accelerator !== null);
  const acceleratorBreakdown: AcceleratorBreakdown | null = primaryAcceleratorStage
    ? (acceleratorByStage.get(primaryAcceleratorStage.id)?.breakdown ?? null)
    : null;

  // ---- Stage evaluation ----
  const stageResults: StageResult[] = [];
  if (basePayStageResult) stageResults.push(basePayStageResult);
  const allBandBreakdowns: CommissionBandBreakdown[] = [];

  for (const stage of stages) {
    if (stage.stageType === 'base_pay' || stage.stageType === 'greater_of') continue;

    // Uncaptured required source -> zero unavailable line + warning, skip.
    if (stage.requiresDataSource && input.capture[stage.requiresDataSource] !== true) {
      const source = stage.requiresDataSource;
      warnings.push({
        kind: 'source_unavailable',
        source,
        stageLabel: stage.label,
        message: `This rule uses ${sourceLabel(source)}, but ${sourceLabel(source)} capture has not yet been enabled.`,
      });
      stageResults.push({
        stage,
        amountCents: 0,
        lines: [
          {
            lineType: stageLineType(stage.stageType),
            stageId: stage.id,
            bandId: null,
            label: stage.label ?? stageLineType(stage.stageType),
            sourceType: null,
            sourceId: null,
            occurredOn: null,
            quantity: null,
            basisAmountCents: null,
            vatRatePercentSnapshot: null,
            ratePercent: null,
            amountCents: 0,
            structureVersionId: version.versionId,
            sourceUnavailable: true,
            unavailableSource: source,
          },
        ],
        bands: [],
        accelerator: null,
        unavailable: true,
      });
      continue;
    }

    switch (stage.stageType) {
      case 'commission': {
        // Only THIS stage's accelerator can promote THIS stage's band rates.
        const stageAccelerator = acceleratorByStage.get(stage.id) ?? null;
        const acceleratorAchieved = stageAccelerator?.achieved === true;
        const stream = stage.revenueStream ?? 'service';
        const revenueBase =
          stream === 'service'
            ? serviceRevenueCents
            : stream === 'retail'
              ? retailRevenueCents
              : serviceRevenueCents + retailRevenueCents;
        const context = {
          targetBaseCents,
          serviceRevenueTargetCents,
          serviceRevenueCents,
          clientCount: input.metrics.clientCount,
        };
        const resolved = stage.bands
          .map((band) => ({
            band,
            thresholdCents: resolveThreshold(band, stage.thresholdBasis!, context),
          }))
          .filter((b): b is { band: ResolvedBand; thresholdCents: number } => {
            if (b.thresholdCents === null) {
              warnings.push({
                kind: 'input_missing',
                input:
                  stage.thresholdBasis === 'percent_of_service_target'
                    ? 'service_revenue_target'
                    : 'pay_structure',
                staffProfileId: staff.staffProfileId,
                message: `A commission band threshold on "${stage.label ?? 'commission'}" could not be resolved.`,
              });
              return false;
            }
            return true;
          })
          .sort((a, b) => a.thresholdCents - b.thresholdCents);

        if (resolved.length !== stage.bands.length) {
          // A threshold failed to resolve — blocking warning already recorded.
          return { ok: false, warnings, ...blockingBase };
        }

        const semantics = stage.tierSemantics ?? 'marginal';
        const bandBreakdowns: CommissionBandBreakdown[] = [];
        const stageLines: Omit<EngineLine, 'sequenceNo'>[] = [];
        let stageAmount = 0;

        if (semantics === 'retroactive') {
          let winner: { band: ResolvedBand; thresholdCents: number } | null = null;
          for (const entry of resolved) {
            if (revenueBase >= entry.thresholdCents) winner = entry;
          }
          if (winner) {
            const rate =
              acceleratorAchieved && winner.band.acceleratorRatePercent !== null
                ? winner.band.acceleratorRatePercent
                : winner.band.ratePercent;
            const amount = rateAmountCents(revenueBase, rate);
            stageAmount = amount;
            bandBreakdowns.push({
              bandId: winner.band.id,
              sequenceNo: winner.band.sequenceNo,
              fromLabel: bandFromLabel(winner.band, stage.thresholdBasis!),
              sliceFromCents: 0,
              sliceToCents: revenueBase,
              ratePercentApplied: rate,
              acceleratorRateApplied:
                acceleratorAchieved && winner.band.acceleratorRatePercent !== null,
              amountCents: amount,
            });
            if (amount !== 0) {
              stageLines.push(
                commissionLine(stage, winner.band.id, version.versionId, {
                  label: `${stage.label ?? 'Commission'} — ${rate}% of the whole base (retroactive)`,
                  basisAmountCents: revenueBase,
                  ratePercent: rate,
                  amountCents: amount,
                }),
              );
            }
          }
        } else {
          // Marginal: each band prices only its own slice.
          for (let i = 0; i < resolved.length; i += 1) {
            const { band, thresholdCents } = resolved[i];
            const next = resolved[i + 1]?.thresholdCents ?? null;
            const sliceFrom = thresholdCents;
            const sliceTo = next === null ? revenueBase : Math.min(next, revenueBase);
            const slice = Math.max(0, sliceTo - sliceFrom);
            const rate =
              acceleratorAchieved && band.acceleratorRatePercent !== null
                ? band.acceleratorRatePercent
                : band.ratePercent;
            const amount = slice > 0 ? rateAmountCents(slice, rate) : 0;
            stageAmount += amount;
            if (slice > 0 || rate > 0) {
              bandBreakdowns.push({
                bandId: band.id,
                sequenceNo: band.sequenceNo,
                fromLabel: bandFromLabel(band, stage.thresholdBasis!),
                sliceFromCents: sliceFrom,
                sliceToCents: next === null ? null : sliceTo,
                ratePercentApplied: rate,
                acceleratorRateApplied: acceleratorAchieved && band.acceleratorRatePercent !== null,
                amountCents: amount,
              });
            }
            if (amount !== 0) {
              stageLines.push(
                commissionLine(stage, band.id, version.versionId, {
                  label: `${stage.label ?? 'Commission'} — ${bandFromLabel(band, stage.thresholdBasis!)} at ${rate}%`,
                  basisAmountCents: slice,
                  ratePercent: rate,
                  amountCents: amount,
                }),
              );
            }
          }
        }

        allBandBreakdowns.push(...bandBreakdowns);
        stageResults.push({
          stage,
          amountCents: stageAmount,
          lines: stageLines,
          bands: bandBreakdowns,
          accelerator: stageAccelerator?.breakdown ?? null,
          unavailable: false,
        });
        break;
      }

      case 'revenue_split': {
        const splitPercent = configNumber(stage.config, 'split_percent');
        if (splitPercent === null) {
          warnings.push({
            kind: 'input_missing',
            input: 'pay_structure',
            staffProfileId: staff.staffProfileId,
            message: `The revenue split stage "${stage.label ?? 'Revenue split'}" has no split_percent configured.`,
          });
          return { ok: false, warnings, ...blockingBase };
        }
        const amount = rateAmountCents(serviceRevenueCents, splitPercent);
        stageResults.push({
          stage,
          amountCents: amount,
          lines:
            amount !== 0
              ? [
                  {
                    lineType: 'revenue_split',
                    stageId: stage.id,
                    bandId: null,
                    label: stage.label ?? `Revenue split ${splitPercent}%`,
                    sourceType: null,
                    sourceId: null,
                    occurredOn: null,
                    quantity: null,
                    basisAmountCents: serviceRevenueCents,
                    vatRatePercentSnapshot: null,
                    ratePercent: splitPercent,
                    amountCents: amount,
                    structureVersionId: version.versionId,
                    sourceUnavailable: false,
                    unavailableSource: null,
                  },
                ]
              : [],
          bands: [],
          accelerator: null,
          unavailable: false,
        });
        break;
      }

      case 'chair_rent': {
        const rentCents = configNumber(stage.config, 'amount_cents');
        if (rentCents === null) {
          warnings.push({
            kind: 'input_missing',
            input: 'pay_structure',
            staffProfileId: staff.staffProfileId,
            message: `The chair rent stage "${stage.label ?? 'Chair rent'}" has no amount_cents configured.`,
          });
          return { ok: false, warnings, ...blockingBase };
        }
        stageResults.push({
          stage,
          amountCents: -Math.abs(rentCents),
          lines: [
            {
              lineType: 'chair_rent',
              stageId: stage.id,
              bandId: null,
              label: stage.label ?? 'Chair rent',
              sourceType: null,
              sourceId: null,
              occurredOn: null,
              quantity: null,
              basisAmountCents: null,
              vatRatePercentSnapshot: null,
              ratePercent: null,
              amountCents: -Math.abs(rentCents),
              structureVersionId: version.versionId,
              sourceUnavailable: false,
              unavailableSource: null,
            },
          ],
          bands: [],
          accelerator: null,
          unavailable: false,
        });
        break;
      }

      case 'deduction': {
        const usesProductCost =
          configString(stage.config, 'source') === 'product_cost' ||
          stage.requiresDataSource === 'product_cost';
        let amount: number;
        let label = stage.label ?? 'Deduction';
        if (usesProductCost && version.productCostMode === 'actual_usage') {
          amount = -(input.productCostCents ?? 0);
          label = stage.label ?? 'Product & colour cost';
        } else {
          const fixed = configNumber(stage.config, 'amount_cents');
          if (fixed === null) {
            warnings.push({
              kind: 'input_missing',
              input: 'pay_structure',
              staffProfileId: staff.staffProfileId,
              message: `The deduction stage "${stage.label ?? 'Deduction'}" has no amount_cents configured.`,
            });
            return { ok: false, warnings, ...blockingBase };
          }
          amount = -Math.abs(fixed);
        }
        stageResults.push({
          stage,
          amountCents: amount,
          lines:
            amount !== 0
              ? [
                  {
                    lineType: 'deduction',
                    stageId: stage.id,
                    bandId: null,
                    label,
                    sourceType: null,
                    sourceId: null,
                    occurredOn: null,
                    quantity: null,
                    basisAmountCents: usesProductCost ? (input.productCostCents ?? 0) : null,
                    vatRatePercentSnapshot: null,
                    ratePercent: null,
                    amountCents: amount,
                    structureVersionId: version.versionId,
                    sourceUnavailable: false,
                    unavailableSource: null,
                  },
                ]
              : [],
          bands: [],
          accelerator: null,
          unavailable: false,
        });
        break;
      }

      case 'bonus': {
        const bonusCents = configNumber(stage.config, 'amount_cents') ?? 0;
        stageResults.push({
          stage,
          amountCents: bonusCents,
          lines:
            bonusCents !== 0
              ? [
                  {
                    lineType: 'bonus',
                    stageId: stage.id,
                    bandId: null,
                    label: stage.label ?? 'Bonus',
                    sourceType: null,
                    sourceId: null,
                    occurredOn: null,
                    quantity: null,
                    basisAmountCents: null,
                    vatRatePercentSnapshot: null,
                    ratePercent: null,
                    amountCents: bonusCents,
                    structureVersionId: version.versionId,
                    sourceUnavailable: false,
                    unavailableSource: null,
                  },
                ]
              : [],
          bands: [],
          accelerator: null,
          unavailable: false,
        });
        break;
      }

      case 'tips_payout': {
        // Tips are never captured today; the capture-matrix branch above
        // handles requires_data_source='tips'. A tips stage without the marker
        // still must not invent figures.
        warnings.push({
          kind: 'source_unavailable',
          source: 'tips',
          stageLabel: stage.label,
          message: 'This rule uses tips, but tips capture has not yet been enabled.',
        });
        stageResults.push({
          stage,
          amountCents: 0,
          lines: [
            {
              lineType: 'tip',
              stageId: stage.id,
              bandId: null,
              label: stage.label ?? 'Tips payout',
              sourceType: null,
              sourceId: null,
              occurredOn: null,
              quantity: null,
              basisAmountCents: null,
              vatRatePercentSnapshot: null,
              ratePercent: null,
              amountCents: 0,
              structureVersionId: version.versionId,
              sourceUnavailable: true,
              unavailableSource: 'tips',
            },
          ],
          bands: [],
          accelerator: null,
          unavailable: true,
        });
        break;
      }

      default:
        break;
    }
  }

  // Version-level cancellation fee share with no capture -> honest warning.
  if (
    version.cancellationFeeSharePercent !== null &&
    version.cancellationFeeSharePercent > 0 &&
    input.capture.cancellation_fees !== true
  ) {
    warnings.push({
      kind: 'source_unavailable',
      source: 'cancellation_fees',
      stageLabel: null,
      message:
        'This rule shares cancellation fees, but cancellation fee capture has not yet been enabled.',
    });
  }

  // ---- Greater-of ----
  const greaterOfStage = stages.find((s) => s.stageType === 'greater_of');
  const comparisonResults = stageResults.filter((r) => r.stage.inGreaterOfComparison);
  let greaterOf: GreaterOfBreakdown | null = null;
  let excluded = new Set<StageResult>();
  if (greaterOfStage && comparisonResults.length >= 2) {
    let winner = comparisonResults[0];
    for (const candidate of comparisonResults.slice(1)) {
      if (candidate.amountCents > winner.amountCents) winner = candidate;
    }
    excluded = new Set(comparisonResults.filter((r) => r !== winner));
    const byType = (type: PayStageType) =>
      comparisonResults.find((r) => r.stage.stageType === type)?.amountCents ?? 0;
    greaterOf = {
      applied: true,
      winner: stageTypeToWinner(winner.stage.stageType),
      basePayCents: byType('base_pay'),
      commissionCents: byType('commission'),
      revenueSplitCents: comparisonResults.some((r) => r.stage.stageType === 'revenue_split')
        ? byType('revenue_split')
        : null,
    };
  }

  // ---- Assemble figures ----
  const kept = stageResults.filter((r) => !excluded.has(r));
  const sumBy = (type: PayStageType) =>
    kept.filter((r) => r.stage.stageType === type).reduce((sum, r) => sum + r.amountCents, 0);

  const figures: EngineSummaryFigures = {
    serviceRevenueCents,
    retailRevenueCents,
    totalCollectedCents: input.totalCollectedCents,
    basePayCents: sumBy('base_pay'),
    commissionCents: sumBy('commission'),
    revenueSplitCents: sumBy('revenue_split'),
    bonusCents: sumBy('bonus'),
    chairRentCents: Math.abs(sumBy('chair_rent')),
    deductionsCents: Math.abs(sumBy('deduction')),
    tipsPaidOutCents: 0,
    tipsOwedCents: 0,
    adjustmentsCents: input.adjustments.reduce((sum, a) => sum + a.amountCents, 0),
    netPayableCents: 0,
    businessRetainedCents: 0,
    greaterOfApplied: greaterOf?.applied ?? false,
    greaterOfWinner: greaterOf?.winner ?? null,
  };
  figures.netPayableCents =
    figures.basePayCents +
    figures.commissionCents +
    figures.revenueSplitCents +
    figures.bonusCents +
    figures.tipsOwedCents -
    figures.chairRentCents -
    figures.deductionsCents +
    figures.adjustmentsCents;
  figures.businessRetainedCents = Math.max(
    0,
    figures.totalCollectedCents - Math.max(figures.netPayableCents, 0),
  );

  // ---- Lines ----
  const lines: EngineLine[] = [];
  let seq = 1;
  const push = (line: Omit<EngineLine, 'sequenceNo'>) => {
    lines.push({ sequenceNo: seq, ...line });
    seq += 1;
  };

  // Evidence lines: every service transaction, amount 0 (drill-down only).
  for (const { line, basisCents, vatSnapshot } of priced) {
    push({
      lineType: 'service_revenue',
      stageId: null,
      bandId: null,
      label: line.label,
      sourceType: line.sourceType,
      sourceId: line.sourceId,
      occurredOn: line.occurredOn,
      quantity: null,
      basisAmountCents: basisCents,
      vatRatePercentSnapshot: vatSnapshot,
      ratePercent: null,
      amountCents: 0,
      structureVersionId: version.versionId,
      sourceUnavailable: false,
      unavailableSource: null,
    });
  }
  if (retailCaptured && retailRevenueCents > 0) {
    push({
      lineType: 'retail_revenue',
      stageId: null,
      bandId: null,
      label: 'Retail sales',
      sourceType: null,
      sourceId: null,
      occurredOn: null,
      quantity: null,
      basisAmountCents: retailRevenueCents,
      vatRatePercentSnapshot: null,
      ratePercent: null,
      amountCents: 0,
      structureVersionId: version.versionId,
      sourceUnavailable: false,
      unavailableSource: null,
    });
  }

  for (const result of kept) {
    for (const line of result.lines) push(line);
  }
  // Losing greater-of legs keep NO pay lines (their amounts are not part of the
  // total) — the comparison survives in `greaterOf` and the snapshot.

  for (const adjustment of input.adjustments) {
    push({
      lineType: 'adjustment',
      stageId: null,
      bandId: null,
      label: adjustment.description,
      sourceType: 'adjustment',
      sourceId: adjustment.id,
      occurredOn: null,
      quantity: null,
      basisAmountCents: null,
      vatRatePercentSnapshot: null,
      ratePercent: null,
      amountCents: adjustment.amountCents,
      structureVersionId: version.versionId,
      sourceUnavailable: false,
      unavailableSource: null,
    });
  }

  // Invariant: pay lines must sum to net payable. The DB enforces nothing here,
  // so the engine does (plan W3.2-D "rounding and line-sum invariants").
  const paySum = lines.reduce((sum, l) => sum + l.amountCents, 0);
  if (paySum !== figures.netPayableCents) {
    throw new Error(
      `payroll.calc invariant violation: pay lines sum ${paySum} != net payable ${figures.netPayableCents}`,
    );
  }

  push({
    lineType: 'net_payable',
    stageId: null,
    bandId: null,
    label: 'Net payable',
    sourceType: null,
    sourceId: null,
    occurredOn: null,
    quantity: null,
    basisAmountCents: null,
    vatRatePercentSnapshot: null,
    ratePercent: null,
    amountCents: figures.netPayableCents,
    structureVersionId: version.versionId,
    sourceUnavailable: false,
    unavailableSource: null,
  });

  const target: ServiceRevenueTargetBreakdown = {
    targetCents: serviceRevenueTargetCents,
    basis: targetBasis,
    derivation: targetDerivation,
    adjustments: [],
  };

  const inputsSnapshot: Record<string, unknown> = {
    snapshotVersion: 1,
    engine: 'payroll.calc@1',
    period: input.period,
    staff: {
      staffProfileId: staff.staffProfileId,
      staffName: staff.staffName,
      employmentType: staff.employmentType,
      hourlyRateCents: staff.hourlyRateCents,
      contractedHours: staff.contractedHours,
      serviceRevenueTargetMode: staff.serviceRevenueTargetMode,
      averageBillBenchmarkCents: staff.averageBillBenchmarkCents,
    },
    rule: {
      structureId: version.structureId,
      structureName: version.structureName,
      versionId: version.versionId,
      versionNo: version.versionNo,
      discountBasis: version.discountBasis,
      vatBasis: version.vatBasis,
      productCostMode: version.productCostMode,
    },
    hours: hoursOut,
    payableHours,
    targetHours,
    target,
    accelerator: acceleratorBreakdown,
    greaterOf,
    bands: allBandBreakdowns,
    metrics: input.metrics,
    capture: input.capture,
    attribution: input.serviceLines.map((l) => ({
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      occurredOn: l.occurredOn,
    })),
    trackingTargetCents: input.trackingTargetCents,
    adjustments: input.adjustments,
    warnings,
  };

  return {
    ok: true,
    warnings,
    figures,
    lines,
    hours: hoursOut,
    target,
    accelerator: acceleratorBreakdown,
    bands: allBandBreakdowns,
    greaterOf,
    payableHours,
    workedHours,
    targetHours,
    inputsSnapshot,
  };
}

// =============================================================================
// Small helpers
// =============================================================================

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCents(cents: number): string {
  return `${(cents / 100).toFixed(2)}`;
}

function sourceLabel(source: PayrollDataSource): string {
  const labels: Record<PayrollDataSource, string> = {
    service_revenue: 'service revenue',
    retail_sales: 'retail sales',
    tips: 'tips',
    refunds: 'refunds',
    cancellation_fees: 'cancellation fees',
    product_cost: 'product cost',
  };
  return labels[source];
}

function stageLineType(stageType: PayStageType): PayLineType {
  switch (stageType) {
    case 'commission':
      return 'commission';
    case 'revenue_split':
      return 'revenue_split';
    case 'chair_rent':
      return 'chair_rent';
    case 'deduction':
      return 'deduction';
    case 'bonus':
      return 'bonus';
    case 'tips_payout':
      return 'tip';
    default:
      return 'adjustment';
  }
}

function stageTypeToWinner(stageType: PayStageType): GreaterOfWinner {
  if (stageType === 'base_pay') return 'base_pay';
  if (stageType === 'revenue_split') return 'revenue_split';
  return 'commission';
}

function commissionLine(
  stage: ResolvedStage,
  bandId: string,
  versionId: string,
  fields: {
    label: string;
    basisAmountCents: number;
    ratePercent: number;
    amountCents: number;
  },
): Omit<EngineLine, 'sequenceNo'> {
  return {
    lineType: 'commission',
    stageId: stage.id,
    bandId,
    label: fields.label,
    sourceType: null,
    sourceId: null,
    occurredOn: null,
    quantity: null,
    basisAmountCents: fields.basisAmountCents,
    vatRatePercentSnapshot: null,
    ratePercent: fields.ratePercent,
    amountCents: fields.amountCents,
    structureVersionId: versionId,
    sourceUnavailable: false,
    unavailableSource: null,
  };
}
