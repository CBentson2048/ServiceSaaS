/**
 * R2 Team report body (QLOOQO V1.1 Week 8).
 *
 * Built on a Ticket A ReportScope. Money is read through R1 Money's own loader
 * (the same paid-bill universe and currency rule); everything else through
 * TeamSource. Every fact is attributed to its own location and read inside that
 * location's own window. Location and team totals always cover every fact; the
 * staff filter only narrows the staff rows and adds a Selected staff subtotal.
 * docs/V1.1/week-8-r2-team.md.
 */
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  TEAM_UNAVAILABLE_METRICS,
  isReportOwner,
  type TeamAmount,
  type TeamCommissionStaff,
  type TeamCount,
  type TeamMetrics,
  type TeamRatio,
  type TeamReportBody,
  type TeamStaffIdentity,
  type TeamStaffOption,
  type TeamStaffRow,
  type TeamTotals,
  type TeamUnavailableReason,
} from '@sheer/domain';
import { reportHttpError } from '../report-errors';
import type { ReportScope } from '../report-scope.service';
import { MONEY_SOURCE, type MoneyAfter, type MoneySource, type MoneyWindow } from '../money/money-source';
import {
  MONEY_ID_CHUNK,
  MONEY_LOCATION_CHUNK,
  MONEY_READ_BATCH,
  assertScoped,
  loadLocationCurrencies,
  loadMoneyFacts,
  locationCurrencySets,
  readAll,
  singleCurrency,
  splitByLocation,
} from '../money/money-report.service';
import { EMPTY_FACTS, type MoneyFacts } from '../money/money-totals';
import { instantKey, localDateTime } from '../money/money-values';
import { commissionPeriods, commissionStaff, visiblePayPeriods } from './team-commission';
import { futureBookingCounts, futureBookingStaffKeys, indexFutureBooking, type FutureBookingCounts } from './team-future-booking';
import {
  attributeMoney,
  combineMoney,
  moneyStaffKeys,
  staffMoneyIndex,
  staffMoneySums,
  type StaffKey,
  type StaffMoneySums,
  type TeamMoneyFacts,
} from './team-money';
import {
  TEAM_SOURCE,
  type FutureAppointmentRow,
  type LocalDateRange,
  type StaffProfileRow,
  type TeamSource,
} from './team-source';
import { assembleUtilisation, sumUtilisation, type UtilisationSums } from './team-utilisation';

/** How money figures may be written for a set of locations. */
type MoneyState = { kind: 'not_started' } | { kind: 'blocked'; reason: TeamUnavailableReason } | { kind: 'ok' };

const NOT_STARTED = { availability: 'not_started' } as const;

@Injectable()
export class TeamReportService {
  constructor(
    @Inject(MONEY_SOURCE) private readonly money: MoneySource,
    @Inject(TEAM_SOURCE) private readonly source: TeamSource,
  ) {}

