/**
 * QLOOQO Financial Rules Engine — shared contracts.
 *
 * Payroll, commission and settlement are OUTPUTS of a reusable rules engine, not
 * bespoke calculators bolted to the staff record (see
 * docs/financial-rules-engine-principles.md). These types mirror the `payroll`
 * schema created by migrations 0071-0073 one-for-one, so a reviewer can hold the
 * SQL and the TypeScript side by side.
 *
 * Conventions, matching the rest of this package and the DB:
 *   - Money is ALWAYS integer minor units, named `...Cents`, and every response
 *     carrying money also carries `currencyCode`. Note the older staff-record pay
 *     fields (`StaffMember.staffProfile.hourlyRate` and friends) are MAJOR
 *     currency — crossing between the two needs an explicit x100.
 *   - Period boundaries and service dates are local dates as 'YYYY-MM-DD'.
 *     `periodEnd` and `effectiveTo` are EXCLUSIVE, matching the DB.
 *   - Lifecycle timestamps are ISO strings.
 *   - `bigint`/`numeric` columns arrive from PostgREST as STRINGS; every mapper
 *     must Number(...) them before they reach these types.
 *
 * Deliberately NOT here: the V1 `CommissionTier` / `CommissionResult` types in
 * index.ts. Those encode the hard-coded 3x/3.5x/10/15/30 model with retroactive
 * band semantics that this engine exists to replace — on Luke's own worked
 * example the two differ by roughly 7x. They must never be reused as payroll
 * calculation types.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOURCE-OF-TRUTH RULE FOR PAY INPUTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The engine must resolve every pay input — hourly rate, contracted hours,
 * average bill benchmark, employment type, holiday entitlement — SERVER-SIDE
 * from `core.staff_profiles` using the service-role client. It must never take
 * them from a client-facing API response.
 *
 * Two client-facing shapes redact these fields for callers without
 * `staff.pay.manage`, and both redact in ways an engine cannot detect:
 *   - `StaffProfileDetails` (GET /profiles/*) redacts to **0**, which is
 *     indistinguishable from a real zero.
 *   - `StaffMember.staffProfile` (GET /staff) **omits** them, so they arrive as
 *     `undefined` and would become NaN in arithmetic.
 *
 * Consuming either would silently produce £0 base pay, or — with a redacted 0
 * benchmark — make accelerator conditions using `basis = 'staff_benchmark'` pass
 * trivially and promote a stylist to the accelerator commission rate. Both are
 * wrong-pay-with-no-error, which is the failure mode this engine exists to
 * prevent.
 */

// =============================================================================
// 1. Enums — mirroring payroll.* Postgres enums exactly
// =============================================================================

/** payroll.pay_stage_type_enum — the ordered calculation pipeline. */
export type PayStageType =
  | 'base_pay'
  | 'commission'
  | 'revenue_split'
  | 'chair_rent'
  | 'deduction'
  | 'bonus'
  | 'greater_of'
  | 'tips_payout';

/**
 * payroll.tier_semantics_enum — the single most consequential setting in the
 * engine. `marginal` pays the rate only on revenue ABOVE the band threshold;
 * `retroactive` pays it on the WHOLE base once the threshold is crossed. Never
 * inferred, always stored.
 */
export type TierSemantics = 'marginal' | 'retroactive';

/** payroll.threshold_basis_enum — how a band threshold is expressed. */
export type ThresholdBasis =
  | 'absolute'
  | 'multiple_of_base_pay'
  | 'percent_of_service_target'
  | 'percent_of_service_revenue'
  | 'per_client';

/** payroll.accelerator_metric_enum */
export type AcceleratorMetric =
  | 'rebooking_rate_percent'
  | 'retail_revenue'
  | 'average_bill'
  | 'service_revenue'
  | 'utilisation_percent';

/** payroll.comparator_enum */
export type PayrollComparator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';

/** payroll.accelerator_evaluation_enum — how conditions combine into a yes/no. */
export type AcceleratorEvaluation = 'all' | 'any' | 'at_least_n' | 'weighted' | 'custom';

/** payroll.condition_basis_enum */
export type ConditionBasis = 'absolute_amount' | 'percent' | 'staff_benchmark' | 'target_met';

/** payroll.hour_category_enum — the eight categories of time. */
export type HourCategory =
  | 'worked'
  | 'paid_holiday'
  | 'unpaid_leave'
  | 'sickness'
  | 'training'
  | 'authorised_absence'
  | 'additional'
  | 'manual_adjustment';

