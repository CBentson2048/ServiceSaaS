/**
 * SupabaseTeamSource query shapes: every read is business-filtered, windowed reads
 * bind each location to its own window (never an envelope), keysets never use an
 * offset, and the status sets are the locked ones. A database or shape failure is
 * a 500, never an empty (zero) report.
 */
import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { MoneyWindow } from '../money/money-source';
import { MoneySourceShapeError } from '../money/money-values';
import { SupabaseTeamSource, dateOverlapFilter, overlapFilter, visitWindowFilter } from './team-source';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BIZ = 'biz-1';
const L1 = '50000000-0000-4000-8000-000000000001';
const L2 = '50000000-0000-4000-8000-000000000002';
const ID = '60000000-0000-4000-8000-000000000001';
const WINDOWS: MoneyWindow[] = [
  { locationId: L1, fromUtc: '2026-09-13T23:00:00.000Z', toUtcExclusive: '2026-09-14T23:00:00.000Z' },
  { locationId: L2, fromUtc: '2026-09-14T15:00:00.000Z', toUtcExclusive: '2026-09-15T15:00:00.000Z' },
];

interface Recorded {
  schema: string;
  table: string;
  ops: Array<[string, unknown[]]>;
}

function fake(result: { data: unknown; error: unknown }) {
  const queries: Recorded[] = [];
  const writes: unknown[] = [];
  const client = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const query: Recorded = { schema, table, ops: [] };
        queries.push(query);
        const builder: Record<string, unknown> = {};
        for (const op of ['select', 'eq', 'neq', 'in', 'gt', 'or', 'order', 'limit', 'not', 'is']) {
          builder[op] = (...args: unknown[]) => {
            query.ops.push([op, args]);
            return builder;
          };
        }
        for (const op of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
          builder[op] = (...args: unknown[]) => {
            writes.push([op, table, ...args]);
            return builder;
          };
        }
        builder.returns = () => Promise.resolve(result);
        return builder;
      },
    }),
  };
  mockedCreateClient.mockReturnValue(client as unknown as ReturnType<typeof createClient>);
  const source = new SupabaseTeamSource({ getOrThrow: () => 'placeholder' } as unknown as ConfigService);
  return { source, queries, writes };
}

const empty = { data: [], error: null };

