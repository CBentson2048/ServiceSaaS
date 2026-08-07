/**
 * Authoring contract + preview round-trip.
 *
 * The preview MUST reproduce the LOH acceptance numbers through the same pure
 * engine the real pay run uses — a wizard preview that disagrees with the
 * payslip would be worse than no preview.
 */

import { BadRequestException } from '@nestjs/common';
import type { PayStructureRulesInput } from '@sheer/domain';
import { PayrollStructuresService } from './payroll-structures.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

function buildService(): PayrollStructuresService {
  const config = { getOrThrow: (key: string) => `fake-${key}` } as never;
  const inputs = { loadStaff: jest.fn() } as never;
  const audit = { record: jest.fn() } as never;
  return new PayrollStructuresService(config, inputs, audit);
}

const LOH_HOUR_RULES: PayStructureRulesInput['hourRules'] = [
  { category: 'worked', countsTowardTarget: true, countsAsPaid: true },
  { category: 'additional', countsTowardTarget: true, countsAsPaid: true },
  { category: 'manual_adjustment', countsTowardTarget: true, countsAsPaid: true },
  { category: 'paid_holiday', countsTowardTarget: false, countsAsPaid: true },
  { category: 'training', countsTowardTarget: false, countsAsPaid: true },
  { category: 'sickness', countsTowardTarget: false, countsAsPaid: false },
  { category: 'authorised_absence', countsTowardTarget: false, countsAsPaid: false },
  { category: 'unpaid_leave', countsTowardTarget: false, countsAsPaid: false },
];

function lohRules(): PayStructureRulesInput {
  return {
    effectiveFrom: '2026-01-06',
    stages: [
      {
        stageType: 'base_pay',
        label: 'Hourly base pay',
        config: { source: 'hourly_rate_x_payable_hours' },
      },
      {
        stageType: 'commission',
        label: 'Service commission',
        tierSemantics: 'marginal',
        thresholdBasis: 'multiple_of_base_pay',
        revenueStream: 'service',
        bands: [
          { fromMultiple: 0, ratePercent: 0 },
          { fromMultiple: 3.0, ratePercent: 10 },
          { fromMultiple: 3.5, ratePercent: 15, acceleratorRatePercent: 30 },
        ],
        accelerator: {
          evaluationMode: 'all',
          conditions: [
            {
              metric: 'rebooking_rate_percent',
              comparator: 'gte',
              basis: 'percent',
              thresholdValue: 50,
            },
            { metric: 'retail_revenue', comparator: 'gte', basis: 'target_met' },
            { metric: 'average_bill', comparator: 'gte', basis: 'staff_benchmark' },
          ],
        },
      },
      {
        stageType: 'commission',
        label: 'Retail commission',
        tierSemantics: 'marginal',
        thresholdBasis: 'percent_of_service_target',
        revenueStream: 'retail',
        bands: [
          { fromPercent: 0, ratePercent: 0 },
          { fromPercent: 10, ratePercent: 10 },
        ],
      },
    ],
    hourRules: LOH_HOUR_RULES.map((rule) => ({ ...rule })),
  };
}

