/**
 * R2 Team money reconciliation: SOURCE LEDGER = R1 MONEY = R2 TEAM, to the penny.
 * The ledger and its hand-worked figures are in testing/team-fixture.ts.
 *
 * Invariants, per location and for the summary:
 *   Σ staff service + Unattributed service = R1 composition `service`
 *   Σ staff colour  + Unattributed colour  = R1 composition `product_usage` (and R1 colour)
 *   Σ seller retail + Unattributed retail  = R1 retail recorded
 *   team average bill total                = R1 gross − R1 not itemised
 * And R1's own output is unchanged by the staff columns the adapter now reads.
 */
import type { MoneyAmount, MoneyFirstPageBody, TeamAmount, TeamReportBody, TeamStaffRow } from '@sheer/domain';
import { MoneyReportService } from '../money/money-report.service';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { firstPage, moneyScope } from '../money/testing/money-scope';
import { TeamReportService } from './team-report.service';
import { MemoryTeamSource, teamScope } from './testing/memory-team-source';
import { ALICE, AS_OF, BEN, BIZ, CARA, DAN, DAY, EVE, FAY, GIL, LOCATIONS, LONDON, OTHER, bill, moneyLedger, retail, teamLedger } from './testing/team-fixture';

const cents = (amount: TeamAmount | MoneyAmount): number => {
  if (amount.availability !== 'available') throw new Error(`expected an available amount, got ${JSON.stringify(amount)}`);
  return amount.cents;
};

async function team(ledger: Ledger = moneyLedger(), staffProfileIds: string[] = []): Promise<TeamReportBody> {
  const service = new TeamReportService(new MemoryMoneySource(ledger), new MemoryTeamSource(teamLedger()));
  return service.build(teamScope(BIZ, LOCATIONS, { ...DAY, staffProfileIds }, AS_OF));
}

async function money(ledger: Ledger = moneyLedger()): Promise<MoneyFirstPageBody> {
  return firstPage(await new MoneyReportService(new MemoryMoneySource(ledger)).build(moneyScope(BIZ, LOCATIONS, DAY, AS_OF), { cursor: null }));
}

const rowsAt = (body: TeamReportBody, locationId: string) => body.staffRows.filter((row) => row.locationId === locationId);
const composition = (body: MoneyFirstPageBody, locationId: string | null, key: string) => {
  const totals = locationId === null ? body.summary : body.locations.find((l) => l.locationId === locationId)!.totals;
  return cents(totals.composition.find((c) => c.key === key)!.gross);
};
const label = (row: TeamStaffRow) => (row.staff.kind === 'staff' ? row.staff.name : row.staff.kind === 'former' ? `former:${row.staff.staffProfileId}` : 'unattributed');

