import type {
  AcceptStaffInvitationRequest,
  AcceptStaffInvitationResponse,
  BusinessSlugAvailabilityResponse,
  CreateAccountRequest,
  CreateStaffInvitationRequest,
  CurrentUserResponse,
  InvitationLookupResponse,
  InvitationStatus,
  ListStaffResponse,
  LoginResponse,
  OwnerOnboardingBootstrap,
  OwnerOnboardingRequest,
  OwnerOnboardingResponse,
  StaffInvitation,
  StaffInvitationWithToken,
  UpdateStaffMemberRequest,
  UpdateStaffMemberResponse,
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
