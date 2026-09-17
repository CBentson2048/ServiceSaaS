/**
 * R2 cross-location privacy: a viewer authorised only for London must not learn any
 * fact recorded at a location outside their Team report grant — leave, rota, book-outs,
 * bookings, visits, bills, retail, pay statements or membership — not even that one
 * exists. Proven by building manager@London's report with and without a set of
 * Other-only facts and requiring the two bodies to be identical, and by checking that
 * no read reaches Other.
 *
 * The scope is resolved by the real ReportScopeService from the actor's grants, and
 * the "with Other facts" business also has a third, inactive location, so whether
 * other locations exist is part of what must not show.
 *
 * The one deliberate exception is locked U-5: Future Booking counts a London client's
 * future appointment at any location. It is not exercised here and is recorded in
 * docs/V1.1/week-8-r2-team.md §8.
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
import { ALICE, AS_OF, BEN, BIZ, DAN, LONDON, OTHER, bill, moneyLedger, retail, teamLedger, uid } from './testing/team-fixture';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

const OLGA = '30000000-0000-4000-8000-0000000000a0';
const ARCHIVED = '20000000-0000-4000-8000-0000000000ff';
const OTHER_PERIOD = '60000000-0000-4000-8000-0000000000f1';
const BUSINESS_PERIOD = '60000000-0000-4000-8000-0000000000f2';
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
// A manager whose grants cover London and Other — every ACTIVE location — is still not an owner.
const MANAGER_BOTH: ReportActor = {
  id: 'manager-both',
  businessId: BIZ,
  roles: ['manager'],
  membershipGrants: [
    { locationId: LONDON, permissions: ['report.performance.view'] },
    { locationId: OTHER, permissions: ['report.performance.view'] },
  ],
};
const OWNER: ReportActor = { id: 'owner', businessId: BIZ, roles: ['owner'] };
const TEAM = getReportDefinition('team') as ReportDefinition;

/** The real scope service over a fake locations table; London is always the selection. */
async function resolveScope(actor: ReportActor, withOtherFacts: boolean, staff: string[]) {
  const rows = [
    { id: LONDON, name: 'London', timezone: 'Europe/London', is_active: true },
    { id: OTHER, name: 'Other', timezone: 'Europe/London', is_active: true },
    ...(withOtherFacts ? [{ id: ARCHIVED, name: 'Archived', timezone: 'Europe/London', is_active: false }] : []),
  ];
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'order', 'in']) builder[op] = () => builder;
  builder.returns = () => Promise.resolve({ data: rows, error: null });
  (createClient as jest.Mock).mockReturnValue({ schema: () => ({ from: () => builder }) });
  const scopeService = new ReportScopeService({ getOrThrow: () => 'placeholder' } as unknown as ConfigService);
  const query = { preset: 'custom', from: '2026-09-14', to: '2026-09-14', locations: LONDON, ...(staff.length > 0 ? { staff: staff.join(',') } : {}) };
  return scopeService.resolve(actor, TEAM, query, AS_OF);
}

