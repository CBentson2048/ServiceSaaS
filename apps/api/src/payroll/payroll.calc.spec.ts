/**
 * Acceptance tests for the pure payroll calculation engine.
 *
 * The worked examples come verbatim from docs/payroll-loh-template.md
 * (confirmed by Luke, 2026-07-27) and must reproduce exactly:
 *   - LOH marginal bands: £38.01 (accelerator not met) / £51.60 (met)
 *   - Example A1 additive: £680.10
 *   - Example A2 greater-of: £540.00
 *   - Retail above target: £7.00
 *
 * DO NOT reconcile these numbers with kpi.calc.ts — the live KPI screen
 * applies 15% retroactively to the whole base (£270 on the same inputs) and
 * that model is exactly what this engine replaces.
 */

import type { PayrollDataSource } from '@sheer/domain';
import {
  calculatePaySummary,
  type EngineInput,
  type ResolvedRuleVersion,
  type ResolvedStage,
} from './payroll.calc';

// =============================================================================
// Fixture builders
// =============================================================================

const CAPTURE_NONE: Record<PayrollDataSource, boolean> = {
  service_revenue: true,
  retail_sales: false,
  tips: false,
  refunds: false,
  cancellation_fees: false,
  product_cost: true,
};

let idCounter = 0;
const id = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

function stage(partial: Partial<ResolvedStage> & Pick<ResolvedStage, 'stageType'>): ResolvedStage {
  return {
    id: id('stage'),
    sequenceNo: 1,
    label: null,
    tierSemantics: null,
    thresholdBasis: null,
    revenueStream: null,
    inGreaterOfComparison: false,
    requiresDataSource: null,
    config: {},
    bands: [],
    accelerator: null,
    ...partial,
  };
}

const LOH_HOUR_RULES: ResolvedRuleVersion['hourRules'] = {
  worked: { countsTowardTarget: true, countsAsPaid: true },
  additional: { countsTowardTarget: true, countsAsPaid: true },
  manual_adjustment: { countsTowardTarget: true, countsAsPaid: true },
  paid_holiday: { countsTowardTarget: false, countsAsPaid: true },
  training: { countsTowardTarget: false, countsAsPaid: true },
  sickness: { countsTowardTarget: false, countsAsPaid: false },
  authorised_absence: { countsTowardTarget: false, countsAsPaid: false },
  unpaid_leave: { countsTowardTarget: false, countsAsPaid: false },
};

function version(
  stages: ResolvedStage[],
  overrides: Partial<ResolvedRuleVersion> = {},
): ResolvedRuleVersion {
  return {
    versionId: 'version-1',
    structureId: 'structure-1',
    structureName: 'Test structure',
    versionNo: 1,
    discountBasis: 'headline_before_discount',
    vatBasis: 'exclusive',
    tipsIncludedInCommission: false,
    depositRecognition: 'on_completion',
    productCostMode: 'none',
    cancellationFeeSharePercent: null,
    stages,
    hourRules: LOH_HOUR_RULES,
    ...overrides,
  };
}

function baseInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    period: { periodStart: '2026-07-28', periodEnd: '2026-08-04' },
    currencyCode: 'GBP',
    staff: {
      staffProfileId: 'staff-1',
      staffName: 'Amelia Reid',
      employmentType: 'employed',
      hourlyRateCents: 1221, // £12.21
      contractedHours: 40,
      averageBillBenchmarkCents: null,
      serviceRevenueTargetMode: 'flat',
    },
    version: null,
    hours: [
      { category: 'worked', hours: 40, notes: null },
      { category: 'paid_holiday', hours: 0, notes: null },
      { category: 'unpaid_leave', hours: 0, notes: null },
      { category: 'sickness', hours: 0, notes: null },
      { category: 'training', hours: 0, notes: null },
      { category: 'authorised_absence', hours: 0, notes: null },
      { category: 'additional', hours: 0, notes: null },
      { category: 'manual_adjustment', hours: 0, notes: null },
    ],
    serviceLines: [
      {
        sourceType: 'visit',
        sourceId: 'visit-1',
        occurredOn: '2026-07-30',
        label: 'Full Head Colour — J. Smith',
        headlineAmountCents: 180_000, // £1,800
        actualAmountCents: 180_000,
        amountsIncludeTax: false,
        taxRatePercent: 20,
      },
    ],
    retailRevenueCents: 0,
    productCostCents: null,
    capture: { ...CAPTURE_NONE },
    metrics: {
      rebookingRatePercent: null,
      averageBillCents: null,
      utilisationPercent: null,
      clientCount: null,
    },
    adjustments: [],
    trackingTargetCents: null,
    totalCollectedCents: 180_000,
    serviceRevenueVariance: null,
    ...overrides,
  };
}

