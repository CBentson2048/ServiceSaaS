import type { LocationProductBillingSettings } from '@sheer/domain';

import type { BleWeightReading } from '../ble/types';
import { calculateBillableChargeCents, calculateFormulaCosts } from './formulaCosting';
import type {
  FormulaClientContext,
  FormulaDraftSession,
  FormulaIngredientRow,
  FormulaPatchTestContext,
  FormulaRemixBaseline,
  FormulaRowMetadataUpdate,
  FormulaVisitContext,
  SavedFormulaRecord,
} from './formulaDraftTypes';
import { toLabCoreFormulaItems, toFormulaFinalSavePayload, toFormulaSavePayload } from './formulaDraftTypes';

type FormulaDraftListener = (draft: FormulaDraftSession) => void;

/** One product chosen on the Build Formula screen, ready to seed an ingredient row. */
export interface BuiltFormulaItemInput {
  productId?: string;
  productName: string;
  brand?: string;
  shade?: string;
  category?: string;
  sku?: string;
  displayName?: string;
  costPerGramCents?: number;
  plannedGrams?: number;
  currencyCode?: string;
}

const DEFAULT_DRAFT_ID = 'local-formula-draft';
const DEFAULT_LAB_SESSION_ID = 'pending-lab-session';

let rowSequence = 0;
let draftSequence = 0;

const persistedDrafts = new Map<string, FormulaDraftSession>();
const savedFormulaHistory = new Map<string, SavedFormulaRecord[]>();
let currentDraft = createInitialDraft();
let productBilling: LocationProductBillingSettings | null = null;
const listeners = new Set<FormulaDraftListener>();

