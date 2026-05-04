import type { CurrentUserResponse, LoginResponse } from '@sheer/domain';

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
    const errorText = await response.text();
    throw new Error(errorText || `Request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