describe('SupabaseTeamSource', () => {
  it('eligible visits: completed, awaiting payment or paid, by completed_at inside each location’s own window, instant keyset', async () => {
    const { source, queries } = fake(empty);
    await source.eligibleVisits(BIZ, WINDOWS, { key: '2026-09-14T10:00:00.000000Z', id: ID }, 1000);
    expect(queries[0]).toMatchObject({ schema: 'booking', table: 'visits' });
    expect(queries[0].ops).toEqual([
      ['select', ['id,location_id,completed_at,appointment_id,client_profile_id,primary_staff_profile_id']],
      ['eq', ['business_id', BIZ]],
      ['in', ['status', ['completed', 'awaiting_payment', 'paid']]],
      ['or', [visitWindowFilter(WINDOWS, { key: '2026-09-14T10:00:00.000000Z', id: ID })]],
      ['order', ['completed_at', { ascending: true }]],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
    expect(visitWindowFilter(WINDOWS, null)).toBe(
      `and(location_id.eq.${L1},completed_at.gte."2026-09-13T23:00:00.000Z",completed_at.lt."2026-09-14T23:00:00.000Z"),` +
        `and(location_id.eq.${L2},completed_at.gte."2026-09-14T15:00:00.000Z",completed_at.lt."2026-09-15T15:00:00.000Z")`,
    );
  });

  it('future appointments: this business, the clients, pending or accepted, starting strictly after the generation instant', async () => {
    const { source, queries } = fake(empty);
    await source.futureAppointments(BIZ, [ID], '2026-09-16T10:00:00.000000Z', null, 1000);
    expect(queries[0].ops).toEqual([
      ['select', ['id,client_profile_id,status']],
      ['eq', ['business_id', BIZ]],
      ['in', ['client_profile_id', [ID]]],
      ['in', ['status', ['pending', 'accepted']]],
      ['gt', ['scheduled_start_at', '2026-09-16T10:00:00.000000Z']],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
  });

  it('staff: active manager and stylist memberships at the locations, then staff profiles — never a primary location', async () => {
    const memberships = fake(empty);
    await memberships.source.activeMemberships(BIZ, [L1], null, 1000);
    expect(memberships.queries[0]).toMatchObject({ schema: 'core', table: 'user_memberships' });
    expect(memberships.queries[0].ops).toEqual([
      ['select', ['id,user_profile_id,location_id']],
      ['eq', ['business_id', BIZ]],
      ['eq', ['status', 'active']],
      ['in', ['role', ['manager', 'stylist']]],
      ['in', ['location_id', [L1]]],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
    const profiles = fake({ data: [{ id: ID, user_profile_id: ID, display_name: 'Alice', employment_status: 'on_leave' }], error: null });
    expect(await profiles.source.staffProfiles(BIZ, [ID])).toEqual([{ id: ID, userProfileId: ID, name: 'Alice', employmentStatus: 'on_leave' }]);
    expect(profiles.queries[0].ops).toEqual([
      ['select', ['id,user_profile_id,display_name,employment_status']],
      ['eq', ['business_id', BIZ]],
      ['in', ['id', [ID]]],
      ['limit', [1]],
    ]);
    expect(JSON.stringify([...memberships.queries, ...profiles.queries])).not.toContain('primary_location_id');
  });

  it('rota and bookings overlap each location’s own window; cancelled shifts and non-booking statuses are excluded', async () => {
    const shifts = fake(empty);
    await shifts.source.shifts(BIZ, WINDOWS, ID, 1000);
    expect(shifts.queries[0].ops).toEqual([
      ['select', ['id,location_id,staff_profile_id,scheduled_start_at,scheduled_end_at']],
      ['eq', ['business_id', BIZ]],
      ['neq', ['status', 'cancelled']],
      ['or', [overlapFilter('scheduled_start_at', 'scheduled_end_at', WINDOWS)]],
      ['gt', ['id', ID]],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
    expect(overlapFilter('starts_at', 'ends_at', [WINDOWS[0]], true)).toBe(
      `and(location_id.eq.${L1},starts_at.lt."2026-09-14T23:00:00.000Z",or(ends_at.is.null,ends_at.gt."2026-09-13T23:00:00.000Z"))`,
    );
    const booked = fake(empty);
    await booked.source.bookedAppointments(BIZ, WINDOWS, null, 1000);
    expect(booked.queries[0].ops).toContainEqual(['in', ['status', ['pending', 'accepted', 'checked_in', 'awaiting_payment', 'paid']]]);
    expect(booked.queries[0].ops).toContainEqual(['not', ['assigned_staff_profile_id', 'is', null]]);
    expect(booked.queries[0].ops).toContainEqual(['eq', ['business_id', BIZ]]);
  });

  it('approved leave of the staff, at any location, overlapping the report dates', async () => {
    const { source, queries } = fake(empty);
    await source.approvedLeave(BIZ, [ID], [{ from: '2026-09-14', to: '2026-09-20' }], null, 1000);
    expect(queries[0].ops).toEqual([
      ['select', ['id,location_id,staff_profile_id,start_date,end_date']],
      ['eq', ['business_id', BIZ]],
      ['eq', ['status', 'approved']],
      ['in', ['staff_profile_id', [ID]]],
      ['or', ['and(start_date.lte.2026-09-20,end_date.gte.2026-09-14)']],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
  });

  it('pay periods: calculation, locked or paid only, overlapping by the exclusive end; statements not superseded', async () => {
    const periods = fake(empty);
    await periods.source.finalisedPayPeriods(BIZ, [{ from: '2026-09-14', to: '2026-09-14' }], null, 1000);
    expect(periods.queries[0]).toMatchObject({ schema: 'payroll', table: 'pay_periods' });
    expect(periods.queries[0].ops).toEqual([
      ['select', ['id,location_id,label,period_start,period_end,status']],
      ['eq', ['business_id', BIZ]],
      ['eq', ['kind', 'calculation']],
      ['in', ['status', ['locked', 'paid']]],
      ['or', [dateOverlapFilter('period_start', 'period_end', [{ from: '2026-09-14', to: '2026-09-14' }], true)]],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
    expect(dateOverlapFilter('period_start', 'period_end', [{ from: '2026-09-14', to: '2026-09-14' }], true)).toBe('and(period_start.lte.2026-09-14,period_end.gt.2026-09-14)');
    const statements = fake({
      data: [{ id: ID, pay_period_id: ID, staff_profile_id: ID, currency_code: 'gbp', commission_cents: '1500', adjustments_cents: -300, greater_of_applied: true, greater_of_winner: 'base_pay' }],
      error: null,
    });
    expect(await statements.source.paySummaries(BIZ, [ID], null, 1000)).toEqual([
      { id: ID, payPeriodId: ID, staffProfileId: ID, currencyCode: 'GBP', commissionCents: 1500, adjustmentsCents: -300, greaterOfApplied: true, greaterOfWinner: 'base_pay' },
    ]);
    expect(statements.queries[0].ops).toContainEqual(['is', ['superseded_by_id', null]]);
    expect(statements.queries[0].ops).toContainEqual(['eq', ['business_id', BIZ]]);
  });

  it('is read-only, refuses unscoped input, and fails loudly on a bad shape or a database error', async () => {
    const { source, writes } = fake(empty);
    await expect(source.futureAppointments(BIZ, ['not-a-uuid'], '2026-09-16T10:00:00.000000Z', null, 10)).rejects.toThrow();
    await expect(source.futureAppointments(BIZ, [ID], '2026-09-16T10:00:00Z', null, 10)).rejects.toThrow();
    expect(() => overlapFilter('a', 'b', [])).toThrow();
    expect(() => dateOverlapFilter('a', 'b', [{ from: '14/09/2026', to: '2026-09-14' }], false)).toThrow();
    expect(writes).toEqual([]);
    const badStatus = fake({ data: [{ id: ID, client_profile_id: ID, status: 'no_show' }], error: null });
    await expect(badStatus.source.futureAppointments(BIZ, [ID], '2026-09-16T10:00:00.000000Z', null, 10)).rejects.toBeInstanceOf(MoneySourceShapeError);
    const badCurrency = fake({ data: [{ id: ID, pay_period_id: ID, staff_profile_id: ID, currency_code: '', commission_cents: 1, adjustments_cents: 0, greater_of_applied: false, greater_of_winner: null }], error: null });
    await expect(badCurrency.source.paySummaries(BIZ, [ID], null, 10)).rejects.toBeInstanceOf(MoneySourceShapeError);
    const failing = fake({ data: null, error: { message: 'boom' } });
    await expect(failing.source.shifts(BIZ, WINDOWS, null, 10)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