  async build(scope: ReportScope): Promise<TeamReportBody> {
    const businessId = scope.actor.businessId;
    const generatedKey = instantKey(scope.asOf.toISOString());
    const started: MoneyWindow[] = scope.windows
      .filter((window) => window.status !== 'not_started')
      .map((window) => ({ locationId: window.locationId, fromUtc: window.fromUtc, toUtcExclusive: window.toUtcExclusive }));
    const startedIds = new Set(started.map((window) => window.locationId));
    const resolvedIds = scope.windows.map((window) => window.locationId);
    const startedRanges = distinctRanges(scope.windows.filter((window) => startedIds.has(window.locationId)));

    // 1. Everything that depends only on the scope.
    const [facts, configured, visits, shifts, absences, appointments, bookOutTypes, memberships, payPeriods] = await Promise.all([
      started.length > 0 ? loadMoneyFacts(this.money, businessId, started) : Promise.resolve(null),
      loadLocationCurrencies(this.money, businessId, started),
      this.byLocationChunks(started, (chunk, after, limit) => this.source.eligibleVisits(businessId, chunk, after, limit)),
      this.byLocationChunksById(started, (chunk, afterId, limit) => this.source.shifts(businessId, chunk, afterId, limit)),
      this.byLocationChunksById(started, (chunk, afterId, limit) => this.source.absences(businessId, chunk, afterId, limit)),
      this.byLocationChunksById(started, (chunk, afterId, limit) => this.source.bookedAppointments(businessId, chunk, afterId, limit)),
      started.length > 0 ? this.source.bookOutTypes(businessId) : Promise.resolve([]),
      readByIdChunks(resolvedIds, (chunk, afterId, limit) => this.source.activeMemberships(businessId, chunk, afterId, limit)),
      readByIdKeyset((afterId, limit) =>
        this.source.finalisedPayPeriods(businessId, distinctRanges(scope.windows), afterId, limit),
      ),
    ]);
    const commissionVisibility = visiblePayPeriods(
      scope.actor,
      payPeriods,
      scope.windows.map((window) => ({ locationId: window.locationId, from: window.from, to: window.to })),
    );

    // 2. What depends on those facts.
    const [breaks, future, leave, memberProfiles, summaries] = await Promise.all([
      readByIdChunks(shifts.map((shift) => shift.id), (chunk, afterId, limit) => this.source.shiftBreaks(businessId, chunk, afterId, limit)),
      readByIdChunks(
        visits.map((visit) => visit.clientProfileId),
        (chunk, afterId, limit): Promise<FutureAppointmentRow[]> => this.source.futureAppointments(businessId, chunk, generatedKey, afterId, limit),
      ),
      // Leave only at the viewer's permitted locations: never a fact from outside the grant.
      readByIdChunks(shifts.map((shift) => shift.staffProfileId), (chunk, afterId, limit) =>
        this.source.approvedLeave(businessId, scope.permittedLocationIds, chunk, startedRanges, afterId, limit),
      ),
      readChunks(memberships.map((membership) => membership.userProfileId), (chunk) => this.source.staffProfilesOfUsers(businessId, chunk)),
      readByIdChunks(commissionVisibility.periods.map((period) => period.id), (chunk, afterId, limit) =>
        this.source.paySummaries(businessId, chunk, afterId, limit),
      ),
    ]);

    // 3. Money by location, on R1's universe and currency rule.
    const factsByLocation = new Map<string, MoneyFacts>();
    if (facts !== null) {
      assertScoped(facts, started);
      for (const window of started) factsByLocation.set(window.locationId, splitByLocation(facts, window.locationId));
    }
    assertFactsScoped(started, visits, shifts, absences, appointments);
    const currenciesByLocation = locationCurrencySets(factsByLocation, started, configured);
    const moneyByLocation = new Map<string, TeamMoneyFacts>();
    for (const window of started) moneyByLocation.set(window.locationId, attributeMoney(factsByLocation.get(window.locationId) ?? EMPTY_FACTS));

    const futureIndex = indexFutureBooking(visits, future);
    const utilisation = assembleUtilisation(
      scope.windows.filter((window) => startedIds.has(window.locationId)),
      { shifts, breaks, absences, bookOutTypes, leave, appointments },
      // Owner by role alone: never "does the grant cover every location", which would reveal whether others exist.
      { seesEveryLocation: isReportOwner(scope.actor) },
    );

    // 4. The staff universe: current active staff at resolved locations, plus staff and
    //    Unattributed with facts, plus former staff whose profile no longer exists.
    const userToStaff = new Map(memberProfiles.map((profile) => [profile.userProfileId, profile]));
    const activeHere = new Map<string, Set<string>>();
    for (const membership of memberships) {
      const profile = userToStaff.get(membership.userProfileId);
      if (!profile) continue; // A manager-only member is not staff.
      const locations = activeHere.get(profile.id) ?? new Set<string>();
      locations.add(membership.locationId);
      activeHere.set(profile.id, locations);
    }
    const commissionStaffLocations = commissionStaff(commissionVisibility.periods, summaries);
    const keysByLocation = new Map<string, Set<StaffKey>>();
    // Staff with a recorded fact at the location; the rest of its keys are current members with none.
    const activeKeysByLocation = new Map<string, Set<StaffKey>>();
    for (const locationId of resolvedIds) {
      const withFacts = new Set<StaffKey>();
      const money = moneyByLocation.get(locationId);
      if (money) for (const key of moneyStaffKeys(money)) withFacts.add(key);
      for (const key of futureBookingStaffKeys(futureIndex, locationId)) withFacts.add(key);
      for (const staffId of utilisation.byLocationStaff.get(locationId)?.keys() ?? []) withFacts.add(staffId);
      for (const [staffId, locations] of commissionStaffLocations) if (locations.has(locationId)) withFacts.add(staffId);
      const keys = new Set<StaffKey>(withFacts);
      for (const [staffId, locations] of activeHere) if (locations.has(locationId)) keys.add(staffId);
      activeKeysByLocation.set(locationId, withFacts);
      keysByLocation.set(locationId, keys);
    }
    const referenced = new Set<string>(commissionStaffLocations.keys());
    for (const keys of keysByLocation.values()) for (const key of keys) if (key !== null) referenced.add(key);
    const profiles = new Map(memberProfiles.map((profile) => [profile.id, profile]));
    const missing = [...referenced].filter((id) => !profiles.has(id));
    for (const profile of await readChunks(missing, (chunk) => this.source.staffProfiles(businessId, chunk))) profiles.set(profile.id, profile);

    // 5. The picker, and the staff filter checked against it (fail closed, no probing).
    const staffOptions = buildStaffOptions(resolvedIds, keysByLocation, commissionStaffLocations, profiles);
    const optionIds = new Set(staffOptions.map((option) => option.staffProfileId));
    const requested = scope.resolved.filter.staffProfileIds;
    if (requested.some((id) => !optionIds.has(id))) throw reportHttpError('report_staff_out_of_scope');
    const selected = requested.length > 0 ? new Set<StaffKey>(requested) : null;

    // 6. Figures.
    const stateOf = (locationIds: readonly string[]): MoneyState => {
      const live = locationIds.filter((id) => startedIds.has(id));
      if (live.length === 0) return { kind: 'not_started' };
      const currencies = new Set(live.flatMap((id) => [...(currenciesByLocation.get(id) ?? [])]));
      if (currencies.size > 1) return { kind: 'blocked', reason: 'mixed_currencies' };
      if (currencies.size === 0) return { kind: 'blocked', reason: 'currency_not_recorded' };
      return { kind: 'ok' };
    };
    const currencyOf = (locationIds: readonly string[]): string | null => {
      const live = locationIds.filter((id) => startedIds.has(id));
      return live.length === 0 ? null : singleCurrency(new Set(live.flatMap((id) => [...(currenciesByLocation.get(id) ?? [])])));
    };
    const utilisationOf = (locationIds: readonly string[], keys: ReadonlySet<StaffKey> | null): UtilisationSums =>
      sumUtilisation(
        locationIds.flatMap((locationId) =>
          [...(utilisation.byLocationStaff.get(locationId) ?? [])].filter(([staffId]) => keys === null || keys.has(staffId)).map(([, sums]) => sums),
        ),
      );

    // One pass per location for every staff member's own sums, so a staff row never re-walks the bills.
    const staffSumsByLocation = new Map([...moneyByLocation].map(([locationId, money]) => [locationId, staffMoneyIndex(money)]));
    const metricsFor = (locationIds: readonly string[], keys: ReadonlySet<StaffKey>): TeamMetrics => {
      const state = stateOf(locationIds);
      let sums: StaffMoneySums;
      if (locationIds.length === 1 && keys.size === 1) {
        sums = staffSumsByLocation.get(locationIds[0])?.get([...keys][0]) ?? staffMoneySums(combineMoney([]), keys);
      } else {
        sums = staffMoneySums(combineMoney(locationIds.flatMap((id) => (moneyByLocation.has(id) ? [moneyByLocation.get(id)!] : []))), keys);
      }
      return teamMetrics(state, sums, utilisationOf(locationIds, keys), futureBookingCounts(futureIndex, locationIds, keys));
    };

    const totalsFor = (locationIds: readonly string[]): TeamTotals => {
      const state = stateOf(locationIds);
      const money = combineMoney(locationIds.flatMap((id) => (moneyByLocation.has(id) ? [moneyByLocation.get(id)!] : [])));
      const t = money.totals;
      const sums: StaffMoneySums = {
        serviceGross: t.serviceGross,
        serviceNet: t.serviceNet,
        colourGross: t.colourGross,
        colourNet: t.colourNet,
        averageBillTotal: t.allLinesGross,
        averageBillBills: t.itemisedBills,
        retail: t.retail,
      };
      return {
        ...teamMetrics(state, sums, utilisationOf(locationIds, null), futureBookingCounts(futureIndex, locationIds, null)),
        retailShareOfServiceRevenue:
          state.kind !== 'ok'
            ? unavailableOrNotStarted(state)
            : t.serviceGross > 0
              ? ratio(t.retail, t.serviceGross)
              : { availability: 'unavailable', reason: 'no_service_revenue' },
        otherBillLines: moneyAmount(state, t.otherLinesGross),
        notItemised: moneyAmount(state, t.notItemised),
      };
    };

    const staffRows: TeamStaffRow[] = [];
    for (const window of scope.windows) {
      const keys = [...(keysByLocation.get(window.locationId) ?? [])]
        .map((key) => ({ key, identity: identityOf(key, window.locationId, profiles, activeHere) }))
        .sort((a, b) => compareIdentity(a.identity, b.identity));
      for (const { key, identity } of keys) {
        if (selected !== null && (key === null || !selected.has(key))) continue;
        staffRows.push({
          rowKey: `${window.locationId}:${key ?? 'unattributed'}`,
          locationId: window.locationId,
          staff: identity,
          currencyCode: currencyOf([window.locationId]),
          hasRecordedActivity: activeKeysByLocation.get(window.locationId)?.has(key) ?? false,
          metrics: metricsFor([window.locationId], new Set([key])),
        });
      }
    }

    const commissionIdentity = (staffProfileId: string): TeamCommissionStaff => {
      const profile = profiles.get(staffProfileId);
      return profile ? { kind: 'staff', staffProfileId, name: profile.name } : { kind: 'former', staffProfileId };
    };

    return {
      generatedAt: scope.asOf.toISOString(),
      currencyCode: currencyOf(resolvedIds),
      summary: totalsFor(resolvedIds),
      selectedStaff: selected === null ? null : metricsFor(resolvedIds, selected),
      locations: scope.windows.map((window) => ({
        locationId: window.locationId,
        currencyCode: currencyOf([window.locationId]),
        totals: totalsFor([window.locationId]),
        selectedStaff: selected === null ? null : metricsFor([window.locationId], selected),
        futureBookingAsAt: localDateTime(window.timezone, generatedKey),
      })),
      staffRows,
      staffOptions,
      finalisedCommission: {
        periods: commissionPeriods(commissionVisibility.periods, summaries, commissionIdentity, selected as ReadonlySet<string> | null),
        restrictions: commissionVisibility.restrictions,
      },
      unavailableMetrics: TEAM_UNAVAILABLE_METRICS.map((metric) => ({ ...metric })),
      dataQuality: {
        rolledUpServiceLines: combineMoney([...moneyByLocation.values()]).rolledUpServiceLines,
        ...utilisation.dataQuality,
      },
    };
  }

