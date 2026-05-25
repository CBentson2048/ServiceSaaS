import { useCallback, useEffect, useState } from 'react';

import type { BleWeightReading } from '../ble/types';
import { formulaDraftStore } from './formulaDraftStore';
import type {
  FormulaClientContext,
  FormulaDraftSession,
  FormulaPatchTestContext,
  FormulaRowMetadataUpdate,
  FormulaVisitContext,
} from './formulaDraftTypes';

export function useFormulaDraft() {
  const [draft, setDraft] = useState<FormulaDraftSession>(() => formulaDraftStore.getState());

  useEffect(() => formulaDraftStore.subscribe(setDraft), []);

  const addRow = useCallback(() => formulaDraftStore.addRow(), []);
  const removeRow = useCallback((rowId: string) => formulaDraftStore.removeRow(rowId), []);
  const selectActiveRow = useCallback((rowId: string) => formulaDraftStore.selectActiveRow(rowId), []);
  const updateRowMetadata = useCallback(
    (rowId: string, metadata: FormulaRowMetadataUpdate) =>
      formulaDraftStore.updateRowMetadata(rowId, metadata),
    [],
  );
  const applyBleWeight = useCallback((reading: BleWeightReading) => {
    formulaDraftStore.applyBleWeight(reading);
  }, []);
  const applyManualWeight = useCallback((rowId: string, grams: number) => {
    formulaDraftStore.applyManualWeight(rowId, grams);
  }, []);
  const saveDraft = useCallback(() => formulaDraftStore.saveDraft(), []);
  const markFinalized = useCallback(() => formulaDraftStore.markFinalized(), []);
  const loadDraft = useCallback((draftId?: string) => formulaDraftStore.loadDraft(draftId), []);
  const getHistoryForClient = useCallback((clientProfileId?: string) => {
    return formulaDraftStore.getHistoryForClient(clientProfileId);
  }, []);
  const getLatestFormulaForClient = useCallback((clientProfileId?: string) => {
    return formulaDraftStore.getLatestFormulaForClient(clientProfileId);
  }, []);
  const duplicateFormula = useCallback((sourceFormulaId: string) => {
    return formulaDraftStore.duplicateFormula(sourceFormulaId);
  }, []);
  const startFromAppointmentContext = useCallback(
    (input: {
      labSessionId: string;
      appointmentId: string;
      client: FormulaClientContext;
      visit: FormulaVisitContext;
      patchTest?: FormulaPatchTestContext;
    }) => formulaDraftStore.startFromAppointmentContext(input),
    [],
  );
  const toSavePayload = useCallback(() => formulaDraftStore.toSavePayload(), []);
  const toFinalSavePayload = useCallback(() => formulaDraftStore.toFinalSavePayload(), []);

  return {
    draft,
    addRow,
    removeRow,
    selectActiveRow,
    updateRowMetadata,
    applyBleWeight,
    applyManualWeight,
    saveDraft,
    markFinalized,
    loadDraft,
    getHistoryForClient,
    getLatestFormulaForClient,
    duplicateFormula,
    startFromAppointmentContext,
    toSavePayload,
    toFinalSavePayload,
  };
}
