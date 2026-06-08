import type { ProductBillingRule, ProductBillingSnapshot } from '@sheer/domain';

export interface CalculateProductBillableAmountInput {
  productCostAmountCents: number;
  rule: ProductBillingRule;
  markupPercent: number | null;
  fixedUpliftAmount: number | null;
  /** When true, the result is rounded UP to the nearest roundUpIncrement. */
  roundUpEnabled?: boolean;
  /** Round-up step in decimal GBP (e.g. 0.50 = round up to nearest 50p). */
  roundUpIncrement?: number | null;
}

/**
 * Rounds an amount (in minor units) UP to the nearest increment.
 * e.g. 444 cents with a £0.50 increment → 450; 489 → 500.
 * A disabled flag, missing increment, or non-positive increment is a no-op.
 */
export function applyRoundUp(
  amountCents: number,
  enabled: boolean | undefined,
  incrementGbp: number | null | undefined,
): number {
  if (!enabled) return amountCents;
  if (incrementGbp === null || incrementGbp === undefined || incrementGbp <= 0) return amountCents;
  const stepCents = Math.round(incrementGbp * 100);
  if (stepCents <= 0) return amountCents;
  return Math.ceil(amountCents / stepCents) * stepCents;
}

function computeBaseBillableAmount(
  productCostAmountCents: number,
  rule: ProductBillingRule,
  markupPercent: number | null,
  fixedUpliftAmount: number | null,
): number {
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

/**
 * Calculates the billable amount for a product usage line item.
 * fixedUpliftAmount is stored as a decimal (e.g. 4.00 = £4.00) and is
 * converted to minor units internally before arithmetic. When round-up is
 * enabled the final amount is rounded UP to the nearest increment.
 */
export function calculateProductBillableAmount(
  input: CalculateProductBillableAmountInput,
): number {
  const { productCostAmountCents, rule, markupPercent, fixedUpliftAmount } = input;
  const base = computeBaseBillableAmount(productCostAmountCents, rule, markupPercent, fixedUpliftAmount);
  return applyRoundUp(base, input.roundUpEnabled, input.roundUpIncrement);
}

export function buildProductBillingSnapshot(
  productCostAmountCents: number,
  rule: ProductBillingRule,
  markupPercent: number | null,
  fixedUpliftAmount: number | null,
  roundUpEnabled = false,
  roundUpIncrement: number | null = null,
): ProductBillingSnapshot {
  const billableAmountCents = calculateProductBillableAmount({
    productCostAmountCents,
    rule,
    markupPercent,
    fixedUpliftAmount,
    roundUpEnabled,
    roundUpIncrement,
  });
  return {
    costAmountCents: productCostAmountCents,
    billableAmountCents,
    billingRuleSnapshot: rule,
    markupPercentSnapshot: rule === 'cost_plus_markup_percent' ? markupPercent : null,
    fixedUpliftAmountSnapshot: rule === 'fixed_uplift' ? fixedUpliftAmount : null,
    roundUpEnabledSnapshot: roundUpEnabled,
    roundUpIncrementSnapshot: roundUpEnabled ? roundUpIncrement : null,
  };
}