/** LOH service commission: marginal, multiple_of_base_pay 0/0%, 3.0/10%, 3.5/15%+30%. */
function lohServiceStage(withAccelerator: boolean): ResolvedStage {
  return stage({
    stageType: 'commission',
    sequenceNo: 2,
    label: 'Service commission',
    tierSemantics: 'marginal',
    thresholdBasis: 'multiple_of_base_pay',
    revenueStream: 'service',
    requiresDataSource: 'service_revenue',
    bands: [
      {
        id: 'band-1',
        sequenceNo: 1,
        fromMultiple: 0,
        fromAmountCents: null,
        fromPercent: null,
        ratePercent: 0,
        acceleratorRatePercent: null,
      },
      {
        id: 'band-2',
        sequenceNo: 2,
        fromMultiple: 3.0,
        fromAmountCents: null,
        fromPercent: null,
        ratePercent: 10,
        acceleratorRatePercent: null,
      },
      {
        id: 'band-3',
        sequenceNo: 3,
        fromMultiple: 3.5,
        fromAmountCents: null,
        fromPercent: null,
        ratePercent: 15,
        acceleratorRatePercent: 30,
      },
    ],
    accelerator: withAccelerator
      ? {
          evaluationMode: 'all',
          requiredConditionCount: null,
          requiredScore: null,
          conditions: [
            {
              sequenceNo: 1,
              metric: 'rebooking_rate_percent',
              comparator: 'gte',
              basis: 'percent',
              thresholdValue: 50,
              weight: 1,
            },
            {
              sequenceNo: 2,
              metric: 'retail_revenue',
              comparator: 'gte',
              basis: 'target_met',
              thresholdValue: null,
              weight: 1,
            },
            {
              sequenceNo: 3,
              metric: 'average_bill',
              comparator: 'gte',
              basis: 'staff_benchmark',
              thresholdValue: null,
              weight: 1,
            },
          ],
        }
      : null,
  });
}

function lohRetailStage(): ResolvedStage {
  return stage({
    stageType: 'commission',
    sequenceNo: 3,
    label: 'Retail commission',
    tierSemantics: 'marginal',
    thresholdBasis: 'percent_of_service_target',
    revenueStream: 'retail',
    requiresDataSource: 'retail_sales',
    bands: [
      {
        id: 'retail-band-1',
        sequenceNo: 1,
        fromMultiple: null,
        fromAmountCents: null,
        fromPercent: 0,
        ratePercent: 0,
        acceleratorRatePercent: null,
      },
      {
        id: 'retail-band-2',
        sequenceNo: 2,
        fromMultiple: null,
        fromAmountCents: null,
        fromPercent: 10,
        ratePercent: 10,
        acceleratorRatePercent: null,
      },
    ],
  });
}

const hourlyBaseStage = () =>
  stage({
    stageType: 'base_pay',
    sequenceNo: 1,
    label: 'Hourly base pay',
    config: { source: 'hourly_rate_x_payable_hours' },
  });

// =============================================================================
// LOH marginal bands — the headline acceptance numbers
// =============================================================================

