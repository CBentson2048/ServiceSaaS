import { useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { UserRole } from '@sheer/domain';
import { detectMobileStoreUrl, sheerAppDeepLink } from '../config/mobileApp';
import { AppButton, AppCard, AppText } from '../design';

/**
 * Public, auth-adjacent route shown after a stylist or client successfully
 * resets their password on the web.
 *
 * Like {@link ./AccountCreatedPage}, this page is intentionally **not**
 * placed behind the dashboard role guard. Stylist / client cannot use
 * the dashboard at all, but the password-reset email link lands them on
 * the web — so we use this completion page as the successful end-state
 * that points them back at the Service SaaS App.
 *
 * Owner and manager normally do not land here; the API redirects them
 * to `/login?password=reset`. If they manually open this URL we still
 * render a generic success state so it never feels like an error.
 */
export function PasswordResetCompletePage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const stateRole = (location.state as { role?: UserRole } | null)?.role;
  const role = normalizeRole(stateRole ?? searchParams.get('role'));
  const copy = roleCopy(role);
  const storeUrl = useMemo(() => detectMobileStoreUrl(), []);

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10 text-text-primary">
      <AppCard elevation="hero" padding="lg" className="w-full max-w-md text-center">
        <div
          className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full border border-success-border bg-success-soft text-success"
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12.5l4.2 4.2L19 7" />
          </svg>
        </div>

        <AppText as="h1" variant="heading" weight="medium">
          {copy.title}
        </AppText>
        <AppText as="p" variant="body" tone="secondary" className="mt-2">
          {copy.subtitle}
        </AppText>

        {copy.kind === 'mobile' ? (
          <>
            <div className="mt-6 flex flex-col gap-2">
              <AppButton
                variant="primary"
                size="lg"
                fullWidth
                onClick={() => {
                  // TODO: Replace placeholder deep link via VITE_SHEER_APP_DEEP_LINK once the
                  // mobile app's universal/custom-scheme link is finalised.
                  window.location.href = sheerAppDeepLink;
                }}
              >
                Open Service SaaS App
              </AppButton>
              <AppButton
                variant="secondary"
                size="lg"
                fullWidth
                onClick={() => {
                  window.location.href = storeUrl;
                }}
              >
                Download Service SaaS App
              </AppButton>
            </div>
            <AppText as="p" variant="micro" tone="muted" className="mt-5">
              You can close this page after opening the Service SaaS App.
            </AppText>
          </>
        ) : (
          <div className="mt-6">
            <Link
              to="/login?password=reset"
              className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-6 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            >
              Continue to sign in
            </Link>
          </div>
        )}

        <div className="mt-6 border-t border-border pt-4">
          <Link
            to="/login"
            className="text-[13px] font-medium text-primary-deep hover:underline"
          >
            Return to sign in
          </Link>
        </div>
      </AppCard>
    </main>
  );
}

interface RoleCopy {
  kind: 'mobile' | 'web';
  title: string;
  subtitle: string;
}

function roleCopy(role: NormalizedRole): RoleCopy {
  switch (role) {
    case 'stylist':
      return {
        kind: 'mobile',
        title: 'Password updated',
        subtitle:
          'Your stylist account is ready. Continue in the Service SaaS App to view your schedule, clients, and formulas.',
      };
    case 'client':
      return {
        kind: 'mobile',
        title: 'Password updated',
        subtitle:
          'Your password has been reset. Use the Service SaaS App to book appointments and stay in touch with your salon.',
      };
    case 'owner':
    case 'manager':
      return {
        kind: 'web',
        title: 'Password updated',
        subtitle: 'Your password has been reset. Sign in with your new password to continue.',
      };
    default:
      return {
        kind: 'mobile',
        title: 'Password updated',
        subtitle: 'Your password has been reset. Continue in the Service SaaS App to pick up where you left off.',
      };
  }
}

type NormalizedRole = UserRole | 'generic';

function normalizeRole(value: string | UserRole | null | undefined): NormalizedRole {
  if (value === 'owner' || value === 'manager' || value === 'stylist' || value === 'client') {
    return value;
  }
  return 'generic';
}
