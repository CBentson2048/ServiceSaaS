import type {
  CreateMyLeaveRequest,
  ClientLabHistoryResponse,
  CreateStylistRebookingRequest,
  CurrentUserResponse,
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

export async function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { email, password, surface: 'sheer_app' },
  });
}

export async function refreshSession(refreshToken: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/refresh', {
    method: 'POST',
    body: { refreshToken, surface: 'sheer_app' },
  });
}

export async function getCurrentUser(accessToken: string): Promise<CurrentUserResponse> {
  return request<CurrentUserResponse>('/auth/me', { accessToken });
}

export async function logout(accessToken?: string, refreshToken?: string): Promise<void> {
  await request<void>('/auth/logout', {
    method: 'POST',
    accessToken,
    body: { refreshToken },
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

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; accessToken?: string } = {},
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
    const message = extractErrorMessage(parsed) ?? raw ?? `Sheer API request failed with ${response.status}`;
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
