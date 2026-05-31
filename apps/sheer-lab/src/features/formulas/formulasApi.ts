import type { LocationProductBillingSettings } from '@sheer/domain';
import type { FormulaSavePayload } from '@sheer/lab-core';

import { appConfig } from '../../config/appConfig';
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

export async function finalizeFormulaForLabSession(sessionId: string, payload: FormulaSavePayload) {
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/formulas/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(payload.formulaId)}/finalize`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`Could not finalize formula (${response.status})`);
  }

  return response.json();
}

export async function getLabProductBillingSettings(
  sessionId: string,
): Promise<LocationProductBillingSettings> {
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/formulas/session/${encodeURIComponent(sessionId)}/product-billing`,
  );

  if (!response.ok) {
    throw new Error(`Could not load product billing settings (${response.status})`);
  }

  const data = (await response.json()) as { settings: LocationProductBillingSettings };
  return data.settings;
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
