import type { FormEvent } from 'react';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthUser, LoginResponse, Permission } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { loginClientBookingAccount } from '../auth/api';
import { loginRedirectTarget } from '../auth/loginRedirect';
import { BrandLogo } from '../components/BrandLogo';
import { PasswordInput } from '../design';
import { usePageMetadata } from '../hooks/usePageMetadata';
import {
  type BookingClient,
  readClientBookingSelection,
  sessionBookingClient,
  updateClientBookingSelection,
} from './clientBookingFlow';

export function LoginPage() {
  usePageMetadata(
    'Log in | Service SaaS',
    'Log in to Service SaaS to manage salon bookings, rota, clients, and payments.',
  );
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const bookingMode = searchParams.get('booking') === '1';
  const bookingSelection = bookingMode ? readClientBookingSelection() : null;
  // Signed in, but not as a client of the salon being booked: offer the same
  // account for a fresh booking sign-in.
  const [email, setEmail] = useState(() => (bookingMode ? (auth.user?.profile.email ?? '') : ''));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const requestedFrom = loginRedirectTarget(location.state);
  const from = bookingMode ? '/book/review' : requestedFrom;
  const justOnboarded = searchParams.get('onboarded') === '1';
  const justAcceptedInvitation = searchParams.get('invitation') === 'accepted';
  const justResetPassword = searchParams.get('password') === 'reset';

  if (bookingMode && !bookingSelection?.selectedSlot) {
    return <Navigate to="/book/date-time" replace />;
  }

  // A signed-in user opening /login (a bookmark, or the marketing site's "Log
  // in" button) should not see the credentials form flash past while the stored
  // session is still being proved.
  if (auth.status === 'bootstrapping') {
    return (
      <div className="grid min-h-screen place-items-center bg-bg text-text-secondary">
        Restoring your Service SaaS session...
      </div>
    );
  }

  const sessionClient =
    auth.user && bookingMode
      ? sessionBookingClient(auth.user, bookingSelection?.location?.businessId)
      : null;

  if (auth.user && !bookingMode) {
    return <Navigate to={from ?? defaultRouteFor(auth.user)} replace />;
  }

  if (auth.user && auth.session && sessionClient) {
    completeBookingAuth({ session: auth.session, user: auth.user }, sessionClient);
    return (
      <Navigate
        to={sessionClient.communicationPreference ? (from ?? '/book/review') : '/book/preference'}
        replace
      />
    );
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
        completeBookingAuth(response, response.bookingClient);
        auth.applyAuthenticatedSession(response.session, response.user);
        navigate(
          response.bookingClient.communicationPreference
            ? (from ?? '/book/review')
            : '/book/preference',
          {
            replace: true,
          },
        );
        return;
      } else {
        const user = await auth.signIn(email, password);
        navigate(from ?? defaultRouteFor(user), { replace: true });
        return;
      }
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
            {bookingMode
              ? 'Sign in to continue your booking'
              : 'Owner and manager dashboard access'}
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

          {auth.user && bookingMode ? (
            <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-sm text-text-secondary">
              You are signed in as {auth.user.profile.email}. Sign in again to book at{' '}
              {bookingSelection?.location?.name ?? 'this salon'}.
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

          {/* Not a wrapping <label>: it would fold "Forgot password?" into the
              input's name, and may not contain the show/hide button. */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <label
                htmlFor="login-password"
                className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]"
              >
                Password
              </label>
              <Link
                to="/forgot-password"
                className="text-[12px] font-medium text-primary-deep hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <PasswordInput
              id="login-password"
              className="w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

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
            {bookingMode ? 'Need an account?' : 'New to Service SaaS?'}{' '}
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

const DEFAULT_PERMISSION_ROUTES: readonly [Permission, string][] = [
  ['report.dashboard.view', '/dashboard'],
  ['bookings.manage', '/bookings'],
  ['crm.view', '/crm'],
  ['inventory.manage', '/inventory'],
  ['services.manage', '/services'],
  ['rota.manage', '/rota'],
  ['report.performance.view', '/performance'],
  ['report.commission.view', '/commission'],
  ['staff.manage', '/team'],
  ['settings.location.manage', '/locations'],
  ['settings.booking.manage', '/settings/booking'],
];

function defaultRouteFor(user: AuthUser): string {
  return (
    DEFAULT_PERMISSION_ROUTES.find(([permission]) => userHasPermission(user, permission))?.[1] ??
    '/profile'
  );
}

function completeBookingAuth(response: LoginResponse, bookingClient: BookingClient): void {
  const profileName = splitFullName(response.user.profile.fullName);
  updateClientBookingSelection({
    client: {
      firstName: profileName.firstName,
      lastName: profileName.lastName,
      email: response.user.profile.email,
      phone: response.user.profile.phone,
    },
    communicationPreference: bookingClient.communicationPreference,
    account: {
      accessToken: response.session.accessToken,
      refreshToken: response.session.refreshToken,
      userProfileId: response.user.id,
      clientProfileId: bookingClient.clientProfileId,
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
