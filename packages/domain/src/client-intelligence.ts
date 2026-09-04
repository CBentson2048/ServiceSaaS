/**
 * Client Intelligence — the canonical lapsed-client calculation (V1.1 Week 7).
 *
 * ONE trustworthy answer to: "when would this particular client normally have
 * returned, and are they now meaningfully overdue?" Campaigns, QLOOQO 10
 * reporting and (later) ZAC all consume THIS function — none of them may
 * re-derive a cadence of their own.
 *
 * Deterministic and rule-based, never predictive. Every input is supplied by
 * the caller (including "today"), so the function is pure: no clock reads, no
 * I/O, no natural language. Presentation layers format the structured
 * `evidence` — this layer never writes a sentence.
 *
 * ---------------------------------------------------------------------------
 * THE RULE (documented once, here)
 * ---------------------------------------------------------------------------
 * 1. SERVICE HISTORY. A completed service visit is a visit the client actually
 *    attended (see `crm.client_service_history`, migration 0097, for the exact
 *    SQL predicate). Cancelled, rejected, no-show, future and never-completed
 *    appointments are excluded. Several services on the SAME salon-local date
 *    are ONE visit — a client who had colour and a cut on Tuesday returned once.
 *
 * 2. BASIS. Salon clients mix a recurring service with one-offs (a regular
 *    6-week colour plus a one-off wedding styling), so averaging everything
 *    produces a meaningless cadence. The dominant service — the service present
 *    in the most completed visits — defines the cadence whenever the client has
 *    `minCompletedVisits` visits containing it. Otherwise every completed visit
 *    is used. Failing both, an explicitly salon-configured per-service rebooking
 *    interval (`booking.services.rebooking_nudge_interval_days`, migration 0062,
 *    only when `rebooking_nudge_enabled`) is the authoritative fallback. Failing
 *    that too, the answer is honestly `insufficient_history` — never a made-up
 *    six-week default.
 *
 * 3. USUAL INTERVAL. The MEDIAN of the day gaps between consecutive basis
 *    visits, rounded half-up to whole days. Median (not mean) so one holiday,
 *    illness or salon-closure gap cannot distort an otherwise stable cadence —
 *    that is the whole of the outlier handling, deliberately.
 *
 * 4. EXPECTED RETURN. `anchor + usualIntervalDays`, in salon-local calendar
 *    days, where the anchor is the client's most recent visit ON THE BASIS (so
 *    a one-off styling after their last colour does not push the colour due
 *    date out).
 *
 * 5. STATUS.
 *      today <= expected                        -> active   (due today is ACTIVE)
 *      expected <  today <= expected + buffer   -> at_risk
 *      today >  expected + buffer               -> lapsed
 *    A valid upcoming appointment masks at_risk/lapsed as `booked` — a client
 *    who is already coming back does not need reactivating. `active` clients
 *    keep `active` (with `hasFutureBooking`), so `active` always means "on
 *    cadence". `evidence.statusIgnoringFutureBooking` preserves what the status
 *    would otherwise have been.
 *
 * A buffer of 0 is meaningful (any overdue day is immediately `lapsed`) and is
 * NOT the same as unconfigured — absence of a settings row inherits the default,
 * a stored 0 is an intentional override. See migration 0097.
 */

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Deterministic lapse lifecycle. Lower-case snake to match every other status
 * union in this package (`AppointmentStatus`, `CrmPatchTestStatus`, …); the
 * V1.1 spec names these at-risk / lapsed / recovered.
 *
 * - `active`               — on cadence, not yet due.
 * - `at_risk`              — past their expected return but inside the buffer.
 * - `lapsed`               — past their expected return by more than the buffer.
 * - `booked`               — would be at_risk/lapsed, but has a valid upcoming
 *                            appointment. Never target these with win-back.
 * - `insufficient_history` — no honest cadence can be derived yet.
 */
export type ClientLapseStatus =
  | 'active'
  | 'at_risk'
  | 'lapsed'
  | 'booked'
  | 'insufficient_history';

