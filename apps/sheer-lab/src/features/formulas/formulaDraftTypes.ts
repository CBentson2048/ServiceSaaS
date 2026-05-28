import type { FormulaDraft, FormulaHistoryRecord, FormulaItem, FormulaSavePayload } from '@sheer/lab-core';

import type { BleWeightReading } from '../ble/types';

export type FormulaWeightSource = 'ble' | 'manual';
export type FormulaDraftStatus = 'draft' | 'mixing' | 'saved';
export type FormulaIngredientIdentityMode = 'catalogue_product' | 'custom_manual';
export type FormulaRowCaptureStatus = 'waiting' | 'live' | 'captured';

export interface FormulaPatchTestContext {
  status: 'unknown' | 'pending' | 'passed' | 'failed' | 'expired';
  performedAt?: string;
  expiresAt?: string;
}

export interface FormulaClientContext {
  clientProfileId?: string;
  clientName: string;
  clientCode?: string;
}

export interface FormulaVisitContext {
  appointmentId?: string;
  visitId?: string;
  serviceType: string;
  startsAt?: string;
}

export interface FormulaCostBasis {
  productId?: string;
  source: 'product_catalog' | 'manual_cost' | 'missing';
  costPerGramCents?: number;
  currencyCode: string;
}

export interface FormulaIngredientRow {
  id: string;
  identityMode: FormulaIngredientIdentityMode;
  productId?: string;
  productName: string;
  brand?: string;
  shade?: string;
  category?: string;
  sku?: string;
  displayName?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  capturedGrams?: number;
  wasteGrams?: number;
  weightSource?: FormulaWeightSource;
  captureStatus: FormulaRowCaptureStatus;
  capturedAt?: string;
  costBasis: FormulaCostBasis;
  costCents?: number;
  wasteCostCents?: number;
  notes?: string;
}

export interface FormulaDraftSession {
  id: string;
  labSessionId: string;
  client: FormulaClientContext;
  visit: FormulaVisitContext;
  patchTest: FormulaPatchTestContext;
  status: FormulaDraftStatus;
  rows: FormulaIngredientRow[];
  activeIngredientId?: string;
  lastLiveReading?: BleWeightReading;
  sourceFormulaId?: string;
  totalCostCents: number;
  totalWasteCostCents: number;
  billableChargeCents: number;
  billingStatus: 'not_requested' | 'applied';
  hasMissingCost: boolean;
  currencyCode: string;
  savedAt?: string;
  finalizedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type FormulaRowMetadataUpdate = Pick<
  FormulaIngredientRow,
  | 'productName'
  | 'productId'
  | 'identityMode'
  | 'brand'
  | 'shade'
  | 'category'
  | 'sku'
  | 'displayName'
  | 'developer'
  | 'ratio'
  | 'processingTimeMinutes'
  | 'costBasis'
  | 'wasteGrams'
  | 'notes'
>;

export type SavedFormulaRecord = FormulaHistoryRecord & {
  client: FormulaClientContext;
  visit: FormulaVisitContext;
  patchTest: FormulaPatchTestContext;
  rows: FormulaIngredientRow[];
  totalCostCents: number;
  hasMissingCost: boolean;
};

export interface FormulaHistorySummary {
  formulas: SavedFormulaRecord[];
  latest?: SavedFormulaRecord;
}

export function toLabCoreFormulaItems(rows: FormulaIngredientRow[]): FormulaItem[] {
  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    productName: row.productName.trim() || 'Untitled ingredient',
    brand: row.brand,
    shade: row.shade,
    developer: row.developer,
    ratio: row.ratio,
    processingTimeMinutes: row.processingTimeMinutes,
    capturedGrams: row.capturedGrams,
    wasteGrams: row.wasteGrams,
    entryMode: row.weightSource === 'manual' ? 'manual' : 'ble_scale',
    capturedAt: row.capturedAt,
    costPerGramCents: row.costBasis.costPerGramCents,
    costCents: row.costCents,
    wasteCostCents: row.wasteCostCents,
    notes: formatFormulaItemNotes(row),
  }));
}

export function toLabCoreFormulaDraft(session: FormulaDraftSession): FormulaDraft {
  return {
    id: session.id,
    labSessionId: session.labSessionId,
    appointmentId: session.visit.appointmentId,
    visitId: session.visit.visitId,
    clientProfileId: session.client.clientProfileId,
    client: {
      clientProfileId: session.client.clientProfileId,
      clientName: session.client.clientName,
    },
    visit: {
      appointmentId: session.visit.appointmentId,
      visitId: session.visit.visitId,
      serviceType: session.visit.serviceType,
    },
    sourceFormulaId: session.sourceFormulaId,
    status: session.status,
    items: toLabCoreFormulaItems(session.rows),
    chargePreviewCents: session.totalCostCents,
    totalCostCents: session.totalCostCents,
    totalWasteCostCents: session.totalWasteCostCents,
    billableChargeCents: session.billableChargeCents,
    billingStatus: session.billingStatus === 'applied' ? 'applied' : 'not_requested',
    currencyCode: session.currencyCode,
    savedAt: session.savedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function toFormulaSavePayload(session: FormulaDraftSession): FormulaSavePayload {
  return toFormulaFinalSavePayload(session, false);
}

export function toFormulaFinalSavePayload(
  session: FormulaDraftSession,
  finalizeRequested = true,
): FormulaSavePayload {
  return {
    formulaId: session.id,
    labSessionId: session.labSessionId,
    appointmentId: session.visit.appointmentId,
    visitId: session.visit.visitId,
    clientProfileId: session.client.clientProfileId,
    sourceFormulaId: session.sourceFormulaId,
    items: toLabCoreFormulaItems(session.rows),
    manualFallbacks: session.rows
      .filter((row) => row.weightSource === 'manual' && row.capturedGrams != null)
      .map((row) => ({
        reason: 'correction',
        grams: row.capturedGrams ?? 0,
        note: row.notes,
      })),
    totalCostCents: session.totalCostCents,
    totalWasteCostCents: session.totalWasteCostCents,
    billableChargeCents: session.billableChargeCents,
    currencyCode: session.currencyCode,
    billingHandoffRequested: true,
    inventoryDeductionRequested: true,
    finalizeRequested,
  };
}

function formatFormulaItemNotes(row: FormulaIngredientRow): string | undefined {
  const metadata = [row.brand, row.shade, row.developer].filter(Boolean).join(' · ');
  const noteParts = [metadata, row.notes].filter(Boolean);

  return noteParts.length > 0 ? noteParts.join('\n') : undefined;
}
