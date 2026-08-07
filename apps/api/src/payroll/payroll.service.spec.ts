/**
 * Data-source capture toggle: the honesty guard.
 *
 * Marking a source "captured" silences its warnings and lets £0 stand as a
 * real figure — so only sources with an actual capture path in the product
 * may ever be flipped on. Everything else is refused, not trusted.
 *
 * Stylist self-view: the visibility contract. Own summaries only, and only
 * once the parent period is approved/locked/paid — draft figures are the
 * owner's unreviewed working numbers and must be indistinguishable from
 * nonexistent (404, never 403).
 */

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { createSupabaseFake, createSupabaseFakeState } from '../common/testing/supabase-fake';
import { PayrollService } from './payroll.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b1000000-0000-0000-0000-000000000001';
const STAFF_ID = 's1000000-0000-0000-0000-000000000001';
const COLLEAGUE_STAFF_ID = 's2000000-0000-0000-0000-000000000002';
const APPROVED_PERIOD_ID = 'p1000000-0000-0000-0000-000000000001';
const DRAFT_PERIOD_ID = 'p2000000-0000-0000-0000-000000000002';

function owner(): AuthUser {
  return {
    id: 'u1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS_ID,
    allowedLocationIds: [],
    permissions: ['payroll.view', 'payroll.edit'],
  } as unknown as AuthUser;
}

function buildService(state = createSupabaseFakeState()) {
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = { getOrThrow: (key: string) => `fake-${key}` } as never;
  const inputs = {
    loadCaptureMatrix: jest.fn().mockResolvedValue({ capture: {}, rows: [] }),
    loadStaff: jest
      .fn()
      .mockResolvedValue([{ staffProfileId: STAFF_ID, staffName: 'Sam Stylist' }]),
  } as never;
  const periods = {} as never;
  const readiness = {} as never;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new PayrollService(config, inputs, periods, readiness, audit as never),
    audit,
    state,
  };
}

