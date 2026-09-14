/**
 * QLOOQO 10 reporting foundation (V1.1 Week 8, Ticket A).
 *
 * One registry of reports drives the API guards, the web routes and the
 * sidebar through ONE decision function, so the three can never disagree about
 * who may open what. One codec turns the browser URL and the API query into
 * the same {@link ReportFilter}.
 *
 * Deliberately browser-safe: no clock, no `Intl`, no timezone maths. A preset
 * such as "today" means a different local date at each location, so only the
 * server — which knows every location's IANA timezone — resolves it
 * (apps/api/src/reports). Decision record: docs/V1.1/week-8-ticket-a-foundation.md.
 */
import type { MembershipGrant, Permission, UserRole } from './index';
import { inclusiveDayCount, isLocalDate, type LocalDate } from './local-date';

// ===========================================================================
// Registry
// ===========================================================================

export type ReportKey = 'money' | 'cash-up' | 'team' | 'colour-lab' | 'pnl';

/**
 * `foundation`: built on the foundation but not released — reachable only when
 * the foundation preview shell is switched on (dev-test). `released`: shipped
 * to every environment. A report's own ticket flips this after its G5 sign-off.
 */
export type ReportRelease = 'foundation' | 'released';

/** Optional controls. Date range and locations are on every report. */
export interface ReportControls {
  /** Staff filter. No report supports it until R2 defines staff scope. */
  staff: boolean;
  /** Summary/detail toggle. */
  detail: boolean;
}

export interface ReportDefinition {
  /** URL slug and API path segment. */
  key: ReportKey;
  label: string;
  /**
   * Owners always pass. A non-owner needs this key on the explicit security
   * level of an active manager membership — see {@link canOpenReport}.
   */
  permission: Permission;
  controls: ReportControls;
  release: ReportRelease;
}

export const REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  {
    key: 'money',
    label: 'Money',
    permission: 'report.financials.view',
    controls: { staff: false, detail: true },
    release: 'foundation',
  },
  {
    key: 'cash-up',
    label: 'Cash up',
    // Viewing only. Signing off a day stays on `eod.sign_off`.
    permission: 'report.financials.view',
    controls: { staff: false, detail: true },
    release: 'foundation',
  },
  {
    key: 'team',
    label: 'Team report',
    permission: 'report.performance.view',
    // R2 switches this on once its staff-scope contract exists (decision S-1d).
    controls: { staff: false, detail: false },
    release: 'foundation',
  },
  {
    key: 'colour-lab',
    label: 'Colour lab',
    permission: 'report.lab_analytics.view',
    controls: { staff: false, detail: false },
    release: 'foundation',
  },
  {
    key: 'pnl',
    label: 'P&L',
    permission: 'report.pnl.view',
    controls: { staff: false, detail: false },
    release: 'foundation',
  },
];

/**
 * Look a report up by its URL key. `Array.find`, never an object index, so
 * `'constructor'` or `'__proto__'` can never resolve to something.
 */
export function getReportDefinition(
  key: string,
  definitions: readonly ReportDefinition[] = REPORT_DEFINITIONS,
): ReportDefinition | undefined {
  return definitions.find((definition) => definition.key === key);
}

// ===========================================================================
// Availability and access
// ===========================================================================

/** Whether the foundation preview shell is on for this deployment. */
export interface ReportSurface {
  foundationShell: boolean;
}

/**
 * Whether a report exists in this deployment at all. Takes no user: it is not a
 * permission, and permission logic never reads it.
 */
export function isReportAvailable(definition: ReportDefinition, surface: ReportSurface): boolean {
  return definition.release === 'released' || surface.foundationShell;
}

/**
 * The only parts of the signed-in user that reporting access may read. An
 * `AuthUser` satisfies it; the merged `permissions` and `allowedLocationIds`
 * are deliberately not part of it.
 */
export interface ReportAccessUser {
  readonly roles: readonly UserRole[];
  readonly membershipGrants?: readonly MembershipGrant[];
}

function isOwner(user: ReportAccessUser): boolean {
  return user.roles.includes('owner');
}

/**
 * FAILS CLOSED. Owners may open every report. Anyone else needs a membership
 * grant — an active manager membership with an explicitly assigned, same-business
 * security level — carrying the report's permission. The merged
 * `AuthUser.permissions` (which falls back to role defaults for a NULL level)
 * and `allowedLocationIds` are never consulted.
 */
export function canOpenReport(
  user: ReportAccessUser | null | undefined,
  definition: ReportDefinition,
): boolean {
  if (!user) return false;
  if (isOwner(user)) return true;
  return (user.membershipGrants ?? []).some((grant) =>
    grant.permissions.includes(definition.permission),
  );
}

