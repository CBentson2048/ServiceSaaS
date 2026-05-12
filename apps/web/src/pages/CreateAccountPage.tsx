import type { FormEvent} from 'react';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { LoginResponse } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { createClientBookingAccount } from '../auth/api';
import {
  readClientBookingSelection,
  updateClientBookingSelection,
} from './clientBookingFlow';

type CommunicationPreference = 'whatsapp' | 'sms' | 'email';

export function CreateAccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const bookingMode = searchParams.get('booking') === '1';
  const bookingSelection = bookingMode ? readClientBookingSelection() : null;
  const [fullName, setFullName] = useState('');
  const [firstName, setFirstName] = useState(bookingSelection?.client?.firstName ?? '');
  const [lastName, setLastName] = useState(bookingSelection?.client?.lastName ?? '');
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState(bookingSelection?.client?.phone ?? '');
  const [password, setPassword] = useState('');
  const [communicationPreference, setCommunicationPreference] =
    useState<CommunicationPreference>(bookingSelection?.communicationPreference ?? 'email');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (bookingMode && !bookingSelection?.selectedSlot) {
    return <Navigate to="/book/account" replace />;
  }

  if (auth.user) {
    if (bookingMode && auth.session && auth.user.clientProfileId) {
      const name = splitFullName(auth.user.profile.fullName);
      completeBookingAuth(
        { session: auth.session, user: auth.user },
        {
          firstName: name.firstName,
          lastName: name.lastName,
          phone: auth.user.profile.phone,
        },
      );
    }
    return <Navigate to={bookingMode ? '/book/review' : '/'} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      if (bookingMode && bookingSelection) {
        const trimmedFirstName = firstName.trim();
        const trimmedLastName = lastName.trim();
        const response = await createClientBookingAccount({
          locationId: bookingSelection.locationId,
          firstName: trimmedFirstName,
          lastName: trimmedLastName,
          email,
          phone: phone.trim() || undefined,
          password,
          communicationPreference,
        });
        completeBookingAuth(response, {
          firstName: trimmedFirstName,
          lastName: trimmedLastName,
          phone: phone.trim() || undefined,
          communicationPreference,
        });
        auth.applyAuthenticatedSession(response.session, response.user);
        navigate('/book/review', { replace: true });
      } else {
        await auth.createAccount({ email, password, fullName, businessName });
        navigate('/', { replace: true });
      }
    } catch {
      setError(
        bookingMode
          ? 'Account creation failed. Check the details or sign in if this email already exists.'
          : 'Account creation failed. Check the details or use a different email.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#F7F2EA] px-4 py-8 text-text-primary">
      <section className="w-full max-w-md overflow-hidden rounded-[28px] border border-[#E7DCCF] bg-white shadow-[0_24px_80px_rgba(38,28,52,0.12)]">
        <div className="border-b border-[#EFE6DC] bg-[#FBF7F1] px-8 py-7 text-center">
          <div className="mb-6 text-sm font-semibold tracking-[0.38em] text-[#2F2540]">
            SH<span className="text-primary">EE</span>R
          </div>
          <h1 className="text-2xl font-semibold text-[#241E30]">Create your account</h1>
          <p className="mt-1 text-sm text-[#776A82]">
            {bookingMode
              ? 'Create an account to continue your booking.'
              : 'Start as the owner of a new Sheer business workspace.'}
          </p>
        </div>

        <form className="space-y-4 px-8 py-7" onSubmit={onSubmit}>
          {bookingMode ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
              <Field label="Last name" value={lastName} onChange={setLastName} autoComplete="family-name" />
            </div>
          ) : (
            <Field label="Full name" value={fullName} onChange={setFullName} autoComplete="name" />
          )}
          {bookingMode ? null : (
            <Field label="Business name" value={businessName} onChange={setBusinessName} />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
          {bookingMode ? (
            <Field
              label="Phone"
              type="tel"
              value={phone}
              onChange={setPhone}
              autoComplete="tel"
              required={false}
            />
          ) : null}
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />
          {bookingMode ? (
            <CommunicationPreferencePicker
              value={communicationPreference}
              onChange={setCommunicationPreference}
            />
          ) : null}

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
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </button>

          <p className="text-center text-sm text-[#776A82]">
            Already have an account?{' '}
            <Link className="font-semibold text-primary-deep" to={bookingMode ? '/login?booking=1' : '/login'}>
              Sign in
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
        {label}
      </span>
      <input
        className="mt-2 w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </label>
  );
}

function completeBookingAuth(
  response: LoginResponse,
  client: {
    firstName: string;
    lastName: string;
    phone?: string;
    communicationPreference?: CommunicationPreference;
  },
): void {
  if (!response.user.clientProfileId) {
    throw new Error('Client profile could not be linked to this booking.');
  }
  updateClientBookingSelection({
    client: {
      firstName: client.firstName,
      lastName: client.lastName,
      email: response.user.profile.email,
      phone: client.phone,
    },
    communicationPreference: client.communicationPreference ?? response.user.clientCommunicationPreference,
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

function CommunicationPreferencePicker({
  value,
  onChange,
}: {
  value: CommunicationPreference;
  onChange: (value: CommunicationPreference) => void;
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
        Communication preference
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {(['whatsapp', 'sms', 'email'] as CommunicationPreference[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-input-lg border px-4 py-3 text-left text-sm font-semibold transition ${
              value === option
                ? 'border-primary bg-primary/5 text-primary-deep'
                : 'border-[#E5D9CC] bg-[#FFFCF8] text-[#241E30]'
            }`}
          >
            {formatPreference(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function formatPreference(value: CommunicationPreference): string {
  if (value === 'whatsapp') return 'WhatsApp';
  if (value === 'sms') return 'SMS';
  return 'Email';
}
