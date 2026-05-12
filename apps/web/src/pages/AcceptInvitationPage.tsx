import type { FormEvent} from 'react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { InvitationLookupResponse } from '@sheer/domain';
import {
  ApiRequestError,
  acceptStaffInvitation,
  inspectStaffInvitation,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { TextField } from '../components/onboarding/FormField';

const PASSWORD_MIN = 8;

export function AcceptInvitationPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [invitation, setInvitation] = useState<InvitationLookupResponse | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setLookupError('Missing invitation token');
      setLoading(false);
      return;
    }
    let cancelled = false;
    inspectStaffInvitation(token)
      .then((result) => {
        if (cancelled) return;
        setInvitation(result);
        setFirstName(result.firstName ?? '');
        setLastName(result.lastName ?? '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setLookupError(err.message);
        else if (err instanceof Error) setLookupError(err.message);
        else setLookupError('Could not load invitation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (auth.user) {
    return <Navigate to="/" replace />;
  }

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!firstName.trim()) next.firstName = 'First name is required';
    if (!lastName.trim()) next.lastName = 'Last name is required';
    if (password.length < PASSWORD_MIN) next.password = `At least ${PASSWORD_MIN} characters`;
    if (password !== confirmPassword) next.confirmPassword = 'Passwords do not match';
    return next;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invitation) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const response = await acceptStaffInvitation({
        token,
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
        displayName: displayName.trim() || undefined,
      });

      // Role-aware post-success routing — the API tells us where to go.
      //
      // Stylist / client (`targetSurface: 'mobile'`) must NEVER be
      // auto-logged into the web dashboard. Even if a session ever
      // sneaks back from the server (defence in depth), we drop it on
      // the floor and route to the public completion page.
      if (response.nextAction === 'show_completion_page') {
        navigate(response.redirectTo || `/auth/account-created?role=${response.role}`, {
          replace: true,
          state: { role: response.role },
        });
        return;
      }

      if (response.session && response.user) {
        auth.applyAuthenticatedSession(response.session, response.user);
        navigate(response.redirectTo === '/' ? '/dashboard' : response.redirectTo, { replace: true });
        return;
      }
      navigate(response.redirectTo || '/login?invitation=accepted', { replace: true });
    } catch (error: unknown) {
      if (error instanceof ApiRequestError) setSubmitError(error.message);
      else if (error instanceof Error) setSubmitError(error.message);
      else setSubmitError('Could not accept invitation');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-bg px-4 py-8 text-text-primary sm:py-12">
      <section className="mx-auto w-full max-w-xl overflow-hidden rounded-card-lg border border-border-strong bg-surface shadow-hero">
        <header className="border-b border-border bg-surface-alt px-6 py-5 sm:px-8">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold tracking-[0.38em] text-text-secondary">
              SH<span className="text-primary">EE</span>R
            </span>
            <Link to="/login" className="text-[12px] font-medium text-primary-deep hover:underline">
              Already accepted? Sign in
            </Link>
          </div>
          <h1 className="text-[20px] font-semibold leading-7 text-text-primary">
            Accept your invitation
          </h1>
          {invitation ? (
            <p className="mt-1 text-[13px] text-text-secondary">
              Joining <strong className="text-text-primary">{invitation.businessName}</strong> as{' '}
              <strong className="text-text-primary capitalize">{invitation.role}</strong> at{' '}
              <strong className="text-text-primary">{invitation.locationName}</strong>.
            </p>
          ) : (
            <p className="mt-1 text-[13px] text-text-secondary">
              Set up your password to join your team{"'"}s workspace.
            </p>
          )}
        </header>

        <div className="px-6 py-6 sm:px-8">
          {loading ? (
            <div className="text-[13px] text-text-secondary">Loading invitation…</div>
          ) : lookupError ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {lookupError}
            </div>
          ) : invitation && invitation.status !== 'pending' ? (
            <div className="rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3 text-[13px] text-warning">
              This invitation is {invitation.status}. Ask the business owner for a new one.
            </div>
          ) : invitation ? (
            <form onSubmit={onSubmit} className="space-y-4">
              <TextField label="Email" value={invitation.email} disabled />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="First name"
                  value={firstName}
                  onValueChange={setFirstName}
                  error={errors.firstName}
                  required
                />
                <TextField
                  label="Last name"
                  value={lastName}
                  onValueChange={setLastName}
                  error={errors.lastName}
                  required
                />
                <TextField
                  label="Phone"
                  type="tel"
                  value={phone}
                  onValueChange={setPhone}
                  optional
                  className="sm:col-span-2"
                />
                {invitation.role === 'stylist' ? (
                  <TextField
                    label="Display name"
                    value={displayName}
                    onValueChange={setDisplayName}
                    hint="Shown to clients on the booking calendar"
                    optional
                    className="sm:col-span-2"
                  />
                ) : null}
                <TextField
                  label="Password"
                  type="password"
                  value={password}
                  onValueChange={setPassword}
                  error={errors.password}
                  hint={`At least ${PASSWORD_MIN} characters`}
                  autoComplete="new-password"
                  required
                />
                <TextField
                  label="Confirm password"
                  type="password"
                  value={confirmPassword}
                  onValueChange={setConfirmPassword}
                  error={errors.confirmPassword}
                  autoComplete="new-password"
                  required
                />
              </div>

              {submitError ? (
                <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
                  {submitError}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex h-10 w-full items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? 'Joining…' : 'Accept invitation'}
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  );
}
