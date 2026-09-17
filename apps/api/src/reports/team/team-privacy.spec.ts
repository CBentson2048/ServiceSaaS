/**
 * R2 cross-location privacy, under the locked rules of 2026-09-17:
 *
 * - Approved leave is a STAFF-LEVEL absence: it reduces the staff member's overlapping
 *   rostered time at every location, whichever location recorded it. The recording
 *   location is administrative context and must never show.
 * - Future Booking counts a future appointment anywhere in the business, but a manager
 *   sees only the aggregate for clients seen in their scope — never the future
 *   appointment's location, stylist or time.
 * - Otherwise a manager at London learns nothing recorded at a location outside their
 *   grant — rota, book-outs, bookings, visits, bills, retail, pay statements,
 *   memberships — not even that another location exists.
 *
 * The scope is resolved by the real ReportScopeService from the actor's grants. The
 * "noise" business also has an archived third location.
 */
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { getReportDefinition, type ReportDefinition, type TeamReportBody } from '@sheer/domain';
import type { ReportActor } from '../report-actor';
import { ReportScopeService } from '../report-scope.service';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { instant as at } from '../money/testing/money-scope';
import { TeamReportService } from './team-report.service';
import { MemoryTeamSource, type TeamLedger } from './testing/memory-team-source';
import { ALICE, AS_OF, BEN, BIZ, DAN, GIL, LONDON, OTHER, bill, moneyLedger, retail, teamLedger, uid } from './testing/team-fixture';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

const OLGA = '30000000-0000-4000-8000-0000000000a0';
const ARCHIVED = '20000000-0000-4000-8000-0000000000ff';
const OTHER_PERIOD = '60000000-0000-4000-8000-0000000000f1';
const BUSINESS_PERIOD = '60000000-0000-4000-8000-0000000000f2';
const LONDON_CLIENT = '50000000-0000-4000-8000-0000000000c1';
const MANAGER_LONDON: ReportActor = {
  id: 'manager-london',
  businessId: BIZ,
  roles: ['manager', 'stylist'],
  membershipGrants: [{ locationId: LONDON, permissions: ['report.performance.view', 'report.commission.view'] }],
};
// Performance at London, commission only at Other: Other stays out of the report, and its pay periods with it.
const MANAGER_LONDON_COMMISSION_OTHER: ReportActor = {
  id: 'manager-split',
  businessId: BIZ,
  roles: ['manager'],
  membershipGrants: [
    { locationId: LONDON, permissions: ['report.performance.view'] },
    { locationId: OTHER, permissions: ['report.commission.view'] },
  ],
};
const OWNER: ReportActor = { id: 'owner', businessId: BIZ, roles: ['owner'] };
const TEAM = getReportDefinition('team') as ReportDefinition;

type Leave = { staff: string; recordedAt: string; from: string; to?: string };

interface Setup {
  /** Facts at Other and an archived location that a London manager must not learn. */
  noise?: boolean;
  leave?: Leave[];
  /** A future appointment for the London client: where, with whom, when. */
  futureBooking?: { locationId: string; staff: string; start: string };
}

/** The real scope service over a fake locations table; London, 14–15 Sep, is always the selection. */
async function resolveScope(actor: ReportActor, withArchived: boolean, staff: string[]) {
  const rows = [
    { id: LONDON, name: 'London', timezone: 'Europe/London', is_active: true },
    { id: OTHER, name: 'Other', timezone: 'Europe/London', is_active: true },
    ...(withArchived ? [{ id: ARCHIVED, name: 'Archived', timezone: 'Europe/London', is_active: false }] : []),
  ];
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'order', 'in']) builder[op] = () => builder;
  builder.returns = () => Promise.resolve({ data: rows, error: null });
  (createClient as jest.Mock).mockReturnValue({ schema: () => ({ from: () => builder }) });
  const scopeService = new ReportScopeService({ getOrThrow: () => 'placeholder' } as unknown as ConfigService);
  const query = { preset: 'custom', from: '2026-09-14', to: '2026-09-15', locations: LONDON, ...(staff.length > 0 ? { staff: staff.join(',') } : {}) };
  return scopeService.resolve(actor, TEAM, query, AS_OF);
}

