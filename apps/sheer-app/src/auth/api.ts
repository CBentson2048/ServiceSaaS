import type {
  CancelAppointmentResponse,
  CreateMyLeaveRequest,
  ClientLabHistoryResponse,
  CreateCrmClientRequest,
  CreateStaffBookingRequest,
  CreateStaffBookingResponse,
  CreateStylistRebookingRequest,
  CrmClientSummary,
  CurrentUserResponse,
  RescheduleAppointmentResponse,
  ListCrmClientsResponse,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
  KpiPeriod,
  LeaveRequestMutationResponse,
  LinkStylistRebookingRequest,
  ListStaffBookingsResponse,
  LoginResponse,
  MobileClientDashboardResponse,
  MobileBookingConfirmRequest,
  MobileBookingStartCheckoutRequest,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  MobileStylistDashboardResponse,
  MyLeaveRequestsResponse,
  PublicBookingAttemptResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingLocationsResponse,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistsResponse,
  CreatePublicBookingResponse,
  StartPublicBookingCheckoutResponse,
  StaffBookingDetail,
  StylistKpiResponse,
  StylistMyWeekResponse,
  UpdateCurrentProfileRequest,
  UpdateProfileResponse,
  UserProfileResponse,
} from '@sheer/domain';

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// Thrown when the backend rejects an authenticated request with 401 — i.e. the
// access token has expired or been revoked (session timeout). Screens can keep
// catching plain `Error`; the global handler below drives the login redirect.
export class SessionExpiredError extends Error {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

// A single app-wide listener (registered by AuthProvider) that fires whenever an
// authenticated request times out, so the session can be cleared and the user
// sent back to the login screen.
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { email, password, surface: 'sheer_app' },
    suppressAuthRedirect: true,
  });
}

export async function refreshSession(refreshToken: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/refresh', {
    method: 'POST',
    body: { refreshToken, surface: 'sheer_app' },
    suppressAuthRedirect: true,
  });
}

export async function getCurrentUser(accessToken: string): Promise<CurrentUserResponse> {
  return request<CurrentUserResponse>('/auth/me', { accessToken, suppressAuthRedirect: true });
}

export async function logout(accessToken?: string, refreshToken?: string): Promise<void> {
  await request<void>('/auth/logout', {
    method: 'POST',
    accessToken,
    body: { refreshToken },
    suppressAuthRedirect: true,
  });
}

export async function getMyProfile(accessToken: string): Promise<UserProfileResponse> {
  return request<UserProfileResponse>('/profiles/me', { accessToken });
}

