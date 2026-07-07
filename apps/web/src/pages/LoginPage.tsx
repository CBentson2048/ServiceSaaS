import type { FormEvent} from 'react';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { LoginResponse } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { loginClientBookingAccount } from '../auth/api';
import { BrandLogo } from '../components/BrandLogo';
import {
  readClientBookingSelection,
  updateClientBookingSelection,
} from './clientBookingFlow';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const bookingMode = searchParams.get('booking') === '1';
  const bookingSelection = bookingMode ? readClientBookingSelection() : null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const from = bookingMode
    ? '/book/review'
    : (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/dashboard';
  const justOnboarded = searchParams.get('onboarded') === '1';
  const justAcceptedInvitation = searchParams.get('invitation') === 'accepted';
  const justResetPassword = searchParams.get('password') === 'reset';

  if (bookingMode && !bookingSelection?.selectedSlot) {
    return <Navigate to="/book/date-time" replace />;
  }

  if (auth.user) {
    if (bookingMode && auth.session && auth.user.clientProfileId) {
      completeBookingAuth({ session: auth.session, user: auth.user });
    }
    return <Navigate to={bookingMode && !auth.user.clientCommunicationPreference ? '/book/preference' : from} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      if (bookingMode && bookingSelection) {
        const response = await loginClientBookingAccount({
          locationId: bookingSelection.locationId,
          email,
          password,
        });
        completeBookingAuth(response);
        auth.applyAuthenticatedSession(response.session, response.user);
        navigate(response.user.clientCommunicationPreference ? from : '/book/preference', { replace: true });
        return;
      } else {
        await auth.signIn(email, password);
      }
      navigate(from, { replace: true });
    } catch {
      setError(
        bookingMode
          ? 'Sign in failed. Check your email and password.'
          : 'Sign in failed. Check the account role, email, and password.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#F7F2EA] px-4 text-text-primary">
      <section className="w-full max-w-md overflow-hidden rounded-[28px] border border-[#E7DCCF] bg-white shadow-[0_24px_80px_rgba(38,28,52,0.12)]">
        <div className="border-b border-[#EFE6DC] bg-[#FBF7F1] px-8 py-7 text-center">
          <BrandLogo variant="color" className="mx-auto mb-6 h-7" />
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full border border-primary/30 bg-primary/10 text-primary">
            <span aria-hidden>◇</span>
          </div>
          <h1 className="text-2xl font-semibold text-[#241E30]">Welcome back</h1>
          <p className="mt-1 text-sm text-[#776A82]">
            {bookingMode ? 'Sign in to continue your booking' : 'Owner and manager dashboard access'}
          </p>
        </div>

        <form className="space-y-4 px-8 py-7" onSubmit={onSubmit}>
          {justOnboarded ? (
            <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-sm text-success">
              Your business workspace is ready. Sign in to access the owner dashboard.
            </div>
          ) : null}

          {justAcceptedInvitation ? (
            <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-sm text-success">
              Invitation accepted. Sign in with the password you just created.
            </div>
          ) : null}

          {justResetPassword ? (
            <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-sm text-success">
              Password updated. Sign in with your new password.
            </div>
          ) : null}

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
              Email
            </span>
            <input
              className="mt-2 w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label className="block">
            <span className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
                Password
              </span>
              <Link
                to="/forgot-password"
                className="text-[12px] font-medium text-primary-deep hover:underline"
              >
                Forgot password?
              </Link>
            </span>
            <input
              className="mt-2 w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? (
            <div className="rounded-input-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-input-lg bg-primary px-4 py-3 text-sm font-semibold text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>

          <p className="text-center text-sm text-[#776A82]">
            {bookingMode ? 'Need an account?' : 'New to Sheer?'}{' '}
            <Link
              className="font-semibold text-primary-deep"
              to={bookingMode ? '/create-account?booking=1' : '/owner/onboarding'}
            >
              {bookingMode ? 'Create account' : 'Set up your business'}
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}

function completeBookingAuth(response: LoginResponse): void {
  if (!response.user.clientProfileId) {
    throw new Error('Client profile could not be linked to this booking.');
  }
  const profileName = splitFullName(response.user.profile.fullName);
  updateClientBookingSelection({
    client: {
      firstName: profileName.firstName,
      lastName: profileName.lastName,
      email: response.user.profile.email,
      phone: response.user.profile.phone,
    },
    communicationPreference: response.user.clientCommunicationPreference,
    account: {
      accessToken: response.session.accessToken,
      refreshToken: response.session.refreshToken,
      userProfileId: response.user.id,
      clientProfileId: response.user.clientProfileId,
      email: response.user.profile.email,
    },
  });
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Client', lastName: 'Client' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Client' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