  /** Every row of a (location chunk, instant keyset) read. */
  private async byLocationChunks<T extends { at: string; id: string }>(
    windows: readonly MoneyWindow[],
    read: (chunk: readonly MoneyWindow[], after: MoneyAfter | null, limit: number) => Promise<T[]>,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (const chunk of chunks(windows, MONEY_LOCATION_CHUNK)) rows.push(...(await readAll((after, limit) => read(chunk, after, limit))));
    return rows;
  }

  /** Every row of a (location chunk, id keyset) read. */
  private async byLocationChunksById<T extends { id: string }>(
    windows: readonly MoneyWindow[],
    read: (chunk: readonly MoneyWindow[], afterId: string | null, limit: number) => Promise<T[]>,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (const chunk of chunks(windows, MONEY_LOCATION_CHUNK)) rows.push(...(await readByIdKeyset((afterId, limit) => read(chunk, afterId, limit))));
    return rows;
  }
}

function teamMetrics(state: MoneyState, sums: StaffMoneySums, utilisation: UtilisationSums, future: FutureBookingCounts): TeamMetrics {
  const money = (cents: number) => moneyAmount(state, cents);
  const count = (value: number): TeamCount => (state.kind === 'not_started' ? NOT_STARTED : { availability: 'available', count: value });
  const average: TeamAmount =
    state.kind !== 'ok'
      ? unavailableOrNotStarted(state)
      : sums.averageBillBills === 0
        ? { availability: 'unavailable', reason: 'no_bills' }
        : { availability: 'available', cents: roundHalfAwayFromZero(sums.averageBillTotal / sums.averageBillBills) };

  let utilisationMetrics: TeamMetrics['utilisation'];
  if (state.kind === 'not_started') {
    utilisationMetrics = { availableMinutes: NOT_STARTED, bookedMinutes: NOT_STARTED, utilisation: NOT_STARTED };
  } else if (utilisation.ambiguous) {
    const ambiguous = { availability: 'unavailable', reason: 'availability_scope_ambiguous' } as const;
    utilisationMetrics = { availableMinutes: ambiguous, bookedMinutes: ambiguous, utilisation: ambiguous };
  } else {
    const availableMinutes = Math.round(utilisation.availableMs / 60_000);
    const bookedMinutes = Math.round(utilisation.bookedMs / 60_000);
    utilisationMetrics = {
      availableMinutes: { availability: 'available', count: availableMinutes },
      bookedMinutes: { availability: 'available', count: bookedMinutes },
      // Gate on the stated minutes too, so a ratio never reads "of 0 min".
      utilisation:
        utilisation.availableMs > 0 && availableMinutes > 0
          ? {
              availability: 'available',
              numerator: bookedMinutes,
              denominator: availableMinutes,
              basisPoints: Math.round((utilisation.bookedMs * 10_000) / utilisation.availableMs),
            }
          : { availability: 'unavailable', reason: 'no_rostered_time' },
    };
  }

  const clientsRatio = (numerator: number): TeamRatio =>
    state.kind === 'not_started'
      ? NOT_STARTED
      : future.clientsSeen === 0
        ? { availability: 'unavailable', reason: 'no_clients_seen' }
        : ratio(numerator, future.clientsSeen);

  return {
    serviceRevenue: { gross: money(sums.serviceGross), netOfVat: money(sums.serviceNet) },
    colour: { gross: money(sums.colourGross), netOfVat: money(sums.colourNet) },
    averageBill: { total: money(sums.averageBillTotal), bills: count(sums.averageBillBills), average },
    utilisation: utilisationMetrics,
    futureBooking: {
      clientsSeen: count(future.clientsSeen),
      withFutureBooking: clientsRatio(future.withFutureBooking),
      withConfirmedFutureBooking: clientsRatio(future.withConfirmedFutureBooking),
    },
    retailRevenue: money(sums.retail),
  };
}

