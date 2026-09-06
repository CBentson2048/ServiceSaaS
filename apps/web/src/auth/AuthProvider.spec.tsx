import { act, render, screen, waitFor } from '@testing-library/react';
import type { AuthSession, AuthUser } from '@sheer/domain';

/**
 * The dashboard session, as a state machine.
 *
 * What these pin down is the difference between a session that lasts as long as
 * someone is working and one that quietly stops an hour after they signed in:
 * the token is rotated BEFORE it expires, a session the API just handed us is
 * not re-proved, and an unreachable API never costs anyone their credentials.
 */

jest.mock('./api', () => {
  class ApiRequestError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = status;
    }
  }
  return {
    ApiRequestError,
    setExpiredTokenHandler: jest.fn(),
    getCurrentUser: jest.fn(),
    refreshSession: jest.fn(),
    login: jest.fn(),
    createAccount: jest.fn(),
    logout: jest.fn(),
  };
});

import * as api from './api';
import { AuthProvider, useAuth } from './AuthProvider';

const STORAGE_KEY = 'sheer.web.auth.session';
const mocked = api as unknown as {
  ApiRequestError: new (message: string, status: number) => Error;
  setExpiredTokenHandler: jest.Mock;
  getCurrentUser: jest.Mock;
  refreshSession: jest.Mock;
  login: jest.Mock;
};

const USER = { id: 'user-1', roles: ['owner'] } as unknown as AuthUser;

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    ...overrides,
  };
}

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="token">{auth.session?.accessToken ?? 'none'}</span>
      <button type="button" onClick={() => void auth.signIn('owner@example.com', 'pw')}>
        sign in
      </button>
    </div>
  );
}

const renderProvider = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

describe('AuthProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rotates the access token before it expires, without anyone asking', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session()));
    mocked.getCurrentUser.mockResolvedValue({ user: USER });
    mocked.refreshSession.mockResolvedValue({
      session: session({ accessToken: 'access-2', refreshToken: 'refresh-2' }),
      user: USER,
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    // The token has 90s left and the margin is 60s, so nothing yet...
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    expect(mocked.refreshSession).not.toHaveBeenCalled();

    // ...and then it rotates on its own, a minute before expiry.
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(mocked.refreshSession).toHaveBeenCalledWith('refresh-1');
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('access-2'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').accessToken).toBe('access-2');
  });

  it('rotates immediately when the tab wakes up past the deadline', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session({ expiresAt: new Date(Date.now() - 1_000).toISOString() })));
    mocked.getCurrentUser.mockResolvedValue({ user: USER });
    mocked.refreshSession.mockResolvedValue({
      session: session({ accessToken: 'access-2' }),
      user: USER,
    });

    renderProvider();

    await waitFor(() => expect(mocked.refreshSession).toHaveBeenCalledWith('refresh-1'));
  });

  it('does not re-prove a session the API has just handed it', async () => {
    mocked.login.mockResolvedValue({ session: session(), user: USER });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));

    await act(async () => {
      screen.getByRole('button', { name: 'sign in' }).click();
    });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    // The old provider fired a second /auth/me here, and a blip on that call
    // signed the user straight back out.
    expect(mocked.getCurrentUser).not.toHaveBeenCalled();
  });

  it('keeps the stored session when the API cannot be reached', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session()));
    mocked.getCurrentUser.mockRejectedValue(new Error('Failed to fetch'));

    renderProvider();
    // Each retry only schedules its timer once the previous attempt's promise
    // has settled, so the clock has to move in steps with microtasks between.
    for (let step = 0; step < 6; step += 1) {
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
    }

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    // Someone else's outage must never cost the user their credentials.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(mocked.refreshSession).not.toHaveBeenCalled();
  });

  it('signs the user out only when the server rejects the refresh token', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session()));
    mocked.getCurrentUser.mockRejectedValue(new mocked.ApiRequestError('expired', 401));
    mocked.refreshSession.mockRejectedValue(new mocked.ApiRequestError('dead', 401));

    renderProvider();

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
  });

  it('lets an expired request recover itself through the registered handler', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session()));
    mocked.getCurrentUser.mockResolvedValue({ user: USER });
    mocked.refreshSession.mockResolvedValue({
      session: session({ accessToken: 'access-2' }),
      user: USER,
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    const handler = mocked.setExpiredTokenHandler.mock.calls.at(-1)?.[0] as
      | ((staleToken: string) => Promise<string | null>)
      | undefined;
    expect(handler).toBeDefined();

    let rotated: string | null = null;
    await act(async () => {
      rotated = (await handler?.('access-1')) ?? null;
    });

    expect(rotated).toBe('access-2');
    await waitFor(() => expect(screen.getByTestId('token').textContent).toBe('access-2'));
  });

  it('hands over the stored token instead of spending another when one tab has already rotated', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session()));
    mocked.getCurrentUser.mockResolvedValue({ user: USER });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    const handler = mocked.setExpiredTokenHandler.mock.calls.at(-1)?.[0] as
      | ((staleToken: string) => Promise<string | null>)
      | undefined;

    // A page held a token captured before the last rotation; storage is ahead.
    let rotated: string | null = null;
    await act(async () => {
      rotated = (await handler?.('access-0')) ?? null;
    });

    expect(rotated).toBe('access-1');
    expect(mocked.refreshSession).not.toHaveBeenCalled();
  });
});
