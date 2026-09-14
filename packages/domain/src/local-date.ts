/**
 * Local calendar dates ('YYYY-MM-DD') with no time and no zone.
 *
 * This is what a salon means by "Tuesday". Converting a local date to UTC
 * instants needs a timezone and lives on the server
 * (apps/api/src/payroll/period-dates.ts); nothing here reads a clock or `Intl`,
 * so the browser can validate and compare dates but can never compute a day
 * boundary.
 */

/** A calendar date, 'YYYY-MM-DD'. Lexicographic order is chronological order. */
export type LocalDate = string;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * True for a real calendar date in strict 'YYYY-MM-DD' form ('2026-02-30' and
 * '2026-7-1' are rejected). Years below 100 are rejected, matching the
 * `Date.UTC`-based check this replaces, which could not represent them.
 */
export function isLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 100 || month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Number of calendar days from `from` to `to`, both included
 * ('2026-09-01'..'2026-09-01' is 1). Zero or negative when `to` is before `from`.
 * Both arguments must satisfy {@link isLocalDate}.
 */
export function inclusiveDayCount(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return daysFromCivil(ty, tm, td) - daysFromCivil(fy, fm, fd) + 1;
}