/** payroll.data_source_enum — transaction sources a pay rule can consume. */
export type PayrollDataSource =
  | 'service_revenue'
  | 'retail_sales'
  | 'tips'
  | 'refunds'
  | 'cancellation_fees'
  | 'product_cost';

/** payroll.revenue_stream_enum */
export type PayrollRevenueStream = 'service' | 'retail' | 'service_and_retail';

/** payroll.discount_basis_enum */
export type DiscountBasis =
  | 'headline_before_discount'
  | 'actual_after_discount'
  | 'custom_commissionable_value';

/** payroll.vat_basis_enum */
export type PayrollVatBasis = 'exclusive' | 'inclusive';

/** payroll.deposit_recognition_enum */
export type DepositRecognition = 'on_completion' | 'on_collection';

/** payroll.product_cost_mode_enum */
export type ProductCostMode = 'none' | 'fixed' | 'actual_usage' | 'percentage' | 'service_specific';

/** payroll.period_frequency_enum */
export type PayPeriodFrequency = 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'custom';

/** payroll.pay_period_kind_enum — what the engine computes over vs what is disbursed. */
export type PayPeriodKind = 'calculation' | 'payment';

/** payroll.pay_period_status_enum — the approval workflow. */
export type PayPeriodStatus = 'draft' | 'ready_for_review' | 'approved' | 'locked' | 'paid';

/**
 * Period statuses visible through stylist self-view. Draft and
 * ready-for-review figures are the owner's unreviewed working numbers —
 * publishing them to staff before approval would force corrections to be
 * negotiated after the fact instead of caught in review.
 */
export const SELF_VIEW_PAY_PERIOD_STATUSES: readonly PayPeriodStatus[] = [
  'approved',
  'locked',
  'paid',
];

/** payroll.pay_line_type_enum */
export type PayLineType =
  | 'service_revenue'
  | 'retail_revenue'
  | 'base_pay'
  | 'commission'
  | 'revenue_split'
  | 'chair_rent'
  | 'deduction'
  | 'bonus'
  | 'tip'
  | 'adjustment'
  | 'gross_payable';

/** payroll.pay_line_source_enum — what a line drills down to. */
export type PayLineSource =
  | 'appointment'
  | 'visit'
  | 'appointment_service'
  | 'retail_sale'
  | 'deposit'
  | 'adjustment'
  | 'manual';

/** payroll.adjustment_reason_enum */
export type PayAdjustmentReason = 'refund' | 'void' | 'correction' | 'manual';

/** payroll.target_scope_enum */
export type PayrollTargetScope = 'staff' | 'location' | 'business';

/** payroll.target_metric_enum */
export type PayrollTargetMetric = 'service_revenue' | 'retail_revenue' | 'total_revenue';

/** payroll.target_basis_enum */
export type PayrollTargetBasis = 'flat' | 'pro_rated';

/** Which side won a greater-of comparison. Narrower than PayLineType by CHECK. */
export type GreaterOfWinner = Extract<PayLineType, 'base_pay' | 'commission' | 'revenue_split'>;

// =============================================================================
// 2. Label maps for the UI
// =============================================================================

export const PAY_PERIOD_STATUS_LABELS: Record<PayPeriodStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  approved: 'Approved',
  locked: 'Locked',
  paid: 'Paid',
};

export const PAY_PERIOD_KIND_LABELS: Record<PayPeriodKind, string> = {
  calculation: 'Calculation period',
  payment: 'Payment period',
};

export const PAY_PERIOD_FREQUENCY_LABELS: Record<PayPeriodFrequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  four_weekly: 'Four-weekly',
  monthly: 'Monthly',
  custom: 'Custom',
};

export const HOUR_CATEGORY_LABELS: Record<HourCategory, string> = {
  worked: 'Worked',
  paid_holiday: 'Paid holiday',
  unpaid_leave: 'Unpaid leave',
  sickness: 'Sickness',
  training: 'Training',
  authorised_absence: 'Authorised absence',
  additional: 'Additional worked',
  manual_adjustment: 'Manual adjustment',
};

