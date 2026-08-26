/**
 * Null-versus-zero at the UI boundary — the place a truthy-check bug would
 * quietly cost money. Blank NEVER becomes 0; 0 NEVER becomes "inherit".
 */
import type { RetailPricingRule } from '@sheer/domain';
import { buildRulePayload, describeRule, planRuleSave, ruleToFormState } from './pricingRuleForm';

const zeroRule: RetailPricingRule = {
  id: 'r1',
  businessId: 'b1',
  scope: 'product',
  productId: 'p1',
  pricingMode: 'percentage_markup',
  markupPercent: 0,
  createdAt: '',
  updatedAt: '',
};

describe('loading a rule into the editor', () => {
  it('an explicit 0% round-trips as the visible text "0", never as blank', () => {
    expect(ruleToFormState(zeroRule)).toEqual({ method: 'percentage_markup', markupInput: '0', priceInput: '' });
  });

  it('no rule loads as Inherit with empty inputs', () => {
    expect(ruleToFormState(undefined).method).toBe('inherit');
  });

  it('a fixed price loads in pounds', () => {
    expect(
      ruleToFormState({ ...zeroRule, pricingMode: 'fixed_price', markupPercent: undefined, fixedPriceCents: 1850 }).priceInput,
    ).toBe('18.50');
  });
});

describe('saving — blank is inherit, 0 is 0', () => {
  it('an empty percentage box is INVALID, never saved as 0', () => {
    const plan = planRuleSave({ method: 'percentage_markup', markupInput: '', priceInput: '' }, undefined);
    expect(plan.action).toBe('invalid');
  });

  it('a typed 0 persists an explicit zero-markup rule', () => {
    const plan = planRuleSave({ method: 'percentage_markup', markupInput: '0', priceInput: '' }, undefined);
    expect(plan).toEqual({ action: 'upsert', pricingMode: 'percentage_markup', markupPercent: 0 });
  });

  it('Inherit with an existing rule DELETES it; without one it is a no-op', () => {
    expect(planRuleSave({ method: 'inherit', markupInput: '', priceInput: '' }, zeroRule)).toEqual({ action: 'delete' });
    expect(planRuleSave({ method: 'inherit', markupInput: '', priceInput: '' }, undefined)).toEqual({ action: 'none' });
  });

  it('a fixed price converts pounds to integer cents (£18.50 -> 1850)', () => {
    expect(planRuleSave({ method: 'fixed_price', markupInput: '', priceInput: '18.50' }, undefined)).toEqual({
      action: 'upsert',
      pricingMode: 'fixed_price',
      fixedPriceCents: 1850,
    });
  });

  it('a fixed price of 0 is a real free-of-charge override', () => {
    expect(planRuleSave({ method: 'fixed_price', markupInput: '', priceInput: '0' }, undefined)).toEqual({
      action: 'upsert',
      pricingMode: 'fixed_price',
      fixedPriceCents: 0,
    });
  });

  it('rejects negatives, non-numbers and sub-penny precision', () => {
    expect(planRuleSave({ method: 'percentage_markup', markupInput: '-5', priceInput: '' }, undefined).action).toBe('invalid');
    expect(planRuleSave({ method: 'fixed_price', markupInput: '', priceInput: 'abc' }, undefined).action).toBe('invalid');
    expect(planRuleSave({ method: 'fixed_price', markupInput: '', priceInput: '1.999' }, undefined).action).toBe('invalid');
  });
});

describe('payload assembly', () => {
  it('a 0 percent survives to the wire', () => {
    const payload = buildRulePayload(
      { action: 'upsert', pricingMode: 'percentage_markup', markupPercent: 0 },
      { scope: 'product', productId: 'p1' },
    );
    expect(payload).toEqual({ scope: 'product', productId: 'p1', pricingMode: 'percentage_markup', markupPercent: 0 });
    expect('fixedPriceCents' in payload).toBe(false);
  });
});

describe('descriptions', () => {
  it('describes 0% as 0% markup, not as inheriting', () => {
    expect(describeRule(zeroRule)).toBe('0% markup');
    expect(describeRule(undefined)).toBe('Inherits');
  });
});
