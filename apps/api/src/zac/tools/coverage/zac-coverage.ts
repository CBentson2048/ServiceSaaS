/**
 * Phase 2 Workstream 3 — THE ANTI-CONFIDENT-ZEROS FIREWALL.
 *
 * THE PROBLEM THIS SOLVES, in the actual numbers on the actual database.
 *
 *   - Colour waste: every one of 20 `lab.formula_items` has `waste_grams = 0`
 *     and `waste_cost_cents = 0`, and `inventory.waste_events` holds 0 rows.
 *     Naive arithmetic renders "0% waste" — which tells an owner they run a
 *     perfect colour bar. The truth is that waste is never captured at save
 *     time, which is a completely different statement and an actionable one.
 *   - Colour margin at AndrewHair: charge 0, cost 0. `0/0` renders "0% margin"
 *     — a fabricated trading result for a salon that has simply never priced a
 *     formula. (At Kensington the same calculation is a real 16.7%.)
 *   - Dead-stock value: 4 of 10 products record no cost at all, and a cost-less
 *     product silently sums as zero — so a "£X of dead stock" total is an
 *     under-report dressed as a precise figure.
 *
 * Every one of those is a DIVISION OR SUM WITH A MISSING DENOMINATOR, and in
 * every case the wrong answer is the confident-looking one. Prose discipline
 * ("remember to check for zero") does not survive contact with a busy
 * afternoon, so this module makes the mistake unconstructible instead:
 *
 *   A `ZacCoverageReading` is the ONLY route from a numerator and a denominator
 *   to a rendered figure, and its constructors DEMAND the denominator, the
 *   sample unit and an as-of timestamp.
 *
 * A reading that is not `measured` has no number. `toNullableNumber()` returns
 * `null`, and `limitationsFor()` returns the sentence saying why. The WS3
 * boundary sweep (`zac-ws3-boundary.spec.ts`) fails any tool file containing
 * bare percentage arithmetic, so there is no way around it.
 *
 * PURE AND CLOCK-FREE. Nothing here reads `Date.now()` — `nowMs` is always a
 * parameter, so every branch is testable at a frozen instant.
 */
import type { ZacConfidence } from '../../responses/zac-response.types';

const MS_PER_DAY = 86_400_000;

/**
 * Why a figure is or is not available. Closed union: adding a state forces every
 * consumer to handle it.
 *
 * The five non-measured states are deliberately distinct rather than one
 * "unavailable", because they lead to five DIFFERENT sentences and three
 * different tool statuses. "You have never set this up" and "your data stops in
 * July" and "I could not read it" are not interchangeable.
 */
export type ZacCoverageReading =
  | {
      kind: 'measured';
      /** The figure itself. A percentage is 0-100, not 0-1. */
      value: number;
      numerator: number;
      denominator: number;
      /** What the denominator counts: 'formulas', 'products', 'stock records'. */
      sampleUnit: string;
      /** Newest record behind the figure, ISO. Null when genuinely unknown. */
      asOf: string | null;
      /**
       * Fraction of the sample carrying the input this figure needs (0-1).
       * 1 when every row contributed. Below 1, the figure is a lower bound.
       */
      coverage: number;
    }
  | { kind: 'zero_denominator'; sampleUnit: string; asOf: string | null }
  | { kind: 'below_sample_floor'; denominator: number; floor: number; sampleUnit: string; asOf: string | null }
  | { kind: 'not_configured'; what: string }
  | { kind: 'stale'; asOf: string; daysStale: number; sampleUnit: string }
  | { kind: 'unreadable'; reason: string };

export interface ZacRateInput {
  numerator: number;
  denominator: number;
  sampleUnit: string;
  asOf: string | null;
  /**
   * Smallest denominator worth reporting a rate over. Below it the reading is
   * `below_sample_floor`: a "100% rebook rate" off one appointment is noise
   * rendered as certainty. Default 1 — any non-zero sample yields a figure, but
   * the caller may raise it.
   */
  sampleFloor?: number;
  /** Rows carrying the input, when fewer than `denominator`. Defaults to full coverage. */
  covered?: number;
}

/**
 * A percentage of a denominator, expressed 0-100.
 *
 * REFUSES a zero denominator rather than returning 0. This single behaviour is
 * why the module exists.
 */