function moneyAmount(state: MoneyState, cents: number): TeamAmount {
  return state.kind === 'ok' ? { availability: 'available', cents } : unavailableOrNotStarted(state);
}

function unavailableOrNotStarted(state: Exclude<MoneyState, { kind: 'ok' }>): { availability: 'not_started' } | { availability: 'unavailable'; reason: TeamUnavailableReason } {
  return state.kind === 'not_started' ? NOT_STARTED : { availability: 'unavailable', reason: state.reason };
}

function ratio(numerator: number, denominator: number): TeamRatio {
  return { availability: 'available', numerator, denominator, basisPoints: roundHalfAwayFromZero((numerator * 10_000) / denominator) };
}

/** Halves round away from zero, so a refund-led −250.5 is −251 just as 250.5 is 251 (Math.round gives −250). */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) || 0 : Math.round(value);
}

function identityOf(
  key: StaffKey,
  locationId: string,
  profiles: ReadonlyMap<string, StaffProfileRow>,
  activeHere: ReadonlyMap<string, ReadonlySet<string>>,
): TeamStaffIdentity {
  if (key === null) return { kind: 'unattributed' };
  const profile = profiles.get(key);
  if (!profile) return { kind: 'former', staffProfileId: key };
  return {
    kind: 'staff',
    staffProfileId: key,
    name: profile.name,
    currentEmploymentStatus: profile.employmentStatus,
    currentlyActiveHere: activeHere.get(key)?.has(locationId) ?? false,
  };
}

