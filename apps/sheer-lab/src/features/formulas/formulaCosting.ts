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

export function formatMoney(cents: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currencyCode,
  }).format(cents / 100);
}