export function rate(input: ZacRateInput): ZacCoverageReading {
  const { numerator, denominator, sampleUnit, asOf } = input;
  const floor = input.sampleFloor ?? 1;

  if (!Number.isFinite(denominator) || denominator <= 0) {
    return { kind: 'zero_denominator', sampleUnit, asOf };
  }
  if (denominator < floor) {
    return { kind: 'below_sample_floor', denominator, floor, sampleUnit, asOf };
  }
  const covered = input.covered ?? denominator;
  return {
    kind: 'measured',
    value: round1((numerator / denominator) * 100),
    numerator,
    denominator,
    sampleUnit,
    asOf,
    coverage: clamp01(covered / denominator),
  };
}

/**
 * A count as a proportion of a population — same arithmetic as {@link rate},
 * named separately so the call site reads honestly ("6 of 10 products", not
 * "a rate").
 */
export function share(input: ZacRateInput): ZacCoverageReading {
  return rate(input);
}

/**
 * A money total whose inputs are only partly recorded.
 *
 * `totalCents` is what the rows that HAVE a cost add up to. `covered`/`total`
 * say how many of them did. Below `minCoverage` the total is suppressed
 * entirely, because a number missing 40% of its inputs is not a smaller number
 * — it is a wrong one.
 */
export function moneyTotal(input: {
  totalCents: number;
  covered: number;
  total: number;
  sampleUnit: string;
  asOf: string | null;
  /** Fraction of rows that must carry a cost for the total to be shown. Default 0.5. */
  minCoverage?: number;
}): ZacCoverageReading {
  const { totalCents, covered, total, sampleUnit, asOf } = input;
  const minCoverage = input.minCoverage ?? 0.5;

  if (!Number.isFinite(total) || total <= 0) {
    return { kind: 'zero_denominator', sampleUnit, asOf };
  }
  const coverage = clamp01(covered / total);
  if (coverage < minCoverage) {
    return { kind: 'below_sample_floor', denominator: covered, floor: Math.ceil(total * minCoverage), sampleUnit, asOf };
  }
  return {
    kind: 'measured',
    value: totalCents,
    numerator: covered,
    denominator: total,
    sampleUnit,
    asOf,
    coverage,
  };
}

/** How much of a population carries some attribute at all — "6 of 10 products record a cost". */
export function coverageOf(input: {
  covered: number;
  total: number;
  sampleUnit: string;
  asOf: string | null;
}): ZacCoverageReading {
  return rate({
    numerator: input.covered,
    denominator: input.total,
    sampleUnit: input.sampleUnit,
    asOf: input.asOf,
    covered: input.total,
  });
}

/** Nothing is set up to measure this — a configuration answer, not a zero. */
export function notConfigured(what: string): ZacCoverageReading {
  return { kind: 'not_configured', what };
}

/** Read successfully, but the newest record is too old to describe the window asked about. */
export function staleReading(asOf: string, nowMs: number, sampleUnit: string): ZacCoverageReading {
  return {
    kind: 'stale',
    asOf,
    daysStale: Math.max(0, Math.floor((nowMs - Date.parse(asOf)) / MS_PER_DAY)),
    sampleUnit,
  };
}

/** The read itself failed. Distinct from "there is nothing there". */
export function unreadable(reason: string): ZacCoverageReading {
  return { kind: 'unreadable', reason };
}

/**
 * The figure, or null.
 *
 * NULL IS THE POINT. A rate over a missing denominator is `null`, never `0`,
 * so a payload field is absent rather than falsely precise.
 */
export function toNullableNumber(reading: ZacCoverageReading): number | null {
  return reading.kind === 'measured' ? reading.value : null;
}

export function isMeasured(
  reading: ZacCoverageReading,
): reading is Extract<ZacCoverageReading, { kind: 'measured' }> {
  return reading.kind === 'measured';
}

/**
 * The honest sentence for a reading, ready to drop into `limitations`.
 *
 * `subject` names the figure in the user's terms ("colour waste", "dead stock
 * value") so the sentence stands alone in a list.
 */
