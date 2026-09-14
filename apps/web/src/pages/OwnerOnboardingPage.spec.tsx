/**
 * Owner onboarding's password rule: only the Password field can be shown, and
 * while it is shown there is no Confirm password field and nothing to match.
 * The review step re-validates the owner step long after that field has
 * unmounted, so the rule is pinned through a full submit, not just step 1.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../auth/api', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  // Never settles: the page falls back to its built-in defaults.
  getOwnerOnboardingBootstrap: jest.fn(() => new Promise(() => {})),
  checkBusinessSlugAvailability: jest.fn(async () => ({ available: true })),
  registerOwnerOnboarding: jest.fn(async () => ({ redirectTo: '/login?onboarded=1' })),
}));

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: null, applyAuthenticatedSession: jest.fn() }),
}));

import * as api from '../auth/api';
import { OwnerOnboardingPage } from './OwnerOnboardingPage';

const registerOwnerOnboarding = api.registerOwnerOnboarding as jest.Mock;

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function renderPage() {
  render(
    <MemoryRouter>
      <OwnerOnboardingPage />
    </MemoryRouter>,
  );
  type('First name', 'Luke');
  type('Last name', 'Ormsby');
  type('Email', 'owner@example.com');
  type('Password', 'correct-horse');
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

beforeEach(() => registerOwnerOnboarding.mockClear());

describe('OwnerOnboardingPage password fields', () => {
  it('offers show/hide on Password only', () => {
    renderPage();

    expect(screen.getByLabelText('Confirm password')).toHaveProperty('type', 'password');
    expect(screen.getAllByRole('button', { name: /password/i })).toHaveLength(1);
  });

  it('removes Confirm password while the password is shown, and brings it back with its value', () => {
    renderPage();
    type('Confirm password', 'correct-horse');

    click('Show password');
    expect(screen.getByLabelText('Password')).toHaveProperty('type', 'text');
    expect(screen.queryByLabelText('Confirm password')).toBeNull();

    click('Hide password');
    expect(screen.getByLabelText('Confirm password')).toHaveProperty('value', 'correct-horse');
  });

  it('still asks for a match once the password is hidden again', () => {
    renderPage();
    click('Show password');
    click('Hide password');

    click('Continue');

    expect(screen.getByText('Passwords do not match')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tell us about you' })).toBeTruthy();
  });

  it('creates the workspace with a shown password and no confirmation', async () => {
    renderPage();
    click('Show password');

    click('Continue');
    expect(screen.getByRole('heading', { name: 'Set up your business' })).toBeTruthy();

    // Coming back finds the password still shown and still unconfirmed.
    click('Back');
    expect(screen.getByLabelText('Password')).toHaveProperty('type', 'text');
    expect(screen.queryByLabelText('Confirm password')).toBeNull();
    click('Continue');

    type('Business name', 'Luke Ormsby Hair');
    click('Continue');
    type('Location name', 'Leeds');
    click('Continue');
    expect(screen.getByRole('heading', { name: 'Review and confirm' })).toBeTruthy();

    click('Create owner workspace');

    await waitFor(() => expect(registerOwnerOnboarding).toHaveBeenCalledTimes(1));
    expect(registerOwnerOnboarding.mock.calls[0][0].owner.password).toBe('correct-horse');
  });
});
