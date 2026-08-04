/**
 * Money helpers for the payroll calculation engine.
 *
 * One home for cents arithmetic (docs/V1.1/3-2 plan.md W3.2-D notes `toCents`
 * was already duplicated three times elsewhere with two divergent remainder
 * algorithms — payroll must not add a fourth).
 *
 * Conventions:
 *  - All engine money is integer minor units ("cents").
 *  - Rounding is half-up on the MAGNITUDE, once per line: compute the positive
 *    figure, round, then apply the sign. `Math.round(-1.5) === -1` in JS, which
 *    would round negative deductions differently from positive commission on
 *    the same basis — hence `roundMagnitude`.
 *  - Staff-record pay fields (`core.staff_profiles.hourly_rate`, benchmarks)
 *    are MAJOR currency (numeric 12,2). Crossing into the engine requires the
 *    explicit x100 in `majorToCents`.
 */

/** Round half-up on the magnitude, preserving sign. */
export function roundMagnitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value));
}

/** basis x rate% as cents, rounded once (half-up on magnitude). */
export function rateAmountCents(basisCents: number, ratePercent: number): number {
  return roundMagnitude((basisCents * ratePercent) / 100);
}

/** Major-currency value (e.g. staff_profiles.hourly_rate 12.21) to integer cents. */
export function majorToCents(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return null;
  return roundMagnitude(num * 100);
}

/**
 * PostgREST returns bigint/numeric columns as strings. Coerce defensively;
 * null/undefined stay null so "missing" is distinguishable from 0.
 */
export function numOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
}

/** Like numOrNull but collapses missing to 0 — for columns defaulted to 0. */
export function numOrZero(value: number | string | null | undefined): number {
  return numOrNull(value) ?? 0;
}
