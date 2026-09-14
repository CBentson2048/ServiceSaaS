/**
 * Logging out never leaves the signed-out page behind as a sign-in target: the
 * next person to sign in on a shared browser starts from their own default
 * page, not from the previous user's address and query.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ProtectedRoute } from '../auth/ProtectedRoute';
import { loginRedirectTarget } from '../auth/loginRedirect';
import { TopBar } from './TopBar';

let mockUser: Record<string, unknown> | null = null;
const mockSignOut = jest.fn(async () => {
  mockUser = null;
  mockRerender?.();
});
let mockRerender: (() => void) | null = null;

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ status: mockUser ? 'authenticated' : 'anonymous', user: mockUser, session: mockUser ? { accessToken: 't' } : null, signOut: mockSignOut }),
}));
jest.mock('../auth/api', () => ({ searchCrmClients: jest.fn() }));
jest.mock('./LocationScopeContext', () => ({
  ALL_LOCATIONS: 'all',
  useLocationScope: () => ({ locationId: 'all', setLocationId: jest.fn(), locations: [] }),
}));

let seen: { pathname: string; search: string; state: unknown } | null = null;
function LoginProbe() {
  const location = useLocation();
  seen = { pathname: location.pathname, search: location.search, state: location.state };
  return <p>Login page</p>;
}

function Shell() {
  return (
    <>
      <TopBar />
      <p>CRM page</p>
    </>
  );
}

function tree() {
  return (
    <MemoryRouter initialEntries={['/crm?q=Jane%20Smith%2007700900123']}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
        <Route element={<ProtectedRoute allowedRoles={['owner']} />}>
          <Route path="/crm" element={<Shell />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  seen = null;
  mockSignOut.mockClear();
  mockUser = {
    id: 'owner-a',
    roles: ['owner'],
    primaryRole: 'owner',
    permissions: [],
    allowedLocationIds: [],
    profile: { id: 'owner-a', email: 'a@example.com', fullName: 'Owner A' },
  };
});

describe('TopBar logout', () => {
  it('goes to /login with no bounce state, so the next sign-in lands on its own default page', async () => {
    const view = render(tree());
    mockRerender = () => view.rerender(tree());
    fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Logout/ }));
    await screen.findByText('Login page');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(seen?.pathname).toBe('/login');
    expect(seen?.search).toBe('');
    expect(loginRedirectTarget(seen?.state)).toBeUndefined();
  });

  it('an unplanned bounce (session gone without Logout) still records where the user was', async () => {
    const view = render(tree());
    mockUser = null;
    view.rerender(tree());
    await screen.findByText('Login page');
    expect(loginRedirectTarget(seen?.state)).toBe('/crm');
  });
});