export const PAY_LINE_TYPE_LABELS: Record<PayLineType, string> = {
  service_revenue: 'Service revenue',
  retail_revenue: 'Retail revenue',
  base_pay: 'Base pay',
  commission: 'Commission',
  revenue_split: 'Revenue split',
  chair_rent: 'Chair rent',
  deduction: 'Deduction',
  bonus: 'Bonus',
  tip: 'Tips',
  adjustment: 'Adjustment',
  gross_payable: 'Gross payable',
};

export const PAY_STAGE_TYPE_LABELS: Record<PayStageType, string> = {
  base_pay: 'Base pay',
  commission: 'Commission',
  revenue_split: 'Revenue split',
  chair_rent: 'Chair rent',
  deduction: 'Deduction',
  bonus: 'Bonus',
  greater_of: 'Whichever is higher',
  tips_payout: 'Tips payout',
};

export const PAYROLL_DATA_SOURCE_LABELS: Record<PayrollDataSource, string> = {
  service_revenue: 'Service revenue',
  retail_sales: 'Retail sales',
  tips: 'Tips',
  refunds: 'Refunds',
  cancellation_fees: 'Cancellation fees',
  product_cost: 'Product & colour cost',
};

export const TIER_SEMANTICS_LABELS: Record<TierSemantics, string> = {
  marginal: 'Marginal',
  retroactive: 'Retroactive',
};

/**
 * Spelled out because picking the wrong one silently mis-pays. On Luke's own
 * worked example (base pay GBP 488.40, service revenue GBP 1,800) marginal pays
 * GBP 38.01 and retroactive pays GBP 270.
 */
export const TIER_SEMANTICS_DESCRIPTIONS: Record<TierSemantics, string> = {
  marginal: 'The rate applies only to the revenue inside this band, above its threshold.',
  retroactive: 'Once the threshold is crossed, the rate applies to the whole commission base.',
};

export const THRESHOLD_BASIS_LABELS: Record<ThresholdBasis, string> = {
  absolute: 'A fixed amount',
  multiple_of_base_pay: 'A multiple of base pay',
  percent_of_service_target: 'A percentage of the Service Revenue Target',
  percent_of_service_revenue: 'A percentage of service revenue',
  per_client: 'A per-client amount',
};

export const ACCELERATOR_METRIC_LABELS: Record<AcceleratorMetric, string> = {
  rebooking_rate_percent: 'Rebooking rate',
  retail_revenue: 'Retail revenue',
  average_bill: 'Average bill',
  service_revenue: 'Service revenue',
  utilisation_percent: 'Utilisation',
};

export const ACCELERATOR_EVALUATION_LABELS: Record<AcceleratorEvaluation, string> = {
  all: 'All conditions must pass',
  any: 'Any condition passes',
  at_least_n: 'At least N conditions pass',
  weighted: 'Weighted score reaches the threshold',
  custom: 'Custom rule',
};

// =============================================================================
// 3. Warnings — the "never a misleading GBP 0.00" contract
// =============================================================================

/**
 * Two distinct classes of "this figure is not what it looks like", deliberately
 * kept apart (principle 4). A zero means "nothing happened"; an unavailable
 * source means "we are not recording this"; a missing input means "we cannot
 * calculate this at all". Conflating them is how an owner ends up trusting a
 * figure that was never calculated.
 */
export type PayrollWarningKind =
  | 'source_unavailable'
  | 'input_missing'
  | 'accelerator_unevaluable'
  | 'source_variance';

/** A configuration input the engine needs but the business has not supplied. */
export type PayrollMissingInput =
  | 'hourly_rate'
  | 'contracted_hours'
  | 'hour_rules'
  | 'pay_structure'
  | 'staff_benchmark'
  | 'service_revenue_target';

/**
 * A rule depends on a transaction source the platform is not capturing. Renders
 * as an explicit warning, never as GBP 0.00. Mirrors
 * pay_summary_lines.source_unavailable / unavailable_source.
 */
export interface PayrollSourceUnavailableWarning {
  kind: 'source_unavailable';
  source: PayrollDataSource;
  /** The pipeline stage that wanted it, when the warning came from a rule. */
  stageLabel?: string | null;
  message: string;
}

/**
 * A required configuration input is absent, so no figure can be produced. Unlike
 * an unavailable source this BLOCKS generation for the staff member rather than
 * producing a zero line — silently paying GBP 0 because an hourly rate was never
 * set is the failure this exists to prevent.
 */
export interface PayrollInputMissingWarning {
  kind: 'input_missing';
  input: PayrollMissingInput;
  staffProfileId?: string | null;
  message: string;
}

