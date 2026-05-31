import type { LocationProductBillingSettings } from '@sheer/domain';

import type { FormulaIngredientRow } from './formulaDraftTypes';

export interface FormulaCostSummary {
  rows: FormulaIngredientRow[];
  totalCostCents: number;
  totalWasteCostCents: number;
  hasMissingCost: boolean;
}

export function calculateFormulaCosts(rows: FormulaIngredientRow[]): FormulaCostSummary {
  let totalCostCents = 0;
  let totalWasteCostCents = 0;
  let hasMissingCost = false;

  const costedRows = rows.map((row) => {
    const costCents = calculateIngredientCostCents(row);
    const wasteCostCents = calculateWasteCostCents(row);

    if ((costCents == null && (row.capturedGrams ?? 0) > 0) || (wasteCostCents == null && (row.wasteGrams ?? 0) > 0)) {
      hasMissingCost = true;
    }

    totalCostCents += costCents ?? 0;
    totalWasteCostCents += wasteCostCents ?? 0;

    return {
      ...row,
      costCents,
      wasteCostCents,
    };
  });

  return {
    rows: costedRows,
    totalCostCents,
    totalWasteCostCents,
    hasMissingCost,
  };
}

export function calculateIngredientCostCents(row: FormulaIngredientRow): number | undefined {
  if (row.capturedGrams == null || row.capturedGrams <= 0) return undefined;
  if (row.costBasis.costPerGramCents == null) return undefined;

  return Math.round(row.capturedGrams * row.costBasis.costPerGramCents);
}

export function calculateWasteCostCents(row: FormulaIngredientRow): number | undefined {
  if (row.wasteGrams == null || row.wasteGrams <= 0) return undefined;
  if (row.costBasis.costPerGramCents == null) return undefined;

  return Math.round(row.wasteGrams * row.costBasis.costPerGramCents);
}

/**
 * Applies the location's product billing rule to a raw product cost so the
 * colour-charge preview matches the billable amount the API will produce at
 * finalize time. Mirrors the server-side calculateProductBillableAmount helper.
 * Falls back to cost-only when billing is disabled or a required parameter is
 * missing.
 */
export function calculateBillableChargeCents(
  totalCostCents: number,
  billing: LocationProductBillingSettings | null | undefined,
): number {
  if (!billing || !billing.productBillingEnabled) return totalCostCents;

  switch (billing.productBillingRule) {
    case 'cost_plus_markup_percent':
      if (billing.productMarkupPercent == null) return totalCostCents;
      return totalCostCents + Math.round((totalCostCents * billing.productMarkupPercent) / 100);
    case 'fixed_uplift':
      if (billing.productFixedUpliftAmount == null) return totalCostCents;
      return totalCostCents + Math.round(billing.productFixedUpliftAmount * 100);
    case 'cost_only':
    default:
      return totalCostCents;
  }
}

export function formatMoney(cents: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currencyCode,
  }).format(cents / 100);
}