describe('LOH marginal service commission (docs/payroll-loh-template.md §1)', () => {
  it('pays £38.01 when the accelerator is not met (£488.40 base, £1,800 revenue)', () => {
    const input = baseInput({
      version: version([hourlyBaseStage(), lohServiceStage(true)]),
    });
    const result = calculatePaySummary(input);

    expect(result.ok).toBe(true);
    expect(result.figures!.basePayCents).toBe(48_840); // £12.21 x 40h
    // 3x = 146,520; 3.5x = 170,940. Band 2: 24,420 x 10% = 2,442.
    // Band 3: (180,000 - 170,940) x 15% = 1,359. Total £38.01.
    expect(result.figures!.commissionCents).toBe(3_801);
    expect(result.figures!.grossPayableCents).toBe(48_840 + 3_801);

    // Accelerator could not fully evaluate (no metrics) => NOT achieved.
    expect(result.accelerator?.achieved).not.toBe(true);
    // Band slices priced separately, with the applied rate recorded.
    const band2 = result.bands.find((b) => b.bandId === 'band-2')!;
    expect(band2.sliceFromCents).toBe(146_520);
    expect(band2.sliceToCents).toBe(170_940);
    expect(band2.amountCents).toBe(2_442);
    const band3 = result.bands.find((b) => b.bandId === 'band-3')!;
    expect(band3.amountCents).toBe(1_359);
    expect(band3.acceleratorRateApplied).toBe(false);
  });

  it('pays £51.60 when all three accelerator conditions pass (30% replaces 15% above 3.5x only)', () => {
    const input = baseInput({
      version: version([hourlyBaseStage(), lohServiceStage(true), lohRetailStage()]),
      capture: { ...CAPTURE_NONE, retail_sales: true },
      retailRevenueCents: 20_000, // >= retail target (10% of SRT £1,465.20 = £146.52)
      staff: {
        ...baseInput().staff,
        averageBillBenchmarkCents: 4_500,
      },
      metrics: {
        rebookingRatePercent: 60,
        averageBillCents: 5_000,
        utilisationPercent: null,
        clientCount: null,
      },
    });
    const result = calculatePaySummary(input);

    expect(result.ok).toBe(true);
    expect(result.accelerator?.achieved).toBe(true);
    // Band 2 unchanged (10%); band 3 at 30%: 9,060 x 30% = 2,718. Total 5,160.
    const serviceCommission = result.bands
      .filter((b) => b.bandId.startsWith('band-'))
      .reduce((sum, b) => sum + b.amountCents, 0);
    expect(serviceCommission).toBe(5_160);
    const band3 = result.bands.find((b) => b.bandId === 'band-3')!;
    expect(band3.ratePercentApplied).toBe(30);
    expect(band3.acceleratorRateApplied).toBe(true);
    // The accelerator NEVER reaches back over band 2.
    const band2 = result.bands.find((b) => b.bandId === 'band-2')!;
    expect(band2.ratePercentApplied).toBe(10);
  });

  it('contrasts marginal vs retroactive on identical inputs (the 7x defect this engine fixes)', () => {
    const marginal = calculatePaySummary(
      baseInput({ version: version([hourlyBaseStage(), lohServiceStage(false)]) }),
    );
    const retro = calculatePaySummary(
      baseInput({
        version: version([
          hourlyBaseStage(),
          { ...lohServiceStage(false), tierSemantics: 'retroactive' },
        ]),
      }),
    );
    expect(marginal.figures!.commissionCents).toBe(3_801);
    // Retroactive: highest crossed band (3.5x, 15%) prices the WHOLE £1,800.
    expect(retro.figures!.commissionCents).toBe(27_000);
  });
});

// =============================================================================
// Example A1 — additive base + commission + retail (£680.10)
// =============================================================================

describe('Example A1 (docs/payroll-loh-template.md §5)', () => {
  it('pays £680.10: base £488.40 + service 30% over 2.5x + retail 10% of £180', () => {
    const a1Service = stage({
      stageType: 'commission',
      sequenceNo: 2,
      label: 'Service commission',
      tierSemantics: 'marginal',
      thresholdBasis: 'multiple_of_base_pay',
      revenueStream: 'service',
      bands: [
        {
          id: 'a1-b1',
          sequenceNo: 1,
          fromMultiple: 0,
          fromAmountCents: null,
          fromPercent: null,
          ratePercent: 0,
          acceleratorRatePercent: null,
        },
        {
          id: 'a1-b2',
          sequenceNo: 2,
          fromMultiple: 2.5,
          fromAmountCents: null,
          fromPercent: null,
          ratePercent: 30,
          acceleratorRatePercent: null,
        },
      ],
    });
    const a1Retail = stage({
      stageType: 'commission',
      sequenceNo: 3,
      label: 'Retail commission',
      tierSemantics: 'marginal',
      thresholdBasis: 'absolute',
      revenueStream: 'retail',
      bands: [
        {
          id: 'a1-r1',
          sequenceNo: 1,
          fromMultiple: null,
          fromAmountCents: 0,
          fromPercent: null,
          ratePercent: 10,
          acceleratorRatePercent: null,
        },
      ],
    });
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), a1Service, a1Retail]),
        capture: { ...CAPTURE_NONE, retail_sales: true },
        retailRevenueCents: 18_000, // £180
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.figures!.basePayCents).toBe(48_840);
    // Target 2.5x = £1,221. (1,800 - 1,221) x 30% = £173.70; retail £18.
    expect(result.figures!.commissionCents).toBe(17_370 + 1_800);
    expect(result.figures!.grossPayableCents).toBe(68_010); // £680.10
    expect(result.target.targetCents).toBe(122_100);
  });
});