/**
 * An accelerator condition could not be evaluated (its metric depends on an
 * uncaptured source, or the staff benchmark it reads is unset). The accelerator
 * then counts as NOT achieved — the lower rate applies, which is the safe
 * direction — and this records why.
 */
export interface PayrollAcceleratorUnevaluableWarning {
  kind: 'accelerator_unevaluable';
  conditionMetric: AcceleratorMetric;
  message: string;
}

/**
 * Two sources that should agree do not — most importantly the per-service rows in
 * booking.appointment_services against the single rolled-up
 * billing.visit_line_items 'service' row, which can drift permanently when
 * services are changed after completion.
 */
export interface PayrollSourceVarianceWarning {
  kind: 'source_variance';
  message: string;
  expectedCents?: number;
  actualCents?: number;
}

export type PayrollWarning =
  | PayrollSourceUnavailableWarning
  | PayrollInputMissingWarning
  | PayrollAcceleratorUnevaluableWarning
  | PayrollSourceVarianceWarning;

/** Whether a warning must block generation rather than merely annotate it. */
export function isBlockingPayrollWarning(warning: PayrollWarning): boolean {
  return warning.kind === 'input_missing';
}

// =============================================================================
// 4. Configuration surfaces
// =============================================================================

/** payroll.payroll_settings — how periods are generated for a business. */
export interface PayrollSettings {
  businessId: string;
  /** 0 = Sunday .. 6 = Saturday. Defaults to 2 (Tuesday) per the LOH week. */
  weekStartDay: number;
  defaultCalculationFrequency: PayPeriodFrequency;
  defaultPaymentFrequency: PayPeriodFrequency;
  /**
   * IANA zone whose LOCAL dates define period boundaries. Null falls back to the
   * location's timezone. Load-bearing: visits are timestamptz, so attributing one
   * to a period must convert through this first.
   */
  timezone: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * payroll.business_data_sources — whether a source is genuinely captured for this
 * business. Drives the source-unavailable warnings.
 *
 * Known limitation: keyed by (businessId, source) with no location dimension,
 * while capture is in fact location-gated in code, so this cannot express the
 * truth for a multi-location business.
 */
export interface PayrollBusinessDataSource {
  businessId: string;
  source: PayrollDataSource;
  isCaptured: boolean;
  notes: string | null;
  updatedAt: string;
}

// =============================================================================
// 5. Pay periods
// =============================================================================

/** payroll.pay_periods */
export interface PayPeriod {
  id: string;
  businessId: string;
  /** Null = the whole business, which is the common case. */
  locationId: string | null;
  kind: PayPeriodKind;
  frequency: PayPeriodFrequency;
  /** Local date, inclusive. */
  periodStart: string;
  /** Local date, EXCLUSIVE. */
  periodEnd: string;
  label: string | null;
  status: PayPeriodStatus;
  /** A calculation period may roll up into one payment period. */
  parentPaymentPeriodId: string | null;
  generatedByUserProfileId: string | null;
  generatedAt: string | null;
  approvedByUserProfileId: string | null;
  approvedAt: string | null;
  lockedByUserProfileId: string | null;
  lockedAt: string | null;
  markedPaidByUserProfileId: string | null;
  paidAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Period-level roll-up shown on the list, so a row is useful without drilling in. */
export interface PayPeriodSummaryTotals {
  staffCount: number;
  totalGrossPayableCents: number;
  totalBasePayCents: number;
  totalCommissionCents: number;
  staleCount: number;
  currencyCode: string;
}

export interface PayPeriodListItem {
  period: PayPeriod;
  totals: PayPeriodSummaryTotals | null;
}

// =============================================================================
// 6. Pay summaries — the settlement statement
// =============================================================================

/**
 * payroll.pay_summaries. One settlement statement per staff member per period.
 *
 * The figure columns answer "whose money is whose" rather than only "what are we
 * paying": for a chair renter taking payments through the salon till, the salon
 * is HOLDING money that belongs to the stylist.
 */
export interface PaySummary {
  id: string;
  businessId: string;
  payPeriodId: string;
  staffProfileId: string;
  /** Snapshot: editing the staff record later must not change an issued statement. */
  employmentTypeSnapshot: string;
  structureId: string | null;
  structureVersionId: string | null;
  currencyCode: string;

  // Revenue observed
  serviceRevenueCents: number;
  retailRevenueCents: number;
  /** Cash-flow figure — what the salon actually took for this stylist's work. */
  totalCollectedCents: number;

