import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { PasswordResetInspectResponse, PasswordResetTokenStatus } from '@sheer/domain';
import {
  ApiRequestError,
  completePasswordReset,
  inspectPasswordResetToken,
} from '../auth/api';
import { TextField } from '../components/onboarding/FormField';
import { BrandLogo } from '../components/BrandLogo';
import { AppButton, AppCard, AppText } from '../design';

const PASSWORD_MIN = 8;

/**
 * Public route the password-reset email links to.
 *
 * Accepts a single-use token via `?token=...`, validates it server-side
 * (`/auth/password-reset/inspect`), and lets the user pick a new
 * password. On success the API returns a role-aware contract — we use
 * the `nextAction` field to decide whether to send the user to the
 * `/login?password=reset` flow (owner / manager) or the role-aware
 * completion page (stylist / client).
 */
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [inspect, setInspect] = useState<PasswordResetInspectResponse | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token || token.length < 20) {
      setInspectError('This reset link is invalid.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    inspectPasswordResetToken(token)
      .then((result) => {
        if (cancelled) return;
        setInspect(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setInspectError(err.message);
        else if (err instanceof Error) setInspectError(err.message);
        else setInspectError('Could not verify reset link.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (password.length < PASSWORD_MIN) next.password = `At least ${PASSWORD_MIN} characters`;
    if (password !== confirmPassword) next.confirmPassword = 'Passwords do not match';
    return next;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitError(null);
    setSubmitting(true);
    try {
      const response = await completePasswordReset({ token, password });

      // Role-aware redirect — the API tells us where to send the user.
      // Stylist / client (`mobile`) go to the role-aware completion
      // page. Owner / manager (`web`) go to sign-in with a friendly
      // banner. We never auto-issue a session here, on purpose: the
      // user must sign in again with their freshly-rotated password.
      if (response.nextAction === 'show_completion_page') {
        navigate(response.redirectTo || `/auth/password-reset-complete?role=${response.role}`, {
          replace: true,
          state: { role: response.role },
        });
        return;
      }
      navigate(response.redirectTo || '/login?password=reset', { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setSubmitError(err.message);
      else if (err instanceof Error) setSubmitError(err.message);
      else setSubmitError('Could not reset password. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const status: PasswordResetTokenStatus | undefined = inspect?.status;
  const cannotProceed = !!inspectError || (status && status !== 'valid');

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10 text-text-primary">
      <AppCard elevation="hero" padding="lg" className="w-full max-w-md">
        <header className="mb-5 text-center">
          <BrandLogo variant="color" className="mx-auto mb-4 h-6" />
          <AppText as="h1" variant="heading" weight="medium">
            Choose a new password
          </AppText>
          {inspect?.emailMasked ? (
            <AppText as="p" variant="body" tone="secondary" className="mt-1">
              For <strong>{inspect.emailMasked}</strong>
            </AppText>
          ) : (
            <AppText as="p" variant="body" tone="secondary" className="mt-1">
              Set a new password to finish resetting your account.
            </AppText>
          )}
        </header>

        {loading ? (
          <div className="text-center text-[13px] text-text-secondary">Verifying link…</div>
        ) : cannotProceed ? (
          <div className="space-y-4">
            <div className="rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3 text-[13px] text-warning">
              {inspectError ?? statusMessage(status)}
            </div>
            <Link
              to="/forgot-password"
              className="block text-center text-[13px] font-medium text-primary-deep hover:underline"
            >
              Request a new reset link
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              value={password}
              onValueChange={setPassword}
              error={errors.password}
              hint={`At least ${PASSWORD_MIN} characters`}
              required
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onValueChange={setConfirmPassword}
              error={errors.confirmPassword}
              required
            />

            {submitError ? (
              <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
                {submitError}
              </div>
            ) : null}

            <AppButton type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
              Update password
            </AppButton>
          </form>
        )}

        <div className="mt-6 border-t border-border pt-4 text-center">
          <Link to="/login" className="text-[13px] font-medium text-primary-deep hover:underline">
            Back to sign in
          </Link>
        </div>
      </AppCard>
    </main>
  );
}

function statusMessage(status?: PasswordResetTokenStatus): string {
  switch (status) {
    case 'expired':
      return 'This reset link has expired. Request a new one.';
    case 'used':
      return 'This reset link has already been used. Request a new one if you still need to reset.';
    case 'unknown':
      return 'This reset link is invalid. Request a new one.';
    default:
      return 'This reset link cannot be used.';
  }
}