describe('updateDataSource honesty guard', () => {
  it.each(['tips', 'refunds', 'cancellation_fees', 'service_revenue', 'product_cost'] as const)(
    'refuses marking %s as captured (no capture path)',
    async (source) => {
      const { service } = buildService();
      await expect(service.updateDataSource(owner(), source, true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('allows toggling retail_sales and audits the change', async () => {
    const state = createSupabaseFakeState({
      'payroll.business_data_sources': [
        { business_id: BUSINESS_ID, source: 'retail_sales', is_captured: false, notes: null },
      ],
    });
    const { service, audit } = buildService(state);
    await service.updateDataSource(owner(), 'retail_sales', true);
    const row = state.tables.get('payroll.business_data_sources')![0];
    expect(row.is_captured).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ action: 'payroll.data_source_updated' }),
    );
  });

  it('allows turning any source OFF (the safe direction is always allowed)', async () => {
    const state = createSupabaseFakeState({
      'payroll.business_data_sources': [
        { business_id: BUSINESS_ID, source: 'retail_sales', is_captured: true, notes: null },
      ],
    });
    const { service } = buildService(state);
    await service.updateDataSource(owner(), 'retail_sales', false);
    expect(state.tables.get('payroll.business_data_sources')![0].is_captured).toBe(false);
  });
});

/** Null = an account with no staff profile row (owner-only logins). */
function stylist(staffProfileId: string | null = STAFF_ID): AuthUser {
  return {
    id: 'u2',
    roles: ['stylist'],
    primaryRole: 'stylist',
    businessId: BUSINESS_ID,
    allowedLocationIds: [],
    permissions: ['payroll.self.view'],
    staffProfileId: staffProfileId ?? undefined,
  } as unknown as AuthUser;
}

function periodRow(id: string, status: string) {
  return {
    id,
    business_id: BUSINESS_ID,
    location_id: null,
    kind: 'calculation',
    frequency: 'weekly',
    period_start: '2026-07-27',
    period_end: '2026-08-03',
    label: null,
    status,
  };
}

function summaryRow(id: string, payPeriodId: string, staffProfileId: string) {
  return {
    id,
    business_id: BUSINESS_ID,
    pay_period_id: payPeriodId,
    staff_profile_id: staffProfileId,
    employment_type_snapshot: 'employed',
    structure_id: null,
    structure_version_id: null,
    currency_code: 'GBP',
    service_revenue_cents: 180000,
    retail_revenue_cents: 0,
    total_collected_cents: 180000,
    base_pay_cents: 48840,
    commission_cents: 18000,
    revenue_split_cents: 0,
    bonus_cents: 0,
    chair_rent_cents: 0,
    deductions_cents: 0,
    tips_paid_out_cents: 0,
    tips_owed_cents: 0,
    adjustments_cents: 0,
    net_payable_cents: 66840,
    business_retained_cents: 113160,
    greater_of_applied: false,
    greater_of_winner: null,
    is_stale: false,
    stale_reason: null,
    superseded_by_id: null,
    inputs_snapshot: {},
    generated_by_user_profile_id: null,
    generated_at: '2026-08-03T08:00:00.000Z',
    exported_at: null,
    emailed_at: null,
    created_at: '2026-08-03T08:00:00.000Z',
    updated_at: '2026-08-03T08:00:00.000Z',
  };
}

function selfViewState() {
  return createSupabaseFakeState({
    'payroll.pay_periods': [
      periodRow(APPROVED_PERIOD_ID, 'approved'),
      periodRow(DRAFT_PERIOD_ID, 'draft'),
    ],
    'payroll.pay_summaries': [
      summaryRow('sum-approved', APPROVED_PERIOD_ID, STAFF_ID),
      summaryRow('sum-draft', DRAFT_PERIOD_ID, STAFF_ID),
      summaryRow('sum-colleague', APPROVED_PERIOD_ID, COLLEAGUE_STAFF_ID),
    ],
  });
}

describe('stylist self-view visibility', () => {
  it('refuses an actor with no staff profile', async () => {
    const { service } = buildService(selfViewState());
    await expect(service.listOwnSummaries(stylist(null))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.getOwnSummaryBreakdown(stylist(null), 'sum-approved'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lists only own summaries in approved/locked/paid periods, with the period attached', async () => {
    const { service } = buildService(selfViewState());
    const response = await service.listOwnSummaries(stylist());
    expect(response.summaries.map((s) => s.summaryId)).toEqual(['sum-approved']);
    expect(response.summaries[0].period).toEqual({
      payPeriodId: APPROVED_PERIOD_ID,
      kind: 'calculation',
      periodStart: '2026-07-27',
      periodEnd: '2026-08-03',
      label: null,
      status: 'approved',
    });
    expect(response.summaries[0].netPayableCents).toBe(66840);
  });

  it.each(['locked', 'paid'] as const)('a %s period is visible', async (status) => {
    const state = createSupabaseFakeState({
      'payroll.pay_periods': [periodRow(APPROVED_PERIOD_ID, status)],
      'payroll.pay_summaries': [summaryRow('sum-approved', APPROVED_PERIOD_ID, STAFF_ID)],
    });
    const { service } = buildService(state);
    const response = await service.listOwnSummaries(stylist());
    expect(response.summaries).toHaveLength(1);
    expect(response.summaries[0].period.status).toBe(status);
  });

  it('a ready_for_review period is still hidden — approval is the publish gate', async () => {
    const state = createSupabaseFakeState({
      'payroll.pay_periods': [periodRow(DRAFT_PERIOD_ID, 'ready_for_review')],
      'payroll.pay_summaries': [summaryRow('sum-draft', DRAFT_PERIOD_ID, STAFF_ID)],
    });
    const { service } = buildService(state);
    const response = await service.listOwnSummaries(stylist());
    expect(response.summaries).toHaveLength(0);
  });

  it('resolves the breakdown for an own summary in an approved period', async () => {
    const { service } = buildService(selfViewState());
    const response = await service.getOwnSummaryBreakdown(stylist(), 'sum-approved');
    expect(response.breakdown.summary.id).toBe('sum-approved');
    expect(response.breakdown.staffName).toBe('Sam Stylist');
  });

  it('404s an own summary whose period is still draft — same as nonexistent', async () => {
    const { service } = buildService(selfViewState());
    await expect(service.getOwnSummaryBreakdown(stylist(), 'sum-draft')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s a colleague's summary id — no existence oracle", async () => {
    const { service } = buildService(selfViewState());
    await expect(
      service.getOwnSummaryBreakdown(stylist(), 'sum-colleague'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