export const formulaDraftStore = {
  getState(): FormulaDraftSession {
    return currentDraft;
  },
  getHistoryForClient(clientProfileId = currentDraft.client.clientProfileId): SavedFormulaRecord[] {
    if (!clientProfileId) return [];

    return [...(savedFormulaHistory.get(clientProfileId) ?? [])].sort((a, b) =>
      b.savedAt.localeCompare(a.savedAt),
    );
  },
  getLatestFormulaForClient(clientProfileId = currentDraft.client.clientProfileId): SavedFormulaRecord | undefined {
    return this.getHistoryForClient(clientProfileId)[0];
  },
  getSavedFormulaById(formulaId: string): SavedFormulaRecord | undefined {
    return findSavedFormula(formulaId);
  },
  subscribe(listener: FormulaDraftListener): () => void {
    listeners.add(listener);
    listener(currentDraft);

    return () => {
      listeners.delete(listener);
    };
  },
  setProductBilling(settings: LocationProductBillingSettings | null): void {
    productBilling = settings;
    currentDraft = recalculateDraft(currentDraft);
    emit();
  },
  addRow(): FormulaIngredientRow {
    const row = createEmptyIngredientRow();

    updateDraft({
      rows: [...freezeActiveRowCapture(currentDraft.rows), row],
      activeIngredientId: row.id,
      status: 'mixing',
    });

    return row;
  },
  removeRow(rowId: string): void {
    const rows = currentDraft.rows.filter((row) => row.id !== rowId);
    const activeIngredientId =
      currentDraft.activeIngredientId === rowId ? rows.at(-1)?.id : currentDraft.activeIngredientId;

    updateDraft({ rows, activeIngredientId, status: rows.length > 0 ? 'mixing' : 'draft' });
  },
  selectActiveRow(rowId: string): void {
    if (!currentDraft.rows.some((row) => row.id === rowId)) return;

    updateDraft({ activeIngredientId: rowId, status: 'mixing' });
  },
  startRowReweigh(rowId: string): void {
    if (!currentDraft.rows.some((row) => row.id === rowId)) return;

    const preparedRows = freezeActiveRowCapture(currentDraft.rows);
    updateDraft({
      rows: preparedRows.map((row) =>
        row.id === rowId
          ? {
              ...row,
              captureStatus: 'waiting',
            }
          : row,
      ),
      activeIngredientId: rowId,
      status: 'mixing',
    });
  },
  updateRowMetadata(rowId: string, metadata: FormulaRowMetadataUpdate): void {
    updateRows((row) => (row.id === rowId ? { ...row, ...metadata } : row));
  },
  applyBleWeight(reading: BleWeightReading): void {
    const activeIngredientId = currentDraft.activeIngredientId;
    if (!activeIngredientId || reading.source !== 'ble') return;
    const activeRow = currentDraft.rows.find((row) => row.id === activeIngredientId);
    if (!activeRow || activeRow.captureStatus === 'captured') return;

    updateRows(
      (row) =>
        row.id === activeIngredientId
          ? {
              ...row,
              capturedGrams: reading.grams,
              weightSource: 'ble',
              captureStatus: 'live',
              capturedAt: reading.capturedAt,
            }
          : row,
      { lastLiveReading: reading, status: 'mixing' },
    );
  },
  applyManualWeight(rowId: string, grams: number): void {
    const capturedAt = new Date().toISOString();

    updateRows(
      (row) =>
        row.id === rowId
          ? {
              ...row,
              capturedGrams: grams,
              weightSource: 'manual',
              captureStatus: 'captured',
              capturedAt,
            }
          : row.id === currentDraft.activeIngredientId && row.capturedGrams != null
            ? {
                ...row,
                captureStatus: 'captured',
              }
            : row,
      { activeIngredientId: rowId, status: 'mixing' },
    );
  },
  saveDraft(): FormulaDraftSession {
    const savedAt = new Date().toISOString();
    const savedDraft = recalculateDraft({
      ...currentDraft,
      rows: freezeActiveRowCapture(currentDraft.rows),
      savedAt,
      updatedAt: savedAt,
    });

    currentDraft = savedDraft;
    persistedDrafts.set(savedDraft.id, savedDraft);
    saveHistoryRecord(savedDraft, savedAt);
    emit();

    return savedDraft;
  },
  markFinalized(): FormulaDraftSession {
    const finalizedAt = new Date().toISOString();
    const finalizedDraft = recalculateDraft({
      ...currentDraft,
      rows: freezeActiveRowCapture(currentDraft.rows),
      status: 'saved',
      savedAt: finalizedAt,
      finalizedAt,
      updatedAt: finalizedAt,
    });

    currentDraft = finalizedDraft;
    persistedDrafts.set(finalizedDraft.id, finalizedDraft);
    saveHistoryRecord(finalizedDraft, finalizedAt);
    emit();

    return finalizedDraft;
  },
  loadDraft(draftId = currentDraft.id): FormulaDraftSession | undefined {
    const draft = persistedDrafts.get(draftId);
    if (!draft) return undefined;

    currentDraft = draft;
    emit();

    return currentDraft;
  },
  duplicateFormula(sourceFormulaId: string): FormulaDraftSession | undefined {
    const source = findSavedFormula(sourceFormulaId);
    if (!source) return undefined;

    const createdAt = new Date().toISOString();
    const rows = source.rows.map((row) => createDuplicatedIngredientRow(row));
    const nextDraft = recalculateDraft({
      ...currentDraft,
      id: createDraftId(),
      rows,
      activeIngredientId: rows[0]?.id,
      sourceFormulaId: source.id,
      status: 'draft',
      savedAt: undefined,
      createdAt,
      updatedAt: createdAt,
    });

    currentDraft = nextDraft;
    emit();

    return currentDraft;
  },
  startFromAppointmentContext(input: {
    labSessionId: string;
    appointmentId?: string;
    client: FormulaClientContext;
    visit: FormulaVisitContext;
    patchTest?: FormulaPatchTestContext;
  }): FormulaDraftSession {
    const createdAt = new Date().toISOString();
    currentDraft = recalculateDraft({
      ...createInitialDraft(),
      id: createDraftId(),
      labSessionId: input.labSessionId,
      client: input.client,
      visit: input.visit,
      patchTest: input.patchTest ?? { status: 'unknown' },
      createdAt,
      updatedAt: createdAt,
    });
    emit();
    return currentDraft;
  },
  /**
   * Seed a fresh draft from the products chosen on the Build Formula screen so
   * the capture screen opens pre-populated with one ingredient row per product
   * (identity + cost basis + planned/target grams). No weights are captured
   * yet — the stylist still weighs each row on the capture screen.
   */
  startBuiltFormula(input: {
    labSessionId: string;
    appointmentId?: string;
    client: FormulaClientContext;
    visit: FormulaVisitContext;
    patchTest?: FormulaPatchTestContext;
    items: BuiltFormulaItemInput[];
  }): FormulaDraftSession {
    const createdAt = new Date().toISOString();
    const rows =
      input.items.length > 0
        ? input.items.map((item) => createSeededIngredientRow(item))
        : [createEmptyIngredientRow('Base colour')];

    currentDraft = recalculateDraft({
      ...createInitialDraft(),
      id: createDraftId(),
      labSessionId: input.labSessionId,
      client: input.client,
      visit: input.visit,
      patchTest: input.patchTest ?? { status: 'unknown' },
      rows,
      activeIngredientId: rows[0]?.id,
      status: input.items.length > 0 ? 'mixing' : 'draft',
      createdAt,
      updatedAt: createdAt,
    });
    emit();
    return currentDraft;
  },
  /**
   * Seed a fresh draft that re-mixes a previously saved formula. Each ingredient
   * row is re-created from the source (identity + cost basis preserved) with its
   * captures cleared and a planned/target weight derived from the source's actual
   * grams scaled by `percent` (or overridden per row via `targetGramsByRowId`).
   *
   * The remix gets a brand-new draft id so it finalizes as its own formula on the
   * same appointment/visit — the backend then deducts only the newly-weighed grams
   * and aggregates visit usage, giving "total used = previous mix + this remix".
   * The previous mix is captured in `remixBaseline` for display only.
   */
  startRemixFromFormula(input: {
    sourceFormulaId: string;
    percent: number;
    labSessionId: string;
    appointmentId?: string;
    client: FormulaClientContext;
    visit: FormulaVisitContext;
    patchTest?: FormulaPatchTestContext;
    targetGramsByRowId?: Record<string, number>;
  }): FormulaDraftSession | undefined {
    const source = findSavedFormula(input.sourceFormulaId);
    if (!source) return undefined;

    const createdAt = new Date().toISOString();
    const rows = source.rows.map((row) =>
      createRemixIngredientRow(
        row,
        input.targetGramsByRowId?.[row.id] ?? scaleGrams(row.capturedGrams, input.percent),
      ),
    );

    currentDraft = recalculateDraft({
      ...createInitialDraft(),
      id: createDraftId(),
      labSessionId: input.labSessionId,
      client: input.client,
      visit: input.visit,
      patchTest: input.patchTest ?? { status: 'unknown' },
      rows,
      activeIngredientId: rows[0]?.id,
      sourceFormulaId: source.id,
      remixBaseline: buildRemixBaseline(source, input.percent),
      currencyCode: source.currencyCode ?? 'GBP',
      status: rows.length > 0 ? 'mixing' : 'draft',
      createdAt,
      updatedAt: createdAt,
    });
    emit();
    return currentDraft;
  },
  toSavePayload() {
    return toFormulaSavePayload(currentDraft);
  },
  toFinalSavePayload() {
    return toFormulaFinalSavePayload(currentDraft);
  },
};