export function limitationsFor(reading: ZacCoverageReading, subject: string): string[] {
  switch (reading.kind) {
    case 'measured':
      return reading.coverage >= 1
        ? []
        : [
            `${capitalise(subject)} is based on ${reading.numerator} of ${reading.denominator} ${reading.sampleUnit} — ` +
              `the rest do not record it, so this is a lower bound rather than the full picture.`,
          ];
    case 'zero_denominator':
      return [
        `I have no ${reading.sampleUnit} to measure ${subject} against, so I have left it out rather than ` +
          `reporting it as zero — zero would read as a result, and this is an absence of data.`,
      ];
    case 'below_sample_floor':
      return [
        `Only ${reading.denominator} ${reading.sampleUnit} back ${subject}, below the ${reading.floor} I need ` +
          `before a figure means anything, so I have left it out.`,
      ];
    case 'not_configured':
      return [`${capitalise(subject)} is not something I can measure yet: ${reading.what}`];
    case 'stale':
      return [
        `The newest ${reading.sampleUnit} behind ${subject} is from ${formatDate(reading.asOf)}, ` +
          `${reading.daysStale} days ago, so it does not describe the period you asked about.`,
      ];
    case 'unreadable':
      return [`I could not read ${subject}: ${reading.reason}`];
  }
}

/**
 * Lower a confidence to what the reading actually supports.
 *
 * Never RAISES — a caller's own doubts survive. Partial coverage cannot be
 * 'high', and anything unmeasured cannot be better than 'low'.
 */
export function capConfidence(base: ZacConfidence, reading: ZacCoverageReading): ZacConfidence {
  if (reading.kind !== 'measured') return 'low';
  if (reading.coverage < 1 && base === 'high') return 'medium';
  return base;
}

/** The weakest confidence across several readings — a whole answer is only as good as its worst input. */
export function capConfidenceAcross(
  base: ZacConfidence,
  readings: readonly ZacCoverageReading[],
): ZacConfidence {
  const order: ZacConfidence[] = ['low', 'medium', 'high'];
  return readings.reduce<ZacConfidence>(
    (worst, reading) => {
      const capped = capConfidence(base, reading);
      return order.indexOf(capped) < order.indexOf(worst) ? capped : worst;
    },
    base,
  );
}

// ---------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------

export interface ZacRecency {
  /** Newest record seen, ISO; null when there are none at all. */
  newestIso: string | null;
  daysSince: number | null;
  /** True when the newest record predates the window being reported on. */
  predatesWindow: boolean;
}

/**
 * How recent the underlying ledger is.
 *
 * Load-bearing for WS3: the stock ledger's newest entry is 2026-08-26 and the
 * newest costed colour formula is 2026-07-21. "Six products are idle" is only
 * meaningful beside "and nothing has moved since 26 August" — without that, a
 * stale ledger reads as a purchasing problem.
 */
export function recency(newestIso: string | null, windowFromIso: string, nowMs: number): ZacRecency {
  if (newestIso === null) return { newestIso: null, daysSince: null, predatesWindow: true };
  const newestMs = Date.parse(newestIso);
  if (!Number.isFinite(newestMs)) return { newestIso: null, daysSince: null, predatesWindow: true };
  return {
    newestIso,
    daysSince: Math.max(0, Math.floor((nowMs - newestMs) / MS_PER_DAY)),
    predatesWindow: newestMs < Date.parse(windowFromIso),
  };
}

/** "26 August 2026" — unambiguous across locales, unlike a numeric date. */
export function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Render a stock quantity in ITS OWN unit.
 *
 * `quantity_on_hand_grams` is named for history, not meaning: since migration
 * 0091 a product's `stock_unit` may be `gram`, `millilitre` or `unit`, and the
 * column comment says the name is retained for compatibility only. Appending
 * "g" to the column would tell an owner they hold "6g" of a product they count
 * in bottles.
 */
export function formatStockQuantity(value: number, stockUnit: 'gram' | 'millilitre' | 'unit'): string {
  const n = round1(value);
  if (stockUnit === 'unit') return `${n} ${n === 1 ? 'unit' : 'units'}`;
  return `${n}${stockUnit === 'millilitre' ? 'ml' : 'g'}`;
}

export function money(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  const sign = cents < 0 ? '-' : '';
  return `${sign}${symbol}${(Math.abs(cents) / 100).toFixed(2)}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
