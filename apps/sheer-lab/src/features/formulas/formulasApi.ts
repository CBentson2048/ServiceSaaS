import type { FormulaSavePayload } from '@sheer/lab-core';

import { sheerApiClient } from '../../lib/api/client';

export async function startFormula(input: {
  labSessionId: string;
  appointmentId?: string;
  clientProfileId?: string;
}) {
  return sheerApiClient.labFormulas.start(input);
}

export async function saveFormula(payload: FormulaSavePayload) {
  return sheerApiClient.labFormulas.save(payload);
}

export async function getLatestFormulaForClient(clientProfileId: string) {
  return sheerApiClient.labFormulas.latestForClient(clientProfileId);
}

export async function listFormulaHistoryForClient(clientProfileId: string) {
  return sheerApiClient.labFormulas.historyForClient(clientProfileId);
}

export async function duplicateFormula(
  formulaId: string,
  input: {
    labSessionId: string;
    appointmentId?: string;
    visitId?: string;
    clientProfileId?: string;
  },
) {
  return sheerApiClient.labFormulas.duplicate(formulaId, input);
}
