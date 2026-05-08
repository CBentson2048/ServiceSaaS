import { useState, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiRequestError, createClientBookingAccount, loginClientBookingAccount } from '../auth/api';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import { readClientBookingSelection, updateClientBookingSelection } from './clientBookingFlow';

type AuthMode = 'create' | 'sign_in';
type CommunicationPreference = 'whatsapp' | 'sms' | 'email';

export function ClientBookingAccountPage() {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  const [mode, setMode] = useState<AuthMode>('create');
  const [firstName, setFirstName] = useState(selection?.client?.firstName ?? '');
  const [lastName, setLastName] = useState(selection?.client?.lastName ?? '');
  const [email, setEmail] = useState(selection?.client?.email ?? '');
  const [phone, setPhone] = useState(selection?.client?.phone ?? '');
  const [password, setPassword] = useState('');
  const [preference, setPreference] = useState<CommunicationPreference>(
    selection?.communicationPreference ?? 'email',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!selection?.selectedSlot) return <Navigate to="/book/date-time" replace />;

  async function continueNext() {
    if (!selection) return;
    if (mode === 'create' && (!firstName.trim() || !lastName.trim())) {
      setError('First and last name are required.');
      return;
    }
    if (!email.trim()) {
      setError('Email is required for account access.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (!preference) {
      setError('Choose a communication preference.');
      return;
    }

    setSubmitting(true);
    setError(null);
    const registrationPayload = {
      locationId: selection.locationId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone.trim() || undefined,
      password,
      communicationPreference: preference,
    };
    const signInPayload = {
      locationId: selection.locationId,
      email: email.trim(),
      phone: phone.trim() || undefined,
      password,
      communicationPreference: preference,
    };

    try {
      const result =
        mode === 'create'
          ? await createClientBookingAccount(registrationPayload)
          : await loginClientBookingAccount(signInPayload);
      if (!result.user.clientProfileId) {
        throw new Error('Client profile could not be linked to this booking.');
      }
      const profileName = splitFullName(result.user.profile.fullName);
      const clientFirstName =
        mode === 'create' ? registrationPayload.firstName : profileName.firstName;
      const clientLastName =
        mode === 'create' ? registrationPayload.lastName : profileName.lastName;
      const clientPhone =
        mode === 'create' ? registrationPayload.phone : phone.trim() || result.user.profile.phone;
      updateClientBookingSelection({
        client: {
          firstName: clientFirstName,
          lastName: clientLastName,
          email: result.user.profile.email,
          phone: clientPhone,
        },
        communicationPreference: preference,
        account: {
          accessToken: result.session.accessToken,
          refreshToken: result.session.refreshToken,
          userProfileId: result.user.id,
          clientProfileId: result.user.clientProfileId,
          email: result.user.profile.email,
        },
      });
      navigate('/book/review');
    } catch (err) {
      setError(toErrorMessage(err, mode));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ClientBookingShell
      title="Your account"
      step="Step 4 of 5"
      footer={
        <AppButton
          size="lg"
          fullWidth
          loading={submitting}
          onClick={() => void continueNext()}
          className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
        >
          Continue to review
        </AppButton>
      }
    >
      <h1 className="text-[18px] font-semibold leading-6">
        {mode === 'create' ? 'Create your account' : 'Sign in to your account'}
      </h1>
      <p className="mt-1 text-[12px] text-text-secondary">
        {mode === 'create'
          ? 'Create an account to keep this booking linked to you. No app install is required.'
          : 'Use your existing client account. No app install is required.'}
      </p>

      {error ? (
        <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <ModeButton active={mode === 'create'} onClick={() => setMode('create')}>
          Create account
        </ModeButton>
        <ModeButton active={mode === 'sign_in'} onClick={() => setMode('sign_in')}>
          Sign in
        </ModeButton>
      </div>

      <div className="mt-5 space-y-3">
        {mode === 'create' ? (
          <>
            <Input label="First name" value={firstName} onChange={setFirstName} />
            <Input label="Last name" value={lastName} onChange={setLastName} />
          </>
        ) : null}
        <Input label="Email" value={email} onChange={setEmail} type="email" />
        <Input
          label={mode === 'create' ? 'Phone' : 'Phone (optional)'}
          value={phone}
          onChange={setPhone}
          type="tel"
        />
        <Input
          label={mode === 'create' ? 'Create password' : 'Password'}
          value={password}
          onChange={setPassword}
          type="password"
        />
      </div>

      <div className="mt-6">
        <div className="text-[13px] font-semibold">Communication preference</div>
        <div className="mt-2 space-y-2">
          {(['whatsapp', 'sms', 'email'] as CommunicationPreference[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreference(option)}
              className="block w-full text-left"
            >
              <AppCard
                elevation="none"
                className={preference === option ? 'border-[1.5px] border-primary bg-primary/5' : 'border-border'}
              >
                <div className="text-[14px] font-semibold">{formatPreference(option)}</div>
              </AppCard>
            </button>
          ))}
        </div>
      </div>
    </ClientBookingShell>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-input-lg border px-3 py-2 text-[13px] font-semibold ${
        active ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-surface text-text-secondary'
      }`}
    >
      {children}
    </button>
  );
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-11 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
      />
    </label>
  );
}

function formatPreference(value: CommunicationPreference): string {
  if (value === 'whatsapp') return 'WhatsApp';
  if (value === 'sms') return 'SMS';
  return 'Email';
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Client', lastName: 'Client' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Client' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function toErrorMessage(err: unknown, mode: AuthMode): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return mode === 'create' ? 'Could not create account' : 'Could not sign in';
}
