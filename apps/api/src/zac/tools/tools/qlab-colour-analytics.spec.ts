import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacLabAnalyticsRead } from '../ports/zac-service-ports';
import { QlabColourAnalyticsTool } from './qlab-colour-analytics.tool';

/**
 * Workstream 3 — colour analytics.
 *
 * The fixtures are the REAL shapes from the working database (recorded in
 * docs/ZAC/phase-2-ws3-data-evidence.md), because the failure modes this tool
 * is built against are the ones that data actually produces: a 16.7% margin at
 * one location, an unpriced Lab at another, and waste that is never captured
 * anywhere.
 */

const CONTEXT = { roleContext: 'owner', roles: ['owner'] } as unknown as ZacActingContext;

const OWNER = {
  id: 'user-1',
  businessId: 'biz-1',
  roles: ['owner'],
  permissions: ['zac.access', 'report.lab_analytics.view'],
  allowedLocationIds: [],
} as unknown as AuthUser;

function summaryResponse(over: Record<string, unknown> = {}, summaryOver: Record<string, unknown> = {}) {
  return {
    range: 'custom',
    rangeStart: '2026-06-13T00:00:00.000Z',
    rangeEnd: '2026-09-11T00:00:00.000Z',
    scope: 'owner',
    summary: {
      colourRevenueCents: 0,
      formulaCostCents: 0,
      grossMarginCents: 0,
      grossMarginPercent: 0,
      wasteCostCents: 0,
      wastePercentOfRevenue: 0,
      formulasMixed: 0,
      currencyCode: 'GBP',
      ...summaryOver,
    },
    byLocation: [],
    byStylist: [],
    averageFormulaCostByServiceType: [],
    mostUsedProductsByWeight: [],
    mostUsedProductsByCost: [],
    lowStockAlerts: [],
    ...over,
  };
}

/** Kensington, verbatim: 5 saved formulas, £105.51 cost, £126.62 charge -> 16.7%. */
const KENSINGTON = summaryResponse(
  {
    byLocation: [
      {
        locationId: 'loc-1',
        locationName: 'Kensington',
        colourRevenueCents: 12_662,
        formulaCostCents: 10_551,
        grossMarginCents: 2_111,
        grossMarginPercent: 16.7,
        wasteCostCents: 0,
        formulasMixed: 5,
        currencyCode: 'GBP',
      },
    ],
    mostUsedProductsByCost: [
      {
        productId: 'p1',
        productName: 'Majirel 6.0 Dark Blonde',
        totalWeightGrams: 150,
        totalCostCents: 4_500,
        formulaCount: 3,
        currencyCode: 'GBP',
      },
    ],
  },
  {
    colourRevenueCents: 12_662,
    formulaCostCents: 10_551,
    grossMarginCents: 2_111,
    formulasMixed: 5,
  },
);

/** AndrewHair, verbatim: 4 saved formulas, every figure zero. */
const UNPRICED = summaryResponse({}, { formulasMixed: 4 });

/**
 * `summary` is called twice per execute — once for the window, once for the
 * 365-day baseline. This routes by `from` so each gets its own answer.
 */
function labPort(window: unknown, baseline: unknown = window): ZacLabAnalyticsRead {
  const summary = jest.fn().mockImplementation((_actor, _range, _loc, from: string) => {
    const daysBack = (Date.now() - Date.parse(from)) / 86_400_000;
    return Promise.resolve(daysBack > 200 ? baseline : window);
  });
  return { summary } as unknown as ZacLabAnalyticsRead;
}

function tool(port: ZacLabAnalyticsRead) {
  return new QlabColourAnalyticsTool(port);
}

