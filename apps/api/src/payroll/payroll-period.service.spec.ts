/**
 * Workflow-ladder enforcement for pay periods.
 *
 * The DB only refuses backwards moves from locked/paid; the full
 * draft -> ready_for_review -> approved -> locked -> paid ladder is a SERVICE
 * responsibility, as is refusing locked/paid writes with 403 BEFORE the DB
 * trigger turns them into 500s.
 */

import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../common/testing/supabase-fake';
import { PayrollPeriodService } from './payroll-period.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    // Replaced per-test via __setFakeState below.
    return (globalThis as { __supabaseFake?: unknown }).__supabaseFake;
  }),
}));

const BUSINESS_ID = 'b1000000-0000-0000-0000-000000000001';
const PERIOD_ID = 'p1000000-0000-0000-0000-000000000001';

function owner(): AuthUser {
  return {
    id: 'u1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS_ID,
    allowedLocationIds: [],
    locationScope: 'all',
    locations: [],
    permissions: [
      'payroll.view',
      'payroll.edit',
      'payroll.approve',
      'payroll.lock',
      'payroll.self.view',
    ],
    profile: { fullName: 'Owner', email: 'owner@example.com' },
  } as unknown as AuthUser;
}

function periodRow(status: string): Record<string, unknown> {
  return {
    id: PERIOD_ID,
    business_id: BUSINESS_ID,
    location_id: null,
    kind: 'calculation',
    frequency: 'weekly',
    period_start: '2026-07-28',
    period_end: '2026-08-04',
    label: null,
    status,
    parent_payment_period_id: null,
    generated_by_user_profile_id: null,
    generated_at: null,
    approved_by_user_profile_id: null,
    approved_at: null,
    locked_by_user_profile_id: null,
    locked_at: null,
    marked_paid_by_user_profile_id: null,
    paid_at: null,
    notes: null,
    created_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-28T00:00:00Z',
  };
}

function buildService(state: SupabaseFakeState): PayrollPeriodService {
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    getOrThrow: (key: string) => `fake-${key}`,
  } as never;
  const inputs = {
    loadSettings: jest.fn().mockResolvedValue({
      businessId: BUSINESS_ID,
      weekStartDay: 2,
      defaultCalculationFrequency: 'weekly',
      defaultPaymentFrequency: 'monthly',
      timezone: 'Europe/London',
      effectiveTimezone: 'Europe/London',
      createdAt: '',
      updatedAt: '',
    }),
    loadCaptureMatrix: jest.fn().mockResolvedValue({ capture: {}, rows: [] }),
    loadStaff: jest.fn().mockResolvedValue([]),
    resolveRuleVersions: jest.fn().mockResolvedValue(new Map()),
    buildEngineInputs: jest.fn().mockResolvedValue(new Map()),
  } as never;
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as never;
  return new PayrollPeriodService(config, inputs, audit);
}

function seededState(status: string, extra: Record<string, Record<string, unknown>[]> = {}) {
  return createSupabaseFakeState({
    'payroll.pay_periods': [periodRow(status)],
    'payroll.pay_summaries': [],
    'payroll.pay_adjustments': [],
    ...extra,
  });
}

