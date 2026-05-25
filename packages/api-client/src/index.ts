import type {
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  BusinessSlugAvailabilityResponse,
  CreateAccountRequest,
  CreateAccountResponse,
  CreateLocationRequest,
  CreateStaffInvitationRequest,
  CurrentUserResponse,
  InvitationLookupResponse,
  InvitationStatus,
  LabDeviceRegistrationResponse,
  LabDeviceResolveResponse,
  ListLocationsResponse,
  ListStaffResponse,
  ListInventoryProductsResponse,
  ListInventoryStockResponse,
  LocationDetailResponse,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  OwnerOnboardingBootstrap,
  OwnerOnboardingRequest,
  OwnerOnboardingResponse,
  PinUnlockRequest,
  PinUnlockResponse,
  RefreshSessionRequest,
  SharedDevice,
  StaffInvitation,
  StaffInvitationWithToken,
  UpdateLocationRequest,
  UpdateStaffMemberRequest,
  UpdateStaffMemberResponse,
  ListStaffBookingsResponse,
  StaffBookingDetail,
  LabPinMutationResponse,
  ListLabPinStatusesResponse,
  ResetLabPinRequest,
  SetLabPinRequest,
} from '@sheer/domain';
import type {
  FormulaDraft,
  FormulaDuplicatePayload,
  FormulaHistoryRecord,
  FormulaSavePayload,
  FormulaSaveResult,
} from '@sheer/lab-core';

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | Promise<string | undefined>;
}

export interface ApiClient {
  auth: AuthClient;
  ownerOnboarding: OwnerOnboardingClient;
  ownerStaff: OwnerStaffClient;
  staffInvitations: PublicStaffInvitationClient;
  locations: LocationsClient;
  ownerLocations: OwnerLocationsClient;
  labDevices: LabDeviceClient;
  labSessions: LabSessionClient;
  labPins: LabPinClient;
  labAppointments: LabAppointmentClient;
  labFormulas: LabFormulaClient;
  inventory: InventoryClient;
}

export interface AuthClient {
  createAccount: (payload: CreateAccountRequest) => Promise<CreateAccountResponse>;
  login: (payload: LoginRequest) => Promise<LoginResponse>;
  logout: (payload?: LogoutRequest) => Promise<void>;
  me: () => Promise<CurrentUserResponse>;
  refresh: (payload: RefreshSessionRequest) => Promise<LoginResponse>;
}

export interface OwnerOnboardingClient {
  bootstrap: () => Promise<OwnerOnboardingBootstrap>;
  checkBusinessSlug: (slug: string) => Promise<BusinessSlugAvailabilityResponse>;
  register: (payload: OwnerOnboardingRequest) => Promise<OwnerOnboardingResponse>;
}

export interface OwnerStaffClient {
  list: () => Promise<ListStaffResponse>;
  update: (
    userId: string,
    payload: UpdateStaffMemberRequest,
  ) => Promise<UpdateStaffMemberResponse>;
  deactivate: (userId: string) => Promise<UpdateStaffMemberResponse>;
  reactivate: (userId: string) => Promise<UpdateStaffMemberResponse>;
  invitations: {
    create: (payload: CreateStaffInvitationRequest) => Promise<StaffInvitationWithToken>;
    list: (status?: InvitationStatus | 'all') => Promise<StaffInvitation[]>;
    resend: (id: string) => Promise<StaffInvitationWithToken>;
    revoke: (id: string) => Promise<StaffInvitation>;
  };
}

export interface PublicStaffInvitationClient {
  inspect: (token: string) => Promise<InvitationLookupResponse>;
  accept: (payload: AcceptStaffInvitationRequest) => Promise<AcceptStaffInvitationResponse>;
}

export interface LocationsClient {
  list: () => Promise<ListLocationsResponse>;
  detail: (id: string) => Promise<LocationDetailResponse>;
}

export interface OwnerLocationsClient {
  create: (payload: CreateLocationRequest) => Promise<LocationDetailResponse>;
  update: (id: string, payload: UpdateLocationRequest) => Promise<LocationDetailResponse>;
  deactivate: (id: string) => Promise<LocationDetailResponse>;
  reactivate: (id: string) => Promise<LocationDetailResponse>;
}

export interface LabDeviceClient {
  register: (payload: RegisterLabDeviceRequest) => Promise<LabDeviceRegistrationResponse>;
  resolve: (deviceSessionToken: string) => Promise<LabDeviceResolveResponse>;
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
  assign: (payload: SetLabPinRequest) => Promise<LabPinMutationResponse>;
  reset: (payload: ResetLabPinRequest) => Promise<LabPinMutationResponse>;
  status: (locationId?: string) => Promise<ListLabPinStatusesResponse>;
}

export interface LabAppointmentClient {
  today: (locationId?: string) => Promise<ListStaffBookingsResponse>;
  todayForSession: (sessionId: string) => Promise<ListStaffBookingsResponse>;
  detail: (appointmentId: string) => Promise<StaffBookingDetail>;
  detailForSession: (sessionId: string, appointmentId: string) => Promise<StaffBookingDetail>;
}

export interface LabFormulaClient {
  start: (payload: StartFormulaRequest) => Promise<FormulaDraft>;
  save: (payload: FormulaSavePayload) => Promise<FormulaSaveResult>;
  latestForClient: (clientProfileId: string) => Promise<FormulaHistoryRecord | null>;
  historyForClient: (clientProfileId: string) => Promise<FormulaHistoryRecord[]>;
  duplicate: (formulaId: string, payload: Omit<FormulaDuplicatePayload, 'sourceFormulaId'>) => Promise<FormulaDraft>;
}