/**
 * The locations this user may report on for this report: every business
 * location for an owner (inactive included), otherwise only the locations of
 * the grants carrying the report's permission. Always intersected with the
 * business's own locations; deduped and sorted.
 */
export function reportLocationIds(
  user: ReportAccessUser,
  definition: ReportDefinition,
  businessLocationIds: readonly string[],
): string[] {
  const business = new Set(businessLocationIds);
  if (isOwner(user)) return [...business].sort();
  const permitted = new Set<string>();
  for (const grant of user.membershipGrants ?? []) {
    if (grant.permissions.includes(definition.permission) && business.has(grant.locationId)) {
      permitted.add(grant.locationId);
    }
  }
  return [...permitted].sort();
}

export type ReportAccessDecision = 'unavailable' | 'forbidden' | 'allowed';

/** The one decision used wherever a user is known: API guard, web route, sidebar. */
export function reportAccessDecision(
  user: ReportAccessUser | null | undefined,
  definition: ReportDefinition,
  surface: ReportSurface,
): ReportAccessDecision {
  if (!isReportAvailable(definition, surface)) return 'unavailable';
  return canOpenReport(user, definition) ? 'allowed' : 'forbidden';
}

// ===========================================================================
// Filter and codec
// ===========================================================================

export type ReportPreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'custom';

export const REPORT_PRESETS: readonly ReportPreset[] = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'custom',
];

/** The presets that need the business's week start. */
export const WEEK_PRESETS: readonly ReportPreset[] = ['this_week', 'last_week'];

export type ReportView = 'summary' | 'detail';

/** `payroll.payroll_settings.week_start_day`: 0 = Sunday … 6 = Saturday. */
export type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function isWeekStartDay(value: unknown): value is WeekStartDay {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

export interface ReportFilter {
  preset: ReportPreset;
  /**
   * Inclusive local dates, only with `custom`. Applied AS GIVEN to every
   * selected location; each location converts them to its own UTC interval.
   */
  from?: LocalDate;
  to?: LocalDate;
  /** `[]` means every location this user may report on for this report. */
  locationIds: string[];
  /** Always `[]` while no report supports a staff control. */
  staffProfileIds: string[];
  view: ReportView;
}

export const DEFAULT_REPORT_FILTER: Readonly<ReportFilter> = Object.freeze({
  preset: 'today',
  locationIds: [],
  staffProfileIds: [],
  view: 'summary',
});

/** URL / query parameter names, in canonical order. */
export const REPORT_PARAM_KEYS = ['preset', 'from', 'to', 'locations', 'staff', 'view'] as const;
export type ReportParamKey = (typeof REPORT_PARAM_KEYS)[number];

export const REPORT_MIN_DATE: LocalDate = '2000-01-01';
export const MAX_REPORT_RANGE_DAYS = 366;
export const MAX_REPORT_IDS = 50;

export type ReportFilterIssueCode =
  | 'invalid_preset'
  | 'invalid_view'
  | 'dates_require_custom'
  | 'custom_dates_required'
  | 'invalid_date'
  | 'date_before_min'
  | 'range_inverted'
  | 'range_too_long'
  | 'invalid_id'
  | 'too_many_ids'
  | 'repeated_param'
  | 'control_not_supported';

export interface ReportFilterIssue {
  code: ReportFilterIssueCode;
  param: ReportParamKey;
}

export type ReportParamsLike =
  | { get(name: string): string | null; getAll?(name: string): string[] }
  | Readonly<Record<string, string | undefined>>;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A parameter given more than once is ambiguous: reading only the first would silently drop the rest. */
function repeatedParams(params: ReportParamsLike): ReportFilterIssue[] {
  const getAll = (params as { getAll?: unknown }).getAll;
  if (typeof getAll !== 'function') return [];
  return REPORT_PARAM_KEYS.filter(
    (key) => (params as { getAll(name: string): string[] }).getAll(key).length > 1,
  ).map((param) => ({ code: 'repeated_param' as const, param }));
}

function readParam(params: ReportParamsLike, key: ReportParamKey): string | undefined {
  const raw =
    typeof (params as { get?: unknown }).get === 'function'
      ? (params as { get(name: string): string | null }).get(key)
      : (params as Readonly<Record<string, string | undefined>>)[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isPreset(value: string): value is ReportPreset {
  return (REPORT_PRESETS as readonly string[]).includes(value);
}

/**
 * Problems with a custom range, in the order a person would fix them. Shared by
 * the codec and the control bar so the browser never lets through a range the
 * API would refuse.
 */
export function reportCustomRangeIssues(
  from: string | undefined,
  to: string | undefined,
): ReportFilterIssue[] {
  const issues: ReportFilterIssue[] = [];
  if (from === undefined || to === undefined) {
    if (from === undefined) issues.push({ code: 'custom_dates_required', param: 'from' });
    if (to === undefined) issues.push({ code: 'custom_dates_required', param: 'to' });
  }
  const validFrom = from !== undefined && isLocalDate(from);
  const validTo = to !== undefined && isLocalDate(to);
  if (from !== undefined && !validFrom) issues.push({ code: 'invalid_date', param: 'from' });
  if (to !== undefined && !validTo) issues.push({ code: 'invalid_date', param: 'to' });
  if (validFrom && from < REPORT_MIN_DATE) issues.push({ code: 'date_before_min', param: 'from' });
  if (validTo && to < REPORT_MIN_DATE) issues.push({ code: 'date_before_min', param: 'to' });
  if (validFrom && validTo) {
    if (to < from) {
      issues.push({ code: 'range_inverted', param: 'to' });
    } else if (inclusiveDayCount(from, to) > MAX_REPORT_RANGE_DAYS) {
      issues.push({ code: 'range_too_long', param: 'to' });
    }
  }
  return issues;
}

function decodeIds(
  raw: string | undefined,
  param: 'locations' | 'staff',
): { ids: string[]; issues: ReportFilterIssue[] } {
  if (raw === undefined) return { ids: [], issues: [] };
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id !== ''),
    ),
  ].sort();
  const issues: ReportFilterIssue[] = [];
  if (ids.some((id) => !ID_PATTERN.test(id))) issues.push({ code: 'invalid_id', param });
  if (ids.length > MAX_REPORT_IDS) issues.push({ code: 'too_many_ids', param });
  return { ids, issues };
}