const IDENTITY_RANK: Record<TeamStaffIdentity['kind'], number> = { staff: 0, former: 1, unattributed: 2 };

function compareIdentity(a: TeamStaffIdentity, b: TeamStaffIdentity): number {
  if (a.kind !== b.kind) return IDENTITY_RANK[a.kind] - IDENTITY_RANK[b.kind];
  if (a.kind === 'staff' && b.kind === 'staff') {
    const byName = a.name.localeCompare(b.name, 'en');
    if (byName !== 0) return byName;
  }
  const idA = a.kind === 'unattributed' ? '' : a.staffProfileId;
  const idB = b.kind === 'unattributed' ? '' : b.staffProfileId;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function buildStaffOptions(
  resolvedIds: readonly string[],
  keysByLocation: ReadonlyMap<string, ReadonlySet<StaffKey>>,
  commissionStaffLocations: ReadonlyMap<string, ReadonlySet<string>>,
  profiles: ReadonlyMap<string, StaffProfileRow>,
): TeamStaffOption[] {
  const locationsOf = new Map<string, string[]>();
  for (const locationId of resolvedIds) {
    for (const key of keysByLocation.get(locationId) ?? []) {
      if (key === null) continue;
      const list = locationsOf.get(key) ?? [];
      if (!list.includes(locationId)) list.push(locationId);
      locationsOf.set(key, list);
    }
  }
  // Staff seen only on a business-wide statement the viewer may see: selectable, with no row.
  for (const staffId of commissionStaffLocations.keys()) if (!locationsOf.has(staffId)) locationsOf.set(staffId, []);
  const options: TeamStaffOption[] = [...locationsOf].map(([staffProfileId, locationIds]) => {
    const profile = profiles.get(staffProfileId);
    return profile
      ? { staffProfileId, kind: 'staff', name: profile.name, locationIds }
      : { staffProfileId, kind: 'former', name: null, locationIds };
  });
  return options.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'staff' ? -1 : 1;
    const byName = (a.name ?? '').localeCompare(b.name ?? '', 'en');
    return byName !== 0 ? byName : a.staffProfileId < b.staffProfileId ? -1 : 1;
  });
}

