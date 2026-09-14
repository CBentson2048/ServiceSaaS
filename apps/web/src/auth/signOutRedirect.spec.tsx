/**
 * A sign-in target is remembered only for a real bounce (a shared link, a lost
 * session) — never for the page someone deliberately signed out of, including
 * pages reached with Back afterwards. Exercised with the real AuthProvider and
 * ProtectedRoute, with and without React Router's v7 transition flag.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { AuthUser } from '@sheer/domain';

jest.mock('./api', () => {
  class ApiRequestError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
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
    logout: jest.fn().mockResolvedValue(undefined),
  };
});

import * as api from './api';
import { AuthProvider, useAuth } from './AuthProvider';
import { ProtectedRoute } from './ProtectedRoute';
import { loginRedirectTarget } from './loginRedirect';

const mocked = api as unknown as { login: jest.Mock; getCurrentUser: jest.Mock };
const SESSION_KEY = 'sheer.web.auth.session';
const OWNER = { id: 'owner-a', roles: ['owner'], primaryRole: 'owner', permissions: [], allowedLocationIds: [] } as unknown as AuthUser;

let current = { pathname: '', search: '', state: undefined as unknown };
let go: ((to: string | number) => void) | null = null;

function Controls() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  current = { pathname: location.pathname, search: location.search, state: location.state };
  useEffect(() => {
    go = (to) => (typeof to === 'number' ? navigate(to) : navigate(to));
  }, [navigate]);
  return (
    <div>
      <span data-testid="signed-out">{String(auth.signedOut)}</span>
      <button type="button" onClick={() => void auth.signIn('owner@example.com', 'pw')}>
        sign in
      </button>
      <button type="button" onClick={() => void auth.signOut()}>
        sign out
      </button>
    </div>
  );
}

function renderApp(initial: string | string[], v7 = false) {
  const entries = Array.isArray(initial) ? initial : [initial];
  return render(
    <MemoryRouter
      initialEntries={entries}
      initialIndex={entries.length - 1}
      future={v7 ? { v7_startTransition: true, v7_relativeSplatPath: true } : undefined}
    >
      <AuthProvider>
        <Controls />
        <Routes>
          <Route path="/login" element={<p>Login page</p>} />
          <Route element={<ProtectedRoute allowedRoles={['owner']} />}>
            <Route path="/reports/:key" element={<p>Report page</p>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** How the (re)rendered page was loaded, as the Navigation Timing API reports it. */
function pageLoadedBy(type: 'navigate' | 'prerender' | 'reload' | 'back_forward') {
  Object.defineProperty(performance, 'getEntriesByType', {
    configurable: true,
    value: (kind: string) => (kind === 'navigation' ? [{ type }] : []),
  });
}

afterEach(() => {
  delete (performance as unknown as Record<string, unknown>).getEntriesByType;
});

async function visit(to: string | number) {
  await act(async () => {
    go?.(to);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mocked.getCurrentUser.mockReset();
  mocked.login.mockReset();
  mocked.login.mockResolvedValue({
    session: { accessToken: 'access-a', refreshToken: 'refresh-a', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    user: OWNER,
  });
});

describe.each([
  ['default router', false],
  ['React Router v7 transitions', true],
])('sign-in targets (%s)', (_label, v7) => {
  it('a shared report link opened while signed out is kept whole for the sign-in', async () => {
    renderApp('/reports/money?locations=aaa', v7);
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBe('/reports/money?locations=aaa');
  });

  it('after Logout, neither the current page nor a page reached with Back becomes a sign-in target', async () => {
    renderApp('/login', v7);
    await screen.findByText('Login page');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    await visit('/reports/money?locations=aaa');
    await visit('/reports/team?locations=bbb');
    await screen.findByText('Report page');

    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBeUndefined();

    await visit(-1);
    await screen.findByText('Login page');
    expect(current.pathname).toBe('/login');
    expect(loginRedirectTarget(current.state)).toBeUndefined();
  });

  it('signing in again clears the sign-out flag', async () => {
    renderApp('/login', v7);
    await screen.findByText('Login page');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
  });

  it('a reload after Logout still remembers the sign-out, so Back records no sign-in target', async () => {
    const first = renderApp('/login', v7);
    await screen.findByText('Login page');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('true'));
    first.unmount();

    // The reloaded page: same tab storage, history still holds the report page.
    pageLoadedBy('reload');
    renderApp(['/reports/money?locations=aaa', '/login'], v7);
    await screen.findByText('Login page');
    expect(screen.getByTestId('signed-out').textContent).toBe('true');
    await visit(-1);
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBeUndefined();
  });

  it('a shared report link opened fresh in a tab that was signed out of still keeps its target; Back still does not', async () => {
    const first = renderApp('/login', v7);
    await screen.findByText('Login page');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('true'));
    first.unmount();

    // A new visit: someone pastes a shared link into the same tab.
    pageLoadedBy('navigate');
    const fresh = renderApp('/reports/money?preset=last_week&locations=shared', v7);
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBe('/reports/money?preset=last_week&locations=shared');
    fresh.unmount();

    // A typed URL the browser prerendered is also a new visit.
    pageLoadedBy('prerender');
    const prerendered = renderApp('/reports/money?preset=yesterday&locations=typed', v7);
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBe('/reports/money?preset=yesterday&locations=typed');
    prerendered.unmount();

    // Back into the previous user's pages is a return, not a new visit.
    pageLoadedBy('back_forward');
    renderApp('/reports/team?locations=bbb', v7);
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBeUndefined();
  });

  it('a session adopted from another tab counts as a sign-in here', async () => {
    renderApp('/login', v7);
    await screen.findByText('Login page');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    act(() => {
      localStorage.removeItem(SESSION_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY, storageArea: localStorage }));
    });
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('true'));

    mocked.getCurrentUser.mockResolvedValue({ user: OWNER });
    act(() => {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ accessToken: 'access-b', refreshToken: 'refresh-b', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      );
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY, storageArea: localStorage }));
    });
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    expect(sessionStorage.getItem('sheer.web.auth.signedOut')).toBeNull();
  });

  it('a sign-out in another tab counts as a sign-out here', async () => {
    renderApp('/login', v7);
    await screen.findByText('Login page');
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));
    await waitFor(() => expect(screen.getByTestId('signed-out').textContent).toBe('false'));
    await visit('/reports/money?locations=aaa');
    await screen.findByText('Report page');
    act(() => {
      localStorage.removeItem('sheer.web.auth.session');
      window.dispatchEvent(new StorageEvent('storage', { key: 'sheer.web.auth.session', storageArea: localStorage }));
    });
    await screen.findByText('Login page');
    expect(loginRedirectTarget(current.state)).toBeUndefined();
  });
});
