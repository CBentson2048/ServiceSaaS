import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, deleteMyAccount, signInForAccountDeletion } from '../auth/api';
import { TextField } from '../components/onboarding/FormField';
import { AppButton, AppCard, AppText } from '../design';

/**
 * Public self-service account deletion page (App Store Guideline 5.1.1(v)).
 *
 * This is the URL submitted in App Store Connect as the account-deletion link.
 * It is mounted OUTSIDE the dashboard ProtectedRoute and never touches the
 * staff AuthProvider session — a client signs in here with their qlooqo app
 * credentials purely to authorise deleting their own account.
 *
 * Flow: verify identity (email + password + acknowledgement) → confirm → done.
 * Only client accounts can be deleted; staff/owner/manager accounts are managed
 * by the salon, so they are turned away before the confirmation step (and the
 * API would reject the delete with a 403 regardless).
 */

type Step = 'verify' | 'confirm' | 'deleted';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function DeleteAccountPage() {
  const [step, setStep] = useState<Step>('verify');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmedEmail = email.trim();
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Enter your password.');
      return;
    }
    if (!acknowledged) {
      setError('Please tick the box to confirm you understand this is permanent.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await signInForAccountDeletion({ email: trimmedEmail, password });
      if (result.user.role !== 'client') {
        // Staff/owner/manager accounts are provisioned and managed by the salon
        // and cannot be self-deleted here — turn them away with a clear message.
        setError(
          'This is a staff account, which is managed by your salon and cannot be deleted here. Please contact your salon owner.',
        );
        return;
      }
      setAccessToken(result.session.accessToken);
      setEmail(trimmedEmail);
      setPassword('');
      setStep('confirm');
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) {
        setError('The email or password is incorrect, or this account can no longer sign in.');
      } else {
        setError(toMessage(err, 'Could not verify your account. Please try again in a moment.'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirmDelete() {
    if (submitting || !accessToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await deleteMyAccount(accessToken);
      setAccessToken(null);
      setStep('deleted');
    } catch (err) {
      setError(toMessage(err, 'Could not delete your account. Please try again in a moment.'));
    } finally {
      setSubmitting(false);
    }
  }

  function onCancel() {
    setAccessToken(null);
    setPassword('');
    setAcknowledged(false);
    setError(null);
    setStep('verify');
  }

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10 text-text-primary">
      <AppCard elevation="hero" padding="lg" className="w-full max-w-md">
        <header className="mb-5 text-center">
          <div className="mb-4 text-xs font-semibold tracking-[0.38em] text-text-secondary">
            SH<span className="text-primary">EE</span>R
          </div>
          <AppText as="h1" variant="heading" weight="medium">
            Delete your account
          </AppText>
        </header>

        {step === 'verify' ? (
          <form onSubmit={onVerify} className="space-y-4" noValidate>
            <AppText as="p" variant="body" tone="secondary">
              Deleting your account is <strong>permanent</strong> and cannot be undone. To continue,
              confirm it&apos;s you by signing in with the email and password you use in the qlooqo
              app.
            </AppText>

            <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-[13px] text-text-secondary">
              <p className="mb-1.5 font-semibold text-text-primary">What gets deleted</p>
              <ul className="list-disc space-y-1 pl-4">
                <li>Your login and personal profile (name, email, phone).</li>
                <li>Your access to bookings and history in the app.</li>
              </ul>
              <p className="mt-2.5">
                Past appointment and payment records the salon must keep for legal and accounting
                reasons are retained, but are unlinked from your account.
              </p>
            </div>

            <TextField
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onValueChange={setEmail}
              required
            />
            <TextField
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onValueChange={setPassword}
              required
            />

            <label className="flex items-start gap-2.5 text-[13px] text-text-secondary">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-danger"
              />
              <span>I understand this permanently deletes my account and cannot be undone.</span>
            </label>

            {error ? (
              <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
                {error}
              </div>
            ) : null}

            <AppButton type="submit" variant="danger" size="lg" fullWidth loading={submitting}>
              Continue
            </AppButton>
          </form>
        ) : step === 'confirm' ? (
          <div className="space-y-4">
            <AppText as="p" variant="body" tone="secondary">
              You&apos;re signed in as <strong>{email}</strong>. This is your last chance to cancel —
              deleting your account is permanent and cannot be undone.
            </AppText>

            {error ? (
              <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
                {error}
              </div>
            ) : null}

            <AppButton
              type="button"
              variant="danger"
              size="lg"
              fullWidth
              loading={submitting}
              onClick={onConfirmDelete}
            >
              Permanently delete my account
            </AppButton>
            <AppButton
              type="button"
              variant="secondary"
              size="lg"
              fullWidth
              disabled={submitting}
              onClick={onCancel}
            >
              Cancel
            </AppButton>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
              Your account has been permanently deleted. You can close this page.
            </div>
            <AppText as="p" variant="body" tone="secondary">
              You can create a new account at any time from the qlooqo app.
            </AppText>
          </div>
        )}

        {step !== 'deleted' ? (
          <div className="mt-6 border-t border-border pt-4 text-center">
            <Link to="/login" className="text-[13px] font-medium text-primary-deep hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : null}
      </AppCard>
    </main>
  );
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) {
    if (err.status >= 500) return 'Could not reach the server. Please try again in a moment.';
    if (err.message) return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