/** Where `usualIntervalDays` came from. Drives {@link ClientLapseConfidence}. */
export type ClientLapseIntervalBasis =
  /** Median gap between visits containing the client's dominant service. */
  | 'dominant_service_history'
  /** Median gap between all completed visits. */
  | 'all_visit_history'
  /** Salon-configured per-service rebooking interval (0062), enabled only. */
  | 'service_rebooking_interval'
  /** No interval could be derived. */
  | 'none';

/**
 * Deterministic, not probabilistic — a plain statement of how much evidence sits
 * behind the interval, so a consumer can decide whether to act on it.
 *
 * - `high`   — 4+ personal intervals (5+ visits) on the basis.
 * - `medium` — 2–3 personal intervals.
 * - `low`    — a single personal interval, or the service-configured fallback.
 */
export type ClientLapseConfidence = 'high' | 'medium' | 'low';

/** Why no personal cadence could be derived. */
export type ClientLapseInsufficientReason =
  | 'no_completed_visits'
  | 'below_minimum_visits';

/** One service line on a completed visit. Names are historic snapshots. */
export interface ClientVisitService {
  /** Null when the service row was deleted; the snapshot name still stands. */
  serviceId: string | null;
  /** `booking.appointment_services.service_name_snapshot` — never re-resolved. */
  serviceName: string;
  serviceCategoryId: string | null;
}

/** One completed service visit, already collapsed to a single salon-local date. */
export interface ClientCompletedVisit {
  /** Salon-local calendar date, `YYYY-MM-DD`. */
  visitDate: string;
  /** The attendance instant (ISO 8601), for evidence/display. */
  visitAt: string;
  locationId: string | null;
  /** Every distinct service across the appointments on that date. */
  services: ClientVisitService[];
}

/** The client's earliest valid upcoming appointment, if any. */
export interface ClientFutureBooking {
  appointmentId: string;
  scheduledStartAt: string;
  locationId: string | null;
}

/**
 * Resolved detection settings. Only `lapsedBufferDays` and `minCompletedVisits`
 * are salon-configurable (`crm.retention_settings`, migration 0097);
 * `historyVisitLimit` is a fixed platform bound kept here so tests can vary it.
 */
export interface LapseDetectionSettings {
  /** Grace days past the expected return before `lapsed`. 0 is meaningful. */
  lapsedBufferDays: number;
  /** Completed visits needed before a PERSONAL cadence is claimed. */
  minCompletedVisits: number;
  /** Most recent N completed visits considered. Bounds both cost and staleness. */
  historyVisitLimit: number;
}

/** Platform defaults, used when no `crm.retention_settings` row applies. */
export const DEFAULT_LAPSE_DETECTION_SETTINGS: LapseDetectionSettings = {
  lapsedBufferDays: 14,
  minCompletedVisits: 3,
  historyVisitLimit: 10,
};

/** Hard bounds mirrored by the CHECK constraints on `crm.retention_settings`. */
export const LAPSE_SETTINGS_BOUNDS = {
  lapsedBufferDays: { min: 0, max: 365 },
  minCompletedVisits: { min: 2, max: 20 },
} as const;

export interface ClientLapseInput {
  clientId: string;
  businessId: string;
  /** The client's primary location, when they have one. Retention is business-wide. */
  locationId?: string | null;
  /** Completed visits in any order; normalised internally. */
  visits: ClientCompletedVisit[];
  /** Earliest valid upcoming appointment, or null/undefined when none. */
  nextBooking?: ClientFutureBooking | null;
  /**
   * Shortest ENABLED `rebooking_nudge_interval_days` among the services on the
   * client's most recent completed visit (0062's own "soonest-due wins" rule).
   * Null when no service on it opts in — in which case there is no authoritative
   * fallback and insufficient history stays insufficient.
   */
  serviceRebookingIntervalDays?: number | null;
  /** Salon-local "today", `YYYY-MM-DD`. Callers own the clock. */
  today: string;
  /** IANA timezone `today` was resolved in; echoed into evidence. */
  timezone: string;
  settings: LapseDetectionSettings;
}

