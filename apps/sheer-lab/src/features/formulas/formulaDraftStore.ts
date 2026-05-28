import type { BleWeightReading } from '../ble/types';
import { calculateFormulaCosts } from './formulaCosting';
import type {
  FormulaClientContext,
  FormulaDraftSession,
  FormulaIngredientRow,
  FormulaPatchTestContext,
  FormulaRowMetadataUpdate,
  FormulaVisitContext,
  SavedFormulaRecord,
} from './formulaDraftTypes';
import { toLabCoreFormulaItems, toFormulaFinalSavePayload, toFormulaSavePayload } from './formulaDraftTypes';

type FormulaDraftListener = (draft: FormulaDraftSession) => void;

const DEFAULT_DRAFT_ID = 'local-formula-draft';
const DEFAULT_LAB_SESSION_ID = 'pending-lab-session';

let rowSequence = 0;
let draftSequence = 0;

const persistedDrafts = new Map<string, FormulaDraftSession>();
const savedFormulaHistory = new Map<string, SavedFormulaRecord[]>();
let currentDraft = createInitialDraft();
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
  subscribe(listener: FormulaDraftListener): () => void {
    listeners.add(listener);
    listener(currentDraft);

    return () => {
      listeners.delete(listener);
    };
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
    appointmentId: string;
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

  return {
    ...draft,
    rows: costSummary.rows,
    totalCostCents: costSummary.totalCostCents,
    totalWasteCostCents: costSummary.totalWasteCostCents,
    billableChargeCents: costSummary.totalCostCents,
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