function ledgers(withOtherFacts: boolean): { team: TeamLedger; money: Ledger } {
  const team = teamLedger();
  const money = moneyLedger();
  // London facts both ledgers share: Alice and Ben rostered, Alice booked.
  team.shifts.push(
    { id: uid(), businessId: BIZ, locationId: LONDON, staffProfileId: ALICE, startAt: at('2026-09-14T08:00:00Z'), endAt: at('2026-09-14T16:00:00Z') },
    { id: uid(), businessId: BIZ, locationId: LONDON, staffProfileId: BEN, startAt: at('2026-09-14T08:00:00Z'), endAt: at('2026-09-14T12:00:00Z') },
  );
  team.appointments.push({ id: uid(), businessId: BIZ, locationId: LONDON, clientProfileId: uid(), staffProfileId: ALICE, status: 'paid', startAt: at('2026-09-14T09:00:00Z'), endAt: at('2026-09-14T10:00:00Z'), occupiedRanges: null });
  if (!withOtherFacts) {
    // Dan (London facts) holds his current Other membership only in the other ledger.
    team.memberships = team.memberships.filter((membership) => !(membership.userProfileId === `u${DAN.slice(1)}` && membership.locationId === OTHER));
    return { team, money };
  }

  // Other only. Approved leave of London staff recorded at Other on the London day, pending leave too.
  team.leave.push(
    { id: uid(), businessId: BIZ, locationId: OTHER, staffProfileId: ALICE, startDate: '2026-09-14', endDate: '2026-09-14', status: 'approved' },
    { id: uid(), businessId: BIZ, locationId: OTHER, staffProfileId: BEN, startDate: '2026-09-10', endDate: '2026-09-20', status: 'approved' },
    { id: uid(), businessId: BIZ, locationId: OTHER, staffProfileId: ALICE, startDate: '2026-09-14', endDate: '2026-09-14', status: 'pending' },
    // And at the archived location.
    { id: uid(), businessId: BIZ, locationId: ARCHIVED, staffProfileId: BEN, startDate: '2026-09-14', endDate: '2026-09-14', status: 'approved' },
  );
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

async function build(withOtherFacts: boolean, actor: ReportActor, staffProfileIds: string[] = []) {
  const { team, money } = ledgers(withOtherFacts);
  const teamSource = new MemoryTeamSource(team);
  const moneySource = new MemoryMoneySource(money);
  // Resolved one at a time: each resolve installs its own fake locations table.
  const scope = await resolveScope(actor, withOtherFacts, staffProfileIds);
  const body = await new TeamReportService(moneySource, teamSource).build(scope);
  return { body, teamSource, moneySource, scope };
}

const aliceUtilisation = (body: TeamReportBody) => body.staffRows.find((row) => row.rowKey === `${LONDON}:${ALICE}`)!.metrics.utilisation;
const ambiguous = { availability: 'unavailable', reason: 'availability_scope_ambiguous' };

describe('R2 cross-location privacy', () => {
  it.each([
    ['manager@London', MANAGER_LONDON],
    ['performance@London + commission@Other', MANAGER_LONDON_COMMISSION_OTHER],
  ])('%s: the whole report is identical with and without leave, rota, bookings, visits, money, pay statements, members and an archived location elsewhere', async (_label, actor) => {
    const without = await build(false, actor);
    const withOther = await build(true, actor);
    expect(withOther.body).toEqual(without.body);
    expect(withOther.scope.permittedLocationIds).toEqual([LONDON]);
    const periods = withOther.body.finalisedCommission.periods.map((period) => period.payPeriodId);
    expect(periods).not.toContain(OTHER_PERIOD);
    expect(periods).not.toContain(BUSINESS_PERIOD);
    // And the same under a staff filter naming London staff, one of whom is a member at Other only in one ledger.
    const filteredWithout = await build(false, actor, [ALICE, BEN, DAN]);
    const filteredWith = await build(true, actor, [ALICE, BEN, DAN]);
    expect(filteredWith.body).toEqual(filteredWithout.body);
  });

  it('manager@London: utilisation is not stated for London days they cannot settle, with the same neutral reason whether or not anything exists elsewhere', async () => {
    for (const withOther of [false, true]) {
      const { body } = await build(withOther, MANAGER_LONDON);
      expect(aliceUtilisation(body)).toEqual({ availableMinutes: ambiguous, bookedMinutes: ambiguous, utilisation: ambiguous });
      const text = JSON.stringify(body);
      expect(text).not.toContain(OTHER);
      expect(text).not.toContain(ARCHIVED);
      expect(text).not.toMatch(/leave|another location|Olga|4321|5555/i);
    }
  });

  it('manager@London never reads a fact at Other: leave only at London, windows and currencies only London; an Other member is neither listed nor probeable', async () => {
    const { body, teamSource, moneySource } = await build(true, MANAGER_LONDON);
    for (const read of teamSource.reads) {
      for (const window of read.windows ?? []) expect(window.locationId).toBe(LONDON);
      if (read.method === 'approvedLeave') expect(read.locationIds).toEqual([LONDON]);
      if (read.method === 'activeMemberships') expect(read.ids).toEqual([LONDON]);
    }
    for (const read of moneySource.reads) {
      for (const window of read.windows ?? []) expect(window.locationId).toBe(LONDON);
      if (read.method === 'locationCurrencies') expect(read.ids).toEqual([LONDON]);
    }
    expect(body.staffOptions.map((option) => option.staffProfileId)).not.toContain(OLGA);
    await expect(build(true, MANAGER_LONDON, [OLGA])).rejects.toMatchObject({ response: { code: 'report_staff_out_of_scope' } });
    await expect(build(false, MANAGER_LONDON, [OLGA])).rejects.toMatchObject({ response: { code: 'report_staff_out_of_scope' } });
  });

  it('a manager whose grants cover every active location is still not an owner: the rule never asks whether other locations exist', async () => {
    const without = await build(false, MANAGER_BOTH);
    const withOther = await build(true, MANAGER_BOTH);
    expect(aliceUtilisation(without.body).utilisation).toEqual(ambiguous);
    expect(aliceUtilisation(withOther.body).utilisation).toEqual(ambiguous);
  });

  it('contrast — an owner, who may see every location, reporting on London alone: leave elsewhere does change what can be stated', async () => {
    const without = await build(false, OWNER);
    const withOther = await build(true, OWNER);
    expect(aliceUtilisation(without.body).utilisation).toEqual({ availability: 'available', numerator: 60, denominator: 480, basisPoints: 1250 });
    expect(aliceUtilisation(withOther.body).utilisation).toEqual(ambiguous);
    // The owner's leave read covers every location the owner may see, whatever is selected.
    expect(withOther.teamSource.reads.find((read) => read.method === 'approvedLeave')!.locationIds).toEqual([LONDON, OTHER, ARCHIVED]);
  });
});
