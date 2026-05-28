import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { UserProfileResponse } from '@sheer/domain';
import { getMyProfile, updateMyProfile } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

interface ProfileForm {
  firstName: string;
  lastName: string;
  phone: string;
  avatarUrl: string;
  communicationPreference: 'whatsapp' | 'sms' | 'email';
}

export function ProfilePage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [form, setForm] = useState<ProfileForm | null>(null);
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
      setProfile(result);
      setForm({
        firstName: result.identity.firstName,
        lastName: result.identity.lastName,
        phone: result.identity.phone ?? '',
        avatarUrl: result.identity.avatarUrl ?? '',
        communicationPreference: result.clientProfile?.communicationPreference ?? 'email',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load profile');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

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
        communicationPreference: profile?.identity.role === 'client' ? form.communicationPreference : undefined,
      });
      setProfile(result.profile);
      setMessage('Profile saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Profile</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          Manage your shared identity. Business-controlled profile fields are shown read-only.
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {message}
        </div>
      ) : null}

      {loading || !form || !profile ? (
        <div className="rounded-card border border-border bg-surface p-5 text-[13px] text-text-secondary">
          Loading profile...
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <form onSubmit={onSubmit} className="rounded-card border border-border bg-surface p-5 shadow-sm">
            <h2 className="text-[16px] font-semibold text-text-primary">Identity</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="First name" value={form.firstName} onChange={(firstName) => setForm({ ...form, firstName })} />
              <Field label="Last name" value={form.lastName} onChange={(lastName) => setForm({ ...form, lastName })} />
              <Field label="Phone" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} optional />
              <Field label="Avatar URL" value={form.avatarUrl} onChange={(avatarUrl) => setForm({ ...form, avatarUrl })} optional />
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-medium text-text-secondary">Email</label>
                <input
                  value={profile.identity.email}
                  disabled
                  className="mt-1 h-10 w-full rounded-input border border-border bg-surface-alt px-3 text-[14px] text-text-secondary"
                />
              </div>
              {profile.identity.role === 'client' ? (
                <label className="sm:col-span-2 block text-[12px] font-medium text-text-secondary">
                  Preferred communication
                  <select
                    value={form.communicationPreference}
                    onChange={(event) =>
                      setForm({ ...form, communicationPreference: event.target.value as ProfileForm['communicationPreference'] })
                    }
                    className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[14px] text-text-primary"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                </label>
              ) : null}
            </div>
            <button
              type="submit"
              disabled={saving}
              className="mt-5 inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save profile'}
            </button>
          </form>

          <aside className="space-y-5">
            {profile.staffProfile ? <StaffProfileCard profile={profile} /> : null}
            {profile.clientProfile ? <ClientProfileCard profile={profile} /> : null}
            <div className="rounded-card border border-border bg-surface p-5">
              <h2 className="text-[16px] font-semibold text-text-primary">Access</h2>
              <p className="mt-2 text-[13px] text-text-secondary">Role: {profile.identity.role}</p>
              <p className="mt-1 text-[13px] text-text-secondary">
                Locations: {profile.locations.map((location) => location.name).join(', ') || 'Business-wide'}
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label} {optional ? <span className="font-normal text-text-muted">(optional)</span> : null}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[14px] text-text-primary outline-none focus:border-primary"
      />
    </label>
  );
}

function StaffProfileCard({ profile }: { profile: UserProfileResponse }) {
  const staff = profile.staffProfile;
  if (!staff) return null;
  return (
    <div className="rounded-card border border-border bg-surface p-5">
      <h2 className="text-[16px] font-semibold text-text-primary">Staff profile</h2>
      <dl className="mt-3 space-y-2 text-[13px]">
        <Row label="Display name" value={staff.displayName} />
        <Row label="Status" value={staff.employmentStatus.replace(/_/g, ' ')} />
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
    <div className="rounded-card border border-border bg-surface p-5">
      <h2 className="text-[16px] font-semibold text-text-primary">Client profile</h2>
      <dl className="mt-3 space-y-2 text-[13px]">
        <Row label="Client code" value={client.clientCode} />
        <Row label="Visits" value={String(client.visitCount)} />
        <Row label="Last visit" value={client.lastVisitAt ? new Date(client.lastVisitAt).toLocaleDateString() : 'None yet'} />
        <Row label="Notes" value={client.notes ?? 'None'} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-right font-medium text-text-primary">{value}</dd>
    </div>
  );
}