// =============================================================================
// Example A2 — greater-of guarantee vs retroactive commission (£540.00)
// =============================================================================

describe('Example A2 (docs/payroll-loh-template.md §6)', () => {
  it('takes the higher of guarantee £488.40 and retroactive 30% (£540), keeping both sides', () => {
    const guarantee = stage({
      stageType: 'base_pay',
      sequenceNo: 1,
      label: 'Guaranteed minimum',
      inGreaterOfComparison: true,
      config: { source: 'hourly_rate_x_payable_hours' },
    });
    const commissionOnly = stage({
      stageType: 'commission',
      sequenceNo: 2,
      label: 'Commission only',
      tierSemantics: 'retroactive',
      thresholdBasis: 'multiple_of_base_pay',
      revenueStream: 'service',
      inGreaterOfComparison: true,
      bands: [
        {
          id: 'a2-b1',
          sequenceNo: 1,
          fromMultiple: 0,
          fromAmountCents: null,
          fromPercent: null,
          ratePercent: 30,
          acceleratorRatePercent: null,
        },
      ],
    });
    const greaterOf = stage({ stageType: 'greater_of', sequenceNo: 3 });

    const result = calculatePaySummary(
      baseInput({ version: version([guarantee, commissionOnly, greaterOf]) }),
    );

    expect(result.ok).toBe(true);
    expect(result.greaterOf).toEqual({
      applied: true,
      winner: 'commission',
      basePayCents: 48_840,
      commissionCents: 54_000, // 30% of ALL £1,800 (retroactive)
      revenueSplitCents: null,
    });
    // The losing guarantee contributes nothing to the totals...
    expect(result.figures!.basePayCents).toBe(0);
    expect(result.figures!.commissionCents).toBe(54_000);
    expect(result.figures!.grossPayableCents).toBe(54_000); // £540.00
    // ...but both sides survive on the summary record.
    expect(result.figures!.greaterOfApplied).toBe(true);
    expect(result.figures!.greaterOfWinner).toBe('commission');
  });
});

// =============================================================================
// Retail above target — £7.00
// =============================================================================

describe('Retail commission above target (docs/payroll-loh-template.md §3)', () => {
  it('pays £7.00 on £220 retail against a £150 target (10% of SRT £1,500)', () => {
    // Service stage with an absolute £1,500 first threshold => SRT = £1,500.
    const serviceStage = stage({
      stageType: 'commission',
      sequenceNo: 2,
      label: 'Service commission',
      tierSemantics: 'marginal',
      thresholdBasis: 'absolute',
      revenueStream: 'service',
      bands: [
        {
          id: 'r-s1',
          sequenceNo: 1,
          fromMultiple: null,
          fromAmountCents: 150_000,
          fromPercent: null,
          ratePercent: 0,
          acceleratorRatePercent: null,
        },
      ],
    });
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), serviceStage, lohRetailStage()]),
        capture: { ...CAPTURE_NONE, retail_sales: true },
        retailRevenueCents: 22_000, // £220
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.target.targetCents).toBe(150_000);
    // Retail target = 10% of £1,500 = £150; (220-150) x 10% = £7.00.
    const retailBands = result.bands.filter((b) => b.bandId.startsWith('retail-band'));
    expect(retailBands.reduce((sum, b) => sum + b.amountCents, 0)).toBe(700);
  });
});

// =============================================================================
// Threshold bases not covered above
// =============================================================================

describe('remaining threshold bases', () => {
  it('percent_of_service_revenue: threshold scales with observed revenue', () => {
    const pct = stage({
      stageType: 'commission',
      sequenceNo: 2,
      tierSemantics: 'marginal',
      thresholdBasis: 'percent_of_service_revenue',
      revenueStream: 'service',
      bands: [
        {
          id: 'p-b1',
          sequenceNo: 1,
          fromMultiple: null,
          fromAmountCents: null,
          fromPercent: 50,
          ratePercent: 10,
          acceleratorRatePercent: null,
        },
      ],
    });
    const result = calculatePaySummary(baseInput({ version: version([hourlyBaseStage(), pct]) }));
    // Threshold = 50% of £1,800 = £900. (1,800-900) x 10% = £90.
    expect(result.figures!.commissionCents).toBe(9_000);
  });

  it('per_client: threshold = amount x distinct clients', () => {
    const perClient = stage({
      stageType: 'commission',
      sequenceNo: 2,
      tierSemantics: 'marginal',
      thresholdBasis: 'per_client',
      revenueStream: 'service',
      bands: [
        {
          id: 'c-b1',
          sequenceNo: 1,
          fromMultiple: null,
          fromAmountCents: 500, // £5 per client
          fromPercent: null,
          ratePercent: 10,
          acceleratorRatePercent: null,
        },
      ],
    });
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), perClient]),
        metrics: {
          rebookingRatePercent: null,
          averageBillCents: null,
          utilisationPercent: null,
          clientCount: 20,
        },
      }),
    );
    // Threshold = £5 x 20 = £100. (1,800 - 100) x 10% = £170.
    expect(result.figures!.commissionCents).toBe(17_000);
  });
});