describe('preview — the wizard worked example runs the real engine', () => {
  const service = buildService();

  it('reproduces LOH £38.01 with the default sample (accelerator not achieved)', () => {
    const preview = service.preview({ rules: lohRules() });
    expect(preview.illustrative).toBe(true);
    expect(preview.basePayCents).toBe(48_840);
    expect(preview.commissionCents).toBe(3_801);
    expect(preview.target.targetCents).toBe(146_520); // 3x base pay
    expect(preview.accelerator?.achieved).not.toBe(true);
    // Benchmark missing => named unevaluable warning, never a trivial pass.
    expect(preview.warnings.some((w) => w.kind === 'accelerator_unevaluable')).toBe(true);
  });

  it('reproduces £51.60 + retail £7.00-style promotion when all conditions pass', () => {
    const preview = service.preview({
      rules: lohRules(),
      sample: {
        retailRevenueCents: 22_000,
        averageBillBenchmarkCents: 4_500,
        averageBillCents: 5_000,
        rebookingRatePercent: 60,
      },
    });
    expect(preview.accelerator?.achieved).toBe(true);
    const serviceBands = preview.bands.filter((b) => !b.fromLabel.includes('Service Revenue'));
    expect(serviceBands.reduce((sum, b) => sum + b.amountCents, 0)).toBe(5_160);
  });

  it('previews the A2 greater-of template (£540 winner, guarantee preserved)', () => {
    const preview = service.preview({
      rules: {
        effectiveFrom: '2026-01-06',
        stages: [
          {
            stageType: 'base_pay',
            label: 'Guaranteed minimum',
            inGreaterOfComparison: true,
            config: { source: 'hourly_rate_x_payable_hours' },
          },
          {
            stageType: 'commission',
            label: 'Commission only',
            tierSemantics: 'retroactive',
            thresholdBasis: 'multiple_of_base_pay',
            revenueStream: 'service',
            inGreaterOfComparison: true,
            bands: [{ fromMultiple: 0, ratePercent: 30 }],
          },
          { stageType: 'greater_of' },
        ],
        hourRules: LOH_HOUR_RULES.map((rule) => ({ ...rule })),
      },
    });
    expect(preview.greaterOf).toMatchObject({
      applied: true,
      winner: 'commission',
      basePayCents: 48_840,
      commissionCents: 54_000,
    });
    expect(preview.grossPayableCents).toBe(54_000);
  });
});

describe('authoring validation (the ratified config contract)', () => {
  const service = buildService();
  const expectBadRequest = (mutate: (rules: PayStructureRulesInput) => void, match: string) => {
    const rules = lohRules();
    mutate(rules);
    try {
      service.validateRules(rules);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((error as BadRequestException).getResponse())).toContain(match);
    }
  };

  it('accepts the LOH template as-is', () => {
    expect(() => service.validateRules(lohRules())).not.toThrow();
  });

  it('refuses tips stages (uncaptured source)', () => {
    expectBadRequest((r) => r.stages.push({ stageType: 'tips_payout' }), 'tips');
  });

  it('refuses incomplete hour rules', () => {
    expectBadRequest((r) => r.hourRules.pop(), 'missing');
  });

  it('refuses a band bound that does not match the threshold basis', () => {
    expectBadRequest((r) => {
      r.stages[1].bands![1] = { fromAmountCents: 100_000, ratePercent: 10 };
    }, 'fromMultiple');
  });

  it('refuses non-ascending band thresholds', () => {
    expectBadRequest((r) => {
      r.stages[1].bands![2] = { fromMultiple: 2.0, ratePercent: 15 };
    }, 'ascend');
  });

  it('refuses at_least_n accelerators without a count', () => {
    expectBadRequest((r) => {
      r.stages[1].accelerator = {
        evaluationMode: 'at_least_n',
        conditions: [
          { metric: 'rebooking_rate_percent', comparator: 'gte', basis: 'percent', thresholdValue: 50 },
        ],
      };
    }, 'requiredConditionCount');
  });

  it('refuses custom accelerators (no engine semantics yet)', () => {
    expectBadRequest((r) => {
      r.stages[1].accelerator = {
        evaluationMode: 'custom',
        conditions: [
          { metric: 'rebooking_rate_percent', comparator: 'gte', basis: 'percent', thresholdValue: 50 },
        ],
      };
    }, 'custom');
  });

  it('refuses discount bases with no captured data', () => {
    expectBadRequest((r) => {
      r.discountBasis = 'actual_after_discount';
    }, 'headline_before_discount');
  });

  it('refuses a greater_of stage with fewer than two comparison members', () => {
    expectBadRequest((r) => {
      r.stages.push({ stageType: 'greater_of' });
    }, 'at least two');
  });

  it('refuses revenue_split without split_percent', () => {
    expectBadRequest((r) => {
      r.stages.push({ stageType: 'revenue_split', config: {} });
    }, 'split_percent');
  });

  it('refuses chair rent without a positive amount', () => {
    expectBadRequest((r) => {
      r.stages.push({ stageType: 'chair_rent', config: { amount_cents: 0 } });
    }, 'amount_cents');
  });
});