function createInitialDraft(): FormulaDraftSession {
  const createdAt = new Date().toISOString();
  const firstRow = createEmptyIngredientRow('Base colour');

  return {
    id: DEFAULT_DRAFT_ID,
    labSessionId: DEFAULT_LAB_SESSION_ID,
    client: {
      clientProfileId: 'placeholder-client',
      clientName: 'Walk-in client',
      clientCode: 'LAB-TEST',
    },
    visit: {
      appointmentId: 'placeholder-appointment',
      serviceType: 'Colour service',
    },
    patchTest: {
      status: 'unknown',
    },
    status: 'draft',
    rows: [firstRow],
    activeIngredientId: firstRow.id,
    totalCostCents: 0,
    totalWasteCostCents: 0,
    billableChargeCents: 0,
    billingStatus: 'not_requested',
    hasMissingCost: false,
    currencyCode: 'GBP',
    createdAt,
    updatedAt: createdAt,
  };
}

function createEmptyIngredientRow(productName = ''): FormulaIngredientRow {
  rowSequence += 1;

  return {
    id: `ingredient-${rowSequence}`,
    identityMode: 'catalogue_product',
    productName,
    captureStatus: 'waiting',
    costBasis: {
      source: 'missing',
      currencyCode: 'GBP',
    },
  };
}

function createSeededIngredientRow(item: BuiltFormulaItemInput): FormulaIngredientRow {
  rowSequence += 1;
  const currencyCode = item.currencyCode ?? 'GBP';

  return {
    id: `ingredient-${rowSequence}`,
    identityMode: item.productId ? 'catalogue_product' : 'custom_manual',
    productId: item.productId,
    productName: item.productName,
    brand: item.brand,
    shade: item.shade,
    category: item.category,
    sku: item.sku,
    displayName: item.displayName,
    plannedGrams: item.plannedGrams,
    captureStatus: 'waiting',
    costBasis: {
      productId: item.productId,
      source:
        item.costPerGramCents == null ? 'missing' : item.productId ? 'product_catalog' : 'manual_cost',
      costPerGramCents: item.costPerGramCents,
      currencyCode,
    },
  };
}

function createDuplicatedIngredientRow(source: FormulaIngredientRow): FormulaIngredientRow {
  rowSequence += 1;

  return {
    ...source,
    id: `ingredient-${rowSequence}`,
    captureStatus: source.capturedGrams == null ? 'waiting' : 'captured',
    capturedAt: undefined,
    weightSource: undefined,
  };
}

function createRemixIngredientRow(source: FormulaIngredientRow, targetGrams: number): FormulaIngredientRow {
  rowSequence += 1;

  return {
    ...source,
    id: `ingredient-${rowSequence}`,
    plannedGrams: targetGrams > 0 ? targetGrams : undefined,
    capturedGrams: undefined,
    capturedAt: undefined,
    weightSource: undefined,
    wasteGrams: undefined,
    captureStatus: 'waiting',
    costCents: undefined,
    wasteCostCents: undefined,
  };
}

