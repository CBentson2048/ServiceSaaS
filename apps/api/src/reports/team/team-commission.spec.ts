/**
 * R2 finalised commission (locked U-9): locked or paid statements only, by actual
 * pay period, never recalculated. Business-wide periods: owners only. Location
 * periods: a grant carrying report.commission.view at that location.
 *
 * PAY PERIODS (report dates: 14 Sep 2026)
 *   P1 business-wide · calculation · locked · 8–14 Sep (end 15 exclusive)
 *   P2 London        · calculation · paid   · 14–20 Sep
 *   P3 London        · approved         P4 London · ready_for_review     P5 London · draft
 *   P6 Other         · calculation · locked · 14–20 Sep
 *   P7 London        · PAYMENT period · locked
 *   P8 London        · calculation · locked · August (does not overlap)
 * STATEMENTS
 *   P1: Alice 5000 (a superseded 4000 is ignored) · Ben 0, base pay won, adjustments −300 · Ivy 700 (only here)
 *   P2: Alice 2500 · Ben 1000          P3–P5: Alice 99 each (never shown)       P6: Gil 1800
 * Currencies are VERIFIED GBP in this ledger, as a future provenance record would state them;
 * production statements are all unverified today (team-source.ts, and the currency tests below).
 */
import type { ReportActor } from '../report-actor';
import type { TeamReportBody } from '@sheer/domain';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { TeamReportService } from './team-report.service';
import { MemoryTeamSource, teamScope, type TeamLedger } from './testing/memory-team-source';
import { ALICE, AS_OF, BEN, BIZ, DAY, GIL, LOCATIONS, LONDON, OTHER, teamLedger, uid } from './testing/team-fixture';

const IVY = '30000000-0000-4000-8000-0000000000bb';
const P = Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map((key, i) => [key, `60000000-0000-4000-8000-00000000000${i + 1}`])) as Record<string, string>;

function ledger(): TeamLedger {
  const base = teamLedger();
  base.staff.push({ id: IVY, businessId: BIZ, userProfileId: 'u-ivy', name: 'Ivy' });
  const period = (id: string, locationId: string | null, status: 'draft' | 'ready_for_review' | 'approved' | 'locked' | 'paid', periodStart: string, periodEnd: string, kind: 'calculation' | 'payment' = 'calculation') =>
    base.payPeriods.push({ id, businessId: BIZ, locationId, label: null, periodStart, periodEnd, status, kind });
  period(P.P1, null, 'locked', '2026-09-08', '2026-09-15');
  period(P.P2, LONDON, 'paid', '2026-09-14', '2026-09-21');
  period(P.P3, LONDON, 'approved', '2026-09-14', '2026-09-21');
  period(P.P4, LONDON, 'ready_for_review', '2026-09-14', '2026-09-21');
  period(P.P5, LONDON, 'draft', '2026-09-14', '2026-09-21');
  period(P.P6, OTHER, 'locked', '2026-09-14', '2026-09-21');
  period(P.P7, LONDON, 'locked', '2026-09-14', '2026-09-21', 'payment');
  period(P.P8, LONDON, 'locked', '2026-08-01', '2026-09-01');
  const statement = (payPeriodId: string, staffProfileId: string, commissionCents: number, extra: Partial<TeamLedger['paySummaries'][number]> = {}) =>
    base.paySummaries.push({
      id: uid(),
      businessId: BIZ,
      payPeriodId,
      staffProfileId,
      currency: { status: 'verified', code: 'GBP' },
      commissionCents,
      adjustmentsCents: 0,
      greaterOfApplied: false,
      greaterOfWinner: null,
      ...extra,
    });
  statement(P.P1, ALICE, 5000);
  statement(P.P1, ALICE, 4000, { supersededById: 'newer' });
  statement(P.P1, BEN, 0, { greaterOfApplied: true, greaterOfWinner: 'base_pay', adjustmentsCents: -300 });
  statement(P.P1, IVY, 700);
  statement(P.P2, ALICE, 2500);
  statement(P.P2, BEN, 1000);
  for (const id of [P.P3, P.P4, P.P5, P.P7, P.P8]) statement(id, ALICE, 99);
  statement(P.P6, GIL, 1800);
  return base;
}

