import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacColourPrepRead } from '../ports/zac-service-ports';
import { InventoryColourPrepRiskTool } from './inventory-colour-prep-risk.tool';

/**
 * Workstream 3 — planned appointment / stock correlation.
 *
 * The behaviour these specs exist to pin is the HONESTY RULE: a shortfall
 * figure is a lower bound whenever any part of the picture is missing, so the
 * tool may say "you are short", but must never say "you have enough" while a
 * client has no formula on file, a formula line is unmapped, or a required
 * product is not stocked. On the live forward book one of the two upcoming
 * colour appointments is exactly the first case.
 */

const CONTEXT = { roleContext: 'owner', roles: ['owner'] } as unknown as ZacActingContext;

const OWNER = {
  id: 'user-1',
  businessId: 'biz-1',
  roles: ['owner'],
  permissions: ['zac.access', 'inventory.manage'],
  allowedLocationIds: [],
} as unknown as AuthUser;

const LOCATIONS = async () => [{ id: 'loc-1', name: 'Kensington' }];

function product(over: Record<string, unknown> = {}) {
  return {
    productId: 'p1',
    productName: 'Majirel 6.0 Dark Blonde',
    stockUnit: 'gram',
    requiredGrams: 6,
    onHandGrams: 319,
    shortfallGrams: 0,
    state: 'sufficient',
    appointmentCount: 1,
    ...over,
  };
}

function plan(over: Record<string, unknown> = {}, summaryOver: Record<string, unknown> = {}) {
  return {
    locationId: 'loc-1',
    locationName: 'Kensington',
    timezone: 'Europe/London',
    range: 'custom',
    from: '2026-09-11T00:00:00.000Z',
    to: '2026-09-25T00:00:00.000Z',
    fromDate: '2026-09-11',
    toDate: '2026-09-24',
    wasteAllowancePercent: 10,
    appointments: [],
    products: [product()],
    summary: {
      appointmentCount: 1,
      appointmentsWithoutFormula: 0,
      productCount: 1,
      shortfallProductCount: 0,
      lowStockProductCount: 0,
      unmappedProductCount: 0,
      ...summaryOver,
    },
    ...over,
  };
}

function port(value: unknown): ZacColourPrepRead {
  return { getPlan: jest.fn().mockResolvedValue(value) } as unknown as ZacColourPrepRead;
}

function tool(p: ZacColourPrepRead, locations = LOCATIONS) {
  return new InventoryColourPrepRiskTool(p, locations as never);
}

