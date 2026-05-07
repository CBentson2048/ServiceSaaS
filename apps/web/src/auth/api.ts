import type {
  AbsenceMutationResponse,
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  ApproveLeaveRequestRequest,
  BreakMutationResponse,
  BusinessSlugAvailabilityResponse,
  CreateAbsenceRequest,
  CreateAccountRequest,
  CreateBreakRequest,
  CreateLocationRequest,
  CreateShiftRequest,
  CreateStaffInvitationRequest,
  CurrentUserResponse,
  InvitationLookupResponse,
  InvitationStatus,
  LeaveRequestMutationResponse,
  LeaveRequestStatus,
  ListLeaveRequestsResponse,
  ListLocationsResponse,
  ListStaffResponse,
  LocationDetailResponse,
  LoginResponse,
  OwnerOnboardingBootstrap,
  OwnerOnboardingRequest,
  OwnerOnboardingResponse,
  PasswordResetCompleteResponse,
  PasswordResetInspectResponse,
  PasswordResetRequestResponse,
  RejectLeaveRequestRequest,
  SaveWeeklyRotaRequest,
  SaveWeeklyRotaResponse,
  ShiftMutationResponse,
  StaffInvitation,
  StaffInvitationWithToken,
  UpdateBreakRequest,
  UpdateLocationRequest,
  UpdateShiftRequest,
  UpdateStaffMemberRequest,
  UpdateStaffMemberResponse,
  WeeklyRotaResponse,
} from '@sheer/domain';

const API_BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { ...input, surface: 'web_dashboard' },
  });
}

export async function createAccount(
  input: Omit<CreateAccountRequest, 'surface'>,
): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/register', {
    method: 'POST',
    body: { ...input, surface: 'web_dashboard' },
  });
}

export async function refreshSession(refreshToken: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/refresh', {
    method: 'POST',
    body: { refreshToken, surface: 'web_dashboard' },
  });
}

export async function getCurrentUser(accessToken: string): Promise<CurrentUserResponse> {
  return request<CurrentUserResponse>('/auth/me', {
    accessToken,
  });
}

export async function logout(accessToken?: string, refreshToken?: string): Promise<void> {
  await request<void>('/auth/logout', {
    method: 'POST',
    accessToken,
    body: { refreshToken },
  });
}

// -------------------- Password reset (public) --------------------

export async function requestPasswordReset(
  email: string,
): Promise<PasswordResetRequestResponse> {
  return request<PasswordResetRequestResponse>('/auth/password-reset/request', {
    method: 'POST',
    body: { email },
  });
}

export async function inspectPasswordResetToken(
  token: string,
): Promise<PasswordResetInspectResponse> {
  return request<PasswordResetInspectResponse>(
    `/auth/password-reset/inspect?token=${encodeURIComponent(token)}`,
  );
}

export async function completePasswordReset(input: {
  token: string;
  password: string;
}): Promise<PasswordResetCompleteResponse> {
  return request<PasswordResetCompleteResponse>('/auth/password-reset/complete', {
    method: 'POST',
    body: input,
  });
}

export async function getOwnerOnboardingBootstrap(): Promise<OwnerOnboardingBootstrap> {
  return request<OwnerOnboardingBootstrap>('/owner/onboarding/bootstrap');
}

export async function checkBusinessSlugAvailability(
  slug: string,
): Promise<BusinessSlugAvailabilityResponse> {
  return request<BusinessSlugAvailabilityResponse>(
    `/owner/onboarding/check-business-slug?slug=${encodeURIComponent(slug)}`,
  );
}

export async function registerOwnerOnboarding(
  payload: OwnerOnboardingRequest,
): Promise<OwnerOnboardingResponse> {
  return request<OwnerOnboardingResponse>('/owner/onboarding/register', {
    method: 'POST',
    body: payload,
  });
}

// -------------------- Staff management (owner-only) --------------------

export async function listStaff(accessToken: string): Promise<ListStaffResponse> {
  return request<ListStaffResponse>('/owner/staff', { accessToken });
}