export async function updateMyProfile(
  accessToken: string,
  payload: UpdateCurrentProfileRequest,
): Promise<UpdateProfileResponse> {
  return request<UpdateProfileResponse>('/profiles/me', {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

// Permanently deletes the caller's own account. Client-only on the server; staff
// accounts are managed by the salon and rejected with a 403.
export async function deleteMyAccount(accessToken: string): Promise<void> {
  await request<void>('/profiles/me', { method: 'DELETE', accessToken });
}

// The caller's own colour/formula history — a cost-stripped view for clients.
export async function getMyLabHistory(accessToken: string): Promise<ClientLabHistoryResponse> {
  return request<ClientLabHistoryResponse>('/lab/formulas/me/history', { accessToken });
}

export async function getMyWeek(
  accessToken: string,
  weekStart: string,
): Promise<StylistMyWeekResponse> {
  return request<StylistMyWeekResponse>(
    `/rota/my-week?weekStart=${encodeURIComponent(weekStart)}`,
    { accessToken },
  );
}

export async function getMyLeaveRequests(accessToken: string): Promise<MyLeaveRequestsResponse> {
  return request<MyLeaveRequestsResponse>('/rota/my-leave-requests', { accessToken });
}

// The caller's own KPI snapshot (service/retail targets, rebooking, average
// bill, and the commission unlock gate) for the given period. Real values from
// the backend KPI engine — never computed on the client.
export async function getMyKpi(
  accessToken: string,
  period: KpiPeriod,
): Promise<StylistKpiResponse> {
  return request<StylistKpiResponse>(`/kpi/me?period=${encodeURIComponent(period)}`, { accessToken });
}

export async function createMyLeaveRequest(
  accessToken: string,
  payload: CreateMyLeaveRequest,
): Promise<LeaveRequestMutationResponse> {
  return request<LeaveRequestMutationResponse>('/rota/leave-requests', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function cancelMyLeaveRequest(
  accessToken: string,
  requestId: string,
): Promise<LeaveRequestMutationResponse> {
  return request<LeaveRequestMutationResponse>(
    `/rota/leave-requests/${encodeURIComponent(requestId)}/cancel`,
    {
      method: 'POST',
      accessToken,
    },
  );
}

export async function getMyBookings(accessToken: string): Promise<ListStaffBookingsResponse> {
  return request<ListStaffBookingsResponse>('/lab/appointments/today', { accessToken });
}

export async function getBookingDetail(
  accessToken: string,
  bookingId: string,
): Promise<StaffBookingDetail> {
  return request<StaffBookingDetail>(`/lab/appointments/${encodeURIComponent(bookingId)}`, {
    accessToken,
  });
}

export async function completeBooking(
  accessToken: string,
  bookingId: string,
): Promise<AppointmentCompletionResponse> {
  return request<AppointmentCompletionResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/complete`,
    {
      method: 'POST',
      accessToken,
    },
  );
}

export async function confirmBookingPayment(
  accessToken: string,
  bookingId: string,
  payload: AppointmentPaymentConfirmationRequest,
): Promise<AppointmentPaymentConfirmationResponse> {
  return request<AppointmentPaymentConfirmationResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/confirm-payment`,
    {
      method: 'POST',
      body: payload,
      accessToken,
    },
  );
}

export async function linkStylistRebooking(
  accessToken: string,
  bookingId: string,
  payload: LinkStylistRebookingRequest,
): Promise<AppointmentCompletionResponse> {
  return request<AppointmentCompletionResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/rebooking/link`,
    {
      method: 'POST',
      body: payload,
      accessToken,
    },
  );
}

export async function createStylistRebooking(
  accessToken: string,
  bookingId: string,
  payload: CreateStylistRebookingRequest,
): Promise<AppointmentCompletionResponse> {
  return request<AppointmentCompletionResponse>(
    `/lab/appointments/${encodeURIComponent(bookingId)}/rebooking`,
    {
      method: 'POST',
      body: payload,
      accessToken,
    },
  );
}

export type MobileDashboardResponse =
  | MobileClientDashboardResponse
  | MobileStylistDashboardResponse
  | MobileManagerDashboardResponse
  | MobileOwnerDashboardResponse;

export async function getMobileDashboard(
  accessToken: string,
  role: 'owner' | 'manager' | 'stylist' | 'client',
): Promise<MobileDashboardResponse> {
  return request<MobileDashboardResponse>(`/mobile-dashboard/${role}`, { accessToken });
}

export async function getMobileBookingLocations(accessToken: string): Promise<PublicBookingLocationsResponse> {
  return request<PublicBookingLocationsResponse>('/mobile/booking/locations', { accessToken });
}

export async function getMobileBookingSelection(
  accessToken: string,
  params: { locationId: string },
): Promise<PublicBookingServiceSelectionResponse> {
  return request<PublicBookingServiceSelectionResponse>(
    `/mobile/booking/selection?locationId=${encodeURIComponent(params.locationId)}`,
    { accessToken },
  );
}

export async function getMobileBookingStylists(
  accessToken: string,
  params: { locationId: string; serviceIds: string[] },
): Promise<PublicBookingStylistsResponse> {
  const search = new URLSearchParams();
  search.set('locationId', params.locationId);
  search.set('serviceIds', params.serviceIds.join(','));
  return request<PublicBookingStylistsResponse>(`/mobile/booking/stylists?${search.toString()}`, { accessToken });
}

export async function getMobileBookingAvailability(
  accessToken: string,
  params: {
    locationId: string;
    serviceIds: string[];
    stylistId?: string;
    nextAvailable?: boolean;
    dateFrom: string;
    dateTo: string;
  },
): Promise<PublicBookingAvailabilityResponse> {
  const search = new URLSearchParams();
  search.set('locationId', params.locationId);
  search.set('serviceIds', params.serviceIds.join(','));
  if (params.stylistId) search.set('stylistId', params.stylistId);
  if (params.nextAvailable) search.set('nextAvailable', 'true');
  search.set('dateFrom', params.dateFrom);
  search.set('dateTo', params.dateTo);
  return request<PublicBookingAvailabilityResponse>(`/mobile/booking/availability?${search.toString()}`, {
    accessToken,
  });
}

export async function confirmMobileBooking(
  accessToken: string,
  payload: MobileBookingConfirmRequest,
): Promise<CreatePublicBookingResponse> {
  return request<CreatePublicBookingResponse>('/mobile/booking/confirm', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function startMobileBookingCheckout(
  accessToken: string,
  payload: MobileBookingStartCheckoutRequest,
): Promise<StartPublicBookingCheckoutResponse> {
  return request<StartPublicBookingCheckoutResponse>('/mobile/booking/start-checkout', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function getMobileBookingAttempt(
  accessToken: string,
  bookingAttemptId: string,
): Promise<PublicBookingAttemptResponse> {
  return request<PublicBookingAttemptResponse>(
    `/mobile/booking/attempts/${encodeURIComponent(bookingAttemptId)}`,
    { accessToken },
  );
}

// -------------------- Customer appointment management --------------------
// A signed-in client cancels or rebooks (reschedules in place) their own upcoming
// appointment. The salon's per-location cancellation window decides refund vs.
// forfeit (cancel) and whether rebooking is allowed (enforced server-side too).

export async function cancelAppointment(
  accessToken: string,
  appointmentId: string,
  reason?: string,
): Promise<CancelAppointmentResponse> {
  return request<CancelAppointmentResponse>(
    `/mobile/appointments/${encodeURIComponent(appointmentId)}/cancel`,
    { method: 'POST', body: reason ? { reason } : {}, accessToken },
  );
}

export async function rescheduleAppointment(
  accessToken: string,
  appointmentId: string,
  payload: { scheduledStartAt: string },
): Promise<RescheduleAppointmentResponse> {
  return request<RescheduleAppointmentResponse>(
    `/mobile/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
    { method: 'POST', body: payload, accessToken },
  );
}

// -------------------- Staff booking (owner / manager / stylist) --------------------
// Internal flow: a staff member books on behalf of a client (walk-in, phone,
// manual). Reuses the same rota-based availability engine as the client flow.

export async function getStaffBookingSelection(
  accessToken: string,
  params: { locationId: string },
): Promise<PublicBookingServiceSelectionResponse> {
  return request<PublicBookingServiceSelectionResponse>(
    `/staff/booking/selection?locationId=${encodeURIComponent(params.locationId)}`,
    { accessToken },
  );
}

export async function getStaffBookingStylists(
  accessToken: string,
  params: { locationId: string; serviceIds: string[] },
): Promise<PublicBookingStylistsResponse> {
  const search = new URLSearchParams();
  search.set('locationId', params.locationId);
  search.set('serviceIds', params.serviceIds.join(','));
  return request<PublicBookingStylistsResponse>(`/staff/booking/stylists?${search.toString()}`, {
    accessToken,
  });
}

export async function getStaffBookingAvailability(
  accessToken: string,
  params: {
    locationId: string;
    serviceIds: string[];
    stylistId?: string;
    nextAvailable?: boolean;
    dateFrom: string;
    dateTo: string;
  },
): Promise<PublicBookingAvailabilityResponse> {
  const search = new URLSearchParams();
  search.set('locationId', params.locationId);
  search.set('serviceIds', params.serviceIds.join(','));
  if (params.stylistId) search.set('stylistId', params.stylistId);
  if (params.nextAvailable) search.set('nextAvailable', 'true');
  search.set('dateFrom', params.dateFrom);
  search.set('dateTo', params.dateTo);
  return request<PublicBookingAvailabilityResponse>(`/staff/booking/availability?${search.toString()}`, {
    accessToken,
  });
}

export async function searchStaffBookingClients(
  accessToken: string,
  params: { q?: string; locationId?: string } = {},
): Promise<ListCrmClientsResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.locationId) search.set('locationId', params.locationId);
  const query = search.toString();
  return request<ListCrmClientsResponse>(`/staff/booking/clients${query ? `?${query}` : ''}`, {
    accessToken,
  });
}

export async function createStaffBookingClient(
  accessToken: string,
  payload: CreateCrmClientRequest,
): Promise<{ client: CrmClientSummary }> {
  return request<{ client: CrmClientSummary }>('/staff/booking/clients', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function createStaffBooking(
  accessToken: string,
  payload: CreateStaffBookingRequest,
): Promise<CreateStaffBookingResponse> {
  return request<CreateStaffBookingResponse>('/staff/booking/appointments', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

async function request<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    accessToken?: string;
    // Set on auth-flow calls (login/refresh/me/logout) so a 401 there does not
    // trigger the global session-timeout redirect — those callers handle it.
    suppressAuthRedirect?: boolean;
  } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      ...(init.accessToken ? { Authorization: `Bearer ${init.accessToken}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    const message = extractErrorMessage(parsed) ?? raw ?? `QLOOQO request failed with ${response.status}`;

    // Session timeout: an authenticated call came back 401. Notify the app so it
    // can clear the stored session and redirect to login, then surface a
    // recognisable error to the caller.
    if (response.status === 401 && !init.suppressAuthRedirect) {
      onUnauthorized?.();
      throw new SessionExpiredError(message);
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { message?: unknown }).message;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ');
  }
  return undefined;
}