describe('InventoryColourPrepRiskTool — contract and window', () => {
  it('is live, read-only and claims no PII', () => {
    const subject = tool(port(plan()));

    expect(subject.enabled).toBe(true);
    expect(subject.readOnly).toBe(true);
    expect(subject.piiLevel).toBe('none');
    expect(subject.requiredPermissions).toEqual(['inventory.manage']);
  });

  it('asks for a rolling custom window, never a Monday-based calendar week', async () => {
    // `this_week` asked on a Friday covers a week that is nearly over and
    // catches none of the live appointments (15th, 17th, 24th).
    const p = port(plan());
    await tool(p).execute(OWNER, CONTEXT, {});

    const call = (p.getPlan as jest.Mock).mock.calls[0];
    expect(call[1]).toMatchObject({ range: 'custom' });
    expect(call[1].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call[1].to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('honours an explicit horizon, bounded to something defensible', async () => {
    const p = port(plan());
    await tool(p).execute(OWNER, CONTEXT, { horizonDays: 999 });

    const { from, to } = (p.getPlan as jest.Mock).mock.calls[0][1];
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(60);
  });

  it('states the window it actually covered', async () => {
    const result = await tool(port(plan())).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('2026-09-11');
    expect(result.presentation?.answer).toContain('2026-09-24');
  });
});

describe('InventoryColourPrepRiskTool — the sufficiency rule', () => {
  it('says stock covers the work ONLY when nothing was unknown', async () => {
    const result = await tool(port(plan())).execute(OWNER, CONTEXT, {});

    expect(result.data?.['sufficiency_claimable']).toBe(true);
    expect(result.presentation?.answer).toContain('Every product those formulas need is in stock');
  });

  it('refuses to claim sufficiency when a client has no formula on file', async () => {
    // The live 2026-09-15 appointment. That client contributes ZERO required
    // grams, so "you have enough" would be measured against a partial demand.
    const result = await tool(
      port(plan({}, { appointmentCount: 2, appointmentsWithoutFormula: 1 })),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['sufficiency_claimable']).toBe(false);
    expect(result.presentation?.answer).not.toContain('Every product those formulas need is in stock');
    expect(result.presentation?.answer).toContain('stopped short of saying you are covered');
    expect(result.presentation?.answer).toContain('need a consultation');
  });

  it('refuses to claim sufficiency when a formula line is unmapped', async () => {
    const result = await tool(
      port(
        plan(
          { products: [product({ state: 'unmapped_product', productId: undefined })] },
          { unmappedProductCount: 1 },
        ),
      ),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['sufficiency_claimable']).toBe(false);
    expect(result.presentation?.limitations.join(' ')).toContain('not linked to a catalogue product');
  });

  it('refuses to claim sufficiency when a required product is not stocked', async () => {
    const result = await tool(
      port(plan({ products: [product({ state: 'not_stocked' })] })),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['sufficiency_claimable']).toBe(false);
    expect(result.presentation?.limitations.join(' ')).toContain('no stock record');
  });

  it('names shortfalls and ranks the worst first', async () => {
    const result = await tool(
      port(
        plan(
          {
            products: [
              product({ productName: 'Small gap', state: 'shortfall', shortfallGrams: 10 }),
              product({ productName: 'Big gap', state: 'shortfall', shortfallGrams: 200 }),
            ],
          },
          { shortfallProductCount: 2 },
        ),
      ),
    ).execute(OWNER, CONTEXT, {});

    const answer = result.presentation?.answer ?? '';
    expect(answer.indexOf('Big gap')).toBeLessThan(answer.indexOf('Small gap'));
    expect(result.presentation?.responseType).toBe('Risk');
  });
});

describe('InventoryColourPrepRiskTool — emptiness and failure', () => {
  it('treats a quiet forward book as a true answer, not a failure', async () => {
    const result = await tool(port(plan({ products: [] }, { appointmentCount: 0 }))).execute(
      OWNER,
      CONTEXT,
      {},
    );

    expect(result.status).toBe('ok');
    expect(result.rowCount).toBe(0);
    expect(result.presentation?.responseType).toBe('Explanation');
    expect(result.presentation?.answer).toContain('No colour work is booked');
    // Explains the one way this can be misleading.
    expect(result.presentation?.answer).toContain('not linked to a colour billing category');
  });

  it('degrades to unavailable when every location read fails', async () => {
    const p = { getPlan: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ZacColourPrepRead;
    const result = await tool(p).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('unavailable');
  });

  it('names the waste allowance as a planning uplift, not measured waste', async () => {
    const result = await tool(port(plan())).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.limitations.join(' ')).toContain('planning uplift you configured, not measured waste');
  });
});

describe('InventoryColourPrepRiskTool — PII', () => {
  it('never reads the appointment list, so no client or stylist name can escape', async () => {
    const withNames = plan({
      appointments: [
        {
          appointmentId: 'a1',
          scheduledStartAt: '2026-09-17T09:00:00.000Z',
          clientProfileId: 'c1',
          clientName: 'Sarah Whitfield',
          stylistName: 'Maya Chen',
          serviceNames: ['Full Head Colour'],
          billingCategories: ['permanent_colour'],
          state: 'formula_on_file',
          items: [],
        },
      ],
    });

    const result = await tool(port(withNames)).execute(OWNER, CONTEXT, {});
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('Sarah Whitfield');
    expect(serialised).not.toContain('Maya Chen');
    expect(serialised).not.toContain('c1');
  });
});
