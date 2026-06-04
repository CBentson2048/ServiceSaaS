/**
 * KPI calculation engine — pure functions, no I/O.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without a database. The NestJS service (kpi.service.ts) is the only
 * place that talks to Supabase; it loads real persisted rows, shapes them into
 * the plain inputs below, and delegates every business rule to these helpers.
 *
 * Money is in integer cents. Rates/benchmarks arrive in currency units
 * (e.g. 12.50) and are converted to cents here. Percentages are integers.
 */

import type {
  AverageBillKpiResult,
  CommissionResult,
  CommissionTier,
  KpiDataNote,
  KpiPeriod,
  RebookingKpiResult,
  RetailKpiResult,
  StylistKpiResult,
} from '@sheer/domain';

// --- Business-rule constants ------------------------------------------------

/** Service target = hourly rate × this multiplier × hours worked. */
export const SERVICE_TARGET_MULTIPLIER = 3;
/** Retail target = this fraction of the service target. */
export const RETAIL_TARGET_RATIO = 0.1;
/** Rebooking KPI passes at or above this percentage. */
export const REBOOKING_THRESHOLD_PERCENT = 50;

/**
 * Commission tiers (V1). The "multiple" is service-revenue base ÷ labour cost
 * (hourly rate × hours worked). Note the service target is 3× labour cost, so
 * hitting 3.0x === hitting the service target.
 *  - < 3.0x              → 0%
 *  - 3.0x ≤ m < 3.5x     → 10%
 *  - m ≥ 3.5x, KPIs not all met → 15%
 *  - m ≥ 3.5x, all KPIs met     → 30% (the all-KPIs gate only promotes 15 → 30)
 */
export const COMMISSION_TIER_3X = 3;
export const COMMISSION_TIER_3_5X = 3.5;
export const COMMISSION_RATE_TIER_3X = 10;
export const COMMISSION_RATE_TIER_3_5X = 15;
export const COMMISSION_RATE_TIER_UNLOCKED = 30;
/**
 * Shift statuses that count as rostered working time. Mirrors the existing
 * frontend convention (DayCalendarBoard treats any non-cancelled shift as
 * real); cancelled shifts never contribute to hours worked.
 */
export const SCHEDULED_SHIFT_STATUSES = new Set(['draft', 'published', 'completed']);

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// --- Plain inputs -----------------------------------------------------------

export interface TimeInterval {
  startMs: number;
  endMs: number;
}

export interface ShiftInput extends TimeInterval {
  status: string;
}

export interface BreakInput extends TimeInterval {
  isPaid: boolean;
}

/** Hours-worked inputs for one stylist over one window. */
export interface WorkedHoursInput {
  windowStartMs: number;
  windowEndMs: number;
  shifts: ShiftInput[];
  /** All breaks for the stylist's shifts in the window. */
  breaks: BreakInput[];
  /** Approved-leave and absence/sickness intervals (already day/range expanded). */
  unavailable: TimeInterval[];
}

/** Everything needed to assemble one stylist's KPI snapshot. */
export interface StylistKpiInputs {
  staffProfileId: string;
  stylistName: string;
  locationId: string;
  locationName: string;
  currencyCode: string;
  /** Currency units (e.g. 12.50), as stored on core.staff_profiles. */
  hourlyRate: number;
  averageBillBenchmark: number;
  hoursWorked: number;
  // Rebooking
  completedVisits: number;
  rebookedVisits: number;
  stylistRebookedVisits: number;
  clientRebookedVisits: number;
  // Realised revenue (paid visits)
  serviceRevenueCents: number;
  /** Colour/formula product billed within the visit — part of the bill, not retail. */
  productUsageRevenueCents: number;
  paidVisits: number;
  // Retail (inventory retail_sale movements)
  retailSalesCents: number;
  hadRetailMovements: boolean;
}

// --- Interval set algebra (sorted, disjoint) --------------------------------

/** Merge overlapping/touching intervals into a sorted, disjoint list. */
export function normalizeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const valid = intervals.filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
  const merged: TimeInterval[] = [];
  for (const interval of valid) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }
  return merged;
}

/** a ∩ b. Both are normalized internally. */
export function intersectIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
  const left = normalizeIntervals(a);
  const right = normalizeIntervals(b);
  const out: TimeInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].startMs, right[j].startMs);
    const end = Math.min(left[i].endMs, right[j].endMs);
    if (end > start) out.push({ startMs: start, endMs: end });
    if (left[i].endMs < right[j].endMs) i += 1;
    else j += 1;
  }
  return out;
}