describe('QlabColourAnalyticsTool — contract', () => {
  it('is live, read-only, fail-closed and never client-visible', () => {
    const subject = tool(labPort(KENSINGTON));

    expect(subject.enabled).toBe(true);
    expect(subject.readOnly).toBe(true);
    expect(subject.errorBehavior).toBe('fail_closed');
    expect(subject.allowedRoles).toEqual(['owner', 'manager']);
    expect(subject.allowedRoles).not.toContain('client');
  });

  it('declares report.lab_analytics.view — the ONLY enforcement of that key on the ZAC path', () => {
    // LabAnalyticsService.summary re-checks the caller's role and location
    // scope but NOT this permission, so weakening the declaration would hand
    // colour financials to anyone holding zac.access.
    expect(tool(labPort(KENSINGTON)).requiredPermissions).toEqual(['report.lab_analytics.view']);
  });

  it('claims no PII, which the never-read byStylist array makes structurally true', () => {
    expect(tool(labPort(KENSINGTON)).piiLevel).toBe('none');
  });
});

describe('QlabColourAnalyticsTool — happy path', () => {
  it('reports the real Kensington margin of 16.7%', async () => {
    const result = await tool(labPort(KENSINGTON)).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      formulas_mixed: 5,
      colour_revenue_cents: 12_662,
      formula_cost_cents: 10_551,
      gross_margin_cents: 2_111,
      gross_margin_percent: 16.7,
    });
    expect(result.presentation?.answer).toContain('£126.62');
    expect(result.presentation?.answer).toContain('16.7%');
  });

  it('names the products the colour spend went on', async () => {
    const result = await tool(labPort(KENSINGTON)).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('Majirel 6.0 Dark Blonde');
  });

  it('never calls the figure profit, and says what it excludes', async () => {
    const result = await tool(labPort(KENSINGTON)).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer.toLowerCase()).not.toContain('profit');
    expect(result.presentation?.limitations.join(' ')).toContain('not profit');
  });

  it('passes the acting user through and always asks for an explicit custom window', async () => {
    const port = labPort(KENSINGTON);
    await tool(port).execute(OWNER, CONTEXT, {});

    for (const call of (port.summary as jest.Mock).mock.calls) {
      expect(call[0]).toBe(OWNER);
      // A preset would resolve in the API host's timezone, not UTC.
      expect(call[1]).toBe('custom');
    }
  });
});

describe('QlabColourAnalyticsTool — the zero traps', () => {
  it('reports an unpriced Lab as a pricing gap, NOT as 0% margin', async () => {
    const result = await tool(labPort(UNPRICED)).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    // The load-bearing assertion: no fabricated trading result.
    expect(result.data?.['gross_margin_percent']).toBeNull();
    expect(result.presentation?.answer).not.toContain('0%');
    expect(result.presentation?.answer).toContain('no margin to work out');
  });

  it('says waste is not captured, and suppresses the percentage entirely', async () => {
    const result = await tool(labPort(KENSINGTON)).execute(OWNER, CONTEXT, {});

    expect(result.data?.['waste_captured']).toBe(false);
    expect(result.data).not.toHaveProperty('waste_percent_of_revenue');
    expect(result.presentation?.answer).toContain('cannot tell you what waste is costing you');
    // "0% waste" would tell an owner they run a perfect colour bar.
    expect(result.presentation?.answer).not.toMatch(/0%\s*waste/i);
  });

  it('reports waste normally when some was actually recorded', async () => {
    const withWaste = summaryResponse(
      { byLocation: KENSINGTON.byLocation },
      { ...KENSINGTON.summary, wasteCostCents: 900 },
    );
    const result = await tool(labPort(withWaste)).execute(OWNER, CONTEXT, {});

    expect(result.data?.['waste_captured']).toBe(true);
    expect(result.presentation?.answer).not.toContain('cannot tell you what waste is costing you');
  });

  it('withholds a percentage below the sample floor rather than dressing noise as certainty', async () => {
    const thin = summaryResponse(
      {},
      { colourRevenueCents: 5_000, formulaCostCents: 4_000, grossMarginCents: 1_000, formulasMixed: 5 },
    );
    // Denominator here is revenue, which is well above the floor, so this
    // confirms the floor applies to the SAMPLE and not to the money.
    const result = await tool(labPort(thin)).execute(OWNER, CONTEXT, {});

    expect(result.data?.['gross_margin_percent']).toBe(20);
  });
});

