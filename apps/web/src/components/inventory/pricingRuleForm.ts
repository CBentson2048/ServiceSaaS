/**
 * Pure logic behind every pricing-rule editor (classification CR).
 *
 * The financially critical rule lives here: an EMPTY input is "inherit"
 * (delete the rule), an explicit "0" is a real zero-markup override
 * (persist 0). The two must never collapse into each other, and no truthy
 * check may ever decide a price. DOM-free and fully unit-tested.
 */
import type { RetailPricingMode, RetailPricingRule, UpsertRetailPricingRuleRequest } from '@sheer/domain';

/** What the editor's Method dropdown offers. */
export type PricingMethodChoice = 'inherit' | 'percentage_markup' | 'fixed_price';

export interface PricingRuleFormState {
  method: PricingMethodChoice;
  /** Raw text of the % input (percentage mode). */
  markupInput: string;
  /** Raw text of the price input in pounds (fixed mode). */
  priceInput: string;
}

/** Editor state for an existing rule (or its absence). */
export function ruleToFormState(rule: RetailPricingRule | undefined): PricingRuleFormState {
  if (!rule) return { method: 'inherit', markupInput: '', priceInput: '' };
  if (rule.pricingMode === 'fixed_price') {
    return {
      method: 'fixed_price',
      markupInput: '',
      priceInput: rule.fixedPriceCents !== undefined ? (rule.fixedPriceCents / 100).toFixed(2) : '',
    };
  }
  return {
    method: 'percentage_markup',
    // String(0) = "0": an explicit zero round-trips visibly, never as blank.
    markupInput: rule.markupPercent !== undefined ? String(rule.markupPercent) : '',
    priceInput: '',
  };
}

export type PricingRulePlan =
  | { action: 'delete' }
  | { action: 'none' }
  | { action: 'upsert'; pricingMode: RetailPricingMode; markupPercent?: number; fixedPriceCents?: number }
  | { action: 'invalid'; message: string };

/**
 * Decide what saving the editor means. Explicit-zero rules:
 * - method "inherit"  -> DELETE the rule (restore inheritance);
 * - percentage ""     -> invalid (an empty box is NOT 0 — the user must type 0);
 * - percentage "0"    -> persist 0 (intentional zero markup);
 * - fixed ""          -> invalid; fixed "0"/"0.00" -> persist 0 cents.
 */
export function planRuleSave(state: PricingRuleFormState, existing: RetailPricingRule | undefined): PricingRulePlan {
  if (state.method === 'inherit') {
    return existing ? { action: 'delete' } : { action: 'none' };
  }

  if (state.method === 'percentage_markup') {
    const trimmed = state.markupInput.trim();
    if (trimmed === '') {
      return { action: 'invalid', message: 'Enter a markup percentage — 0 is allowed, blank means inherit (choose Inherit instead).' };
    }
    const percent = Number(trimmed);
    if (!Number.isFinite(percent) || percent < 0) {
      return { action: 'invalid', message: 'Markup must be a number of 0 or more.' };
    }
    if (Math.round(percent * 100) !== percent * 100) {
      return { action: 'invalid', message: 'Markup supports at most 2 decimal places.' };
    }
    return { action: 'upsert', pricingMode: 'percentage_markup', markupPercent: percent };
  }

  const trimmed = state.priceInput.trim();
  if (trimmed === '') {
    return { action: 'invalid', message: 'Enter a selling price — blank means inherit (choose Inherit instead).' };
  }
  const pounds = Number(trimmed);
  if (!Number.isFinite(pounds) || pounds < 0) {
    return { action: 'invalid', message: 'Price must be 0 or more.' };
  }
  const cents = Math.round(pounds * 100);
  if (Math.abs(pounds * 100 - cents) > 1e-6) {
    return { action: 'invalid', message: 'Price supports at most 2 decimal places (pence).' };
  }
  return { action: 'upsert', pricingMode: 'fixed_price', fixedPriceCents: cents };
}

/** Assemble the API payload for an upsert plan at one scope binding. */
export function buildRulePayload(
  plan: Extract<PricingRulePlan, { action: 'upsert' }>,
  binding: Pick<UpsertRetailPricingRuleRequest, 'scope' | 'productId' | 'categoryId' | 'locationId'>,
): UpsertRetailPricingRuleRequest {
  return {
    ...binding,
    pricingMode: plan.pricingMode,
    // `!== undefined` — a 0 percent must survive to the wire.
    ...(plan.markupPercent !== undefined ? { markupPercent: plan.markupPercent } : {}),
    ...(plan.fixedPriceCents !== undefined ? { fixedPriceCents: plan.fixedPriceCents } : {}),
  };
}

/** One-line human description of a rule for lists ("25% markup", "£18.50 fixed"). */
export function describeRule(rule: RetailPricingRule | undefined): string {
  if (!rule) return 'Inherits';
  if (rule.pricingMode === 'fixed_price') {
    return `£${((rule.fixedPriceCents ?? 0) / 100).toFixed(2)} fixed price`;
  }
  return `${rule.markupPercent ?? 0}% markup`;
}