/** Structured explainability. Presentation layers turn this into sentences. */
export interface ClientLapseEvidence {
  intervalBasis: ClientLapseIntervalBasis;
  /** The consecutive day gaps the median was taken over, ascending by date. */
  intervalDaysSamples: number[];
  /** Visit the expected return is anchored on (basis-scoped). */
  anchorVisitAt: string | null;
  anchorVisitDate: string | null;
  /** Local dates of the visits the cadence came from, ascending. */
  basisVisitDates: string[];
  /** Completed visits considered after same-day collapse and the history window. */
  totalVisitsConsidered: number;
  /** Number of visits containing the dominant service, when one was identified. */
  dominantServiceVisitCount: number;
  /** What the status would be if the upcoming appointment were ignored. */
  statusIgnoringFutureBooking: ClientLapseStatus;
  /** Populated only for `insufficient_history`. */
  insufficientReason?: ClientLapseInsufficientReason;
  /** The salon-local date the evaluation was made on, and its timezone. */
  evaluatedOn: string;
  timezone: string;
}

/** The canonical, reusable answer. */
export interface ClientLapseResult {
  clientId: string;
  businessId: string;
  locationId: string | null;

  status: ClientLapseStatus;

  /** Null when the status is `insufficient_history`. */
  usualIntervalDays: number | null;
  /** Completed visits behind the interval (basis-scoped). */
  historySampleSize: number;

  /** The client's most recent completed visit of ANY service. */
  lastCompletedVisitAt: string | null;
  /**
   * Salon-local DATE of that visit. The stable identity of the client's current
   * rebooking cycle: unlike the expected-return date it depends on nothing an
   * owner can edit, so changing a retention or interval setting cannot re-arm a
   * client who has already been contacted this cycle.
   */
  lastCompletedVisitDate: string | null;
  /** Null when no interval could be derived. */
  expectedNextVisitAt: string | null;

  /** Whole days past `expectedNextVisitAt`; 0 when not yet due. */
  overdueDays: number;

  /** The buffer actually applied, after settings resolution. */
  lapsedBufferDays: number;

  hasFutureBooking: boolean;
  nextBookedAppointmentAt: string | null;

  representativeServiceId: string | null;
  representativeServiceName: string | null;
  serviceCategoryId: string | null;

  confidence: ClientLapseConfidence | null;

  evidence: ClientLapseEvidence;
}

