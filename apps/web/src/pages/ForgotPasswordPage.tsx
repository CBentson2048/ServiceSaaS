import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, requestPasswordReset } from '../auth/api';
import { TextField } from '../components/onboarding/FormField';
import { AppButton, AppCard, AppText } from '../design';

/**
 * Public route for the "I forgot my password" flow.
 *
 * Always shows a neutral success message, regardless of whether the
 * email matches a real account. The API is also designed to never leak
 * existence of an account (it always returns `{ accepted: true }`); this
 * UI mirrors that contract — never branch on a 404 here.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address');
      return;
    }

    setSubmitting(true);
    try {
      await requestPasswordReset(trimmed);
      setSubmitted(true);
    } catch (err) {
      // Network / server error — only here do we show a generic failure.
      // We deliberately do NOT differentiate "user not found" because the
      // API does not return that signal.
      if (err instanceof ApiRequestError && err.status >= 500) {
        setError('Could not reach the server. Please try again in a moment.');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Could not request a password reset. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4 py-10 text-text-primary">
      <AppCard elevation="hero" padding="lg" className="w-full max-w-md">
        <header className="mb-5 text-center">
          <div className="mb-4 text-xs font-semibold tracking-[0.38em] text-text-secondary">
            SH<span className="text-primary">EE</span>R
          </div>
          <AppText as="h1" variant="heading" weight="medium">
            Reset your password
          </AppText>
          <AppText as="p" variant="body" tone="secondary" className="mt-1">
            Enter the email associated with your Sheer account. We&apos;ll send a link to set
            a new password.
          </AppText>
        </header>

        {submitted ? (
          <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
            If an account exists for <strong>{email}</strong>, we&apos;ve sent password reset
            instructions. Check your inbox (and spam folder).
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onValueChange={setEmail}
              required
            />

            {error ? (
              <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
                {error}
              </div>
            ) : null}

            <AppButton type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
              Send reset link
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
