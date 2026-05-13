import type {
  CreateMyLeaveRequest,
  CurrentUserResponse,
  LeaveRequestMutationResponse,
  ListStaffBookingsResponse,
  LoginResponse,
  MyLeaveRequestsResponse,
  StaffBookingDetail,
  StylistMyWeekResponse,
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

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; accessToken?: string } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
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