// =============================================================================
// Accelerator evaluation modes and the never-trivially-pass rule
// =============================================================================

describe('accelerator evaluation', () => {
  function acceleratorInput(
    mode: 'all' | 'any' | 'at_least_n' | 'weighted',
    opts: {
      requiredConditionCount?: number;
      requiredScore?: number;
      rebooking?: number | null;
      averageBill?: number | null;
      benchmark?: number | null;
      weights?: [number, number];
    } = {},
  ): EngineInput {
    const svc = lohServiceStage(false);
    svc.accelerator = {
      evaluationMode: mode,
      requiredConditionCount: opts.requiredConditionCount ?? null,
      requiredScore: opts.requiredScore ?? null,
      conditions: [
        {
          sequenceNo: 1,
          metric: 'rebooking_rate_percent',
          comparator: 'gte',
          basis: 'percent',
          thresholdValue: 50,
          weight: opts.weights?.[0] ?? 1,
        },
        {
          sequenceNo: 2,
          metric: 'average_bill',
          comparator: 'gte',
          basis: 'staff_benchmark',
          thresholdValue: null,
          weight: opts.weights?.[1] ?? 1,
        },
      ],
    };
    return baseInput({
      version: version([hourlyBaseStage(), svc]),
      staff: { ...baseInput().staff, averageBillBenchmarkCents: opts.benchmark ?? null },
      metrics: {
        rebookingRatePercent: opts.rebooking ?? null,
        averageBillCents: opts.averageBill ?? null,
        utilisationPercent: null,
        clientCount: null,
      },
    });
  }

  it('a zero or missing staff benchmark FAILS its condition (never a trivial pass)', () => {
    const result = calculatePaySummary(
      acceleratorInput('all', { rebooking: 80, averageBill: 5_000, benchmark: 0 }),
    );
    expect(result.accelerator?.achieved).not.toBe(true);
    const benchmarkCondition = result.accelerator!.conditions[1];
    expect(benchmarkCondition.passed).toBeNull();
    expect(benchmarkCondition.unevaluableReason).toContain('benchmark');
    expect(result.warnings.some((w) => w.kind === 'accelerator_unevaluable')).toBe(true);
    // Lower band rate applied — the safe direction.
    const band3 = result.bands.find((b) => b.bandId === 'band-3')!;
    expect(band3.ratePercentApplied).toBe(15);
  });

  it("'any' passes when one condition passes", () => {
    const result = calculatePaySummary(
      acceleratorInput('any', { rebooking: 80, averageBill: null, benchmark: null }),
    );
    expect(result.accelerator?.achieved).toBe(true);
  });

  it("'at_least_n' with n=2: one pass + one fail is not achieved", () => {
    const result = calculatePaySummary(
      acceleratorInput('at_least_n', {
        requiredConditionCount: 2,
        rebooking: 80,
        averageBill: 3_000,
        benchmark: 4_000, // fails: 3,000 < 4,000
      }),
    );
    expect(result.accelerator?.achieved).toBe(false);
  });

  it("'weighted' sums weights of passing conditions against required score", () => {
    const pass = calculatePaySummary(
      acceleratorInput('weighted', {
        requiredScore: 5,
        weights: [3, 2],
        rebooking: 80,
        averageBill: 5_000,
        benchmark: 4_000,
      }),
    );
    expect(pass.accelerator?.achieved).toBe(true);

    const fail = calculatePaySummary(
      acceleratorInput('weighted', {
        requiredScore: 5,
        weights: [3, 2],
        rebooking: 80,
        averageBill: 3_000,
        benchmark: 4_000, // benchmark condition fails => score 3 < 5
      }),
    );
    expect(fail.accelerator?.achieved).toBe(false);
  });
});

