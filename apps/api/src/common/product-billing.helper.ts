import type { ProductBillingRule, ProductBillingSnapshot } from '@sheer/domain';

export interface CalculateProductBillableAmountInput {
  productCostAmountCents: number;
  rule: ProductBillingRule;
  markupPercent: number | null;
  fixedUpliftAmount: number | null;
}

/**
 * Calculates the billable amount for a product usage line item.
 * fixedUpliftAmount is stored as a decimal (e.g. 4.00 = £4.00) and is
 * converted to minor units internally before arithmetic.
 */
export function calculateProductBillableAmount(
  input: CalculateProductBillableAmountInput,
): number {
  const { productCostAmountCents, rule, markupPercent, fixedUpliftAmount } = input;

  if (rule === 'cost_only') {
    return productCostAmountCents;
  }

  if (rule === 'cost_plus_markup_percent') {
    if (markupPercent === null || markupPercent === undefined) {
      throw new Error('markupPercent is required for cost_plus_markup_percent rule');
    }
    return productCostAmountCents + Math.round((productCostAmountCents * markupPercent) / 100);
  }

  if (rule === 'fixed_uplift') {
    if (fixedUpliftAmount === null || fixedUpliftAmount === undefined) {
      throw new Error('fixedUpliftAmount is required for fixed_uplift rule');
    }
    const upliftCents = Math.round(fixedUpliftAmount * 100);
    return productCostAmountCents + upliftCents;
  }

  throw new Error(`Unknown product billing rule: ${rule}`);
}

export function buildProductBillingSnapshot(
  productCostAmountCents: number,
  rule: ProductBillingRule,
  markupPercent: number | null,
  fixedUpliftAmount: number | null,
): ProductBillingSnapshot {
  const billableAmountCents = calculateProductBillableAmount({
    productCostAmountCents,
    rule,
    markupPercent,
    fixedUpliftAmount,
  });
  return {
    costAmountCents: productCostAmountCents,
    billableAmountCents,
    billingRuleSnapshot: rule,
    markupPercentSnapshot: rule === 'cost_plus_markup_percent' ? markupPercent : null,
    fixedUpliftAmountSnapshot: rule === 'fixed_uplift' ? fixedUpliftAmount : null,
  };
}