export interface InventoryClient {
  products: (params?: { q?: string; category?: string; includeInactive?: boolean }) => Promise<ListInventoryProductsResponse>;
  productsForLabSession: (
    sessionId: string,
    params?: { q?: string; category?: string },
  ) => Promise<ListInventoryProductsResponse>;
  stock: (params?: { locationId?: string; q?: string; lowStockOnly?: boolean }) => Promise<ListInventoryStockResponse>;
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

export interface StartFormulaRequest {
  appointmentId?: string;
  clientProfileId?: string;
  labSessionId: string;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const request = createRequest(options);

  return {
    auth: {
      createAccount: (payload) => request('/auth/register', { method: 'POST', body: payload }),
      login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
      logout: (payload = {}) => request('/auth/logout', { method: 'POST', body: payload }),
      me: () => request('/auth/me'),
      refresh: (payload) => request('/auth/refresh', { method: 'POST', body: payload }),
    },
    ownerOnboarding: {
      bootstrap: () => request('/owner/onboarding/bootstrap'),
      checkBusinessSlug: (slug) =>
        request(`/owner/onboarding/check-business-slug?slug=${encodeURIComponent(slug)}`),
      register: (payload) => request('/owner/onboarding/register', { method: 'POST', body: payload }),
    },
    ownerStaff: {
      list: () => request('/owner/staff'),
      update: (userId, payload) =>
        request(`/owner/staff/${encodeURIComponent(userId)}`, { method: 'PATCH', body: payload }),
      deactivate: (userId) =>
        request(`/owner/staff/${encodeURIComponent(userId)}/deactivate`, { method: 'POST' }),
      reactivate: (userId) =>
        request(`/owner/staff/${encodeURIComponent(userId)}/reactivate`, { method: 'POST' }),
      invitations: {
        create: (payload) => request('/owner/staff/invitations', { method: 'POST', body: payload }),
        list: (status) =>
          request(
            status && status !== 'all'
              ? `/owner/staff/invitations?status=${encodeURIComponent(status)}`
              : '/owner/staff/invitations',
          ),
        resend: (id) =>
          request(`/owner/staff/invitations/${encodeURIComponent(id)}/resend`, { method: 'POST' }),
        revoke: (id) =>
          request(`/owner/staff/invitations/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
      },
    },
    staffInvitations: {
      inspect: (token) =>
        request(`/staff/invitations/inspect?token=${encodeURIComponent(token)}`),
      accept: (payload) => request('/staff/invitations/accept', { method: 'POST', body: payload }),
    },
    locations: {
      list: () => request('/locations'),
      detail: (id) => request(`/locations/${encodeURIComponent(id)}`),
    },
    ownerLocations: {
      create: (payload) => request('/owner/locations', { method: 'POST', body: payload }),
      update: (id, payload) =>
        request(`/owner/locations/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
      deactivate: (id) =>
        request(`/owner/locations/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }),
      reactivate: (id) =>
        request(`/owner/locations/${encodeURIComponent(id)}/reactivate`, { method: 'POST' }),
    },
    labDevices: {
      register: (payload) => request('/lab/device/register', { method: 'POST', body: payload }),
      resolve: (deviceSessionToken) =>
        request('/lab/device/resolve', {
          headers: { Authorization: `Bearer ${deviceSessionToken}` },
        }),
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
      status: (locationId) =>
        request(locationId ? `/lab/pins/status?locationId=${encodeURIComponent(locationId)}` : '/lab/pins/status'),
    },
    labAppointments: {
      today: (locationId) =>
        request(
          locationId
            ? `/lab/appointments/today?locationId=${encodeURIComponent(locationId)}`
            : '/lab/appointments/today',
        ),
      todayForSession: (sessionId) =>
        request(`/lab/appointments/session/${encodeURIComponent(sessionId)}/today`),
      detail: (appointmentId) => request(`/lab/appointments/${encodeURIComponent(appointmentId)}`),
      detailForSession: (sessionId, appointmentId) =>
        request(
          `/lab/appointments/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(appointmentId)}`,
        ),
    },
    labFormulas: {
      start: (payload) => request('/lab/formulas/start', { method: 'POST', body: payload }),
      save: (payload) => request(`/lab/formulas/${payload.formulaId}/save`, { method: 'POST', body: payload }),
      latestForClient: (clientProfileId) =>
        request(`/lab/formulas/client/${encodeURIComponent(clientProfileId)}/latest`),
      historyForClient: (clientProfileId) =>
        request(`/lab/formulas/client/${encodeURIComponent(clientProfileId)}/history`),
      duplicate: (formulaId, payload) =>
        request(`/lab/formulas/${encodeURIComponent(formulaId)}/duplicate`, {
          method: 'POST',
          body: payload,
        }),
    },
    inventory: {
      products: (params = {}) => request(`/inventory/products${toQueryString(params)}`),
      productsForLabSession: (sessionId, params = {}) =>
        request(`/lab/inventory/session/${encodeURIComponent(sessionId)}/products${toQueryString(params)}`),
      stock: (params = {}) => request(`/inventory/stock${toQueryString(params)}`),
    },
  };
}

function toQueryString(params: Record<string, string | boolean | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `?${query}` : '';
}

function createRequest(options: ApiClientOptions) {
  return async function request<TResponse>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<TResponse> {
    const token = await options.getAccessToken?.();
    const response = await fetch(`${options.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
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