/** Scale a previous actual weight by a remix percentage, to 0.1 g precision. */
function scaleGrams(grams: number | undefined, percent: number): number {
  if (grams == null || grams <= 0) return 0;
  return Math.round(((grams * percent) / 100) * 10) / 10;
}

function buildRemixBaseline(source: SavedFormulaRecord, percent: number): FormulaRemixBaseline {
  const gramsByProduct = new Map<string, number>();
  let totalGrams = 0;
  for (const row of source.rows) {
    const grams = row.capturedGrams ?? 0;
    if (grams <= 0) continue;
    totalGrams += grams;
    const name = row.productName?.trim() || row.displayName?.trim() || 'Ingredient';
    gramsByProduct.set(name, (gramsByProduct.get(name) ?? 0) + grams);
  }

  return {
    sourceFormulaId: source.id,
    percent,
    totalGrams,
    totalCostCents: source.totalCostCents ?? 0,
    billableChargeCents: source.billableChargeCents ?? 0,
    currencyCode: source.currencyCode ?? 'GBP',
    productUsage: Array.from(gramsByProduct, ([productName, grams]) => ({ productName, grams })).sort(
      (a, b) => b.grams - a.grams,
    ),
  };
}

function freezeActiveRowCapture(rows: FormulaIngredientRow[]): FormulaIngredientRow[] {
  const activeIngredientId = currentDraft.activeIngredientId;
  if (!activeIngredientId) return rows;

  return rows.map((row) =>
    row.id === activeIngredientId && row.capturedGrams != null
      ? {
          ...row,
          captureStatus: 'captured',
        }
      : row,
  );
}

function updateRows(
  updater: (row: FormulaIngredientRow) => FormulaIngredientRow,
  draftUpdate: Partial<FormulaDraftSession> = {},
): void {
  updateDraft({
    ...draftUpdate,
    rows: currentDraft.rows.map(updater),
  });
}

function updateDraft(update: Partial<FormulaDraftSession>): void {
  currentDraft = recalculateDraft({
    ...currentDraft,
    ...update,
    updatedAt: new Date().toISOString(),
  });
  emit();
}

function recalculateDraft(draft: FormulaDraftSession): FormulaDraftSession {
  const costSummary = calculateFormulaCosts(draft.rows.map(normalizeRowCaptureStatus));
  // Mirror the API's applyProductBillingLineItem guard: the location billing
  // rule only marks up an actual product cost, so a £0 mix stays at £0.
  const billableChargeCents =
    costSummary.totalCostCents > 0
      ? calculateBillableChargeCents(costSummary.totalCostCents, productBilling)
      : costSummary.totalCostCents;

  return {
    ...draft,
    rows: costSummary.rows,
    totalCostCents: costSummary.totalCostCents,
    totalWasteCostCents: costSummary.totalWasteCostCents,
    billableChargeCents,
    hasMissingCost: costSummary.hasMissingCost,
  };
}

function normalizeRowCaptureStatus(row: FormulaIngredientRow): FormulaIngredientRow {
  if (row.captureStatus) return row;

  return {
    ...row,
    captureStatus: row.capturedGrams == null ? 'waiting' : 'captured',
  };
}

function saveHistoryRecord(draft: FormulaDraftSession, savedAt: string): void {
  const clientProfileId = draft.client.clientProfileId;
  if (!clientProfileId) return;

  const record: SavedFormulaRecord = {
    ...draft,
    status: 'saved',
    items: toLabCoreFormulaItems(draft.rows),
    chargePreviewCents: draft.billableChargeCents,
    billableChargeCents: draft.billableChargeCents,
    totalWasteCostCents: draft.totalWasteCostCents,
    billingStatus: 'applied',
    savedAt,
  };

  const history = savedFormulaHistory.get(clientProfileId) ?? [];
  savedFormulaHistory.set(clientProfileId, [record, ...history].sort(sortNewestFirst));
}

function findSavedFormula(formulaId: string): SavedFormulaRecord | undefined {
  for (const history of savedFormulaHistory.values()) {
    const formula = history.find((record) => record.id === formulaId);
    if (formula) return formula;
  }

  return undefined;
}

function createDraftId(): string {
  draftSequence += 1;
  return `local-formula-draft-${draftSequence}`;
}

function sortNewestFirst(a: SavedFormulaRecord, b: SavedFormulaRecord): number {
  return b.savedAt.localeCompare(a.savedAt);
}

function emit(): void {
  listeners.forEach((listener) => listener(currentDraft));
}