/**
 * Decode URL / query parameters into a filter.
 *
 * - `strict` (API): every problem is an issue, and the API refuses the request.
 * - `lenient` (browser URL): parameters the report ignores are dropped silently
 *   (the URL is then canonicalised), junk presets/views fall back to defaults,
 *   and only problems that must stop a request are returned: a bad custom range,
 *   bad ids or a repeated parameter. Ids are never dropped — a shared link
 *   naming a location the viewer may not see is refused by the server, never
 *   silently widened or narrowed.
 */
export function decodeReportFilter(
  params: ReportParamsLike,
  definition: ReportDefinition,
  mode: 'lenient' | 'strict',
): { filter: ReportFilter; issues: ReportFilterIssue[] } {
  const strict = mode === 'strict';
  const issues: ReportFilterIssue[] = repeatedParams(params);

  const rawPreset = readParam(params, 'preset');
  let preset: ReportPreset = 'today';
  if (rawPreset !== undefined) {
    if (isPreset(rawPreset)) preset = rawPreset;
    else if (strict) issues.push({ code: 'invalid_preset', param: 'preset' });
  }

  const rawFrom = readParam(params, 'from');
  const rawTo = readParam(params, 'to');
  let from: LocalDate | undefined;
  let to: LocalDate | undefined;
  if (preset === 'custom') {
    issues.push(...reportCustomRangeIssues(rawFrom, rawTo));
    from = rawFrom !== undefined && isLocalDate(rawFrom) ? rawFrom : undefined;
    to = rawTo !== undefined && isLocalDate(rawTo) ? rawTo : undefined;
  } else if (strict) {
    if (rawFrom !== undefined) issues.push({ code: 'dates_require_custom', param: 'from' });
    if (rawTo !== undefined) issues.push({ code: 'dates_require_custom', param: 'to' });
  }

  const locations = decodeIds(readParam(params, 'locations'), 'locations');
  issues.push(...locations.issues);

  const rawStaff = readParam(params, 'staff');
  let staffProfileIds: string[] = [];
  if (rawStaff !== undefined) {
    if (definition.controls.staff) {
      const staff = decodeIds(rawStaff, 'staff');
      staffProfileIds = staff.ids;
      issues.push(...staff.issues);
    } else if (strict) {
      issues.push({ code: 'control_not_supported', param: 'staff' });
    }
  }

  const rawView = readParam(params, 'view');
  let view: ReportView = 'summary';
  if (rawView === 'detail') {
    if (definition.controls.detail) view = 'detail';
    else if (strict) issues.push({ code: 'control_not_supported', param: 'view' });
  } else if (rawView !== undefined && rawView !== 'summary' && strict) {
    issues.push({ code: 'invalid_view', param: 'view' });
  }

  const filter: ReportFilter = {
    preset,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    locationIds: locations.ids,
    staffProfileIds,
    view,
  };
  return { filter, issues };
}

