import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { CrmClientSummary } from '@sheer/domain';
import { ApiRequestError, createCrmClient, listCrmClients } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

export function CrmClientsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [clients, setClients] = useState<CrmClientSummary[]>([]);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    communicationPreference: 'email' as 'email' | 'sms' | 'whatsapp',
  });

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listCrmClients(accessToken, { q: submittedSearch || undefined });
      setClients(result.clients);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load CRM clients');
    } finally {
      setLoading(false);
    }
  }, [accessToken, submittedSearch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visibleClients = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term || term === submittedSearch.trim().toLowerCase()) return clients;
    return clients.filter((client) =>
      [
        client.displayName,
        client.email ?? '',
        client.phone ?? '',
        client.communicationPreference ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }, [clients, search, submittedSearch]);

  if (auth.status === 'authenticated' && auth.user?.role === 'client') {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    setCreating(true);
    setError(null);
    setActionMessage(null);
    try {
      const result = await createCrmClient(accessToken, {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email || undefined,
        phone: form.phone || undefined,
        communicationPreference: form.communicationPreference,
      });
      setClients((current) => [result.client, ...current]);
      setForm({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        communicationPreference: 'email',
      });
      setShowCreate(false);
      setActionMessage(`${result.client.displayName} has been added to CRM.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create CRM client');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">CRM</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Search client records, check alerts, and open visit history.
          </p>
        </div>
        {auth.user?.role !== 'stylist' ? (
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            onClick={() => setShowCreate((current) => !current)}
          >
            {showCreate ? 'Close form' : 'New client'}
          </button>
        ) : null}
      </header>

      {actionMessage ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {actionMessage}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {showCreate ? (
        <form
          onSubmit={handleCreate}
          className="mb-5 grid gap-3 rounded-card-lg border border-border bg-surface p-4 sm:grid-cols-2"
        >
          <TextInput
            label="First name"
            value={form.firstName}
            onChange={(value) => setForm((current) => ({ ...current, firstName: value }))}
            required
          />
          <TextInput
            label="Last name"
            value={form.lastName}
            onChange={(value) => setForm((current) => ({ ...current, lastName: value }))}
            required
          />
          <TextInput
            label="Email"
            type="email"
            value={form.email}
            onChange={(value) => setForm((current) => ({ ...current, email: value }))}
          />
          <TextInput
            label="Phone"
            value={form.phone}
            onChange={(value) => setForm((current) => ({ ...current, phone: value }))}
          />
          <label className="text-[12px] font-medium text-text-secondary">
            Preferred communication
            <select
              value={form.communicationPreference}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  communicationPreference: event.target.value as 'email' | 'sms' | 'whatsapp',
                }))
              }
              className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <div className="flex items-end justify-end">
            <button
              type="submit"
              disabled={creating}
              className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
            >
              {creating ? 'Saving…' : 'Save client'}
            </button>
          </div>
        </form>
      ) : null}

      <form
        className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedSearch(search.trim());
        }}
      >
        <input
          type="search"
          placeholder="Search by name, phone, or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-96"
        />
        <button
          type="submit"
          className="h-10 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
        >
          Search
        </button>
      </form>

      <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
        {loading ? (
          <EmptyState title="Loading clients…" body="Fetching CRM records." />
        ) : visibleClients.length === 0 ? (
          <EmptyState
            title={clients.length === 0 ? 'No CRM clients yet' : 'No clients match this search'}
            body={
              clients.length === 0
                ? 'Client records will appear after bookings or manual staff-side creation.'
                : 'Try searching by a different name, phone, or email.'
            }
          />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Last visit</th>
                <th className="px-4 py-3">Alerts</th>
                <th className="px-4 py-3 text-right">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleClients.map((client) => (
                <ClientRow key={client.id} client={client} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function ClientRow({ client }: { client: CrmClientSummary }) {
  const { activeAllergies, expiredPatchTests } = client.alertCounts;
  const alertCount = activeAllergies + expiredPatchTests;
  return (
    <tr>
      <td className="px-4 py-3">
        <Link to={`/crm/clients/${client.id}`} className="font-medium text-text-primary hover:text-primary">
          {client.displayName}
        </Link>
        <div className="mt-0.5 text-[12px] text-text-secondary">
          {client.communicationPreference ? `Prefers ${client.communicationPreference}` : 'No preference'}
        </div>
      </td>
      <td className="px-4 py-3 text-text-secondary">
        <div>{client.email ?? 'No email'}</div>
        <div className="text-[12px]">{client.phone ?? 'No phone'}</div>
      </td>
      <td className="px-4 py-3 text-text-secondary">{formatDate(client.lastVisitAt)}</td>
      <td className="px-4 py-3">
        {alertCount > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {activeAllergies > 0 ? (
              <AlertBadge count={activeAllergies} singular="active allergy" />
            ) : null}
            {expiredPatchTests > 0 ? (
              <AlertBadge count={expiredPatchTests} singular="expired patch test" />
            ) : null}
          </div>
        ) : (
          <span className="text-[12px] text-text-muted">No active alerts</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to={`/crm/clients/${client.id}`}
          className="text-[13px] font-medium text-primary hover:text-primary-deep"
        >
          View
        </Link>
      </td>
    </tr>
  );
}

function AlertBadge({ count, singular }: { count: number; singular: string }) {
  return (
    <span className="inline-flex rounded-pill border border-danger-border bg-danger-soft px-2.5 py-1 text-[12px] font-medium text-danger">
      {count} {singular}
      {count === 1 ? '' : 's'}
    </span>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="text-[12px] font-medium text-text-secondary">
      {label}
      <input
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <div className="mt-1 text-[13px] text-text-secondary">{body}</div>
    </div>
  );
}

function formatDate(value?: string): string {
  if (!value) return 'No visits';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}