const EMPTY_MONEY: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [], locations: [] };
const OWNER: ReportActor = { id: 'owner', businessId: BIZ, roles: ['owner'] };
const managerWith = (permissions: Array<'report.performance.view' | 'report.commission.view'>): ReportActor => ({
  id: 'manager',
  businessId: BIZ,
  roles: ['manager'],
  membershipGrants: [{ locationId: LONDON, permissions }],
});

const build = (actor: ReportActor, locations = LOCATIONS, staffProfileIds: string[] = []): Promise<TeamReportBody> =>
  new TeamReportService(new MemoryMoneySource(EMPTY_MONEY), new MemoryTeamSource(ledger())).build(teamScope(BIZ, locations, { ...DAY, staffProfileIds }, AS_OF, actor));

const gbp = (cents: number) => ({ availability: 'available', cents });

describe('R2 finalised commission', () => {
  it('owner: locked and paid calculation periods overlapping the dates, newest first — never approved, review, draft, payment or out-of-range', async () => {
    const body = await build(OWNER);
    const { periods, restrictions } = body.finalisedCommission;
    expect(periods.map((period) => [period.payPeriodId, period.scope, period.status, period.periodStart, period.periodEnd])).toEqual([
      [P.P2, { kind: 'location', locationId: LONDON }, 'paid', '2026-09-14', '2026-09-20'],
      [P.P6, { kind: 'location', locationId: OTHER }, 'locked', '2026-09-14', '2026-09-20'],
      [P.P1, { kind: 'business' }, 'locked', '2026-09-08', '2026-09-14'],
    ]);
    expect(restrictions).toEqual([]);
    expect(JSON.stringify(body.finalisedCommission)).not.toContain('"cents":99');
  });

  it('shows statements as locked — commission, adjustments apart, greater-of outcome — and never the superseded one', async () => {
    const body = await build(OWNER);
    const p1 = body.finalisedCommission.periods.find((period) => period.payPeriodId === P.P1)!;
    expect(p1.lines).toEqual([
      { staff: { kind: 'staff', staffProfileId: ALICE, name: 'Alice' }, currency: { status: 'verified', code: 'GBP' }, commission: gbp(5000), adjustments: gbp(0), greaterOf: 'not_applied' },
      { staff: { kind: 'staff', staffProfileId: BEN, name: 'Ben' }, currency: { status: 'verified', code: 'GBP' }, commission: gbp(0), adjustments: gbp(-300), greaterOf: 'base_pay_won' },
      { staff: { kind: 'staff', staffProfileId: IVY, name: 'Ivy' }, currency: { status: 'verified', code: 'GBP' }, commission: gbp(700), adjustments: gbp(0), greaterOf: 'not_applied' },
    ]);
    expect(p1.total).toEqual(gbp(5700));
    expect(p1.currencyCode).toBe('GBP');
    expect(p1.statements).toBe(3);
  });

  it('a manager with a commission grant at London sees London’s period only; business-wide periods are owner-only', async () => {
    const body = await build(managerWith(['report.performance.view', 'report.commission.view']), [LOCATIONS[0]]);
    expect(body.finalisedCommission.periods.map((period) => period.payPeriodId)).toEqual([P.P2]);
    expect(body.finalisedCommission.restrictions).toEqual(['business_wide_owner_only']);
    // Ivy appears only on the business-wide statement: not in this manager's picker.
    expect(body.staffOptions.map((option) => option.staffProfileId)).not.toContain(IVY);
  });

  it('a manager without a commission grant sees no statement at all', async () => {
    const body = await build(managerWith(['report.performance.view']), [LOCATIONS[0]]);
    expect(body.finalisedCommission).toEqual({ periods: [], restrictions: ['business_wide_owner_only', 'location_commission_permission_required'] });
  });

  it('owner: staff seen only on a business-wide statement can be selected; the filter narrows lines, not the period total', async () => {
    const all = await build(OWNER);
    expect(all.staffOptions.find((option) => option.staffProfileId === IVY)).toEqual({ staffProfileId: IVY, kind: 'staff', name: 'Ivy', locationIds: [] });
    const ben = await build(OWNER, LOCATIONS, [BEN]);
    const p2 = ben.finalisedCommission.periods.find((period) => period.payPeriodId === P.P2)!;
    expect(p2.lines.map((line) => line.staff)).toEqual([{ kind: 'staff', staffProfileId: BEN, name: 'Ben' }]);
    expect(p2.total).toEqual(gbp(3500));
  });

  describe('statement currency: never relabelled, defaulted or converted', () => {
    const EUR_PERIOD = '60000000-0000-4000-8000-0000000000e1';
    const withStatements = (currency: Array<TeamLedger['paySummaries'][number]['currency']>): TeamLedger => {
      const team = ledger();
      team.payPeriods = [{ id: EUR_PERIOD, businessId: BIZ, locationId: LONDON, label: null, periodStart: '2026-09-14', periodEnd: '2026-09-21', status: 'locked', kind: 'calculation' }];
      team.paySummaries = currency.map((c, i) => ({
        id: uid(),
        businessId: BIZ,
        payPeriodId: EUR_PERIOD,
        staffProfileId: [ALICE, BEN][i],
        currency: c,
        commissionCents: 1000 * (i + 1),
        adjustmentsCents: -50,
        greaterOfApplied: false,
        greaterOfWinner: null,
      }));
      return team;
    };
    const period = async (team: TeamLedger) =>
      (await new TeamReportService(new MemoryMoneySource(EMPTY_MONEY), new MemoryTeamSource(team)).build(teamScope(BIZ, LOCATIONS, DAY, AS_OF, OWNER))).finalisedCommission.periods[0];

    it('a verified GBP period is stated in GBP', async () => {
      const p = await period(withStatements([{ status: 'verified', code: 'GBP' }]));
      expect([p.currencyCode, p.total, p.lines[0].currency, p.lines[0].commission]).toEqual(['GBP', gbp(1000), { status: 'verified', code: 'GBP' }, gbp(1000)]);
    });

    it('a verified non-GBP period is stated in its own currency, never the location’s (London is GBP)', async () => {
      const p = await period(withStatements([{ status: 'verified', code: 'EUR' }, { status: 'verified', code: 'EUR' }]));
      expect([p.currencyCode, p.total]).toEqual(['EUR', gbp(3000)]);
      expect(p.lines.map((line) => line.currency)).toEqual([{ status: 'verified', code: 'EUR' }, { status: 'verified', code: 'EUR' }]);
    });

    it('legacy / unverified currency: amounts and the total are unavailable, with no currency code — never a silent GBP', async () => {
      const p = await period(withStatements([{ status: 'unverified' }, { status: 'verified', code: 'GBP' }]));
      const unverified = { availability: 'unavailable', reason: 'currency_unverified' };
      expect(p.currencyCode).toBeNull();
      expect(p.total).toEqual(unverified);
      expect(p.lines[0]).toEqual({ staff: { kind: 'staff', staffProfileId: ALICE, name: 'Alice' }, currency: { status: 'unverified' }, commission: unverified, adjustments: unverified, greaterOf: 'not_applied' });
      // The verified statement beside it keeps its own figures.
      expect(p.lines[1].commission).toEqual(gbp(2000));
    });

    it('mixed verified currencies: the period total is unavailable, each statement keeps its own', async () => {
      const p = await period(withStatements([{ status: 'verified', code: 'GBP' }, { status: 'verified', code: 'EUR' }]));
      expect([p.currencyCode, p.total]).toEqual([null, { availability: 'unavailable', reason: 'mixed_currencies' }]);
    });

    it('a pay period with no statements has no total, not a zero', async () => {
      const p = await period(withStatements([]));
      expect([p.statements, p.total, p.currencyCode]).toEqual([0, { availability: 'unavailable', reason: 'no_pay_statements' }, null]);
    });
  });

  it('never states live commission', async () => {
    const body = await build(OWNER);
    expect(body.unavailableMetrics).toContainEqual({ metric: 'live_commission', reason: 'payroll_rules_not_implemented' });
  });
});