/** a − b (remove every part of b from a). */
export function subtractIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
  const subtract = normalizeIntervals(b);
  let current = normalizeIntervals(a);
  for (const cut of subtract) {
    const next: TimeInterval[] = [];
    for (const interval of current) {
      if (cut.endMs <= interval.startMs || cut.startMs >= interval.endMs) {
        next.push(interval); // no overlap
        continue;
      }
      if (cut.startMs > interval.startMs) next.push({ startMs: interval.startMs, endMs: cut.startMs });
      if (cut.endMs < interval.endMs) next.push({ startMs: cut.endMs, endMs: interval.endMs });
    }
    current = next;
  }
  return current;
}

export function totalMs(intervals: TimeInterval[]): number {
  return intervals.reduce((sum, i) => sum + Math.max(0, i.endMs - i.startMs), 0);
}

/** Clamp an interval to [windowStart, windowEnd], or null if it falls outside. */
function clampToWindow(interval: TimeInterval, windowStartMs: number, windowEndMs: number): TimeInterval | null {
  const startMs = Math.max(interval.startMs, windowStartMs);
  const endMs = Math.min(interval.endMs, windowEndMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

// --- Target engine ----------------------------------------------------------

/**
 * Net hours worked = rostered (non-cancelled) shift time inside the window,
 * minus approved leave / absence overlap, minus unpaid breaks that fall within
 * the remaining available time. Paid breaks are NOT subtracted (they count as
 * worked time). Leave reducing hours and sickness reducing hours both fall out
 * of the single `unavailable` subtraction.
 */
export function computeNetWorkedHours(input: WorkedHoursInput): number {
  const { windowStartMs, windowEndMs } = input;

  const scheduled = input.shifts
    .filter((shift) => SCHEDULED_SHIFT_STATUSES.has(shift.status))
    .map((shift) => clampToWindow(shift, windowStartMs, windowEndMs))
    .filter((i): i is TimeInterval => i !== null);

  const unavailable = input.unavailable
    .map((i) => clampToWindow(i, windowStartMs, windowEndMs))
    .filter((i): i is TimeInterval => i !== null);

  const unpaidBreaks = input.breaks
    .filter((b) => !b.isPaid)
    .map((i) => clampToWindow(i, windowStartMs, windowEndMs))
    .filter((i): i is TimeInterval => i !== null);

  const available = subtractIntervals(scheduled, unavailable);
  const unpaidWithinAvailable = intersectIntervals(unpaidBreaks, available);
  const netMs = Math.max(0, totalMs(available) - totalMs(unpaidWithinAvailable));
  return netMs / MS_PER_HOUR;
}

export function toCents(currencyUnits: number): number {
  if (!Number.isFinite(currencyUnits)) return 0;
  return Math.round(currencyUnits * 100);
}

export function computeServiceTargetCents(hourlyRate: number, hoursWorked: number): number {
  const hours = Math.max(0, hoursWorked);
  return Math.round(toCents(hourlyRate) * SERVICE_TARGET_MULTIPLIER * hours);
}

export function computeRetailTargetCents(serviceTargetCents: number): number {
  return Math.round(Math.max(0, serviceTargetCents) * RETAIL_TARGET_RATIO);
}

// --- KPI category calculators -----------------------------------------------

export function computeRebookingKpi(input: {
  completedVisits: number;
  rebookedVisits: number;
  stylistRebookedVisits: number;
  clientRebookedVisits: number;
}): RebookingKpiResult {
  const completedVisits = Math.max(0, input.completedVisits);
  const rebookedVisits = Math.max(0, Math.min(input.rebookedVisits, completedVisits));
  const rebookingRatePercent =
    completedVisits > 0 ? Math.round((rebookedVisits / completedVisits) * 100) : 0;
  // Exact ≥50% test (avoids rounding 49.x% up to a pass): 2·rebooked ≥ completed.
  const met = completedVisits > 0 && rebookedVisits * 2 >= completedVisits;
  return {
    completedVisits,
    rebookedVisits,
    stylistRebookedVisits: Math.max(0, input.stylistRebookedVisits),
    clientRebookedVisits: Math.max(0, input.clientRebookedVisits),
    rebookingRatePercent,
    thresholdPercent: REBOOKING_THRESHOLD_PERCENT,
    met,
  };
}

export function computeRetailKpi(
  retailTargetCents: number,
  actualRetailSalesCents: number,
  hasHours: boolean,
): RetailKpiResult {
  const target = Math.max(0, retailTargetCents);
  const actual = Math.max(0, actualRetailSalesCents);
  // With no rostered hours there is no meaningful target, so the KPI cannot be
  // "passed" by virtue of 0 ≥ 0 — that would wrongly unlock commission.
  const met = hasHours && target > 0 && actual >= target;
  return { retailTargetCents: target, actualRetailSalesCents: actual, varianceCents: actual - target, met };
}

export function computeAverageBillKpi(
  benchmarkCents: number,
  totalBillCents: number,
  paidVisits: number,
): AverageBillKpiResult {
  const benchmark = Math.max(0, benchmarkCents);
  const hasBenchmark = benchmark > 0;
  const visits = Math.max(0, paidVisits);
  const actualAverageBillCents = visits > 0 ? Math.round(Math.max(0, totalBillCents) / visits) : 0;
  const met = hasBenchmark && visits > 0 && actualAverageBillCents >= benchmark;
  return {
    benchmarkCents: benchmark,
    hasBenchmark,
    paidVisits: visits,
    actualAverageBillCents,
    varianceCents: actualAverageBillCents - benchmark,
    met,
  };
}

function progressPercent(actualCents: number, targetCents: number): number {
  if (targetCents <= 0) return 0;
  return Math.round((Math.max(0, actualCents) / targetCents) * 100);
}

// --- Commission engine ------------------------------------------------------

/**
 * Commission for the period (V1 rules). `commissionBaseCents` is the service
 * revenue base (service + colour, excluding retail/deposits); `laborCostCents`
 * is hourly rate × hours. The all-KPIs gate only promotes the 3.5x tier
 * (15% → 30%); it never gates the 10% or 15% tiers.
 */
export function computeCommission(input: {
  laborCostCents: number;
  commissionBaseCents: number;
  allKpisMet: boolean;
}): CommissionResult {
  const laborCostCents = Math.max(0, Math.round(input.laborCostCents));
  const commissionBaseCents = Math.max(0, Math.round(input.commissionBaseCents));
  const serviceMultiple =
    laborCostCents > 0 ? Math.round((commissionBaseCents / laborCostCents) * 100) / 100 : 0;

  // Integer-safe threshold tests (avoid float drift at exactly 3.0x / 3.5x).
  const meets3x = laborCostCents > 0 && commissionBaseCents * 10 >= 30 * laborCostCents;
  const meets35x = laborCostCents > 0 && commissionBaseCents * 2 >= 7 * laborCostCents;

  let tier: CommissionTier;
  let ratePercent: number;
  let kpiUnlockApplied = false;
  if (!meets3x) {
    tier = 'below_3x';
    ratePercent = 0;
  } else if (!meets35x) {
    tier = 'tier_3x';
    ratePercent = COMMISSION_RATE_TIER_3X;
  } else if (input.allKpisMet) {
    tier = 'tier_3_5x_unlocked';
    ratePercent = COMMISSION_RATE_TIER_UNLOCKED;
    kpiUnlockApplied = true;
  } else {
    tier = 'tier_3_5x';
    ratePercent = COMMISSION_RATE_TIER_3_5X;
  }

  const commissionAmountCents = Math.round((commissionBaseCents * ratePercent) / 100);

  return {
    laborCostCents,
    commissionBaseCents,
    serviceMultiple,
    tier,
    ratePercent,
    commissionAmountCents,
    kpiUnlockApplied,
    nextTier: computeNextTier(tier, laborCostCents, commissionBaseCents, input.allKpisMet),
  };
}

/** Extra service revenue (cents) needed to reach a target multiple of labour cost. */
function additionalToMultiple(targetMultiple: number, laborCostCents: number, baseCents: number): number {
  if (laborCostCents <= 0) return 0;
  return Math.max(0, Math.ceil(targetMultiple * laborCostCents) - baseCents);
}

function computeNextTier(
  tier: CommissionTier,
  laborCostCents: number,
  baseCents: number,
  allKpisMet: boolean,
): CommissionResult['nextTier'] {
  if (laborCostCents <= 0) return undefined;
  if (tier === 'below_3x') {
    return {
      tier: 'tier_3x',
      ratePercent: COMMISSION_RATE_TIER_3X,
      additionalServiceRevenueCents: additionalToMultiple(COMMISSION_TIER_3X, laborCostCents, baseCents),
    };
  }
  if (tier === 'tier_3x') {
    return {
      tier: allKpisMet ? 'tier_3_5x_unlocked' : 'tier_3_5x',
      ratePercent: allKpisMet ? COMMISSION_RATE_TIER_UNLOCKED : COMMISSION_RATE_TIER_3_5X,
      additionalServiceRevenueCents: additionalToMultiple(COMMISSION_TIER_3_5X, laborCostCents, baseCents),
      requiresAllKpis: false,
    };
  }
  if (tier === 'tier_3_5x') {
    // Already at ≥3.5x; the only remaining gain is the KPI unlock to 30%.
    return { tier: 'tier_3_5x_unlocked', ratePercent: COMMISSION_RATE_TIER_UNLOCKED, requiresAllKpis: true };
  }
  return undefined; // tier_3_5x_unlocked is the top tier
}

// --- Aggregation ------------------------------------------------------------

/** Build the full per-stylist KPI snapshot from loaded inputs. */
export function aggregateStylistKpi(input: StylistKpiInputs): StylistKpiResult {
  const hoursWorked = Math.max(0, input.hoursWorked);
  const hasHours = hoursWorked > 0;
  const hourlyRateCents = toCents(input.hourlyRate);
  const serviceTargetCents = computeServiceTargetCents(input.hourlyRate, hoursWorked);
  const retailTargetCents = computeRetailTargetCents(serviceTargetCents);

  const actualServiceRevenueCents = Math.max(0, input.serviceRevenueCents);
  const actualRetailRevenueCents = Math.max(0, input.retailSalesCents);
  const totalBillCents = actualServiceRevenueCents + Math.max(0, input.productUsageRevenueCents);

  const rebooking = computeRebookingKpi(input);
  const retail = computeRetailKpi(retailTargetCents, actualRetailRevenueCents, hasHours);
  const averageBill = computeAverageBillKpi(toCents(input.averageBillBenchmark), totalBillCents, input.paidVisits);

  const allKpisMet = rebooking.met && retail.met && averageBill.met;

  // Commission base = service revenue including colour (product_usage), per V1
  // rules — retail and deposits are excluded from the direct base.
  const laborCostCents = Math.round(hourlyRateCents * hoursWorked);
  const commissionBaseCents = actualServiceRevenueCents + Math.max(0, input.productUsageRevenueCents);
  const commission = computeCommission({ laborCostCents, commissionBaseCents, allKpisMet });

  const notes: KpiDataNote[] = [];
  if (!hasHours) notes.push('no_hours_worked');
  if (input.completedVisits <= 0) notes.push('no_completed_visits');
  if (!averageBill.hasBenchmark) notes.push('missing_benchmark');
  if (input.hadRetailMovements) notes.push('retail_attribution_approximate');

  return {
    staffProfileId: input.staffProfileId,
    stylistName: input.stylistName,
    locationId: input.locationId,
    locationName: input.locationName,
    currencyCode: input.currencyCode,
    hoursWorked: Math.round(hoursWorked * 100) / 100,
    hourlyRateCents,
    serviceTargetCents,
    retailTargetCents,
    actualServiceRevenueCents,
    actualRetailRevenueCents,
    serviceTargetProgressPercent: progressPercent(actualServiceRevenueCents, serviceTargetCents),
    retailTargetProgressPercent: progressPercent(actualRetailRevenueCents, retailTargetCents),
    rebooking,
    retail,
    averageBill,
    rebookingKpiMet: rebooking.met,
    retailKpiMet: retail.met,
    averageBillKpiMet: averageBill.met,
    allKpisMet,
    commission,
    notes,
  };
}

/**
 * Commission compatibility hook. The full commission engine is out of scope,
 * but it will gate tiers on this single predicate, so expose it explicitly.
 */
export function isCommissionUnlocked(result: Pick<StylistKpiResult, 'allKpisMet'>): boolean {
  return result.allKpisMet;
}

// --- Period / window resolution ---------------------------------------------

export interface ResolvedKpiWindow {
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
  period?: KpiPeriod;
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function mondayUtc(ms: number): number {
  const start = startOfUtcDay(ms);
  const dow = new Date(start).getUTCDay(); // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7;
  return start - offsetToMonday * MS_PER_DAY;
}

/**
 * Resolve a reporting window from either a named period (computed against
 * `nowMs` in UTC, boundaries explicit and exclusive at the end) or an explicit
 * ISO from/to pair. Throws a plain Error on invalid input; the service maps it
 * to a BadRequest.
 */
export function resolveKpiWindow(
  input: { period?: KpiPeriod; from?: string; to?: string },
  nowMs: number,
): ResolvedKpiWindow {
  if (input.period) {
    let fromMs: number;
    let toMs: number;
    if (input.period === 'today') {
      fromMs = startOfUtcDay(nowMs);
      toMs = fromMs + MS_PER_DAY;
    } else if (input.period === 'week') {
      fromMs = mondayUtc(nowMs);
      toMs = fromMs + 7 * MS_PER_DAY;
    } else {
      const d = new Date(startOfUtcDay(nowMs));
      fromMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      toMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return {
      fromMs,
      toMs,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      period: input.period,
    };
  }

  if (!input.from || !input.to) {
    throw new Error('Provide either a period or both from and to');
  }
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) {
    throw new Error('from must be a valid date before to');
  }
  return { fromMs, toMs, fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString() };
}
