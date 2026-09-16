/**
 * R2 staff universe and staff filter (decision S-1d, locked U-11).
 *
 * Rows: current active staff at the resolved locations (zero activity included),
 * plus staff with facts there in the period, plus Unattributed, plus former staff
 * whose profile no longer exists. Facts keep their own location; current status is
 * labelled as current and never claimed as history.
 *
 * Filter: narrows rows only; location and team totals stay full-scope, with a
 * Selected staff subtotal; any id outside the picker fails closed with one
 * identical refusal, so staff elsewhere cannot be probed.
 */
import type { ReportActor } from '../report-actor';
import type { TeamReportBody, TeamStaffRow } from '@sheer/domain';
import { MemoryMoneySource } from '../money/testing/memory-money-source';
import { TeamReportService } from './team-report.service';
import { MemoryTeamSource, teamScope } from './testing/memory-team-source';
import { ALICE, AS_OF, BEN, BIZ, CARA, DAN, DAY, EVE, FAY, GIL, HAL, LOCATIONS, LONDON, OTHER, moneyLedger, teamLedger } from './testing/team-fixture';

const OWNER: ReportActor = { id: 'owner', businessId: BIZ, roles: ['owner'] };

function service(): { service: TeamReportService; team: MemoryTeamSource; money: MemoryMoneySource } {
  const money = new MemoryMoneySource(moneyLedger());
  const team = new MemoryTeamSource(teamLedger());
  return { service: new TeamReportService(money, team), team, money };
}

async function build(staffProfileIds: string[] = [], locations = LOCATIONS, actor = OWNER): Promise<TeamReportBody> {
  return service().service.build(teamScope(BIZ, locations, { ...DAY, staffProfileIds }, AS_OF, actor));
}

const describeRow = (row: TeamStaffRow) =>
  row.staff.kind === 'staff'
    ? [row.staff.name, row.staff.currentEmploymentStatus, row.staff.currentlyActiveHere ? 'active here now' : 'not active here now']
    : row.staff.kind === 'former'
      ? ['Former staff', row.staff.staffProfileId]
      : ['Unattributed'];

describe('R2 staff universe', () => {
  it('London: active with activity, active with none, moved away, terminated, deleted profile and Unattributed — in that order', async () => {
    const body = await build();
    expect(body.staffRows.filter((row) => row.locationId === LONDON).map(describeRow)).toEqual([
      ['Alice', 'active', 'active here now'],
      ['Ben', 'active', 'active here now'],
      // Dan moved to Other: his London facts stay at London; he is labelled by today's status only.
      ['Dan', 'active', 'not active here now'],
      // Eve has no activity: a row, from her current membership.
      ['Eve', 'active', 'active here now'],
      // Fay's profile still exists; she is terminated today.
      ['Fay', 'terminated', 'not active here now'],
      ['Former staff', CARA],
      ['Unattributed'],
    ]);
  });

  it('Other: a multi-location member and a moved member appear at each location where they belong today or have facts', async () => {
    const body = await build();
    expect(body.staffRows.filter((row) => row.locationId === OTHER).map(describeRow)).toEqual([
      ['Ben', 'active', 'active here now'],
      ['Dan', 'active', 'active here now'],
      ['Gil', 'active', 'active here now'],
    ]);
    const ben = body.staffOptions.find((option) => option.staffProfileId === BEN)!;
    expect(ben.locationIds).toEqual([LONDON, OTHER]);
  });

  it('the picker lists staff by name, then former staff — never Unattributed, never another business', async () => {
    const body = await build();
    expect(body.staffOptions.map((option) => [option.kind, option.name, option.staffProfileId])).toEqual([
      ['staff', 'Alice', ALICE],
      ['staff', 'Ben', BEN],
      ['staff', 'Dan', DAN],
      ['staff', 'Eve', EVE],
      ['staff', 'Fay', FAY],
      ['staff', 'Gil', GIL],
      ['former', null, CARA],
    ]);
    expect(body.staffOptions.map((option) => option.staffProfileId)).not.toContain(HAL);
  });

  it('never claims historical assignment: the row carries current status only', async () => {
    const body = await build();
    const dan = body.staffRows.find((row) => row.rowKey === `${LONDON}:${DAN}`)!;
    expect(Object.keys(dan.staff).sort()).toEqual(['currentEmploymentStatus', 'currentlyActiveHere', 'kind', 'name', 'staffProfileId']);
  });
});

