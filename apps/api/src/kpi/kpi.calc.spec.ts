import {
  aggregateStylistKpi,
  computeAverageBillKpi,
  computeCommission,
  computeNetWorkedHours,
  computeRebookingKpi,
  computeRetailKpi,
  computeRetailTargetCents,
  computeServiceTargetCents,
  isCommissionUnlocked,
  resolveKpiWindow,
  type StylistKpiInputs,
} from './kpi.calc';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// 2026-05-04 is a Monday.
const MON_09 = Date.parse('2026-05-04T09:00:00.000Z');
const MON_17 = Date.parse('2026-05-04T17:00:00.000Z');
const WINDOW_START = Date.parse('2026-05-04T00:00:00.000Z');
const WINDOW_END = Date.parse('2026-05-11T00:00:00.000Z'); // exclusive, +7 days

function baseInputs(overrides: Partial<StylistKpiInputs> = {}): StylistKpiInputs {
  return {
    staffProfileId: 'staff-1',
    stylistName: 'Alex',
    locationId: 'loc-1',
    locationName: 'Main',
    currencyCode: 'GBP',
    hourlyRate: 20,
    averageBillBenchmark: 60,
    hoursWorked: 40,
    completedVisits: 10,
    rebookedVisits: 6,
    stylistRebookedVisits: 4,
    clientRebookedVisits: 2,
    serviceRevenueCents: 300_000,
    productUsageRevenueCents: 60_000,
    paidVisits: 10,
    retailSalesCents: 25_000,
    hadRetailMovements: true,
    ...overrides,
  };
}

describe('target engine — service & retail target from rota hours', () => {
  it('service target = hourly rate × 3 × hours worked', () => {
    // £20/hr × 3 × 8h = £480 = 48000 cents
    expect(computeServiceTargetCents(20, 8)).toBe(48_000);
  });

  it('retail target = 10% of service target', () => {
    const service = computeServiceTargetCents(20, 8); // 48000
    expect(computeRetailTargetCents(service)).toBe(4_800);
  });

  it('net worked hours subtracts unpaid breaks but keeps paid breaks', () => {
    const hours = computeNetWorkedHours({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      shifts: [{ startMs: MON_09, endMs: MON_17, status: 'published' }], // 8h
      breaks: [
        { startMs: MON_09 + 3 * HOUR, endMs: MON_09 + 4 * HOUR, isPaid: false }, // -1h
        { startMs: MON_09 + 5 * HOUR, endMs: MON_09 + 5.5 * HOUR, isPaid: true }, // kept
      ],
      unavailable: [],
    });
    expect(hours).toBeCloseTo(7, 5);
  });

  it('excludes cancelled shifts from hours worked', () => {
    const hours = computeNetWorkedHours({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      shifts: [{ startMs: MON_09, endMs: MON_17, status: 'cancelled' }],
      breaks: [],
      unavailable: [],
    });
    expect(hours).toBe(0);
  });

  it('approved leave reduces hours and therefore the target', () => {
    // Two 8h shifts (Mon, Tue). Tuesday is fully covered by approved leave.
    const tue09 = MON_09 + DAY;
    const tue17 = MON_17 + DAY;
    const hours = computeNetWorkedHours({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      shifts: [
        { startMs: MON_09, endMs: MON_17, status: 'published' },
        { startMs: tue09, endMs: tue17, status: 'published' },
      ],
      breaks: [],
      // approved leave expanded to the full Tuesday day
      unavailable: [{ startMs: WINDOW_START + DAY, endMs: WINDOW_START + 2 * DAY }],
    });
    expect(hours).toBeCloseTo(8, 5); // only Monday remains
    expect(computeServiceTargetCents(20, hours)).toBe(48_000);
  });

  it('sickness/absence reduces hours (partial-day overlap)', () => {
    const hours = computeNetWorkedHours({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      shifts: [{ startMs: MON_09, endMs: MON_17, status: 'published' }], // 8h
      breaks: [],
      unavailable: [{ startMs: MON_09 + 4 * HOUR, endMs: MON_17 }], // sick from 13:00 → -4h
    });
    expect(hours).toBeCloseTo(4, 5);
  });

  it('no rostered shifts → zero hours → zero targets', () => {
    const hours = computeNetWorkedHours({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      shifts: [],
      breaks: [],
      unavailable: [],
    });
    expect(hours).toBe(0);
    expect(computeServiceTargetCents(20, hours)).toBe(0);
    expect(computeRetailTargetCents(0)).toBe(0);
  });
});