function ledgers(setup: Setup): { team: TeamLedger; money: Ledger } {
  const team = teamLedger();
  const money = moneyLedger();
  // London facts every ledger shares: Alice rostered 8h on 14 and 15 Sep and booked 1h; Ben rostered 4h; a London client of Alice's.
  team.shifts.push(
    { id: uid(), businessId: BIZ, locationId: LONDON, staffProfileId: ALICE, startAt: at('2026-09-14T08:00:00Z'), endAt: at('2026-09-14T16:00:00Z') },
    { id: uid(), businessId: BIZ, locationId: LONDON, staffProfileId: ALICE, startAt: at('2026-09-15T08:00:00Z'), endAt: at('2026-09-15T16:00:00Z') },
    { id: uid(), businessId: BIZ, locationId: LONDON, staffProfileId: BEN, startAt: at('2026-09-14T08:00:00Z'), endAt: at('2026-09-14T12:00:00Z') },
  );
  team.appointments.push({ id: uid(), businessId: BIZ, locationId: LONDON, clientProfileId: uid(), staffProfileId: ALICE, status: 'paid', startAt: at('2026-09-14T09:00:00Z'), endAt: at('2026-09-14T10:00:00Z'), occupiedRanges: null });
  team.visits.push({ id: uid(), businessId: BIZ, locationId: LONDON, status: 'paid', completedAt: at('2026-09-14T10:00:00Z'), appointmentId: null, clientProfileId: LONDON_CLIENT, primaryStaffProfileId: ALICE });

  for (const leave of setup.leave ?? []) {
    team.leave.push({ id: uid(), businessId: BIZ, locationId: leave.recordedAt, staffProfileId: leave.staff, startDate: leave.from, endDate: leave.to ?? leave.from, status: 'approved' });
  }
  if (setup.futureBooking) {
    const { locationId, staff, start } = setup.futureBooking;
    team.appointments.push({ id: '70000000-0000-4000-8000-0000000000f9', businessId: BIZ, locationId, clientProfileId: LONDON_CLIENT, staffProfileId: staff, status: 'accepted', startAt: at(start), endAt: at('2026-09-30T12:00:00Z'), occupiedRanges: null });
  }

  if (!setup.noise) {
    // Dan (London facts) holds his current Other membership only in the noise ledger.
    team.memberships = team.memberships.filter((membership) => !(membership.userProfileId === `u${DAN.slice(1)}` && membership.locationId === OTHER));
    return { team, money };
  }
  // Pending leave of a London stylist (never counts), and rota, book-outs and bookings at Other.
  team.leave.push({ id: uid(), businessId: BIZ, locationId: OTHER, staffProfileId: ALICE, startDate: '2026-09-14', endDate: '2026-09-15', status: 'pending' });
  team.shifts.push({ id: uid(), businessId: BIZ, locationId: OTHER, staffProfileId: ALICE, startAt: at('2026-09-14T17:00:00Z'), endAt: at('2026-09-14T20:00:00Z') });
  team.absences.push({ id: uid(), businessId: BIZ, locationId: OTHER, staffProfileId: ALICE, bookOutTypeId: null, startAt: at('2026-09-14T17:00:00Z'), endAt: at('2026-09-14T18:00:00Z') });
  team.appointments.push({ id: uid(), businessId: BIZ, locationId: OTHER, clientProfileId: uid(), staffProfileId: ALICE, status: 'accepted', startAt: at('2026-09-14T18:00:00Z'), endAt: at('2026-09-14T19:00:00Z'), occupiedRanges: null });
  // A client seen only at Other, with a future booking at Other.
  const otherClient = uid();
  team.visits.push({ id: uid(), businessId: BIZ, locationId: OTHER, status: 'paid', completedAt: at('2026-09-14T19:00:00Z'), appointmentId: null, clientProfileId: otherClient, primaryStaffProfileId: ALICE });
  team.appointments.push({ id: uid(), businessId: BIZ, locationId: OTHER, clientProfileId: otherClient, staffProfileId: ALICE, status: 'accepted', startAt: at('2026-09-25T10:00:00Z'), endAt: at('2026-09-25T11:00:00Z'), occupiedRanges: null });
  // A current member at Other only.
  team.staff.push({ id: OLGA, businessId: BIZ, userProfileId: 'u-olga', name: 'Olga' });
  team.memberships.push({ id: uid(), businessId: BIZ, userProfileId: 'u-olga', locationId: OTHER, role: 'stylist', status: 'active' });
  // Pay statements of London staff at Other, and on a business-wide period (owners only).
  team.payPeriods.push(
    { id: OTHER_PERIOD, businessId: BIZ, locationId: OTHER, label: null, periodStart: '2026-09-14', periodEnd: '2026-09-21', status: 'locked', kind: 'calculation' },
    { id: BUSINESS_PERIOD, businessId: BIZ, locationId: null, label: null, periodStart: '2026-09-08', periodEnd: '2026-09-15', status: 'paid', kind: 'calculation' },
  );
  team.paySummaries.push(
    { id: uid(), businessId: BIZ, payPeriodId: OTHER_PERIOD, staffProfileId: ALICE, currency: { status: 'verified', code: 'GBP' }, commissionCents: 4321, adjustmentsCents: 0, greaterOfApplied: false, greaterOfWinner: null },
    { id: uid(), businessId: BIZ, payPeriodId: BUSINESS_PERIOD, staffProfileId: BEN, currency: { status: 'unverified' }, commissionCents: 5555, adjustmentsCents: 0, greaterOfApplied: false, greaterOfWinner: null },
  );
  // Money of London staff at Other.
  bill(money, { locationId: OTHER, at: '2026-09-14T18:30:00Z', gross: 7000 }, [['service', ALICE, 7000, 5833, 1167]]);
  retail(money, OTHER, '2026-09-14T18:45:00Z', 900, ALICE);
  return { team, money };
}

