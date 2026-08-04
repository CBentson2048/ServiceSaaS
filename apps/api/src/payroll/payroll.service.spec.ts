/**
 * Data-source capture toggle: the honesty guard.
 *
 * Marking a source "captured" silences its warnings and lets £0 stand as a
 * real figure — so only sources with an actual capture path in the product
 * may ever be flipped on. Everything else is refused, not trusted.
 */

import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { createSupabaseFake, createSupabaseFakeState } from '../common/testing/supabase-fake';
import { PayrollService } from './payroll.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b1000000-0000-0000-0000-000000000001';

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