/**
 * The one encoder for the browser URL and the API query. Defaults are omitted,
 * id lists are deduped and sorted, and keys come out in {@link REPORT_PARAM_KEYS}
 * order — so two equal filters always encode to the same string.
 */
export function encodeReportFilter(filter: ReportFilter): Record<string, string> {
  const encoded: Record<string, string> = {};
  if (filter.preset !== 'today') encoded.preset = filter.preset;
  if (filter.preset === 'custom') {
    if (filter.from !== undefined) encoded.from = filter.from;
    if (filter.to !== undefined) encoded.to = filter.to;
  }
  const locations = [...new Set(filter.locationIds)].sort();
  if (locations.length > 0) encoded.locations = locations.join(',');
  const staff = [...new Set(filter.staffProfileIds)].sort();
  if (staff.length > 0) encoded.staff = staff.join(',');
  if (filter.view !== 'summary') encoded.view = filter.view;
  return encoded;
}

// ===========================================================================
// Options, resolved filter and result
// ===========================================================================

export interface ReportLocationOption {
  id: string;
  name: string;
  /** IANA timezone as stored on the location. */
  timezone: string;
  isActive: boolean;
  /** False when the stored timezone cannot be converted; the location cannot be reported on until it is fixed. */
  timezoneValid: boolean;
}

/**
 * GET /api/reports/:reportKey/options. Takes no selection query, so it can
 * never refuse a selection — but an actor with no permitted location for the
 * report still gets `report_no_locations_in_scope`.
 */
export interface ReportOptions {
  reportKey: ReportKey;
  /** Every location the user may report on for this report, in the business's location order. */
  locations: ReportLocationOption[];
  /** `null` when the business has no valid week start: the week presets are unavailable. */
  weekStartDay: WeekStartDay | null;
}

/**
 * `complete`: the range ended before this location's today. `in_progress`:
 * today is inside it. `not_started`: it starts after today — render as not
 * started, never as 0.
 */
export type ReportLocalStatus = 'complete' | 'in_progress' | 'not_started';

/** One resolved location. Local dates and IANA names only — no instants. */
export interface ResolvedReportLocation extends ReportLocationOption {
  localToday: LocalDate;
  from: LocalDate;
  to: LocalDate;
  status: ReportLocalStatus;
}

export interface ResolvedReportFilter {
  reportKey: ReportKey;
  /** The normalised request. A preset stays a preset — it is not frozen into dates. */
  filter: ReportFilter;
  /** The week start used, for week presets only; otherwise `null`. */
  weekStartDay: WeekStartDay | null;
  /** One entry per resolved location. There is no shared date: each location has its own. */
  locations: ResolvedReportLocation[];
}

/** Report bodies, added by each report's own ticket (e.g. `money: MoneyReportBody`). */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ReportBodyMap {}

export type ReportBody<K extends ReportKey> = K extends keyof ReportBodyMap ? ReportBodyMap[K] : null;

export interface ReportResult<K extends ReportKey = ReportKey> {
  reportKey: K;
  filter: ResolvedReportFilter;
  /** `null` until the report's own ticket delivers figures. */
  body: ReportBody<K>;
}

export type ReportErrorCode =
  | 'report_not_found'
  | 'report_forbidden'
  | 'report_filter_invalid'
  | 'report_control_not_supported'
  | 'report_location_out_of_scope'
  | 'report_no_locations_in_scope'
  | 'report_timezone_invalid'
  | 'report_week_start_unconfigured';

export const REPORT_ERROR_CODES: readonly ReportErrorCode[] = [
  'report_not_found',
  'report_forbidden',
  'report_filter_invalid',
  'report_control_not_supported',
  'report_location_out_of_scope',
  'report_no_locations_in_scope',
  'report_timezone_invalid',
  'report_week_start_unconfigured',
];

export interface ReportErrorBody {
  statusCode: number;
  code: ReportErrorCode;
  message: string;
  issues?: ReportFilterIssue[];
  /** `report_timezone_invalid` only: the resolved locations whose timezone is invalid. */
  locationIds?: string[];
}

/** Narrow an API error payload to a report error body. */
export function isReportErrorBody(value: unknown): value is ReportErrorBody {
  if (!value || typeof value !== 'object') return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && (REPORT_ERROR_CODES as readonly string[]).includes(code);
}