async function build(actor: ReportActor, setup: Setup = {}, staffProfileIds: string[] = []) {
  const { team, money } = ledgers(setup);
  const teamSource = new MemoryTeamSource(team);
  const moneySource = new MemoryMoneySource(money);
  // Resolved one at a time: each resolve installs its own fake locations table.
  const scope = await resolveScope(actor, setup.noise === true, staffProfileIds);
  const body = await new TeamReportService(moneySource, teamSource).build(scope);
  return { body, teamSource, moneySource };
}

const utilisationOf = (body: TeamReportBody, staffId: string) => body.staffRows.find((row) => row.rowKey === `${LONDON}:${staffId}`)!.metrics.utilisation;
const available = (numerator: number, denominator: number, basisPoints: number) => ({
  availableMinutes: { availability: 'available', count: denominator },
  bookedMinutes: { availability: 'available', count: numerator },
  utilisation: { availability: 'available', numerator, denominator, basisPoints },
});
/** The body with every utilisation figure blanked: what must not change when only leave does. */
const withoutUtilisation = (body: TeamReportBody): unknown => JSON.parse(JSON.stringify(body, (key, value) => (key === 'utilisation' ? '<utilisation>' : value)));

const ALICE_ON_LEAVE_15: Leave = { staff: ALICE, recordedAt: OTHER, from: '2026-09-15' };

describe('R2 cross-location privacy: staff-wide leave', () => {
  it('A. the same approved leave gives the same report whether it was recorded at London or at Other — for a manager and an owner', async () => {
    for (const actor of [MANAGER_LONDON, OWNER]) {
      const atLondon = await build(actor, { leave: [{ ...ALICE_ON_LEAVE_15, recordedAt: LONDON }] });
      const atOther = await build(actor, { leave: [ALICE_ON_LEAVE_15] });
      expect(atOther.body).toEqual(atLondon.body);
      // The legitimate result: Alice's 15 Sep London shift is removed; 14 Sep stays.
      expect(utilisationOf(atOther.body, ALICE)).toEqual(available(60, 480, 1250));
    }
  });

  it('B. manager@London: everything at Other plus that leave changes nothing but the resulting utilisation', async () => {
    const quiet = await build(MANAGER_LONDON);
    const noisy = await build(MANAGER_LONDON, { noise: true, leave: [ALICE_ON_LEAVE_15] });
    expect(withoutUtilisation(noisy.body)).toEqual(withoutUtilisation(quiet.body));
    expect(utilisationOf(quiet.body, ALICE)).toEqual(available(60, 960, 625));
    expect(utilisationOf(noisy.body, ALICE)).toEqual(available(60, 480, 1250));
    // Ben's figure — no leave — is untouched.
    expect(utilisationOf(noisy.body, BEN)).toEqual(utilisationOf(quiet.body, BEN));
    // And with no leave at all, the noise changes nothing whatsoever.
    expect((await build(MANAGER_LONDON, { noise: true })).body).toEqual(quiet.body);
  });

  it('C. no provenance or count: the body names no other location, no leave, no leave count and nothing from Other', async () => {
    const { body } = await build(MANAGER_LONDON, {
      noise: true,
      leave: [ALICE_ON_LEAVE_15, { staff: ALICE, recordedAt: ARCHIVED, from: '2026-09-15' }],
    });
    const text = JSON.stringify(body);
    for (const id of [OTHER, ARCHIVED, OLGA, OTHER_PERIOD, BUSINESS_PERIOD]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/leave|recorded at|another location|other location|Olga|4321|5555/i);
    expect(Object.keys(body.dataQuality).sort()).toEqual(['bookedAtAnotherLocation', 'bookedWithoutRota', 'rolledUpServiceLines']);
  });

  it('D. overlapping and duplicate leave is unioned, never subtracted twice', async () => {
    const single = await build(MANAGER_LONDON, { leave: [ALICE_ON_LEAVE_15] });
    const overlapping = await build(MANAGER_LONDON, {
      leave: [
        ALICE_ON_LEAVE_15,
        { ...ALICE_ON_LEAVE_15, recordedAt: LONDON },
        { staff: ALICE, recordedAt: OTHER, from: '2026-09-15', to: '2026-09-17' },
        { staff: ALICE, recordedAt: ARCHIVED, from: '2026-09-15' },
      ],
    });
    expect(overlapping.body).toEqual(single.body);
    expect(utilisationOf(overlapping.body, ALICE)).toEqual(available(60, 480, 1250));
  });

  it('E. leave of other staff at Other — including a member there only — has no effect on manager@London', async () => {
    const none = await build(MANAGER_LONDON, { noise: true });
    const others = await build(MANAGER_LONDON, {
      noise: true,
      leave: [
        { staff: OLGA, recordedAt: OTHER, from: '2026-09-14', to: '2026-09-15' },
        { staff: GIL, recordedAt: OTHER, from: '2026-09-14', to: '2026-09-15' },
      ],
    });
    expect(others.body).toEqual(none.body);
    // Their leave is never even read: only staff rostered in scope are asked for.
    for (const read of others.teamSource.reads.filter((r) => r.method === 'approvedLeave')) expect([...read.ids!].sort()).toEqual([ALICE, BEN].sort());
  });

  it('F. leave outside Alice’s London shifts (13 Sep; 16–18 Sep) does not reduce her availability', async () => {
    const none = await build(MANAGER_LONDON);
    const outside = await build(MANAGER_LONDON, {
      leave: [
        { staff: ALICE, recordedAt: OTHER, from: '2026-09-13' },
        { staff: ALICE, recordedAt: LONDON, from: '2026-09-16', to: '2026-09-18' },
      ],
    });
    expect(outside.body).toEqual(none.body);
    expect(utilisationOf(outside.body, ALICE)).toEqual(available(60, 960, 625));
  });
});