describe('R2 Team money reconciles with R1 Money', () => {
  it('London: each staff member’s service, colour, average bill and retail, to the penny', async () => {
    const body = await team();
    const byLabel = Object.fromEntries(
      rowsAt(body, LONDON).map((row) => [
        label(row),
        {
          service: row.metrics.serviceRevenue.gross,
          serviceNet: row.metrics.serviceRevenue.netOfVat,
          colour: row.metrics.colour.gross,
          average: row.metrics.averageBill,
          retail: row.metrics.retailRevenue,
        },
      ]),
    );
    const a = (c: number) => ({ availability: 'available', cents: c });
    expect(Object.keys(byLabel)).toEqual(['Alice', 'Ben', 'Dan', 'Eve', 'Fay', `former:${CARA}`, 'unattributed']);
    expect(byLabel.Alice).toEqual({
      service: a(13000),
      serviceNet: a(10834),
      colour: a(1000),
      average: { total: a(14000), bills: { availability: 'available', count: 2 }, average: a(7000) },
      retail: a(1200),
    });
    expect(byLabel.Ben.service).toEqual(a(3000));
    expect(byLabel.Ben.average).toEqual({ total: a(3000), bills: { availability: 'available', count: 1 }, average: a(3000) });
    expect(byLabel.Ben.retail).toEqual(a(500));
    expect(byLabel.Dan.service).toEqual(a(1500));
    expect(byLabel.Fay.service).toEqual(a(1000));
    expect(byLabel[`former:${CARA}`].service).toEqual(a(2500));
    expect(byLabel.unattributed).toEqual({
      service: a(3500),
      serviceNet: a(2917),
      colour: a(600),
      average: { total: a(4100), bills: { availability: 'available', count: 2 }, average: a(2050) },
      retail: a(800),
    });
    // Zero activity: a real £0.00 of service, but no average bill to state.
    expect(byLabel.Eve.service).toEqual(a(0));
    expect(byLabel.Eve.average).toEqual({ total: a(0), bills: { availability: 'available', count: 0 }, average: { availability: 'unavailable', reason: 'no_bills' } });
  });

  it('London and Other totals: the hand-worked figures', async () => {
    const body = await team();
    const london = body.locations.find((l) => l.locationId === LONDON)!.totals;
    expect(cents(london.serviceRevenue.gross)).toBe(24500);
    expect(cents(london.serviceRevenue.netOfVat)).toBe(20417);
    expect(cents(london.colour.gross)).toBe(1600);
    expect(london.averageBill).toEqual({
      total: { availability: 'available', cents: 25600 },
      bills: { availability: 'available', count: 6 },
      average: { availability: 'available', cents: 4267 },
    });
    expect(cents(london.notItemised)).toBe(2000);
    expect(cents(london.otherBillLines)).toBe(-500);
    expect(cents(london.retailRevenue)).toBe(2500);
    expect(london.retailShareOfServiceRevenue).toEqual({ availability: 'available', numerator: 2500, denominator: 24500, basisPoints: 1020 });
    const other = body.locations.find((l) => l.locationId === OTHER)!.totals;
    expect(cents(other.serviceRevenue.gross)).toBe(6000);
    expect(other.retailShareOfServiceRevenue).toEqual({ availability: 'available', numerator: 0, denominator: 6000, basisPoints: 0 });
    expect(cents(body.summary.serviceRevenue.gross)).toBe(30500);
    expect(body.summary.averageBill.average).toEqual({ availability: 'available', cents: 3950 });
    expect(body.summary.retailShareOfServiceRevenue).toEqual({ availability: 'available', numerator: 2500, denominator: 30500, basisPoints: 820 });
    expect(body.currencyCode).toBe('GBP');
  });

  it('INVARIANTS: Σ staff + Unattributed = R1 for service, colour and retail; team average-bill total = R1 gross − not itemised', async () => {
    const [body, r1] = await Promise.all([team(), money()]);
    for (const locationId of [LONDON, OTHER]) {
      const rows = rowsAt(body, locationId);
      const sum = (pick: (row: TeamStaffRow) => TeamAmount) => rows.reduce((total, row) => total + cents(pick(row)), 0);
      const r1Location = r1.locations.find((l) => l.locationId === locationId)!.totals;
      const teamLocation = body.locations.find((l) => l.locationId === locationId)!.totals;
      expect([locationId, sum((row) => row.metrics.serviceRevenue.gross)]).toEqual([locationId, composition(r1, locationId, 'service')]);
      expect([locationId, sum((row) => row.metrics.colour.gross)]).toEqual([locationId, composition(r1, locationId, 'product_usage')]);
      expect(sum((row) => row.metrics.colour.gross)).toBe(cents(r1Location.colour.gross));
      expect(sum((row) => row.metrics.colour.netOfVat)).toBe(cents(r1Location.colour.netOfVat));
      expect(sum((row) => row.metrics.retailRevenue)).toBe(cents(r1Location.retail.recorded));
      expect(cents(teamLocation.serviceRevenue.gross)).toBe(composition(r1, locationId, 'service'));
      expect(cents(teamLocation.averageBill.total)).toBe(cents(r1Location.paidBills.gross) - composition(r1, locationId, 'not_itemised'));
      expect(cents(teamLocation.notItemised)).toBe(composition(r1, locationId, 'not_itemised'));
      // Σ staff average-bill totals + Unattributed + other lines = team total.
      expect(sum((row) => row.metrics.averageBill.total) + cents(teamLocation.otherBillLines)).toBe(cents(teamLocation.averageBill.total));
    }
    expect(cents(body.summary.serviceRevenue.gross)).toBe(composition(r1, null, 'service'));
    expect(cents(body.summary.colour.gross)).toBe(composition(r1, null, 'product_usage'));
    expect(cents(body.summary.retailRevenue)).toBe(cents(r1.summary.retail.recorded));
    expect(cents(body.summary.averageBill.total)).toBe(cents(r1.summary.paidBills.gross) - composition(r1, null, 'not_itemised'));
  });

  it('R1 Money output is unchanged by the staff columns its adapter now reads', async () => {
    const withStaff = moneyLedger();
    const withoutStaff: Ledger = {
      ...withStaff,
      lines: withStaff.lines.map(({ staffProfileId: _s, perService: _p, ...line }) => line),
      retail: withStaff.retail.map(({ sellerStaffProfileId: _s, ...sale }) => sale),
    };
    expect(await money(withStaff)).toEqual(await money(withoutStaff));
  });

  it('a shared bill counts once for each staff member on it, and once for any set of them', async () => {
    const london = (body: TeamReportBody) => body.locations.find((l) => l.locationId === LONDON)!.selectedStaff!;
    const aliceAndBen = await team(moneyLedger(), [ALICE, BEN]);
    expect(london(aliceAndBen).averageBill).toEqual({
      total: { availability: 'available', cents: 17000 },
      bills: { availability: 'available', count: 2 },
      average: { availability: 'available', cents: 8500 },
    });
    // Σ of staff bill counts (2 + 1) is more than the distinct bills: never averaged.
    expect(london(aliceAndBen).averageBill.bills).not.toEqual({ availability: 'available', count: 3 });
  });

  it('a multi-staff bill: each stylist’s lines are theirs alone', async () => {
    const body = await team();
    const ben = rowsAt(body, LONDON).find((row) => label(row) === 'Ben')!;
    const alice = rowsAt(body, LONDON).find((row) => label(row) === 'Alice')!;
    // B1 holds Alice 8000 + colour 1000 and Ben 3000: Ben's average bill is his 3000, not the bill's 12000.
    expect(cents(ben.metrics.averageBill.average)).toBe(3000);
    expect(cents(alice.metrics.averageBill.total)).toBe(14000);
  });

  it('mixed currency: every money figure at the location is unavailable, never totalled or relabelled — the average bill included', async () => {
    const ledger = moneyLedger();
    retail(ledger, OTHER, '2026-09-14T12:00:00Z', 900, GIL, 'EUR');
    const body = await team(ledger);
    const other = body.locations.find((l) => l.locationId === OTHER)!;
    const mixed = { availability: 'unavailable', reason: 'mixed_currencies' };
    expect(other.currencyCode).toBeNull();
    expect(other.totals.serviceRevenue.gross).toEqual(mixed);
    expect(other.totals.averageBill.average).toEqual(mixed);
    expect(other.totals.retailShareOfServiceRevenue).toEqual(mixed);
    for (const row of rowsAt(body, OTHER)) {
      expect(row.metrics.serviceRevenue.gross).toEqual(mixed);
      expect(row.metrics.averageBill.average).toEqual(mixed);
      expect(row.metrics.retailRevenue).toEqual(mixed);
    }
    expect(body.summary.serviceRevenue.gross).toEqual(mixed);
    // London alone is still stated.
    expect(cents(body.locations.find((l) => l.locationId === LONDON)!.totals.serviceRevenue.gross)).toBe(24500);
  });

  it('no service revenue: retail share is unavailable, never 0% or infinite', async () => {
    const ledger: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [], locations: [{ id: LONDON, businessId: BIZ, currencyCode: 'GBP' }] };
    retail(ledger, LONDON, '2026-09-14T09:00:00Z', 700, null);
    const service = new TeamReportService(new MemoryMoneySource(ledger), new MemoryTeamSource(teamLedger()));
    const body = await service.build(teamScope(BIZ, [LOCATIONS[0]], DAY, AS_OF));
    expect(body.summary.retailShareOfServiceRevenue).toEqual({ availability: 'unavailable', reason: 'no_service_revenue' });
    expect(body.summary.retailRevenue).toEqual({ availability: 'available', cents: 700 });
    expect(body.summary.averageBill.average).toEqual({ availability: 'unavailable', reason: 'no_bills' });
  });

  it('a bill with no lines is left out of the average bill and reported as not itemised', async () => {
    const ledger: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [], locations: [{ id: LONDON, businessId: BIZ, currencyCode: 'GBP' }] };
    bill(ledger, { locationId: LONDON, at: '2026-09-14T10:00:00Z', gross: 5000 }, []);
    bill(ledger, { locationId: LONDON, at: '2026-09-14T11:00:00Z', gross: 3000 }, [['service', DAN, 3000, 3000, 0]]);
    const service = new TeamReportService(new MemoryMoneySource(ledger), new MemoryTeamSource(teamLedger()));
    const body = await service.build(teamScope(BIZ, [LOCATIONS[0]], DAY, AS_OF));
    expect(body.summary.averageBill).toEqual({
      total: { availability: 'available', cents: 3000 },
      bills: { availability: 'available', count: 1 },
      average: { availability: 'available', cents: 3000 },
    });
    expect(body.summary.notItemised).toEqual({ availability: 'available', cents: 5000 });
  });

  it('counts rolled-up service lines as a data-quality note', async () => {
    expect((await team()).dataQuality.rolledUpServiceLines).toBe(1);
  });

  it('names the metrics it cannot state yet, each with its typed reason — never as a number', async () => {
    const body = await team();
    expect(body.unavailableMetrics).toEqual([
      { metric: 'rebooking_at_source', reason: 'capture_not_implemented' },
      { metric: 'service_revenue_target', reason: 'target_model_not_available' },
      { metric: 'retail_attach', reason: 'retail_visit_linkage_not_captured' },
      { metric: 'live_commission', reason: 'payroll_rules_not_implemented' },
    ]);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/rebookingAtSource|retailAttach|liveCommission|serviceRevenueTarget/);
  });

  it('a location whose day has not started: every figure reads not started, never zero', async () => {
    const body = await new TeamReportService(new MemoryMoneySource(moneyLedger()), new MemoryTeamSource(teamLedger())).build(
      teamScope(BIZ, LOCATIONS, { ...DAY, from: '2026-09-20', to: '2026-09-20' }, AS_OF),
    );
    const notStarted = { availability: 'not_started' };
    expect(body.summary.serviceRevenue.gross).toEqual(notStarted);
    expect(body.summary.averageBill.average).toEqual(notStarted);
    expect(body.summary.utilisation.utilisation).toEqual(notStarted);
    expect(body.summary.futureBooking.withFutureBooking).toEqual(notStarted);
    // Current staff still appear, with not-started figures.
    const eve = body.staffRows.find((row) => row.staff.kind === 'staff' && row.staff.staffProfileId === EVE)!;
    expect(eve.metrics.serviceRevenue.gross).toEqual(notStarted);
    expect(body.currencyCode).toBeNull();
  });

  it('ignores the other business, voided bills and bills outside the local day', async () => {
    const body = await team();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('88888');
    expect(serialised).not.toContain('9999');
    expect(serialised).not.toContain('7777');
    expect(body.staffOptions.map((option) => option.staffProfileId)).not.toContain('30000000-0000-4000-8000-000000000011');
    expect(FAY).toBeDefined();
  });
});
