import {
  buildProductBillingSnapshot,
  calculateProductBillableAmount,
} from './product-billing.helper';

describe('calculateProductBillableAmount', () => {
  describe('cost_only', () => {
    it('returns product cost unchanged', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 800,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
        }),
      ).toBe(800);
    });

    it('handles zero cost', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 0,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
        }),
      ).toBe(0);
    });

    it('ignores markup/uplift values when present', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 500,
          rule: 'cost_only',
          markupPercent: 50,
          fixedUpliftAmount: 2.0,
        }),
      ).toBe(500);
    });
  });

  describe('cost_plus_markup_percent', () => {
    it('adds 25% markup correctly: £8.00 + 25% = £10.00', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 800,
          rule: 'cost_plus_markup_percent',
          markupPercent: 25,
          fixedUpliftAmount: null,
        }),
      ).toBe(1000);
    });

    it('handles zero markup — billable equals cost', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 800,
          rule: 'cost_plus_markup_percent',
          markupPercent: 0,
          fixedUpliftAmount: null,
        }),
      ).toBe(800);
    });

    it('rounds fractional pence correctly (Math.round)', () => {
      // 100 cents * 33% = 33 cents (no fraction)
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 100,
          rule: 'cost_plus_markup_percent',
          markupPercent: 33,
          fixedUpliftAmount: null,
        }),
      ).toBe(133);

      // 1 cent * 50% = 0.5 → rounds to 1
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 1,
          rule: 'cost_plus_markup_percent',
          markupPercent: 50,
          fixedUpliftAmount: null,
        }),
      ).toBe(2);
    });

    it('throws when markupPercent is null', () => {
      expect(() =>
        calculateProductBillableAmount({
          productCostAmountCents: 800,
          rule: 'cost_plus_markup_percent',
          markupPercent: null,
          fixedUpliftAmount: null,
        }),
      ).toThrow('markupPercent is required');
    });
  });

  describe('fixed_uplift', () => {
    it('adds fixed uplift: £6.00 cost + £4.00 uplift = £10.00', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 600,
          rule: 'fixed_uplift',
          markupPercent: null,
          fixedUpliftAmount: 4.0,
        }),
      ).toBe(1000);
    });

    it('handles zero uplift — billable equals cost', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 600,
          rule: 'fixed_uplift',
          markupPercent: null,
          fixedUpliftAmount: 0,
        }),
      ).toBe(600);
    });

    it('converts decimal uplift to minor units correctly', () => {
      // £2.50 uplift = 250 pence
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 500,
          rule: 'fixed_uplift',
          markupPercent: null,
          fixedUpliftAmount: 2.5,
        }),
      ).toBe(750);
    });

    it('throws when fixedUpliftAmount is null', () => {
      expect(() =>
        calculateProductBillableAmount({
          productCostAmountCents: 600,
          rule: 'fixed_uplift',
          markupPercent: null,
          fixedUpliftAmount: null,
        }),
      ).toThrow('fixedUpliftAmount is required');
    });
  });

  describe('round-up', () => {
    it('rounds up to the nearest £0.50: £4.44 → £4.50', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 444,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
          roundUpEnabled: true,
          roundUpIncrement: 0.5,
        }),
      ).toBe(450);
    });

    it('rounds up to the nearest £0.50: £4.89 → £5.00', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 489,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
          roundUpEnabled: true,
          roundUpIncrement: 0.5,
        }),
      ).toBe(500);
    });

    it('rounds up to the nearest £1.00: £4.89 → £5.00', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 489,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
          roundUpEnabled: true,
          roundUpIncrement: 1,
        }),
      ).toBe(500);
    });

    it('applies after markup is added: £8.00 + 11% = £8.88 → £9.00 at £0.50 step', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 800,
          rule: 'cost_plus_markup_percent',
          markupPercent: 11,
          fixedUpliftAmount: null,
          roundUpEnabled: true,
          roundUpIncrement: 0.5,
        }),
      ).toBe(900);
    });

    it('leaves exact multiples unchanged', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 500,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
          roundUpEnabled: true,
          roundUpIncrement: 0.5,
        }),
      ).toBe(500);
    });

    it('is a no-op when disabled or increment missing', () => {
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 444,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
          roundUpEnabled: false,
          roundUpIncrement: 0.5,
        }),
      ).toBe(444);
      expect(
        calculateProductBillableAmount({
          productCostAmountCents: 444,
          rule: 'cost_only',
          markupPercent: null,
          fixedUpliftAmount: null,
          roundUpEnabled: true,
          roundUpIncrement: null,
        }),
      ).toBe(444);
    });
  });

  describe('validation', () => {
    it('throws for unknown rule', () => {
      expect(() =>
        calculateProductBillableAmount({
          productCostAmountCents: 100,
          // @ts-expect-error intentional invalid rule for test
          rule: 'unknown_rule',
          markupPercent: null,
          fixedUpliftAmount: null,
        }),
      ).toThrow('Unknown product billing rule');
    });
  });
});