// ---------------------------------------------------------------------------
// Local-date arithmetic (calendar days, DST-safe by construction)
// ---------------------------------------------------------------------------
//
// Local dates are compared and advanced as CALENDAR dates, never as instants,
// so a BST/GMT transition inside an interval can never add or drop a day. The
// caller converts timestamptz -> salon-local date once (in SQL, `at time zone`),
// and everything downstream is pure `YYYY-MM-DD` arithmetic.

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a syntactically and calendrically valid `YYYY-MM-DD`. */
export function isLocalDateString(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function localDateToUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMsToLocalDate(ms: number): string {
  const at = new Date(ms);
  const y = at.getUTCFullYear();
  const mo = String(at.getUTCMonth() + 1).padStart(2, '0');
  const da = String(at.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** `date` advanced by whole calendar days. */
export function addLocalDays(date: string, days: number): string {
  return utcMsToLocalDate(localDateToUtcMs(date) + days * 86_400_000);
}

/** Whole calendar days from `from` to `to`; negative when `to` precedes `from`. */
export function localDaysBetween(from: string, to: string): number {
  return Math.round((localDateToUtcMs(to) - localDateToUtcMs(from)) / 86_400_000);
}

/**
 * Median of a non-empty sample, rounded half-up to whole days. Even-length
 * samples average the two middle values — [42, 42, 43, 120] -> 42.5 -> 43, so
 * a single 120-day outlier moves a 42-day cadence by one day, not by twenty.
 */
export function medianDays(values: readonly number[]): number {
  if (values.length === 0) throw new Error('medianDays requires at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const raw = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw);
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

interface NormalisedVisit extends ClientCompletedVisit {
  serviceIds: string[];
}

/**
 * Collapse to one visit per salon-local date, drop anything after `today`,
 * order ascending and keep only the most recent `historyVisitLimit`.
 *
 * Same-date collapse is what makes gaps meaningful: without it a client who had
 * colour and a treatment booked as two appointments on one day would contribute
 * a 0-day interval and drag their median toward zero.
 */
function normaliseVisits(
  visits: readonly ClientCompletedVisit[],
  today: string,
  historyVisitLimit: number,
): NormalisedVisit[] {
  const byDate = new Map<string, NormalisedVisit>();

  for (const visit of visits) {
    if (!isLocalDateString(visit.visitDate)) continue;
    if (visit.visitDate > today) continue; // never let a future row form cadence

    const existing = byDate.get(visit.visitDate);
    if (!existing) {
      byDate.set(visit.visitDate, {
        visitDate: visit.visitDate,
        visitAt: visit.visitAt,
        locationId: visit.locationId,
        services: [...visit.services],
        serviceIds: [],
      });
      continue;
    }
    existing.services.push(...visit.services);
    // Keep the latest instant on the date as the visit's representative moment.
    if (visit.visitAt > existing.visitAt) {
      existing.visitAt = visit.visitAt;
      existing.locationId = visit.locationId;
    }
  }

  const ordered = [...byDate.values()].sort((a, b) => (a.visitDate < b.visitDate ? -1 : 1));
  const windowed = historyVisitLimit > 0 ? ordered.slice(-historyVisitLimit) : ordered;

  for (const visit of windowed) {
    const seen = new Set<string>();
    const services: ClientVisitService[] = [];
    for (const service of visit.services) {
      const key = service.serviceId ?? `name:${service.serviceName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      services.push(service);
    }
    visit.services = services;
    visit.serviceIds = services
      .map((service) => service.serviceId)
      .filter((id): id is string => Boolean(id));
  }

  return windowed;
}

interface DominantService {
  serviceId: string;
  visits: NormalisedVisit[];
}

/**
 * The service present in the most completed visits. Ties break on the most
 * recent visit containing the service, then on the id itself — so the answer is
 * stable for identical history regardless of row order. A service seen only
 * once is never dominant: one visit is an event, not a cadence.
 */
function findDominantService(visits: readonly NormalisedVisit[]): DominantService | null {
  const byService = new Map<string, NormalisedVisit[]>();
  for (const visit of visits) {
    for (const serviceId of visit.serviceIds) {
      const bucket = byService.get(serviceId);
      if (bucket) bucket.push(visit);
      else byService.set(serviceId, [visit]);
    }
  }

  let best: DominantService | null = null;
  for (const [serviceId, serviceVisits] of byService) {
    if (serviceVisits.length < 2) continue;
    if (!best) {
      best = { serviceId, visits: serviceVisits };
      continue;
    }
    if (serviceVisits.length !== best.visits.length) {
      if (serviceVisits.length > best.visits.length) best = { serviceId, visits: serviceVisits };
      continue;
    }
    const candidateLatest = serviceVisits[serviceVisits.length - 1].visitDate;
    const bestLatest = best.visits[best.visits.length - 1].visitDate;
    if (candidateLatest !== bestLatest) {
      if (candidateLatest > bestLatest) best = { serviceId, visits: serviceVisits };
      continue;
    }
    if (serviceId < best.serviceId) best = { serviceId, visits: serviceVisits };
  }
  return best;
}

/** Day gaps between consecutive visits, ascending by date. */
function intervalsBetween(visits: readonly NormalisedVisit[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < visits.length; i += 1) {
    gaps.push(localDaysBetween(visits[i - 1].visitDate, visits[i].visitDate));
  }
  return gaps;
}

function confidenceFor(basis: ClientLapseIntervalBasis, intervalCount: number): ClientLapseConfidence {
  if (basis === 'service_rebooking_interval') return 'low';
  if (intervalCount >= 4) return 'high';
  if (intervalCount >= 2) return 'medium';
  return 'low';
}

function serviceDetail(
  visits: readonly NormalisedVisit[],
  serviceId: string,
): ClientVisitService | null {
  for (let i = visits.length - 1; i >= 0; i -= 1) {
    const match = visits[i].services.find((service) => service.serviceId === serviceId);
    if (match) return match;
  }
  return null;
}

/**
 * Evaluate one client's lapse status. Pure — the same inputs always produce the
 * same result, which is what makes the answer safe to cache, to explain, and to
 * recompute on every read instead of storing a boolean that can go stale.
 */
export function evaluateClientLapse(input: ClientLapseInput): ClientLapseResult {
  const { settings } = input;
  const buffer = Math.max(0, Math.trunc(settings.lapsedBufferDays));
  const minVisits = Math.max(2, Math.trunc(settings.minCompletedVisits));

  const visits = normaliseVisits(input.visits, input.today, settings.historyVisitLimit);
  const lastVisit = visits.length > 0 ? visits[visits.length - 1] : null;

  const futureBooking = input.nextBooking ?? null;
  const hasFutureBooking = Boolean(futureBooking);

  const dominant = findDominantService(visits);

  // Basis selection, most personal first.
  let basis: ClientLapseIntervalBasis = 'none';
  let basisVisits: NormalisedVisit[] = [];
  let usualIntervalDays: number | null = null;
  let intervalSamples: number[] = [];

  if (dominant && dominant.visits.length >= minVisits) {
    basis = 'dominant_service_history';
    basisVisits = dominant.visits;
  } else if (visits.length >= minVisits) {
    basis = 'all_visit_history';
    basisVisits = visits;
  }

  if (basis !== 'none') {
    intervalSamples = intervalsBetween(basisVisits);
    usualIntervalDays = medianDays(intervalSamples);
  } else if (
    lastVisit &&
    typeof input.serviceRebookingIntervalDays === 'number' &&
    Number.isFinite(input.serviceRebookingIntervalDays) &&
    input.serviceRebookingIntervalDays > 0
  ) {
    // The salon explicitly configured this service's return interval (0062).
    // That is an authoritative product decision, so it beats "we don't know" —
    // but it is never invented, only used when a service opted in.
    basis = 'service_rebooking_interval';
    basisVisits = [lastVisit];
    usualIntervalDays = Math.trunc(input.serviceRebookingIntervalDays);
  }

  const anchor = basisVisits.length > 0 ? basisVisits[basisVisits.length - 1] : null;
  const expectedNextVisitDate =
    anchor && usualIntervalDays !== null ? addLocalDays(anchor.visitDate, usualIntervalDays) : null;

  const overdueDays = expectedNextVisitDate
    ? Math.max(0, localDaysBetween(expectedNextVisitDate, input.today))
    : 0;

  let statusIgnoringFutureBooking: ClientLapseStatus;
  if (expectedNextVisitDate === null) {
    statusIgnoringFutureBooking = 'insufficient_history';
  } else if (overdueDays === 0) {
    // Due exactly today is still ACTIVE — the client has the whole day to come
    // in. At-risk requires today to be strictly past the expected return.
    statusIgnoringFutureBooking = 'active';
  } else if (overdueDays <= buffer) {
    statusIgnoringFutureBooking = 'at_risk';
  } else {
    statusIgnoringFutureBooking = 'lapsed';
  }

  const status: ClientLapseStatus =
    hasFutureBooking &&
    (statusIgnoringFutureBooking === 'at_risk' || statusIgnoringFutureBooking === 'lapsed')
      ? 'booked'
      : statusIgnoringFutureBooking;

  const representative =
    basis === 'dominant_service_history' && dominant
      ? serviceDetail(basisVisits, dominant.serviceId)
      : dominant
        ? serviceDetail(visits, dominant.serviceId)
        : (lastVisit?.services[0] ?? null);

  const insufficientReason: ClientLapseInsufficientReason | undefined =
    statusIgnoringFutureBooking === 'insufficient_history'
      ? visits.length === 0
        ? 'no_completed_visits'
        : 'below_minimum_visits'
      : undefined;

  return {
    clientId: input.clientId,
    businessId: input.businessId,
    locationId: input.locationId ?? null,

    status,

    usualIntervalDays,
    historySampleSize: basisVisits.length,

    lastCompletedVisitAt: lastVisit?.visitAt ?? null,
    lastCompletedVisitDate: lastVisit?.visitDate ?? null,
    expectedNextVisitAt: expectedNextVisitDate,

    overdueDays,
    lapsedBufferDays: buffer,

    hasFutureBooking,
    nextBookedAppointmentAt: futureBooking?.scheduledStartAt ?? null,

    representativeServiceId: representative?.serviceId ?? null,
    representativeServiceName: representative?.serviceName ?? null,
    serviceCategoryId: representative?.serviceCategoryId ?? null,

    confidence: usualIntervalDays === null ? null : confidenceFor(basis, intervalSamples.length),

    evidence: {
      intervalBasis: basis,
      intervalDaysSamples: intervalSamples,
      anchorVisitAt: anchor?.visitAt ?? null,
      anchorVisitDate: anchor?.visitDate ?? null,
      basisVisitDates: basisVisits.map((visit) => visit.visitDate),
      totalVisitsConsidered: visits.length,
      dominantServiceVisitCount: dominant?.visits.length ?? 0,
      statusIgnoringFutureBooking,
      ...(insufficientReason ? { insufficientReason } : {}),
      evaluatedOn: input.today,
      timezone: input.timezone,
    },
  };
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/** A `crm.retention_settings` row, already mapped out of SQL. */
export interface RetentionSettingsRecord {
  businessId: string;
  /** Null for the business-wide default row. */
  locationId: string | null;
  lapsedBufferDays: number;
  minCompletedVisits: number;
}

/**
 * Precedence: location override -> business default -> platform default.
 *
 * ABSENCE inherits; PRESENCE wins at any value. A stored `lapsedBufferDays` of 0
 * is an intentional "no grace period", structurally distinct from no row at all
 * — the same null-vs-zero rule the retail pricing resolver uses.
 */
export function resolveLapseDetectionSettings(
  rows: readonly RetentionSettingsRecord[],
  locationId?: string | null,
): LapseDetectionSettings {
  const locationRow = locationId
    ? rows.find((row) => row.locationId === locationId)
    : undefined;
  const businessRow = rows.find((row) => row.locationId === null);
  const effective = locationRow ?? businessRow;
  if (!effective) return { ...DEFAULT_LAPSE_DETECTION_SETTINGS };
  return {
    lapsedBufferDays: effective.lapsedBufferDays,
    minCompletedVisits: effective.minCompletedVisits,
    historyVisitLimit: DEFAULT_LAPSE_DETECTION_SETTINGS.historyVisitLimit,
  };
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/**
 * One row of the lapsed-client list. Carries exactly what a retention campaign
 * or the QLOOQO 10 Clients/Retention report needs to select and explain an
 * audience WITHOUT recomputing cadence: pick `status = 'lapsed'` (which already
 * excludes anyone with an upcoming appointment) and go.
 *
 * Messaging consent is deliberately absent-by-policy from the DECISION here —
 * `marketingOptIn` is carried for the campaign layer to apply its own consent
 * and contactability rules. Cadence detection never encodes marketing policy.
 */
export interface ClientLapseSummary extends ClientLapseResult {
  clientCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email?: string;
  phone?: string;
  marketingOptIn: boolean;
}

export interface ClientLapseListPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ClientLapseCounts {
  active: number;
  atRisk: number;
  lapsed: number;
  booked: number;
  insufficientHistory: number;
}

export interface ListClientLapseResponse {
  clients: ClientLapseSummary[];
  /** Counts across the whole evaluated scope, not just the returned page. */
  counts: ClientLapseCounts;
  /** The settings actually applied, so a caller can explain the numbers. */
  settings: LapseDetectionSettings;
  /** True when the evaluated scope hit the platform cap; counts are partial. */
  truncated: boolean;
  /** Clients evaluated (i.e. with at least one completed visit in the window). */
  evaluatedClientCount: number;
  pagination: ClientLapseListPagination;
}

export interface ClientLapseDetailResponse {
  intelligence: ClientLapseSummary;
  settings: LapseDetectionSettings;
}

export interface RetentionSettingsScope {
  /** Null for the business-wide default. */
  locationId: string | null;
  lapsedBufferDays: number;
  minCompletedVisits: number;
  /** False when no row exists and the platform defaults are in force. */
  configured: boolean;
}

export interface RetentionSettingsResponse {
  /** Business-wide default plus every location override, business row first. */
  scopes: RetentionSettingsScope[];
  defaults: LapseDetectionSettings;
}