describe('R2 cross-location privacy: everything else', () => {
  it('Future Booking counts a booking anywhere in the business, and exposes only the aggregate — never its location, stylist or time', async () => {
    const atOther = await build(MANAGER_LONDON, { noise: true, futureBooking: { locationId: OTHER, staff: OLGA, start: '2026-09-25T10:00:00Z' } });
    const atLondon = await build(MANAGER_LONDON, { noise: true, futureBooking: { locationId: LONDON, staff: ALICE, start: '2026-09-22T15:30:00Z' } });
    // Wherever and with whomever it is, the manager sees the same aggregate.
    expect(atOther.body).toEqual(atLondon.body);
    const alice = atOther.body.staffRows.find((row) => row.rowKey === `${LONDON}:${ALICE}`)!;
    expect(alice.metrics.futureBooking.withFutureBooking).toEqual({ availability: 'available', numerator: 1, denominator: 1, basisPoints: 10000 });
    expect(atOther.body.locations[0].futureBookingAsAt).toEqual({ localDate: '2026-09-16', localTime: '11:00' });
    const text = JSON.stringify(atOther.body);
    for (const leak of [OTHER, OLGA, '70000000-0000-4000-8000-0000000000f9', '2026-09-25']) expect(text).not.toContain(leak);
  });

  it.each([
    ['manager@London', MANAGER_LONDON],
    ['performance@London + commission@Other', MANAGER_LONDON_COMMISSION_OTHER],
  ])('%s: rota, bookings, visits, money, pay statements, members and an archived location elsewhere change nothing, with or without a staff filter', async (_label, actor) => {
    expect((await build(actor, { noise: true })).body).toEqual((await build(actor)).body);
    expect((await build(actor, { noise: true }, [ALICE, BEN, DAN])).body).toEqual((await build(actor, {}, [ALICE, BEN, DAN])).body);
    const periods = (await build(actor, { noise: true })).body.finalisedCommission.periods.map((period) => period.payPeriodId);
    expect(periods).not.toContain(OTHER_PERIOD);
    expect(periods).not.toContain(BUSINESS_PERIOD);
  });

  it('manager@London reads rota, bookings, visits, money and members only at London; an Other member is neither listed nor probeable', async () => {
    const { body, teamSource, moneySource } = await build(MANAGER_LONDON, { noise: true, leave: [ALICE_ON_LEAVE_15] });
    for (const read of teamSource.reads) {
      for (const window of read.windows ?? []) expect(window.locationId).toBe(LONDON);
      if (read.method === 'activeMemberships') expect(read.ids).toEqual([LONDON]);
    }
    for (const read of moneySource.reads) {
      for (const window of read.windows ?? []) expect(window.locationId).toBe(LONDON);
      if (read.method === 'locationCurrencies') expect(read.ids).toEqual([LONDON]);
    }
    expect(body.staffOptions.map((option) => option.staffProfileId)).not.toContain(OLGA);
    await expect(build(MANAGER_LONDON, { noise: true }, [OLGA])).rejects.toMatchObject({ response: { code: 'report_staff_out_of_scope' } });
    await expect(build(MANAGER_LONDON, {}, [OLGA])).rejects.toMatchObject({ response: { code: 'report_staff_out_of_scope' } });
  });
});