export async function updateStaffMember(
  accessToken: string,
  userId: string,
  payload: UpdateStaffMemberRequest,
): Promise<UpdateStaffMemberResponse> {
  return request<UpdateStaffMemberResponse>(`/owner/staff/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

export async function deactivateStaffMember(
  accessToken: string,
  userId: string,
): Promise<UpdateStaffMemberResponse> {
  return request<UpdateStaffMemberResponse>(
    `/owner/staff/${encodeURIComponent(userId)}/deactivate`,
    { method: 'POST', accessToken },
  );
}

export async function reactivateStaffMember(
  accessToken: string,
  userId: string,
): Promise<UpdateStaffMemberResponse> {
  return request<UpdateStaffMemberResponse>(
    `/owner/staff/${encodeURIComponent(userId)}/reactivate`,
    { method: 'POST', accessToken },
  );
}

export async function listStaffInvitations(
  accessToken: string,
  status?: InvitationStatus | 'all',
): Promise<StaffInvitation[]> {
  const path =
    status && status !== 'all'
      ? `/owner/staff/invitations?status=${encodeURIComponent(status)}`
      : '/owner/staff/invitations';
  return request<StaffInvitation[]>(path, { accessToken });
}

export async function createStaffInvitation(
  accessToken: string,
  payload: CreateStaffInvitationRequest,
): Promise<StaffInvitationWithToken> {
  return request<StaffInvitationWithToken>('/owner/staff/invitations', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function resendStaffInvitation(
  accessToken: string,
  invitationId: string,
): Promise<StaffInvitationWithToken> {
  return request<StaffInvitationWithToken>(
    `/owner/staff/invitations/${encodeURIComponent(invitationId)}/resend`,
    { method: 'POST', accessToken },
  );
}

export async function revokeStaffInvitation(
  accessToken: string,
  invitationId: string,
): Promise<StaffInvitation> {
  return request<StaffInvitation>(
    `/owner/staff/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: 'POST', accessToken },
  );
}

// -------------------- Locations (owner + manager) --------------------

export async function listLocations(accessToken: string): Promise<ListLocationsResponse> {
  return request<ListLocationsResponse>('/locations', { accessToken });
}

export async function getLocation(
  accessToken: string,
  locationId: string,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/locations/${encodeURIComponent(locationId)}`,
    { accessToken },
  );
}

export async function createLocation(
  accessToken: string,
  payload: CreateLocationRequest,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>('/owner/locations', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function updateLocation(
  accessToken: string,
  locationId: string,
  payload: UpdateLocationRequest,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/owner/locations/${encodeURIComponent(locationId)}`,
    { method: 'PATCH', body: payload, accessToken },
  );
}

