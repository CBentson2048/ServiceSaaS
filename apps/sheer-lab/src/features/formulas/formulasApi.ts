import type { LocationProductBillingSettings } from '@sheer/domain';
import type { FormulaBillingBreakdown, FormulaSavePayload } from '@sheer/lab-core';

import { appConfig } from '../../config/appConfig';
import { sheerApiClient } from '../../lib/api/client';

export interface LabProductUsage {
  productName: string;
  grams: number;
}

export interface LabSessionBillingBreakdown {
  appointmentId: string;
  billingLineItem: {
    visitId: string;
    amountCents: number;
    currencyCode: string;
    formulaBreakdown: FormulaBillingBreakdown[];
    updatedAt: string;
  } | null;
  /** Per-product grams spent in the finalized mix(es) for this appointment. */
  productUsage: LabProductUsage[];
}

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

/**
 * Durably saves a draft mix on the client's record (no billing handoff, no
 * inventory deduction — those happen at finalize, which updates the same
 * server-side formula row).
 */
export async function saveDraftFormulaForLabSession(sessionId: string, payload: FormulaSavePayload) {
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/formulas/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(payload.formulaId)}/save-draft`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`Could not save draft (${response.status})`);
  }

  return response.json();
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

/**
 * Real, durable billing breakdown for a finalized appointment, scoped to the
 * lab session's location. Reads the product-usage line item written at finalize
 * time. `billingLineItem` is null when no mix has been finalized for the
 * appointment's visit yet.
 */
export async function getLabSessionBillingBreakdown(
  sessionId: string,
  appointmentId: string,
): Promise<LabSessionBillingBreakdown> {
  const response = await fetch(
    `${appConfig.apiBaseUrl}/lab/formulas/session/${encodeURIComponent(sessionId)}/appointment/${encodeURIComponent(appointmentId)}/billing-breakdown`,
  );

  if (!response.ok) {
    throw new Error(`Could not load billing breakdown (${response.status})`);
  }

  return (await response.json()) as LabSessionBillingBreakdown;
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
