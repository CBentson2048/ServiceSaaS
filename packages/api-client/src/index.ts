import type { PinUnlockRequest, PinUnlockResponse, SharedDevice } from '@sheer/domain';
import type { AppointmentDetail, AppointmentSummary } from '@sheer/booking-core';
import type { FormulaDraft, FormulaSavePayload } from '@sheer/lab-core';

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | Promise<string | undefined>;
}

export interface ApiClient {
  labDevices: LabDeviceClient;
  labSessions: LabSessionClient;
  labPins: LabPinClient;
  labAppointments: LabAppointmentClient;
  labFormulas: LabFormulaClient;
}

export interface LabDeviceClient {
  register: (payload: RegisterLabDeviceRequest) => Promise<SharedDevice>;
  status: () => Promise<SharedDevice>;
  pairScale: (payload: PairScaleRequest) => Promise<void>;
  unpairScale: () => Promise<void>;
}

export interface LabSessionClient {
  unlock: (payload: PinUnlockRequest) => Promise<PinUnlockResponse>;
  heartbeat: (sessionId: string) => Promise<void>;
  logout: (sessionId: string) => Promise<void>;
  me: () => Promise<PinUnlockResponse | null>;
}

export interface LabPinClient {
  assign: (payload: AssignPinRequest) => Promise<void>;
  reset: (payload: ResetPinRequest) => Promise<void>;
  status: (locationId: string) => Promise<PinStatusResponse>;
}

export interface LabAppointmentClient {
  today: (locationId: string) => Promise<AppointmentSummary[]>;
  detail: (appointmentId: string) => Promise<AppointmentDetail>;
}

export interface LabFormulaClient {
  start: (payload: StartFormulaRequest) => Promise<FormulaDraft>;
  save: (payload: FormulaSavePayload) => Promise<FormulaDraft>;
}

export interface RegisterLabDeviceRequest {
  businessId: string;
  locationId: string;
  deviceName: string;
  stationLabel?: string;
}

export interface PairScaleRequest {
  bleDeviceIdentifier: string;
  bleDeviceName?: string;
  deviceModel?: string;
}

export interface AssignPinRequest {
  businessId: string;
  locationId: string;
  userProfileId: string;
  pin: string;
}

export interface ResetPinRequest {
  businessId: string;
  locationId: string;
  userProfileId: string;
}

export interface PinStatusResponse {
  locationId: string;
  activeCredentialCount: number;
  lockedCredentialCount: number;
}

export interface StartFormulaRequest {
  appointmentId?: string;
  clientProfileId?: string;
  labSessionId: string;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const request = createRequest(options);

  return {
    labDevices: {
      register: (payload) => request('/lab/device/register', { method: 'POST', body: payload }),
      status: () => request('/lab/device/status'),
      pairScale: (payload) => request('/lab/device/pair-scale', { method: 'POST', body: payload }),
      unpairScale: () => request('/lab/device/unpair-scale', { method: 'POST' }),
    },
    labSessions: {
      unlock: (payload) => request('/lab/session/unlock', { method: 'POST', body: payload }),
      heartbeat: (sessionId) => request('/lab/session/heartbeat', { method: 'POST', body: { sessionId } }),
      logout: (sessionId) => request('/lab/session/logout', { method: 'POST', body: { sessionId } }),
      me: () => request('/lab/session/me'),
    },
    labPins: {
      assign: (payload) => request('/lab/pins/assign', { method: 'POST', body: payload }),
      reset: (payload) => request('/lab/pins/reset', { method: 'POST', body: payload }),
      status: (locationId) => request(`/lab/pins/status?locationId=${encodeURIComponent(locationId)}`),
    },
    labAppointments: {
      today: (locationId) => request(`/lab/appointments/today?locationId=${encodeURIComponent(locationId)}`),
      detail: (appointmentId) => request(`/lab/appointments/${appointmentId}`),
    },
    labFormulas: {
      start: (payload) => request('/lab/formulas/start', { method: 'POST', body: payload }),
      save: (payload) => request(`/lab/formulas/${payload.formulaId}/save`, { method: 'POST', body: payload }),
    },
  };
}

function createRequest(options: ApiClientOptions) {
  return async function request<TResponse>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<TResponse> {
    const token = await options.getAccessToken?.();
    const response = await fetch(`${options.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Sheer API request failed: ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as TResponse;
    }

    return (await response.json()) as TResponse;
  };
}