export async function deactivateLocation(
  accessToken: string,
  locationId: string,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/owner/locations/${encodeURIComponent(locationId)}/deactivate`,
    { method: 'POST', accessToken },
  );
}

export async function reactivateLocation(
  accessToken: string,
  locationId: string,
): Promise<LocationDetailResponse> {
  return request<LocationDetailResponse>(
    `/owner/locations/${encodeURIComponent(locationId)}/reactivate`,
    { method: 'POST', accessToken },
  );
}

// -------------------- Rota (manager + owner) --------------------

export async function getWeeklyRota(
  accessToken: string,
  params: { locationId?: string; weekStart: string },
): Promise<WeeklyRotaResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  search.set('weekStart', params.weekStart);
  return request<WeeklyRotaResponse>(`/rota/week?${search.toString()}`, { accessToken });
}

export async function createRotaShift(
  accessToken: string,
  payload: CreateShiftRequest,
): Promise<ShiftMutationResponse> {
  return request<ShiftMutationResponse>('/rota/shifts', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function updateRotaShift(
  accessToken: string,
  shiftId: string,
  payload: UpdateShiftRequest,
): Promise<ShiftMutationResponse> {
  return request<ShiftMutationResponse>(`/rota/shifts/${encodeURIComponent(shiftId)}`, {
    method: 'PATCH',
    body: payload,
    accessToken,
  });
}

export async function deleteRotaShift(
  accessToken: string,
  shiftId: string,
  pastEditReason?: string,
): Promise<{ success: true }> {
  const search = pastEditReason
    ? `?pastEditReason=${encodeURIComponent(pastEditReason)}`
    : '';
  return request<{ success: true }>(
    `/rota/shifts/${encodeURIComponent(shiftId)}${search}`,
    { method: 'DELETE', accessToken },
  );
}

export async function addRotaBreak(
  accessToken: string,
  shiftId: string,
  payload: CreateBreakRequest,
): Promise<BreakMutationResponse> {
  return request<BreakMutationResponse>(
    `/rota/shifts/${encodeURIComponent(shiftId)}/breaks`,
    { method: 'POST', body: payload, accessToken },
  );
}

export async function updateRotaBreak(
  accessToken: string,
  shiftId: string,
  breakId: string,
  payload: UpdateBreakRequest,
): Promise<BreakMutationResponse> {
  return request<BreakMutationResponse>(
    `/rota/shifts/${encodeURIComponent(shiftId)}/breaks/${encodeURIComponent(breakId)}`,
    { method: 'PATCH', body: payload, accessToken },
  );
}

export async function deleteRotaBreak(
  accessToken: string,
  shiftId: string,
  breakId: string,
  pastEditReason?: string,
): Promise<{ success: true }> {
  const search = pastEditReason
    ? `?pastEditReason=${encodeURIComponent(pastEditReason)}`
    : '';
  return request<{ success: true }>(
    `/rota/shifts/${encodeURIComponent(shiftId)}/breaks/${encodeURIComponent(breakId)}${search}`,
    { method: 'DELETE', accessToken },
  );
}

export async function listRotaLeaveRequests(
  accessToken: string,
  params: { locationId?: string; status?: LeaveRequestStatus | 'all' } = {},
): Promise<ListLeaveRequestsResponse> {
  const search = new URLSearchParams();
  if (params.locationId) search.set('locationId', params.locationId);
  if (params.status) search.set('status', params.status);
  const query = search.toString();
  return request<ListLeaveRequestsResponse>(
    `/rota/leave-requests${query ? `?${query}` : ''}`,
    { accessToken },
  );
}

export async function approveRotaLeaveRequest(
  accessToken: string,
  requestId: string,
  payload: ApproveLeaveRequestRequest = {},
): Promise<LeaveRequestMutationResponse> {
  return request<LeaveRequestMutationResponse>(
    `/rota/leave-requests/${encodeURIComponent(requestId)}/approve`,
    { method: 'POST', body: payload, accessToken },
  );
}

export async function rejectRotaLeaveRequest(
  accessToken: string,
  requestId: string,
  payload: RejectLeaveRequestRequest = {},
): Promise<LeaveRequestMutationResponse> {
  return request<LeaveRequestMutationResponse>(
    `/rota/leave-requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST', body: payload, accessToken },
  );
}

export async function markRotaAbsence(
  accessToken: string,
  payload: CreateAbsenceRequest,
): Promise<AbsenceMutationResponse> {
  return request<AbsenceMutationResponse>('/rota/absence-events', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function saveWeeklyRota(
  accessToken: string,
  payload: SaveWeeklyRotaRequest,
): Promise<SaveWeeklyRotaResponse> {
  return request<SaveWeeklyRotaResponse>('/rota/week/save', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function previewNewWeek(
  accessToken: string,
  payload: import('@sheer/domain').PreviewNewWeekRequest,
): Promise<import('@sheer/domain').PreviewNewWeekResponse> {
  return request<import('@sheer/domain').PreviewNewWeekResponse>('/rota/weeks/preview', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

export async function createNewWeek(
  accessToken: string,
  payload: import('@sheer/domain').CreateNewWeekRequest,
): Promise<import('@sheer/domain').CreateNewWeekResponse> {
  return request<import('@sheer/domain').CreateNewWeekResponse>('/rota/weeks/create', {
    method: 'POST',
    body: payload,
    accessToken,
  });
}

// -------------------- Public invitation acceptance --------------------

export async function inspectStaffInvitation(token: string): Promise<InvitationLookupResponse> {
  return request<InvitationLookupResponse>(
    `/staff/invitations/inspect?token=${encodeURIComponent(token)}`,
  );
}

export async function acceptStaffInvitation(
  payload: AcceptStaffInvitationRequest,
): Promise<AcceptStaffInvitationResponse> {
  return request<AcceptStaffInvitationResponse>('/staff/invitations/accept', {
    method: 'POST',
    body: payload,
  });
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details;
  }
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
    const message = extractErrorMessage(parsed) ?? raw ?? `Request failed with ${response.status}`;
    throw new ApiRequestError(message, response.status, parsed);
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
