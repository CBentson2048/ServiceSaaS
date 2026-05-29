import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { UserProfileResponse } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { getMyProfile, updateMyProfile } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

interface ProfileForm {
  firstName: string;
  lastName: string;
  phone: string;
  avatarUrl: string;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  stylist: 'Stylist',
  client: 'Client',
};

export function ProfilePage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [initialForm, setInitialForm] = useState<ProfileForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getMyProfile(accessToken);
      const next: ProfileForm = {
        firstName: result.identity.firstName,
        lastName: result.identity.lastName,
        phone: result.identity.phone ?? '',
        avatarUrl: result.identity.avatarUrl ?? '',
        communicationPreference: result.clientProfile?.communicationPreference ?? 'email',
      };
      setProfile(result);
      setForm(next);
      setInitialForm(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load profile');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const isDirty = useMemo(() => {
    if (!form || !initialForm) return false;
    return (
      form.firstName !== initialForm.firstName ||
      form.lastName !== initialForm.lastName ||
      form.phone !== initialForm.phone ||
      form.avatarUrl !== initialForm.avatarUrl ||
      form.communicationPreference !== initialForm.communicationPreference
    );
  }, [form, initialForm]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !form) return;
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError('First name and last name are required.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const result = await updateMyProfile(accessToken, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        phone: form.phone.trim() || null,
        avatarUrl: form.avatarUrl.trim() || null,
        communicationPreference:
          profile?.identity.role === 'client' ? form.communicationPreference : undefined,
      });
      const next: ProfileForm = {
        firstName: result.profile.identity.firstName,
        lastName: result.profile.identity.lastName,
        phone: result.profile.identity.phone ?? '',
        avatarUrl: result.profile.identity.avatarUrl ?? '',
        communicationPreference: result.profile.clientProfile?.communicationPreference ?? 'email',
      };
      setProfile(result.profile);
      setForm(next);
      setInitialForm(next);
      setMessage('Your profile has been updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setSaving(false);
    }
  }

  function onDiscard() {
    if (initialForm) setForm(initialForm);
    setError(null);
    setMessage(null);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 lg:px-8">
      <header className="mb-6">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-text-muted">
          Account
        </p>
        <h1 className="mt-1 text-[26px] font-semibold leading-8 text-text-primary">My profile</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-text-secondary">
          Manage your shared identity across Sheer. Fields controlled by your business are shown as
          read-only.
        </p>
      </header>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {message ? <Banner tone="success">{message}</Banner> : null}

      {loading || !form || !profile ? (
        <LoadingState />
      ) : (
        <>
          <ProfileHero
            firstName={form.firstName}
            lastName={form.lastName}
            email={profile.identity.email}
            avatarUrl={form.avatarUrl}
            role={profile.identity.role}
          />

          <form onSubmit={onSubmit} className="mt-6 grid items-start gap-6 lg:grid-cols-[1.35fr_0.65fr]">
            <div className="space-y-6">
              <Section
                title="Personal information"
                description="This information may be visible to your team and clients."
              >
                <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                  <Field
                    label="First name"
                    value={form.firstName}
                    onChange={(firstName) => setForm({ ...form, firstName })}
                    placeholder="Jane"
                    required
                  />
                  <Field
                    label="Last name"
                    value={form.lastName}
                    onChange={(lastName) => setForm({ ...form, lastName })}
                    placeholder="Doe"
                    required
                  />
                  <Field
                    label="Phone"
                    value={form.phone}
                    onChange={(phone) => setForm({ ...form, phone })}
                    placeholder="+44 7700 900000"
                    type="tel"
                    optional
                  />
                  <Field
                    label="Avatar URL"
                    value={form.avatarUrl}
                    onChange={(avatarUrl) => setForm({ ...form, avatarUrl })}
                    placeholder="https://…"
                    type="url"
                    optional
                    hint="Link to a square image for best results."
                  />
                  <Field
                    label="Email"
                    value={profile.identity.email}
                    readOnly
                    hint="Contact your administrator to change your email."
                    className="sm:col-span-2"
                  />
                </div>
              </Section>

              {profile.identity.role === 'client' ? (
                <Section
                  title="Communication preferences"
                  description="How would you like us to reach you about appointments?"
                >
                  <ChannelPicker
                    value={form.communicationPreference}
                    onChange={(communicationPreference) =>
                      setForm({ ...form, communicationPreference })
                    }
                  />
                </Section>
              ) : null}
            </div>

            <aside className="space-y-6">
              <AccessCard profile={profile} />
              {profile.staffProfile ? <StaffProfileCard profile={profile} /> : null}
              {profile.clientProfile ? <ClientProfileCard profile={profile} /> : null}
            </aside>

            {/* Sticky action bar keeps Save/Discard reachable on long forms. */}
            <div className="sticky bottom-0 z-10 -mx-4 mt-2 flex items-center justify-between gap-3 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur lg:col-span-2 lg:mx-0 lg:rounded-card lg:border lg:px-5 lg:shadow-card">
              <p className="text-[12px] text-text-muted">
                {isDirty ? 'You have unsaved changes.' : 'All changes saved.'}
              </p>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={onDiscard}
                  disabled={!isDirty || saving}
                  className="inline-flex h-10 items-center justify-center rounded-pill border border-border-strong px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  type="submit"
                  disabled={saving || !isDirty}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-pill bg-primary px-6 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {saving ? (
                    <>
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
                      Saving…
                    </>
                  ) : (
                    'Save changes'
                  )}
                </button>
              </div>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function ProfileHero({
  firstName,
  lastName,
  email,
  avatarUrl,
  role,
}: {
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl: string;
  role: string;
}) {
  const fullName = `${firstName} ${lastName}`.trim() || 'Your name';
  const initials =
    `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || 'SH';
  return (
    <div className="flex flex-col gap-4 rounded-card-lg border border-border bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:gap-5">
      <Avatar avatarUrl={avatarUrl} initials={initials} name={fullName} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-[19px] font-semibold text-text-primary">{fullName}</h2>
          <RoleBadge role={role} />
        </div>
        <p className="mt-0.5 truncate text-[13px] text-text-secondary">{email}</p>
      </div>
    </div>
  );
}

function Avatar({
  avatarUrl,
  initials,
  name,
}: {
  avatarUrl: string;
  initials: string;
  name: string;
}) {
  const [broken, setBroken] = useState(false);
  const showImage = avatarUrl.trim().length > 0 && !broken;
  return (
    <div className="relative h-16 w-16 shrink-0">
      {showImage ? (
        <img
          src={avatarUrl}
          alt={name}
          onError={() => setBroken(true)}
          className="h-16 w-16 rounded-full border border-border object-cover"
        />
      ) : (
        <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-primary bg-primary-soft text-[20px] font-semibold text-primary-deep">
          {initials}
        </span>
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center rounded-pill bg-primary-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-primary-deep">
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="mb-4">
        <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-[12px] leading-4 text-text-secondary">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  optional,
  required,
  readOnly,
  hint,
  placeholder,
  type = 'text',
  className,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  optional?: boolean;
  required?: boolean;
  readOnly?: boolean;
  hint?: string;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="flex items-center gap-1 text-[12px] font-medium text-text-secondary">
        {label}
        {required ? <span className="text-danger">*</span> : null}
        {optional ? <span className="font-normal text-text-muted">(optional)</span> : null}
      </label>
      <input
        value={value}
        type={type}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className={cn(
          'mt-1.5 h-10 w-full rounded-input border px-3 text-[14px] outline-none transition-colors',
          readOnly
            ? 'cursor-not-allowed border-border bg-surface-alt text-text-secondary'
            : 'border-border bg-surface text-text-primary placeholder:text-text-subtle hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/20',
        )}
      />
      {hint ? <p className="mt-1 text-[11px] leading-4 text-text-muted">{hint}</p> : null}
    </div>
  );
}

const CHANNELS: { value: ProfileForm['communicationPreference']; label: string; hint: string }[] = [
  { value: 'email', label: 'Email', hint: 'Receipts & confirmations' },
  { value: 'sms', label: 'SMS', hint: 'Text reminders' },
  { value: 'whatsapp', label: 'WhatsApp', hint: 'Chat updates' },
];

function ChannelPicker({
  value,
  onChange,
}: {
  value: ProfileForm['communicationPreference'];
  onChange: (value: ProfileForm['communicationPreference']) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {CHANNELS.map((channel) => {
        const active = channel.value === value;
        return (
          <button
            key={channel.value}
            type="button"
            onClick={() => onChange(channel.value)}
            aria-pressed={active}
            className={cn(
              'flex flex-col items-start rounded-input-lg border p-3 text-left transition-colors',
              active
                ? 'border-primary bg-primary-soft ring-1 ring-primary'
                : 'border-border bg-surface hover:border-border-strong hover:bg-surface-alt',
            )}
          >
            <span
              className={cn(
                'text-[13px] font-semibold',
                active ? 'text-primary-deep' : 'text-text-primary',
              )}
            >
              {channel.label}
            </span>
            <span className="mt-0.5 text-[11px] text-text-secondary">{channel.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function AccessCard({ profile }: { profile: UserProfileResponse }) {
  const locations = profile.locations.map((location) => location.name);
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="text-[15px] font-semibold text-text-primary">Access</h3>
      <dl className="mt-3 space-y-3 text-[13px]">
        <Row label="Role" value={ROLE_LABELS[profile.identity.role] ?? profile.identity.role} />
        <div>
          <dt className="text-text-secondary">Locations</dt>
          <dd className="mt-1.5 flex flex-wrap gap-1.5">
            {locations.length > 0 ? (
              locations.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded-pill bg-surface-alt px-2.5 py-0.5 text-[11px] font-medium text-text-primary"
                >
                  {name}
                </span>
              ))
            ) : (
              <span className="text-[12px] text-text-muted">Business-wide</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function StaffProfileCard({ profile }: { profile: UserProfileResponse }) {
  const staff = profile.staffProfile;
  if (!staff) return null;
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="text-[15px] font-semibold text-text-primary">Staff profile</h3>
      <dl className="mt-3 space-y-3 text-[13px]">
        <Row label="Display name" value={staff.displayName} />
        <Row label="Status" value={staff.employmentStatus.replace(/_/g, ' ')} capitalize />
        <Row label="Contracted hours" value={`${staff.contractedHours}h`} />
        <Row label="Average bill benchmark" value={`£${staff.averageBillBenchmark.toFixed(2)}`} />
        <Row label="Lab PIN" value={staff.sheerLabPinEnabled ? 'Enabled' : 'Not enabled'} />
        <Row label="Pending leave" value={String(staff.pendingLeaveRequests)} />
      </dl>
    </div>
  );
}

function ClientProfileCard({ profile }: { profile: UserProfileResponse }) {
  const client = profile.clientProfile;
  if (!client) return null;
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h3 className="text-[15px] font-semibold text-text-primary">Client profile</h3>
      <dl className="mt-3 space-y-3 text-[13px]">
        <Row label="Client code" value={client.clientCode} />
        <Row label="Visits" value={String(client.visitCount)} />
        <Row
          label="Last visit"
          value={client.lastVisitAt ? new Date(client.lastVisitAt).toLocaleDateString() : 'None yet'}
        />
        <Row label="Notes" value={client.notes ?? 'None'} />
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  capitalize,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-text-secondary">{label}</dt>
      <dd className={cn('text-right font-medium text-text-primary', capitalize && 'capitalize')}>
        {value}
      </dd>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'danger' | 'success'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'mb-4 flex items-start gap-2 rounded-input-lg border px-4 py-3 text-[13px]',
        tone === 'danger'
          ? 'border-danger-border bg-danger-soft text-danger'
          : 'border-success-border bg-success-soft text-success',
      )}
    >
      <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
        {tone === 'danger' ? (
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM9 6a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0V6Zm1 7a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"
            clipRule="evenodd"
          />
        ) : (
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.58 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z"
            clipRule="evenodd"
          />
        )}
      </svg>
      <span>{children}</span>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="h-[88px] animate-pulse rounded-card-lg border border-border bg-surface-alt" />
      <div className="grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
        <div className="h-72 animate-pulse rounded-card border border-border bg-surface-alt" />
        <div className="h-56 animate-pulse rounded-card border border-border bg-surface-alt" />
      </div>
    </div>
  );
}
