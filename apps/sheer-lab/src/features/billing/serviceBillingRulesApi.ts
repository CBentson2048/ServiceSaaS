import type {
  ResetServiceBillingRulesResponse,
  ServiceBillingRulesResponse,
  UpdateServiceBillingRulesRequest,
  UpdateServiceBillingRulesResponse,
} from '@sheer/domain';

import { appConfig } from '../../config/appConfig';

// Owner/manager-only "Billing & Revenue Rules" for the qlooqo-lab station.
// These hit `/lab/billing-rules/session/:sessionId/rules`, which validate the
// PIN session and enforce the owner/manager gate (same pattern as the lab
// inventory management endpoints — auth is the sessionId in the URL, not a JWT).

const base = (sessionId: string) =>
  `${appConfig.apiBaseUrl}/lab/billing-rules/session/${encodeURIComponent(sessionId)}/rules`;

export async function getServiceBillingRules(
  sessionId: string,
): Promise<ServiceBillingRulesResponse> {
  return getJson(base(sessionId), 'load billing rules');
}

export async function updateServiceBillingRules(
  sessionId: string,
  payload: UpdateServiceBillingRulesRequest,
): Promise<UpdateServiceBillingRulesResponse> {
  return sendJson(base(sessionId), 'PATCH', payload, 'save billing rules');
}

export async function resetServiceBillingRules(
  sessionId: string,
): Promise<ResetServiceBillingRulesResponse> {
  return sendJson(`${base(sessionId)}/reset`, 'POST', undefined, 'restore default billing rules');
}

async function getJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(messageForStatus(response.status, label));
  return (await response.json()) as T;
}

async function sendJson<T>(url: string, method: 'POST' | 'PATCH', body: unknown, label: string): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(messageForStatus(response.status, label));
  return (await response.json()) as T;
}

function messageForStatus(status: number, action: string): string {
  if (status === 401) return 'Your lab session has expired. Please sign in again.';
  if (status === 403) return 'Billing rules are limited to owners and managers.';
  return `Could not ${action} (${status})`;
}