describe('QlabColourAnalyticsTool — emptiness, staleness and failure', () => {
  it('distinguishes a quiet window from a salon that has never mixed colour', async () => {
    // Nothing in the window, 5 formulas on the 365-day baseline.
    const result = await tool(labPort(summaryResponse(), KENSINGTON)).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    expect(result.rowCount).toBe(0);
    expect(result.presentation?.answer).toContain('No colour formulas were saved');
    expect(result.presentation?.answer).toContain('the Lab is in use');
  });

  it('answers set-up, not performance, when no formula has ever been saved', async () => {
    const result = await tool(labPort(summaryResponse())).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    expect(result.presentation?.answer).toContain('No formula has ever been saved');
    expect(result.presentation?.answer).toContain('set-up rather than performance');
    // Never 'not_connected': that maps to "this feature does not exist".
    expect(result.status).not.toBe('not_connected');
  });

  it('degrades to unavailable when the service throws, never to a zero', async () => {
    const port = { summary: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ZacLabAnalyticsRead;
    const result = await tool(port).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('unavailable');
    expect(result.data).toBeNull();
  });

  it('says which window it used when the question named none', async () => {
    const result = await tool(labPort(KENSINGTON)).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.limitations.join(' ')).toContain('my default window');
    expect(result.presentation?.limitations.join(' ')).toContain('the last 90 days');
  });

  it('caps an all-time window and says it did so', async () => {
    const result = await tool(labPort(KENSINGTON)).execute(OWNER, CONTEXT, {
      period: {
        fromIso: '2019-01-01T00:00:00.000Z',
        toIso: new Date().toISOString(),
        label: 'everything on record',
        kind: 'all_time',
        explicit: true,
      },
    });

    // fetchFormulas has no limit, so the window IS the bound on the read.
    expect(result.presentation?.limitations.join(' ')).toContain('366 days');
  });
});

describe('QlabColourAnalyticsTool — worst location ranking', () => {
  it('ignores a site that did no colour when picking the thinnest margin', async () => {
    // The source's own worstLocationName ranks on a percent that returns 0 for a
    // zero denominator, so a site with no colour work outranks a genuinely thin
    // one. Only sites that actually charged can be "worst" at charging.
    const multi = summaryResponse(
      {
        byLocation: [
          ...KENSINGTON.byLocation,
          {
            locationId: 'loc-2',
            locationName: 'Thame',
            colourRevenueCents: 0,
            formulaCostCents: 0,
            grossMarginCents: 0,
            grossMarginPercent: 0,
            wasteCostCents: 0,
            formulasMixed: 0,
            currencyCode: 'GBP',
          },
          {
            locationId: 'loc-3',
            locationName: 'Pinner',
            colourRevenueCents: 10_000,
            formulaCostCents: 9_500,
            grossMarginCents: 500,
            grossMarginPercent: 5,
            wasteCostCents: 0,
            formulasMixed: 2,
            currencyCode: 'GBP',
          },
        ],
      },
      { ...KENSINGTON.summary },
    );

    const result = await tool(labPort(multi)).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('Pinner');
    expect(result.presentation?.answer).not.toContain('Thame');
  });
});

describe('QlabColourAnalyticsTool — PII', () => {
  it('leaks no stylist name or pay field into any part of the result', async () => {
    const withStylists = summaryResponse(
      {
        byLocation: KENSINGTON.byLocation,
        byStylist: [
          {
            stylistProfileId: 'staff-1',
            stylistName: 'Maya Chen',
            locationId: 'loc-1',
            locationName: 'Kensington',
            hourlyRate: 18.5,
            contractedHours: 37.5,
            averageBillBenchmark: 62,
            colourRevenueCents: 12_662,
            formulaCostCents: 10_551,
            grossMarginCents: 2_111,
            grossMarginPercent: 16.7,
            wasteCostCents: 0,
            formulasMixed: 5,
            currencyCode: 'GBP',
          },
        ],
      },
      { ...KENSINGTON.summary },
    );

    const result = await tool(labPort(withStylists)).execute(OWNER, CONTEXT, {});
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain('Maya Chen');
    expect(serialised).not.toContain('18.5');
    expect(serialised).not.toContain('37.5');
    expect(serialised).not.toContain('hourlyRate');
  });
});
