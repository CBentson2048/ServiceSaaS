/**
 * Booking sign-in for customers who arrive already signed in. A session belongs
 * to one business, so it can only be reused at that salon. Anyone else (a staff
 * or owner account, or a client of another salon) used to bounce between this
 * page and the review page forever, or book with another salon's client profile
 * and be rejected at confirmation. They now get the sign-in form for this salon.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockAuth: {
  status: string;
  user: unknown;
  session: unknown;
  applyAuthenticatedSession: jest.Mock;
  signIn: jest.Mock;
} = {
  status: 'authenticated',
  user: null,
  session: null,
  applyAuthenticatedSession: jest.fn(),
  signIn: jest.fn(),
};

jest.mock('../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('../auth/api', () => ({ loginClientBookingAccount: jest.fn() }));

import * as api from '../auth/api';
import { LoginPage } from './LoginPage';
import { CLIENT_BOOKING_STORAGE_KEY, readClientBookingSelection } from './clientBookingFlow';

const loginClientBookingAccount = api.loginClientBookingAccount as jest.Mock;

const SESSION = { accessToken: 'access', refreshToken: 'refresh', expiresAt: 0 };

function user(overrides: Record<string, unknown>) {
  return {
    id: 'user-1',
    roles: ['client'],
    permissions: [],
    profile: { email: 'sam@example.com', fullName: 'Sam Carter' },
    ...overrides,
  };
}

function CurrentPath() {
  return <output aria-label="path">{useLocation().pathname}</output>;
}

function renderBookingLogin() {
  window.sessionStorage.setItem(
    CLIENT_BOOKING_STORAGE_KEY,
    JSON.stringify({
      locationId: 'location-b',
      location: { id: 'location-b', businessId: 'business-b', name: 'Salon B' },
      serviceIds: ['service-1'],
      selectedSlot: { startAt: '2026-10-01T10:00:00.000Z', staffProfileId: 'staff-1' },
    }),
  );
  render(
    <MemoryRouter initialEntries={['/login?booking=1']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<CurrentPath />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  loginClientBookingAccount.mockReset();
  mockAuth.applyAuthenticatedSession.mockReset();
  mockAuth.session = SESSION;
});

describe('LoginPage booking sign-in when already signed in', () => {
  it('continues straight to review for a client of the salon being booked', () => {
    mockAuth.user = user({
      businessId: 'business-b',
      clientProfileId: 'client-at-b',
      clientCommunicationPreference: 'email',
    });

    renderBookingLogin();

    expect(screen.getByLabelText('path').textContent).toBe('/book/review');
    expect(readClientBookingSelection()?.account?.clientProfileId).toBe('client-at-b');
  });

  it('asks a staff or owner account to sign in for this salon instead of looping', () => {
    mockAuth.user = user({ roles: ['owner'], businessId: 'business-b' });

    renderBookingLogin();

    expect(screen.queryByLabelText('path')).toBeNull();
    expect(screen.getByText(/You are signed in as sam@example.com/)).toBeTruthy();
    expect(screen.getByText(/Salon B/)).toBeTruthy();
    expect(screen.getByLabelText('Email')).toHaveProperty('value', 'sam@example.com');
  });

  it('books with this salon\'s client profile, not the one the session carries', async () => {
    mockAuth.user = user({ businessId: 'business-a', clientProfileId: 'client-at-a' });
    loginClientBookingAccount.mockResolvedValue({
      session: SESSION,
      // The account's primary membership is still salon A.
      user: user({ businessId: 'business-a', clientProfileId: 'client-at-a' }),
      bookingClient: {
        businessId: 'business-b',
        clientProfileId: 'client-at-b',
        communicationPreference: 'whatsapp',
      },
    });

    renderBookingLogin();
    expect(screen.queryByLabelText('path')).toBeNull();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByLabelText('path').textContent).toBe('/book/review'));
    expect(loginClientBookingAccount).toHaveBeenCalledWith({
      locationId: 'location-b',
      email: 'sam@example.com',
      password: 'secret-pass',
    });
    const selection = readClientBookingSelection();
    expect(selection?.account?.clientProfileId).toBe('client-at-b');
    expect(selection?.communicationPreference).toBe('whatsapp');
  });
});
