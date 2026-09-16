/**
 * End-of-day service tests: the trading-day window arithmetic (DST-safe), the
 * sign-off variance freeze, and location scoping. The Supabase mock resolves
 * terminal calls (maybeSingle/single/returns/rpc) from an ordered queue so
 * each test scripts the exact database conversation it expects.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { EodService, businessDayWindow } from './eod.service';
import type { AuditService } from '../audit/audit.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

function createService(results: Array<{ data: unknown; error?: unknown }>) {
  let index = -1;
  const next = () => results[++index] ?? { data: null, error: null };
  const captured: { updates: Array<Record<string, unknown>> } = { updates: [] };
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  for (const method of ['from', 'select', 'eq', 'in', 'is', 'order', 'limit', 'range', 'insert']) {
    chain[method] = jest.fn(passthrough);
  }
  Object.assign(chain, {
    update: jest.fn((payload: Record<string, unknown>) => {
      captured.updates.push(payload);
      return chain;
    }),
    rpc: jest.fn(async () => ({ error: null, ...next() })),
    maybeSingle: jest.fn(async () => ({ error: null, ...next() })),
    single: jest.fn(async () => ({ error: null, ...next() })),
    returns: jest.fn(async () => ({ error: null, ...next() })),
  });
  mockedCreateClient.mockReturnValue({ schema: () => chain } as never);
  const config = { getOrThrow: jest.fn(() => 'test') } as unknown as ConfigService;
  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  const currencies = { locationCurrencies: jest.fn(async () => new Map([['location_1', 'GBP']])) };
  return { service: new EodService(config, audit, currencies), captured, audit };
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user_1',
    roles: ['manager'],
    primaryRole: 'manager',
    businessId: 'business_1',
    allowedLocationIds: ['location_1'],
    ...overrides,
  } as unknown as AuthUser;
}

function dayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'eod_1',
    business_id: 'business_1',
    location_id: 'location_1',
    business_date: '2026-08-12',
    status: 'open',
    opening_float_cents: 5000,
    expected_cash_cents: null,
    counted_cash_cents: null,
    expected_card_cents: null,
    counted_card_cents: null,
    unclassified_retail_cents: 0,
    deposits_collected_cents: 0,
    deposits_redeemed_cents: 0,
    voids_cents: 0,
    refunds_cents: 0,
    petty_cash_out_cents: 0,
    variance_cents: null,
    notes: null,
    signed_off_by_user_profile_id: null,
    signed_off_at: null,
    currency_code: 'GBP',
    created_at: '2026-08-12T08:00:00.000Z',
    updated_at: '2026-08-12T08:00:00.000Z',
    ...overrides,
  };
}

const locationRow = { data: { id: 'location_1', business_id: 'business_1', timezone: 'Europe/London' } };

const expectedFigures = (cash: number, card: number) => ({
  data: [
    {
      expected_cash_cents: cash,
      expected_card_cents: card,
      unclassified_retail_cents: 0,
      deposits_collected_cents: 2000,
      deposits_redeemed_cents: 2000,
      open_visits: 0,
    },
  ],
});

describe('businessDayWindow — location-local trading days', () => {
  it('maps a GMT (winter) date to UTC midnight boundaries', () => {
    expect(businessDayWindow('2026-01-15')).toEqual({
      start: '2026-01-15T00:00:00.000Z',
      end: '2026-01-16T00:00:00.000Z',
    });
  });

  it('maps a BST (summer) date to 23:00Z boundaries', () => {
    expect(businessDayWindow('2026-08-12')).toEqual({
      start: '2026-08-11T23:00:00.000Z',
      end: '2026-08-12T23:00:00.000Z',
    });
  });

  it('handles the spring DST changeover (a 23-hour trading day)', () => {
    // Clocks go forward 29 Mar 2026: midnight is GMT, next midnight is BST.
    expect(businessDayWindow('2026-03-29')).toEqual({
      start: '2026-03-29T00:00:00.000Z',
      end: '2026-03-29T23:00:00.000Z',
    });
  });
});

describe('EodService — scoping and lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a location outside the manager scope before any query', async () => {
    const { service } = createService([]);
    await expect(service.getDay(actor(), 'location_9')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses to change a signed-off day', async () => {
    const { service } = createService([
      { data: dayRow({ status: 'signed_off' }) }, // fetchDayById
      locationRow,                                // same-business location check
    ]);
    await expect(
      service.updateDay(actor(), 'eod_1', { countedCashCents: 1000 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sign-off recomputes expected figures and freezes counted − expected as the variance', async () => {
    const counted = dayRow({ counted_cash_cents: 10000, counted_card_cents: 20000 });
    const refreshed = dayRow({
      counted_cash_cents: 10000,
      counted_card_cents: 20000,
      expected_cash_cents: 9000,
      expected_card_cents: 20500,
    });
    const signedOff = { ...refreshed, status: 'signed_off', variance_cents: 500 };
    const { service, captured, audit } = createService([
      { data: counted },                    // fetchDayById
      locationRow,                          // same-business location check
      { data: [] },                         // applyExpected → petty cash entries
      expectedFigures(9000, 20500),         // applyExpected → rpc
      { data: refreshed },                  // applyExpected → update.single
      { data: signedOff },                  // sign-off update.single
      { data: [] },                         // buildDayResponse → petty cash
      { data: { cash_variance_threshold_amount: 5 } }, // threshold
      expectedFigures(9000, 20500),         // buildDayResponse → live figures
    ]);

    const result = await service.signOff(actor(), 'eod_1');

    // The frozen variance is (10000 + 20000) − (9000 + 20500) = +500.
    const signOffPatch = captured.updates[1];
    expect(signOffPatch.status).toBe('signed_off');
    expect(signOffPatch.variance_cents).toBe(500);
    expect(signOffPatch.signed_off_by_user_profile_id).toBe('user_1');
    expect(result.day?.status).toBe('signed_off');
    expect(result.cashVarianceThresholdCents).toBe(500);
    expect(
      (audit.record as jest.Mock).mock.calls.some(
        ([, params]) => (params as { action: string }).action === 'cashup.signed_off',
      ),
    ).toBe(true);
  });

  it('refuses to sign off before counted amounts are entered', async () => {
    const { service } = createService([{ data: dayRow() }, locationRow]);
    await expect(service.signOff(actor(), 'eod_1')).rejects.toThrow(
      'Enter the counted cash and card amounts',
    );
  });
});