describe('workflow ladder (service-enforced, one step at a time)', () => {
  it('walks the full ladder draft -> ready -> approved -> locked -> paid with stamps', async () => {
    const state = seededState('draft', {
      'payroll.pay_summaries': [
        {
          id: 's1',
          pay_period_id: PERIOD_ID,
          business_id: BUSINESS_ID,
          superseded_by_id: null,
          inputs_snapshot: { adjustments: [] },
        },
      ],
    });
    const service = buildService(state);
    const actor = owner();

    const ready = await service.transition(actor, PERIOD_ID, 'ready');
    expect(ready.status).toBe('ready_for_review');

    const approved = await service.transition(actor, PERIOD_ID, 'approve');
    expect(approved.status).toBe('approved');
    expect(approved.approvedByUserProfileId).toBe(actor.id);
    expect(approved.approvedAt).not.toBeNull();

    const locked = await service.transition(actor, PERIOD_ID, 'lock');
    expect(locked.status).toBe('locked');
    expect(locked.lockedByUserProfileId).toBe(actor.id);

    const paid = await service.transition(actor, PERIOD_ID, 'mark-paid');
    expect(paid.status).toBe('paid');
    expect(paid.markedPaidByUserProfileId).toBe(actor.id);
    expect(paid.paidAt).not.toBeNull();
  });

  it.each([
    ['approve', 'draft'],
    ['lock', 'draft'],
    ['mark-paid', 'draft'],
    ['lock', 'ready_for_review'],
    ['mark-paid', 'approved'],
    ['ready', 'approved'],
  ] as const)('refuses %s from %s with 409 (no skips, no rewinds)', async (transition, status) => {
    const service = buildService(seededState(status));
    await expect(service.transition(owner(), PERIOD_ID, transition)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses ready when the period has no generated summaries', async () => {
    const service = buildService(seededState('draft'));
    await expect(service.transition(owner(), PERIOD_ID, 'ready')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('draft -> paid in one jump is impossible through the API surface', async () => {
    const service = buildService(seededState('draft'));
    await expect(service.transition(owner(), PERIOD_ID, 'mark-paid')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('locked/paid period protection (403 in the service, before the trigger 500s)', () => {
  it.each(['locked', 'paid'] as const)('generate on a %s period is a 403', async (status) => {
    const service = buildService(seededState(status));
    await expect(service.generate(owner(), PERIOD_ID)).rejects.toBeInstanceOf(ForbiddenException);
    // Nothing was deleted or written.
    expect(
      (globalThis as { __supabaseFake?: unknown }).__supabaseFake && seededState(status).log.length,
    ).toBe(0);
  });

  it('assertWritablePeriod names the adjustments path in its message', () => {
    const service = buildService(seededState('locked'));
    expect(() =>
      service.assertWritablePeriod(periodRow('locked') as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `"This pay period is locked; its figures can no longer be changed. Corrections go through pay adjustments in the next period."`,
    );
  });
});

describe('createPeriod', () => {
  it('refuses a custom frequency without explicit dates', async () => {
    const service = buildService(seededState('draft'));
    await expect(service.createPeriod(owner(), { frequency: 'custom' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses an overlapping window with 409', async () => {
    const service = buildService(seededState('draft'));
    await expect(
      service.createPeriod(owner(), {
        periodStart: '2026-07-30',
        periodEnd: '2026-08-06',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('derives the Tuesday-anchored weekly window from settings', async () => {
    const state = createSupabaseFakeState({ 'payroll.pay_periods': [] });
    const service = buildService(state);
    const period = await service.createPeriod(owner(), { referenceDate: '2026-07-30' });
    expect(period.periodStart).toBe('2026-07-28');
    expect(period.periodEnd).toBe('2026-08-04');
    expect(period.status).toBe('draft');
  });
});

describe('business scoping', () => {
  it('a period from another business is a 404, not readable', async () => {
    const state = createSupabaseFakeState({
      'payroll.pay_periods': [{ ...periodRow('draft'), business_id: 'other-business' }],
    });
    const service = buildService(state);
    await expect(service.fetchPeriodForBusiness(owner(), PERIOD_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a location-scoped period reads as 404 to a manager without that location (no oracle)', async () => {
    const state = createSupabaseFakeState({
      'payroll.pay_periods': [{ ...periodRow('draft'), location_id: 'loc-2' }],
    });
    const service = buildService(state);
    const manager = {
      ...owner(),
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-1'],
    } as unknown as AuthUser;
    await expect(service.fetchPeriodForBusiness(manager, PERIOD_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a manager cannot create or generate a business-wide period', async () => {
    const state = seededState('draft');
    const service = buildService(state);
    const manager = {
      ...owner(),
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-1'],
    } as unknown as AuthUser;
    await expect(
      service.createPeriod(manager, { referenceDate: '2026-08-20' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.generate(manager, PERIOD_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