  // How it is divided
  basePayCents: number;
  commissionCents: number;
  revenueSplitCents: number;
  bonusCents: number;
  chairRentCents: number;
  deductionsCents: number;
  /** Tips already received by the stylist (cash at the chair, direct card). */
  tipsPaidOutCents: number;
  /** Tips the salon still owes (terminal, pooled). */
  tipsOwedCents: number;
  /** Signed. Corrections carried in from an earlier locked period. */
  adjustmentsCents: number;

  /** SIGNED — negative means the stylist owes the business, normal for renters. */
  grossPayableCents: number;
  businessRetainedCents: number;

  greaterOfApplied: boolean;
  greaterOfWinner: GreaterOfWinner | null;

  /** Source data changed after generation. Flagged for a human, never silently recalculated. */
  isStale: boolean;
  staleReason: string | null;
  supersededById: string | null;

  generatedByUserProfileId: string | null;
  generatedAt: string;
  exportedAt: string | null;
  emailedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** payroll.pay_summary_lines — the drill-down to source transactions. */
export interface PaySummaryLine {
  id: string;
  summaryId: string;
  sequenceNo: number;
  lineType: PayLineType;
  stageId: string | null;
  /** The commission band that priced this slice, when the line came from one. */
  bandId: string | null;
  label: string | null;
  sourceType: PayLineSource | null;
  sourceId: string | null;
  /** Service date — drives the period and the rule version, not when cash moved. */
  occurredOn: string | null;
  quantity: number | null;
  /** The commissionable amount after the version's discount/VAT policy. */
  basisAmountCents: number | null;
  /** The VAT rate actually used, snapshotted so a later rate change cannot re-base history. */
  vatRatePercentSnapshot: number | null;
  ratePercent: number | null;
  /** Signed — deductions and rent are negative from the stylist's perspective. */
  amountCents: number;
  /** The rule version that priced THIS line; a mid-period change splits a period. */
  structureVersionId: string | null;
  /** True = "we are not recording this", NOT "this was zero". Forces amountCents 0. */
  sourceUnavailable: boolean;
  unavailableSource: PayrollDataSource | null;
  createdAt: string;
}

/** payroll.pay_summary_hours — how the Service Revenue Target was derived. */
export interface PaySummaryHours {
  id: string;
  summaryId: string;
  category: HourCategory;
  hours: number;
  countedTowardTarget: boolean;
  countedAsPaid: boolean;
  /** Why a category is zero — e.g. "no source: leave records carry no hours". */
  notes: string | null;
  createdAt: string;
}

/** payroll.target_adjustments — an authorised manual change to a target. */
export interface PayrollTargetAdjustment {
  id: string;
  businessId: string;
  staffProfileId: string;
  payPeriodId: string;
  summaryId: string | null;
  originalTargetCents: number;
  adjustedTargetCents: number;
  reason: string;
  adjustedByUserProfileId: string;
  adjustedAt: string;
  notes: string | null;
}

/** payroll.pay_adjustments — a correction carried into a later period. */
export interface PayAdjustment {
  id: string;
  businessId: string;
  staffProfileId: string;
  originPayPeriodId: string | null;
  appliedInPayPeriodId: string | null;
  reason: PayAdjustmentReason;
  /** Signed — negative claws back commission paid on a refunded service. */
  amountCents: number;
  description: string;
  sourceType: PayLineSource | null;
  sourceId: string | null;
  createdByUserProfileId: string | null;
  createdAt: string;
  appliedAt: string | null;
}

// =============================================================================
// 7. Calculation breakdown — the explainability payload
// =============================================================================

/**
 * How the Service Revenue Target was arrived at.
 *
 * PRECEDENCE, and it matters: the money-affecting figure is the commission
 * stage's band threshold (e.g. 3x payable base pay). payroll.targets rows are
 * TRACKING ONLY — migration 0072 was written specifically to stop the two being
 * conflated — and the legacy core.staff_profiles.service_revenue_target_amount is
 * not read by the engine at all.
 */
export interface ServiceRevenueTargetBreakdown {
  targetCents: number | null;
  basis: ThresholdBasis | null;
  /** Plain-English derivation, e.g. "3.0 x base pay (GBP 488.40 payable)". */
  derivation: string;
  adjustments: PayrollTargetAdjustment[];
}

/** One band's slice, priced separately so the statement can show the workings. */
export interface CommissionBandBreakdown {
  bandId: string;
  sequenceNo: number;
  /** e.g. "3.0x base pay" or "10% of the Service Revenue Target". */
  fromLabel: string;
  sliceFromCents: number;
  /** Null on the open-ended top band. */
  sliceToCents: number | null;
  ratePercentApplied: number;
  /** True when the accelerator rate substituted for this band's normal rate. */
  acceleratorRateApplied: boolean;
  amountCents: number;
}

/** One accelerator condition and how it actually evaluated. */
export interface AcceleratorConditionResult {
  metric: AcceleratorMetric;
  comparator: PayrollComparator;
  basis: ConditionBasis;
  thresholdValue: number | null;
  actualValue: number | null;
  /** Null = could not be evaluated; see unevaluableReason. */
  passed: boolean | null;
  unevaluableReason: string | null;
}

/**
 * Accelerator outcome. `achieved: null` means it could not be evaluated, which is
 * treated as NOT achieved by the engine (the lower band rate applies) — the safe
 * direction, and always accompanied by a warning.
 *
 * The DB has no home for this: payroll.accelerators has no outcome column and
 * pay_summaries has no accelerator flag, so it is persisted inside
 * pay_summaries.inputs_snapshot.
 */
export interface AcceleratorBreakdown {
  achieved: boolean | null;
  evaluationMode: AcceleratorEvaluation | null;
  requiredConditionCount: number | null;
  requiredScore: number | null;
  conditions: AcceleratorConditionResult[];
}

/** Both sides of a greater-of comparison survive, with the winner recorded. */
export interface GreaterOfBreakdown {
  applied: boolean;
  winner: GreaterOfWinner | null;
  basePayCents: number;
  commissionCents: number;
  revenueSplitCents: number | null;
}

/** A staff row on the period detail table. */
export interface PaySummaryListItem {
  summaryId: string;
  staffProfileId: string;
  staffName: string;
  employmentTypeSnapshot: string;
  structureName: string | null;
  structureVersionNo: number | null;
  payableHours: number;
  workedHours: number;
  serviceRevenueTargetCents: number | null;
  serviceRevenueCents: number;
  retailRevenueCents: number;
  basePayCents: number;
  commissionCents: number;
  revenueSplitCents: number;
  chairRentCents: number;
  deductionsCents: number;
  bonusCents: number;
  adjustmentsCents: number;
  /** SIGNED. */
  grossPayableCents: number;
  businessRetainedCents: number;
  greaterOfApplied: boolean;
  greaterOfWinner: GreaterOfWinner | null;
  /** Null = could not be evaluated. */
  acceleratorAchieved: boolean | null;
  isStale: boolean;
  staleReason: string | null;
  warnings: PayrollWarning[];
  currencyCode: string;
}

/** The full drill-down for one staff member. Everything needed to defend a figure. */
export interface PaySummaryBreakdown {
  summary: PaySummary;
  staffName: string;
  hours: PaySummaryHours[];
  lines: PaySummaryLine[];
  target: ServiceRevenueTargetBreakdown;
  accelerator: AcceleratorBreakdown | null;
  bands: CommissionBandBreakdown[];
  greaterOf: GreaterOfBreakdown | null;
  adjustments: PayAdjustment[];
  warnings: PayrollWarning[];
}

// =============================================================================
// 8. Readiness — the pre-flight gate
// =============================================================================

/**
 * Whether a period can be generated at all. Uncaptured transaction sources WARN;
 * missing configuration inputs BLOCK, because generating a statement whose base
 * pay is GBP 0 for want of an hourly rate is worse than refusing to generate it.
 */
export interface PayrollStaffReadiness {
  staffProfileId: string;
  staffName: string;
  canGenerate: boolean;
  warnings: PayrollWarning[];
}

export interface PayrollReadiness {
  canGenerate: boolean;
  staff: PayrollStaffReadiness[];
  /** Business-level warnings, e.g. an uncaptured source a live rule depends on. */
  warnings: PayrollWarning[];
}

// =============================================================================
// 9. Response envelopes
// =============================================================================

export interface ListPayPeriodsResponse {
  periods: PayPeriodListItem[];
}

export interface PayPeriodDetailResponse {
  period: PayPeriod;
  totals: PayPeriodSummaryTotals | null;
  readiness: PayrollReadiness | null;
}

export interface ListPaySummariesResponse {
  period: PayPeriod;
  summaries: PaySummaryListItem[];
  periodWarnings: PayrollWarning[];
}

export interface PaySummaryDetailResponse {
  breakdown: PaySummaryBreakdown;
}

export interface PayrollSettingsResponse {
  settings: PayrollSettings;
  dataSources: PayrollBusinessDataSource[];
}

/**
 * The slice of the parent period a stylist needs to read their own statement.
 * Deliberately NOT the full PayPeriod: who generated/approved/locked it and
 * the owner's period notes are management-side data.
 */
export interface MyPayPeriod {
  payPeriodId: string;
  kind: PayPeriodKind;
  /** Local date, inclusive. */
  periodStart: string;
  /** Local date, EXCLUSIVE. */
  periodEnd: string;
  label: string | null;
  status: PayPeriodStatus;
}

export interface MyPaySummaryListItem extends PaySummaryListItem {
  period: MyPayPeriod;
}

/** Stylist self-view. Scoped server-side to the actor — never takes a staff id. */
export interface MyPaySummariesResponse {
  summaries: MyPaySummaryListItem[];
}

// =============================================================================
// 10. Pay-structure authoring (Phase 1: template-driven owner UI)
// =============================================================================

/**
 * Stage `config` contracts — the DTO-layer validation migration 0071 promised
 * ("validated per stage_type in the API DTO layer"). These ratify the shapes
 * the calculation engine already reads; the authoring API refuses anything
 * else, so UI-written rules can never drift from what the engine understands.
 *
 * Deliberately absent: `tips_payout` (tips are uncaptured — an authored tips
 * stage would only ever render "source not captured") and percentage/
 * service-specific deductions, rent cadences and rule-triggered bonuses
 * (Phase 2; the enum values exist but have no engine semantics yet).
 */
export type BasePayStageConfig =
  | { source: 'hourly_rate_x_payable_hours' }
  | { source: 'fixed_amount'; amount_cents: number };

export interface RevenueSplitStageConfig {
  split_percent: number;
}

export interface ChairRentStageConfig {
  amount_cents: number;
  /** Per calculation period this phase; weekly/monthly proration is Phase 2. */
  cadence: 'per_period';
}

export type DeductionStageConfig =
  | { source: 'product_cost' }
  | { source: 'fixed'; amount_cents: number };

export interface BonusStageConfig {
  source: 'fixed';
  amount_cents: number;
}

/** One band of an authored commission stage. Exactly one bound must be set,
 * and it must match the stage's threshold basis (DB triggers re-enforce). */
export interface PayStructureBandInput {
  fromMultiple?: number | null;
  fromAmountCents?: number | null;
  fromPercent?: number | null;
  ratePercent: number;
  acceleratorRatePercent?: number | null;
}

export interface PayStructureAcceleratorConditionInput {
  metric: AcceleratorMetric;
  comparator: PayrollComparator;
  basis: ConditionBasis;
  thresholdValue?: number | null;
  weight?: number;
}

export interface PayStructureAcceleratorInput {
  name?: string;
  evaluationMode: AcceleratorEvaluation;
  requiredConditionCount?: number | null;
  requiredScore?: number | null;
  conditions: PayStructureAcceleratorConditionInput[];
}

export interface PayStructureStageInput {
  stageType: PayStageType;
  label?: string | null;
  tierSemantics?: TierSemantics | null;
  thresholdBasis?: ThresholdBasis | null;
  revenueStream?: PayrollRevenueStream | null;
  inGreaterOfComparison?: boolean;
  requiresDataSource?: PayrollDataSource | null;
  config?: Record<string, unknown>;
  bands?: PayStructureBandInput[];
  accelerator?: PayStructureAcceleratorInput | null;
}

export interface PayStructureHourRuleInput {
  category: HourCategory;
  countsTowardTarget: boolean;
  countsAsPaid: boolean;
}

export interface PayStructureRulesInput {
  /** Local date the version takes effect (inclusive). */
  effectiveFrom: string;
  discountBasis?: DiscountBasis;
  vatBasis?: PayrollVatBasis;
  depositRecognition?: DepositRecognition;
  productCostMode?: ProductCostMode;
  stages: PayStructureStageInput[];
  /** All eight categories must be present — absence is not a default. */
  hourRules: PayStructureHourRuleInput[];
  notes?: string;
}

export interface CreatePayStructureRequest extends PayStructureRulesInput {
  name: string;
  description?: string;
}

/** Creates version N+1 and closes the current version at `effectiveFrom`. */
export type CreatePayStructureVersionRequest = PayStructureRulesInput;

export interface PayStructureBandDetail {
  id: string;
  sequenceNo: number;
  fromMultiple: number | null;
  fromAmountCents: number | null;
  fromPercent: number | null;
  ratePercent: number;
  acceleratorRatePercent: number | null;
}

export interface PayStructureStageDetail {
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
  bands: PayStructureBandDetail[];
  accelerator:
    | (PayStructureAcceleratorInput & {
        conditions: (PayStructureAcceleratorConditionInput & { sequenceNo: number })[];
      })
    | null;
}

export interface PayStructureVersionDetail {
  id: string;
  versionNo: number;
  effectiveFrom: string;
  /** EXCLUSIVE; null = in force. */
  effectiveTo: string | null;
  discountBasis: DiscountBasis;
  vatBasis: PayrollVatBasis;
  depositRecognition: DepositRecognition;
  productCostMode: ProductCostMode;
  /** True once any pay run priced this version — rules are frozen by the DB. */
  isUsed: boolean;
  stages: PayStructureStageDetail[];
  hourRules: PayStructureHourRuleInput[];
  notes: string | null;
}

export interface PayStructureSummary {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  assignedStaffCount: number;
}

export interface ListPayStructuresResponse {
  structures: PayStructureSummary[];
}

export interface PayStructureDetailResponse {
  structure: PayStructureSummary;
  versions: PayStructureVersionDetail[];
  /** The version in force today, when one exists. */
  currentVersionId: string | null;
}

/**
 * Wizard preview: run the REAL engine over the drafted rules with illustrative
 * sample inputs, before anything is saved. All sources are treated as captured
 * so the illustration shows figures; the live engine still warns/zeroes per
 * the capture matrix.
 */
export interface PayStructurePreviewSample {
  hourlyRateCents?: number;
  workedHours?: number;
  serviceRevenueCents?: number;
  retailRevenueCents?: number;
  averageBillBenchmarkCents?: number | null;
  rebookingRatePercent?: number | null;
  averageBillCents?: number | null;
  clientCount?: number | null;
}

export interface PayStructurePreviewRequest {
  rules: PayStructureRulesInput;
  sample?: PayStructurePreviewSample;
}

export interface PayStructurePreviewResponse {
  illustrative: true;
  grossPayableCents: number;
  basePayCents: number;
  commissionCents: number;
  revenueSplitCents: number;
  bonusCents: number;
  chairRentCents: number;
  deductionsCents: number;
  target: ServiceRevenueTargetBreakdown;
  bands: CommissionBandBreakdown[];
  accelerator: AcceleratorBreakdown | null;
  greaterOf: GreaterOfBreakdown | null;
  warnings: PayrollWarning[];
}

// --- Assignment ---

export interface AssignPayStructureRequest {
  structureId: string;
  /** Local date the assignment starts; any open assignment closes here. */
  effectiveFrom: string;
}

export interface StaffPayAssignmentDetail {
  id: string;
  staffProfileId: string;
  structureId: string;
  structureName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface AssignPayStructureResponse {
  assignment: StaffPayAssignmentDetail;
  /** The previous open assignment that was closed, when one existed. */
  closedAssignment: StaffPayAssignmentDetail | null;
}

export interface StaffPayAssignmentResponse {
  /** The assignment in force today, or null. */
  assignment: StaffPayAssignmentDetail | null;
  /**
   * The open (unended) assignment. Differs from `assignment` only when the
   * open assignment starts in the future — the case a start-date correction
   * exists to fix.
   */
  openAssignment: StaffPayAssignmentDetail | null;
}

export interface AmendPayAssignmentRequest {
  /** Corrected local start date for the staff member's open assignment. */
  effectiveFrom: string;
}

export interface AmendPayAssignmentResponse {
  assignment: StaffPayAssignmentDetail;
  previousEffectiveFrom: string;
  /**
   * Already-calculated pay summaries the date move made stale (their periods
   * resolved the plan under the old date). Recalculate those periods.
   */
  staleFlaggedCount: number;
  /**
   * Locked/paid periods inside the moved window. Their figures are final;
   * corrections flow through a pay adjustment in a later period.
   */
  lockedPeriodCount: number;
}
