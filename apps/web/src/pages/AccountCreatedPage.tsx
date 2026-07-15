import { useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { UserRole } from '@sheer/domain';
import { AppButton, AppCard, AppText } from '../design';
import {
  detectMobileStoreUrl,
  sheerAppDeepLink,
} from '../config/mobileApp';

/**
 * Public, auth-adjacent route shown after a stylist or client successfully
 * claims their account on the web.
 *
 * This page is intentionally **not** placed behind the dashboard role
 * guard. Stylists and clients are not allowed into the dashboard at all
 * (see {@link ./web/auth/ProtectedRoute}), but they *are* allowed to land
 * here after a successful invitation acceptance. It's a successful
 * end-state for the web flow, not an error / forbidden screen.
 *
 * The owner-onboarding and manager-invitation flows never route here;
 * they continue into the dashboard via the existing redirect logic in
 * `OwnerOnboardingPage` / `AcceptInvitationPage`.
 */
export function AccountCreatedPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();

  const stateRole = (location.state as { role?: UserRole } | null)?.role;
  const role = normalizeRole(stateRole ?? searchParams.get('role'));
  const copy = roleCopy(role);
  const storeUrl = useMemo(() => detectMobileStoreUrl(), []);

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10 text-text-primary">
      <AppCard
        elevation="hero"
        padding="lg"
        className="w-full max-w-md text-center"
      >
        <div
          className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full border border-success-border bg-success-soft text-success"
          aria-hidden
        >
          {/* Inline checkmark — no icon dep needed. */}
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

        <div className="mt-6 flex flex-col gap-2">
          <AppButton
            variant="primary"
            size="lg"
            fullWidth
            onClick={() => {
              window.location.href = sheerAppDeepLink;
            }}
          >
            Open Qlooqo App
          </AppButton>
          <AppButton
            variant="secondary"
            size="lg"
            fullWidth
            onClick={() => {
              window.location.href = storeUrl;
            }}
          >
            Download Qlooqo App
          </AppButton>
        </div>

        <AppText as="p" variant="micro" tone="muted" className="mt-5">
          {copy.helpText}
        </AppText>

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
  title: string;
  subtitle: string;
  helpText: string;
}

function roleCopy(role: NormalizedRole): RoleCopy {
  switch (role) {
    case 'stylist':
      return {
        title: 'Account created successfully',
        subtitle:
          'Your stylist account is ready. Continue in the Qlooqo App to view your schedule, clients, and formulas.',
        helpText:
          'You can close this page after opening the Qlooqo App on your phone or tablet.',
      };
    case 'client':
      return {
        title: 'Account created successfully',
        subtitle:
          'Your account is ready. Use the Qlooqo App to book appointments and stay in touch with your salon.',
        helpText: 'You can close this page after opening the Qlooqo App.',
      };
    default:
      return {
        title: 'Account created successfully',
        subtitle:
          'Your account is ready. Continue in the Qlooqo App to pick up where you left off.',
        helpText: 'You can close this page after opening the Qlooqo App.',
      };
  }
}

type NormalizedRole = 'stylist' | 'client' | 'generic';

function normalizeRole(value: string | UserRole | null | undefined): NormalizedRole {
  if (value === 'stylist' || value === 'client') return value;
  return 'generic';
}