/** The windows' distinct local date ranges: locations usually share one, so filters stay short. */
function distinctRanges(windows: ReadonlyArray<{ from: string; to: string }>): LocalDateRange[] {
  const seen = new Map<string, LocalDateRange>();
  for (const window of windows) seen.set(`${window.from}|${window.to}`, { from: window.from, to: window.to });
  return [...seen.values()];
}

/** Every non-money fact must belong to a started, scoped location — the provider invariant. */
function assertFactsScoped(windows: readonly MoneyWindow[], ...groups: ReadonlyArray<ReadonlyArray<{ locationId: string }>>): void {
  const scoped = new Set(windows.map((window) => window.locationId));
  for (const rows of groups) if (rows.some((row) => !scoped.has(row.locationId))) throw new InternalServerErrorException();
}

/** Read every row by id keyset until a read returns none. */
async function readByIdKeyset<T extends { id: string }>(read: (afterId: string | null, limit: number) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const batch = await read(afterId, MONEY_READ_BATCH);
    if (batch.length === 0) return rows;
    const lastId: string = batch[batch.length - 1].id;
    // A keyset that does not advance would loop forever or repeat rows.
    if (afterId !== null && !(lastId > afterId)) throw new InternalServerErrorException();
    rows.push(...batch);
    afterId = lastId;
  }
}

/** Distinct ids in chunks, each chunk read by id keyset. */
async function readByIdChunks<T extends { id: string }>(
  ids: readonly string[],
  read: (chunk: readonly string[], afterId: string | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunks([...new Set(ids)], MONEY_ID_CHUNK)) rows.push(...(await readByIdKeyset((afterId, limit) => read(chunk, afterId, limit))));
  return rows;
}

/** Distinct ids in chunks, for reads bounded by the chunk itself. */
async function readChunks<T>(ids: readonly string[], read: (chunk: readonly string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunks([...new Set(ids)], MONEY_ID_CHUNK)) rows.push(...(await read(chunk)));
  return rows;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
