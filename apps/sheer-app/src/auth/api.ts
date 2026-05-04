import type { CurrentUserResponse, LoginResponse } from '@sheer/domain';

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
    throw new Error(`Sheer API request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