describe('accelerators are PER STAGE (payroll.accelerators is keyed by stage_id)', () => {
  it("one stage's passing accelerator never promotes another stage's rates", () => {
    const svc = lohServiceStage(false);
    svc.accelerator = {
      evaluationMode: 'all',
      requiredConditionCount: null,
      requiredScore: null,
      conditions: [
        {
          sequenceNo: 1,
          metric: 'rebooking_rate_percent',
          comparator: 'gte',
          basis: 'percent',
          thresholdValue: 50, // passes (actual 80)
          weight: 1,
        },
      ],
    };
    const retail = lohRetailStage();
    retail.bands[1].acceleratorRatePercent = 20; // own accelerator rate on retail
    retail.accelerator = {
      evaluationMode: 'all',
      requiredConditionCount: null,
      requiredScore: null,
      conditions: [
        {
          sequenceNo: 1,
          metric: 'rebooking_rate_percent',
          comparator: 'gte',
          basis: 'percent',
          thresholdValue: 99, // fails (actual 80)
          weight: 1,
        },
      ],
    };
    // Service stage: absolute threshold £1,500 so SRT = £1,500, retail target £150.
    const svcAbsolute = stage({
      stageType: 'commission',
      sequenceNo: 2,
      tierSemantics: 'marginal',
      thresholdBasis: 'absolute',
      revenueStream: 'service',
      accelerator: svc.accelerator,
      bands: [
        {
          id: 'ps-b1',
          sequenceNo: 1,
          fromMultiple: null,
          fromAmountCents: 150_000,
          fromPercent: null,
          ratePercent: 15,
          acceleratorRatePercent: 30,
        },
      ],
    });
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), svcAbsolute, retail]),
        capture: { ...CAPTURE_NONE, retail_sales: true },
        retailRevenueCents: 22_000,
        metrics: {
          rebookingRatePercent: 80,
          averageBillCents: null,
          utilisationPercent: null,
          clientCount: null,
        },
      }),
    );
    expect(result.ok).toBe(true);
    // Service stage's own accelerator passed => 30% above £1,500.
    const serviceBand = result.bands.find((b) => b.bandId === 'ps-b1')!;
    expect(serviceBand.ratePercentApplied).toBe(30);
    expect(serviceBand.acceleratorRateApplied).toBe(true);
    // Retail stage's own accelerator FAILED => normal 10%, £7.00 not £14.00.
    const retailBands = result.bands.filter((b) => b.bandId.startsWith('retail-band'));
    expect(retailBands.reduce((sum, b) => sum + b.amountCents, 0)).toBe(700);
    expect(retailBands.every((b) => !b.acceleratorRateApplied)).toBe(true);
  });
});

// =============================================================================
// Unavailable sources and missing inputs
// =============================================================================

describe('uncaptured sources render warnings, never £0-as-fact', () => {
  it('retail stage with retail uncaptured emits a zero unavailable line + warning', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), lohServiceStage(false), lohRetailStage()]),
        retailRevenueCents: 99_999, // must be IGNORED — not captured
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.figures!.retailRevenueCents).toBe(0);
    const unavailableLine = result.lines.find((l) => l.sourceUnavailable);
    expect(unavailableLine).toBeDefined();
    expect(unavailableLine!.amountCents).toBe(0);
    expect(unavailableLine!.unavailableSource).toBe('retail_sales');
    expect(
      result.warnings.some((w) => w.kind === 'source_unavailable' && w.source === 'retail_sales'),
    ).toBe(true);
  });

  it('a tips stage is always unavailable today', () => {
    const tips = stage({ stageType: 'tips_payout', sequenceNo: 4, label: 'Tips payout' });
    const result = calculatePaySummary(baseInput({ version: version([hourlyBaseStage(), tips]) }));
    expect(result.ok).toBe(true);
    expect(
      result.warnings.some((w) => w.kind === 'source_unavailable' && w.source === 'tips'),
    ).toBe(true);
    expect(result.figures!.tipsOwedCents).toBe(0);
    expect(result.figures!.tipsPaidOutCents).toBe(0);
  });
});

describe('missing configuration inputs BLOCK generation', () => {
  it('no pay structure => ok=false with input_missing pay_structure', () => {
    const result = calculatePaySummary(baseInput({ version: null }));
    expect(result.ok).toBe(false);
    expect(result.figures).toBeNull();
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: 'input_missing', input: 'pay_structure' }),
    ]);
  });

  it('no hourly rate with an hourly base-pay stage => ok=false, never £0 base pay', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), lohServiceStage(false)]),
        staff: { ...baseInput().staff, hourlyRateCents: 0 },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'input_missing', input: 'hourly_rate' }),
      ]),
    );
  });

  it('a rule version with no hour rules => ok=false', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage()], { hourRules: {} }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'input_missing', input: 'hour_rules' }),
      ]),
    );
  });
});