describe('buildProductBillingSnapshot', () => {
  it('cost_only snapshot has correct fields', () => {
    const snapshot = buildProductBillingSnapshot(800, 'cost_only', null, null);
    expect(snapshot.costAmountCents).toBe(800);
    expect(snapshot.billableAmountCents).toBe(800);
    expect(snapshot.billingRuleSnapshot).toBe('cost_only');
    expect(snapshot.markupPercentSnapshot).toBeNull();
    expect(snapshot.fixedUpliftAmountSnapshot).toBeNull();
    expect(snapshot.roundUpEnabledSnapshot).toBe(false);
    expect(snapshot.roundUpIncrementSnapshot).toBeNull();
  });

  it('records round-up in the snapshot and applies it to the billable amount', () => {
    const snapshot = buildProductBillingSnapshot(444, 'cost_only', null, null, true, 0.5);
    expect(snapshot.billableAmountCents).toBe(450);
    expect(snapshot.roundUpEnabledSnapshot).toBe(true);
    expect(snapshot.roundUpIncrementSnapshot).toBe(0.5);
  });

  it('cost_plus_markup_percent snapshot records markup', () => {
    const snapshot = buildProductBillingSnapshot(800, 'cost_plus_markup_percent', 25, null);
    expect(snapshot.costAmountCents).toBe(800);
    expect(snapshot.billableAmountCents).toBe(1000);
    expect(snapshot.billingRuleSnapshot).toBe('cost_plus_markup_percent');
    expect(snapshot.markupPercentSnapshot).toBe(25);
    expect(snapshot.fixedUpliftAmountSnapshot).toBeNull();
  });

  it('fixed_uplift snapshot records uplift', () => {
    const snapshot = buildProductBillingSnapshot(600, 'fixed_uplift', null, 4.0);
    expect(snapshot.costAmountCents).toBe(600);
    expect(snapshot.billableAmountCents).toBe(1000);
    expect(snapshot.billingRuleSnapshot).toBe('fixed_uplift');
    expect(snapshot.markupPercentSnapshot).toBeNull();
    expect(snapshot.fixedUpliftAmountSnapshot).toBe(4.0);
  });

  it('snapshot preserves cost vs billable separation — cost_plus_markup', () => {
    const snapshot = buildProductBillingSnapshot(1000, 'cost_plus_markup_percent', 10, null);
    expect(snapshot.costAmountCents).toBe(1000);
    expect(snapshot.billableAmountCents).toBe(1100);
    expect(snapshot.costAmountCents).not.toBe(snapshot.billableAmountCents);
  });

  it('snapshot rule is not retroactively changed when called again with different rule', () => {
    const first = buildProductBillingSnapshot(800, 'cost_only', null, null);
    const second = buildProductBillingSnapshot(800, 'cost_plus_markup_percent', 25, null);
    expect(first.billingRuleSnapshot).toBe('cost_only');
    expect(second.billingRuleSnapshot).toBe('cost_plus_markup_percent');
  });
});