describe('rebooking KPI', () => {
  it('passes at exactly 50% and counts client + stylist equally', () => {
    const r = computeRebookingKpi({
      completedVisits: 10,
      rebookedVisits: 5,
      stylistRebookedVisits: 2,
      clientRebookedVisits: 3,
    });
    expect(r.rebookingRatePercent).toBe(50);
    expect(r.met).toBe(true);
    expect(r.stylistRebookedVisits + r.clientRebookedVisits).toBe(5);
  });

  it('fails below 50% and does not round 49.x% up to a pass', () => {
    const r = computeRebookingKpi({
      completedVisits: 100,
      rebookedVisits: 49,
      stylistRebookedVisits: 49,
      clientRebookedVisits: 0,
    });
    expect(r.rebookingRatePercent).toBe(49);
    expect(r.met).toBe(false);
  });

  it('zero completed visits → 0% and not met (commission stays locked)', () => {
    const r = computeRebookingKpi({
      completedVisits: 0,
      rebookedVisits: 0,
      stylistRebookedVisits: 0,
      clientRebookedVisits: 0,
    });
    expect(r.rebookingRatePercent).toBe(0);
    expect(r.met).toBe(false);
  });
});

describe('retail KPI', () => {
  it('met when retail sales >= retail target', () => {
    const r = computeRetailKpi(4_800, 5_000, true);
    expect(r.met).toBe(true);
    expect(r.varianceCents).toBe(200);
  });

  it('not met when below target', () => {
    const r = computeRetailKpi(4_800, 4_000, true);
    expect(r.met).toBe(false);
    expect(r.varianceCents).toBe(-800);
  });

  it('with no hours (zero target) it is not trivially met', () => {
    const r = computeRetailKpi(0, 0, false);
    expect(r.met).toBe(false);
  });
});

describe('average bill KPI', () => {
  it('met when actual average bill >= benchmark', () => {
    // (30000 + 6000) over 6 visits = 6000 average; benchmark 6000
    const r = computeAverageBillKpi(6_000, 36_000, 6);
    expect(r.actualAverageBillCents).toBe(6_000);
    expect(r.met).toBe(true);
    expect(r.varianceCents).toBe(0);
  });

  it('not met when below benchmark', () => {
    const r = computeAverageBillKpi(6_000, 30_000, 6); // 5000 avg
    expect(r.met).toBe(false);
  });

  it('missing benchmark → not met', () => {
    const r = computeAverageBillKpi(0, 50_000, 5);
    expect(r.hasBenchmark).toBe(false);
    expect(r.met).toBe(false);
  });

  it('no paid visits → average 0, not met', () => {
    const r = computeAverageBillKpi(6_000, 0, 0);
    expect(r.actualAverageBillCents).toBe(0);
    expect(r.met).toBe(false);
  });
});

describe('aggregation — all_kpis_met', () => {
  it('all three met → allKpisMet true and commission unlocked', () => {
    const result = aggregateStylistKpi(baseInputs());
    expect(result.rebookingKpiMet).toBe(true);
    expect(result.retailKpiMet).toBe(true);
    expect(result.averageBillKpiMet).toBe(true);
    expect(result.allKpisMet).toBe(true);
    expect(isCommissionUnlocked(result)).toBe(true);
  });

  it('one KPI failing flips allKpisMet to false', () => {
    const result = aggregateStylistKpi(baseInputs({ retailSalesCents: 0 }));
    expect(result.retailKpiMet).toBe(false);
    expect(result.allKpisMet).toBe(false);
    expect(isCommissionUnlocked(result)).toBe(false);
  });

  it('service target = hourly × 3 × hours and retail target = 10%', () => {
    const result = aggregateStylistKpi(baseInputs({ hourlyRate: 20, hoursWorked: 40 }));
    expect(result.serviceTargetCents).toBe(240_000); // £20×3×40 = £2400
    expect(result.retailTargetCents).toBe(24_000);
  });

  it('average bill uses service + product-usage (colour) but not retail', () => {
    const result = aggregateStylistKpi(
      baseInputs({ serviceRevenueCents: 300_000, productUsageRevenueCents: 60_000, paidVisits: 10, retailSalesCents: 999_999 }),
    );
    // (300000 + 60000) / 10 = 36000, independent of retail
    expect(result.averageBill.actualAverageBillCents).toBe(36_000);
  });

  it('no hours / no visits / missing benchmark are flagged and keep commission locked', () => {
    const result = aggregateStylistKpi(
      baseInputs({
        hoursWorked: 0,
        completedVisits: 0,
        rebookedVisits: 0,
        paidVisits: 0,
        serviceRevenueCents: 0,
        productUsageRevenueCents: 0,
        retailSalesCents: 0,
        averageBillBenchmark: 0,
        hadRetailMovements: false,
      }),
    );
    expect(result.allKpisMet).toBe(false);
    expect(result.notes).toEqual(
      expect.arrayContaining(['no_hours_worked', 'no_completed_visits', 'missing_benchmark']),
    );
  });
});