// =============================================================================
// Settlement: renters, signed nets, line invariants, hours flags
// =============================================================================

describe('settlement statement', () => {
  it('a chair renter can owe the business (signed negative gross payable)', () => {
    const split = stage({
      stageType: 'revenue_split',
      sequenceNo: 1,
      label: 'Revenue split 45%',
      config: { split_percent: 45 },
    });
    const rent = stage({
      stageType: 'chair_rent',
      sequenceNo: 2,
      label: 'Chair rent',
      config: { amount_cents: 100_000 }, // £1,000/period
    });
    const result = calculatePaySummary(
      baseInput({
        version: version([split, rent]),
        staff: { ...baseInput().staff, employmentType: 'self_employed', hourlyRateCents: null },
      }),
    );
    expect(result.ok).toBe(true);
    // 45% of £1,800 = £810; rent £1,000 => gross payable -£190.
    expect(result.figures!.revenueSplitCents).toBe(81_000);
    expect(result.figures!.chairRentCents).toBe(100_000);
    expect(result.figures!.grossPayableCents).toBe(-19_000);
  });

  it('pay lines sum to gross payable and the gross_payable line closes the statement', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), lohServiceStage(false)]),
        adjustments: [{ id: 'adj-1', amountCents: -1_500, description: 'Refund clawback' }],
      }),
    );
    expect(result.ok).toBe(true);
    const payLines = result.lines.filter((l) => l.lineType !== 'gross_payable');
    const grossLine = result.lines[result.lines.length - 1];
    expect(grossLine.lineType).toBe('gross_payable');
    expect(payLines.reduce((sum, l) => sum + l.amountCents, 0)).toBe(grossLine.amountCents);
    expect(grossLine.amountCents).toBe(result.figures!.grossPayableCents);
    expect(result.figures!.adjustmentsCents).toBe(-1_500);
  });

  it('paid holiday shrinks the Service Revenue Target but not base pay (multiple_of_base_pay)', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), lohServiceStage(false)]),
        hours: [
          { category: 'worked', hours: 32, notes: null },
          { category: 'paid_holiday', hours: 8, notes: null },
          { category: 'unpaid_leave', hours: 0, notes: null },
          { category: 'sickness', hours: 0, notes: null },
          { category: 'training', hours: 0, notes: null },
          { category: 'authorised_absence', hours: 0, notes: null },
          { category: 'additional', hours: 0, notes: null },
          { category: 'manual_adjustment', hours: 0, notes: null },
        ],
      }),
    );
    // Base pay stays on PAYABLE hours: £12.21 x 40h = £488.40.
    expect(result.figures!.basePayCents).toBe(48_840);
    // The 3x threshold uses TARGET hours only: 3 x (£12.21 x 32h) = £1,172.16.
    // A stylist on holiday keeps their wage but cannot be asked to sell the
    // hours they were away (docs/payroll-loh-template.md §4).
    expect(result.target.targetCents).toBe(3 * Math.round(1221 * 32));
    expect(result.target.derivation).toContain('target-counted hours');
  });

  it('paid holiday is payable but does not raise the target; sickness is neither', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), lohServiceStage(false)]),
        hours: [
          { category: 'worked', hours: 32, notes: null },
          { category: 'paid_holiday', hours: 8, notes: null },
          { category: 'sickness', hours: 8, notes: null },
          { category: 'unpaid_leave', hours: 0, notes: null },
          { category: 'training', hours: 0, notes: null },
          { category: 'authorised_absence', hours: 0, notes: null },
          { category: 'additional', hours: 0, notes: null },
          { category: 'manual_adjustment', hours: 0, notes: null },
        ],
      }),
    );
    expect(result.payableHours).toBe(40); // worked 32 + paid holiday 8
    expect(result.targetHours).toBe(32); // paid holiday and sickness excluded
    // Base pay uses PAYABLE hours: £12.21 x 40.
    expect(result.figures!.basePayCents).toBe(48_840);
    const holiday = result.hours.find((h) => h.category === 'paid_holiday')!;
    expect(holiday.countedAsPaid).toBe(true);
    expect(holiday.countedTowardTarget).toBe(false);
    const sick = result.hours.find((h) => h.category === 'sickness')!;
    expect(sick.countedAsPaid).toBe(false);
    expect(sick.countedTowardTarget).toBe(false);
  });

  it('VAT is de-grossed out of the commission base on inc-tax locations (exclusive basis)', () => {
    const flat = stage({
      stageType: 'commission',
      sequenceNo: 2,
      tierSemantics: 'marginal',
      thresholdBasis: 'absolute',
      revenueStream: 'service',
      bands: [
        {
          id: 'v-b1',
          sequenceNo: 1,
          fromMultiple: null,
          fromAmountCents: 0,
          fromPercent: null,
          ratePercent: 10,
          acceleratorRatePercent: null,
        },
      ],
    });
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), flat]),
        serviceLines: [
          {
            sourceType: 'visit',
            sourceId: 'visit-1',
            occurredOn: '2026-07-30',
            label: 'Cut & Finish',
            headlineAmountCents: 12_000, // £120 inc VAT
            actualAmountCents: 12_000,
            amountsIncludeTax: true,
            taxRatePercent: 20,
          },
        ],
        totalCollectedCents: 12_000,
      }),
    );
    // £120 gross at 20% => £100 net; commission 10% of £100 = £10.
    expect(result.figures!.serviceRevenueCents).toBe(10_000);
    expect(result.figures!.commissionCents).toBe(1_000);
    const evidence = result.lines.find((l) => l.lineType === 'service_revenue')!;
    expect(evidence.vatRatePercentSnapshot).toBe(20);
    expect(evidence.basisAmountCents).toBe(10_000);
  });
});