describe('R2 staff filter', () => {
  it('narrows the staff rows only; location and team totals stay full-scope, with a Selected staff subtotal', async () => {
    const [all, ben] = await Promise.all([build(), build([BEN])]);
    expect(ben.staffRows.map((row) => row.rowKey)).toEqual([`${LONDON}:${BEN}`, `${OTHER}:${BEN}`]);
    expect(ben.locations.map((location) => location.totals)).toEqual(all.locations.map((location) => location.totals));
    expect(ben.summary).toEqual(all.summary);
    expect(all.selectedStaff).toBeNull();
    expect(all.locations.every((location) => location.selectedStaff === null)).toBe(true);
    const london = ben.locations.find((location) => location.locationId === LONDON)!.selectedStaff!;
    const other = ben.locations.find((location) => location.locationId === OTHER)!.selectedStaff!;
    expect([london.serviceRevenue.gross, other.serviceRevenue.gross, ben.selectedStaff!.serviceRevenue.gross]).toEqual([
      { availability: 'available', cents: 3000 },
      { availability: 'available', cents: 2000 },
      { availability: 'available', cents: 5000 },
    ]);
    expect(ben.selectedStaff!.averageBill).toEqual({
      total: { availability: 'available', cents: 5000 },
      bills: { availability: 'available', count: 2 },
      average: { availability: 'available', cents: 2500 },
    });
    // The picker is the whole universe whatever the filter.
    expect(ben.staffOptions).toEqual(all.staffOptions);
  });

  it('a former staff member can be selected by id', async () => {
    const body = await build([CARA]);
    expect(body.staffRows.map((row) => row.rowKey)).toEqual([`${LONDON}:${CARA}`]);
  });

  it('fails closed with one identical refusal for an unknown id, another business’s staff member, and staff outside the viewer’s locations', async () => {
    const unknown = build(['40000000-0000-4000-8000-000000000999']);
    const foreign = build([HAL]);
    // Gil has facts only at Other: for a scope of London alone he is not in the picker.
    const outside = build([GIL], [LOCATIONS[0]]);
    const refusal = { response: { statusCode: 403, code: 'report_staff_out_of_scope', message: 'One or more selected staff are not available to you for this report' } };
    await expect(unknown).rejects.toMatchObject(refusal);
    await expect(foreign).rejects.toMatchObject(refusal);
    await expect(outside).rejects.toMatchObject(refusal);
    // Mixing a valid and an invalid id is refused too: the filter is never silently narrowed.
    await expect(build([ALICE, HAL])).rejects.toMatchObject(refusal);
  });

  it('never reads a fact or membership outside the resolved locations (manager@A + stylist@B sees A only)', async () => {
    const { service: teamService, team, money } = service();
    const managerA: ReportActor = { id: 'manager', businessId: BIZ, roles: ['manager', 'stylist'], membershipGrants: [{ locationId: LONDON, permissions: ['report.performance.view'] }] };
    // The scope service has already resolved the manager to London only.
    const body = await teamService.build(teamScope(BIZ, [LOCATIONS[0]], DAY, AS_OF, managerA));
    expect(body.locations.map((location) => location.locationId)).toEqual([LONDON]);
    expect(body.staffOptions.map((option) => option.name)).not.toContain('Gil');
    for (const read of team.reads) {
      for (const window of read.windows ?? []) expect(window.locationId).toBe(LONDON);
      if (read.method === 'activeMemberships') expect(read.ids).toEqual([LONDON]);
    }
    for (const read of money.reads) for (const window of read.windows ?? []) expect(window.locationId).toBe(LONDON);
  });
});