describe('commission engine', () => {
  const LABOR = 100_000; // £1000 labour cost (rate × hours)

  it('below 3.0x → 0%', () => {
    const c = computeCommission({ laborCostCents: LABOR, commissionBaseCents: 299_999, allKpisMet: true });
    expect(c.tier).toBe('below_3x');
    expect(c.ratePercent).toBe(0);
    expect(c.commissionAmountCents).toBe(0);
  });

  it('exactly 3.0x → 10%', () => {
    const c = computeCommission({ laborCostCents: LABOR, commissionBaseCents: 300_000, allKpisMet: false });
    expect(c.tier).toBe('tier_3x');
    expect(c.ratePercent).toBe(10);
    expect(c.commissionAmountCents).toBe(30_000);
  });

  it('between 3.0x and 3.5x → 10% (KPIs do not change it)', () => {
    const withoutKpis = computeCommission({ laborCostCents: LABOR, commissionBaseCents: 340_000, allKpisMet: false });
    const withKpis = computeCommission({ laborCostCents: LABOR, commissionBaseCents: 340_000, allKpisMet: true });
    expect(withoutKpis.ratePercent).toBe(10);
    expect(withKpis.ratePercent).toBe(10); // all-KPIs gate must not affect the 10% tier
  });

  it('at/above 3.5x without all KPIs → 15%', () => {
    const c = computeCommission({ laborCostCents: LABOR, commissionBaseCents: 350_000, allKpisMet: false });
    expect(c.tier).toBe('tier_3_5x');
    expect(c.ratePercent).toBe(15);
    expect(c.commissionAmountCents).toBe(52_500);
    expect(c.kpiUnlockApplied).toBe(false);
    expect(c.nextTier).toEqual(
      expect.objectContaining({ tier: 'tier_3_5x_unlocked', ratePercent: 30, requiresAllKpis: true }),
    );
  });

  it('at/above 3.5x with all KPIs → 30% (replaces 15%)', () => {
    const c = computeCommission({ laborCostCents: LABOR, commissionBaseCents: 350_000, allKpisMet: true });
    expect(c.tier).toBe('tier_3_5x_unlocked');
    expect(c.ratePercent).toBe(30);
    expect(c.commissionAmountCents).toBe(105_000);
    expect(c.kpiUnlockApplied).toBe(true);
    expect(c.nextTier).toBeUndefined();
  });

  it('no labour cost → 0% and no commission', () => {
    const c = computeCommission({ laborCostCents: 0, commissionBaseCents: 999_999, allKpisMet: true });
    expect(c.tier).toBe('below_3x');
    expect(c.ratePercent).toBe(0);
    expect(c.serviceMultiple).toBe(0);
  });

  it('aggregate commission base = service + colour (product_usage), excludes retail', () => {
    // labour = £20 × 40h = £800 = 80000c; base = 300000 + 60000 = 360000 (4.5x); all KPIs met
    const result = aggregateStylistKpi(baseInputs({ retailSalesCents: 999_999 }));
    expect(result.commission.laborCostCents).toBe(80_000);
    expect(result.commission.commissionBaseCents).toBe(360_000); // independent of retail
    expect(result.commission.serviceMultiple).toBe(4.5);
    expect(result.commission.tier).toBe('tier_3_5x_unlocked');
    expect(result.commission.commissionAmountCents).toBe(108_000);
  });

  it('aggregate: failing a KPI at ≥3.5x drops 30% → 15%', () => {
    const result = aggregateStylistKpi(baseInputs({ retailSalesCents: 0 })); // retail KPI fails
    expect(result.allKpisMet).toBe(false);
    expect(result.commission.tier).toBe('tier_3_5x');
    expect(result.commission.ratePercent).toBe(15);
  });
});

describe('period / window resolution', () => {
  // A Wednesday in May 2026.
  const now = Date.parse('2026-05-06T12:34:00.000Z');

  it('today → start of UTC day to next day', () => {
    const w = resolveKpiWindow({ period: 'today' }, now);
    expect(w.fromIso).toBe('2026-05-06T00:00:00.000Z');
    expect(w.toIso).toBe('2026-05-07T00:00:00.000Z');
  });

  it('week → Monday to next Monday (UTC)', () => {
    const w = resolveKpiWindow({ period: 'week' }, now);
    expect(w.fromIso).toBe('2026-05-04T00:00:00.000Z');
    expect(w.toIso).toBe('2026-05-11T00:00:00.000Z');
  });

  it('month → first of month to first of next month', () => {
    const w = resolveKpiWindow({ period: 'month' }, now);
    expect(w.fromIso).toBe('2026-05-01T00:00:00.000Z');
    expect(w.toIso).toBe('2026-06-01T00:00:00.000Z');
  });

  it('explicit from/to is honoured', () => {
    const w = resolveKpiWindow({ from: '2026-05-01T00:00:00.000Z', to: '2026-05-02T00:00:00.000Z' }, now);
    expect(w.fromIso).toBe('2026-05-01T00:00:00.000Z');
    expect(w.toIso).toBe('2026-05-02T00:00:00.000Z');
  });

  it('rejects invalid / inverted ranges and missing inputs', () => {
    expect(() => resolveKpiWindow({}, now)).toThrow();
    expect(() => resolveKpiWindow({ from: '2026-05-02T00:00:00Z', to: '2026-05-01T00:00:00Z' }, now)).toThrow();
  });
});