describe('pro-rated tracking target (Service Revenue Target mode)', () => {
  /** All-zero hour rows except `worked`, which counts toward the target. */
  const workedOnly = (worked: number) => [
    { category: 'worked' as const, hours: worked, notes: null },
    { category: 'paid_holiday' as const, hours: 0, notes: null },
    { category: 'unpaid_leave' as const, hours: 0, notes: null },
    { category: 'sickness' as const, hours: 0, notes: null },
    { category: 'training' as const, hours: 0, notes: null },
    { category: 'authorised_absence' as const, hours: 0, notes: null },
    { category: 'additional' as const, hours: 0, notes: null },
    { category: 'manual_adjustment' as const, hours: 0, notes: null },
  ];

  it('pro_rated scales the tracking target by target-counted vs contracted hours', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage()]),
        hours: workedOnly(20),
        trackingTargetCents: 50_000,
        staff: { ...baseInput().staff, serviceRevenueTargetMode: 'pro_rated' },
      }),
    );
    // 20 target-counted hours against 40 contracted over a 7-day period: half.
    expect(result.target.targetCents).toBe(25_000);
    expect(result.target.derivation).toContain('pro-rated by hours');
  });

  it('flat mode leaves the tracking target exactly as entered', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage()]),
        hours: workedOnly(20),
        trackingTargetCents: 50_000,
      }),
    );
    expect(result.target.targetCents).toBe(50_000);
    expect(result.target.derivation).toContain('Tracking target from payroll targets');
  });

  it('a band-derived target ignores the mode — multiple_of_base_pay already follows hours', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage(), lohServiceStage(false)]),
        trackingTargetCents: 99_999,
        staff: { ...baseInput().staff, serviceRevenueTargetMode: 'pro_rated' },
      }),
    );
    // 3.0 x (£12.21 x 40 target hours) = £1,465.20 — from the band, not the
    // tracking figure, and untouched by the pro-rating mode.
    expect(result.target.targetCents).toBe(3 * Math.round(1221 * 40));
    expect(result.target.derivation).toContain('base pay');
  });

  it('missing contracted hours assumes the 40h/week default and says so in the derivation', () => {
    const result = calculatePaySummary(
      baseInput({
        version: version([hourlyBaseStage()]),
        hours: workedOnly(20),
        trackingTargetCents: 50_000,
        staff: {
          ...baseInput().staff,
          contractedHours: null,
          serviceRevenueTargetMode: 'pro_rated',
        },
      }),
    );
    expect(result.target.targetCents).toBe(25_000);
    expect(result.target.derivation).toContain('assumed');
  });

  it('a fortnight period doubles the contracted baseline (periodEnd exclusive)', () => {
    const result = calculatePaySummary(
      baseInput({
        period: { periodStart: '2026-07-28', periodEnd: '2026-08-11' },
        version: version([hourlyBaseStage()]),
        hours: workedOnly(40),
        trackingTargetCents: 50_000,
        staff: { ...baseInput().staff, serviceRevenueTargetMode: 'pro_rated' },
      }),
    );
    // 40 hours against 40 x (14/7) = 80 contracted for the fortnight: half.
    expect(result.target.targetCents).toBe(25_000);
  });
});
