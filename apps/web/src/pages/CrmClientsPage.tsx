import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { CrmClientSummary, CrmClientsPagination } from '@sheer/domain';
import { userHasAnyRole } from '@sheer/domain';
import { ApiRequestError, createCrmClient, listCrmClients } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

const PAGE_SIZE_OPTIONS = [5, 10, 15, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 20;

export function CrmClientsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [clients, setClients] = useState<CrmClientSummary[]>([]);
  const [pagination, setPagination] = useState<CrmClientsPagination | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState('');
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

  const reload = useCallback(
    async (term: string, pageArg: number) => {
      if (!accessToken) return;
      setLoading(true);
      setError(null);
      try {
        const result = await listCrmClients(accessToken, {
          q: term || undefined,
          page: pageArg,
          pageSize,
        });
        setClients(result.clients);
        setPagination(result.pagination ?? null);
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load clients');
      } finally {
        setLoading(false);
      }
    },
    [accessToken, pageSize],
  );

  // Query the backend as the user types (debounced + trimmed) so any client is
  // found — not just the recently-updated page held in memory. Trimming keeps
  // "Luke" and "Luke " equivalent so a trailing space never changes results.
  // Paging is server-side, so page changes refetch through the same effect.
  useEffect(() => {
    if (!accessToken) return;
    const term = search.trim();
    const handle = setTimeout(() => {
      void reload(term, page);
    }, 250);
    return () => clearTimeout(handle);
  }, [accessToken, search, page, reload]);

  // Safety net: if the dataset shrank (e.g. a client was removed elsewhere) and
  // the current page no longer exists, snap back to the last valid page.
  useEffect(() => {
    if (pagination && page > pagination.pageCount) setPage(pagination.pageCount);
  }, [pagination, page]);

  // CRM is staff-only: block users who hold NO staff role. A user who is also a
  // client (e.g. an owner who has booked themselves) keeps access — mirrors the
  // backend's CrmService.assertStaffRole. Gating on `userHasRole('client')` here
  // wrongly bounced multi-role staff to /unauthorized.
  if (
    auth.status === 'authenticated' &&
    !userHasAnyRole(auth.user, ['owner', 'manager', 'stylist'])
  ) {
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
      setForm({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        communicationPreference: 'email',
      });
      setShowCreate(false);
      setActionMessage(`${result.client.displayName} has been added to Client Hub.`);
      // A new client sorts to the top (most-recently-updated). Jump to page 1 so
      // it's visible and the total/pagination stays accurate. If already on page
      // 1 the page state won't change, so refresh explicitly.
      if (page === 1) void reload(search.trim(), 1);
      else setPage(1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create client');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Client Hub</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Search client records, check alerts, and open visit history.
          </p>
        </div>
        {userHasAnyRole(auth.user, ['owner', 'manager']) ? (
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
          // A new search starts at page 1; the debounced effect does the fetch.
          setPage(1);
        }}
      >
        <input
          type="search"
          placeholder="Search by name, phone, email, or Q code"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
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
          <EmptyState title="Loading clients…" body="Fetching client records." />
        ) : clients.length === 0 ? (
          <EmptyState
            title={search.trim() ? 'No clients match this search' : 'No clients yet'}
            body={
              search.trim()
                ? 'Try searching by a different name, phone, or email.'
                : 'Client records will appear after bookings or manual staff-side creation.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
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
                {clients.map((client) => (
                  <ClientRow key={client.id} client={client} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pagination && pagination.total > 0 ? (
          <Pagination
            pagination={pagination}
            pageSize={pageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            disabled={loading}
            onChange={(next) => setPage(next)}
            onPageSizeChange={(next) => {
              // New page size invalidates the current offset — restart at page 1.
              setPageSize(next);
              setPage(1);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

// Server-side pager: shows the visible range + total and a windowed set of page
// buttons with ellipses, so the control stays compact for large client lists.
function Pagination({
  pagination,
  pageSize,
  pageSizeOptions,
  disabled,
  onChange,
  onPageSizeChange,
}: {
  pagination: CrmClientsPagination;
  pageSize: number;
  pageSizeOptions: readonly number[];
  disabled: boolean;
  onChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { page, total, pageCount } = pagination;
  // Use the server-echoed page size for the visible range so it always matches
  // the rows actually rendered, even for the brief moment after the size changes.
  const effectivePageSize = pagination.pageSize;
  const firstRow = (page - 1) * effectivePageSize + 1;
  const lastRow = Math.min(page * effectivePageSize, total);
  const pages = pageWindow(page, pageCount);

  return (
    <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[12px] text-text-secondary">
          <span>Rows per page</span>
          <select
            value={pageSize}
            disabled={disabled}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Rows per page"
            className="h-8 rounded-input-lg border border-border-strong bg-surface px-2 text-[13px] font-medium text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[12px] text-text-secondary">
          Showing <span className="font-medium text-text-primary">{firstRow}</span>–
          <span className="font-medium text-text-primary">{lastRow}</span> of{' '}
          <span className="font-medium text-text-primary">{total}</span>
        </p>
      </div>
      <nav className="flex items-center gap-1" aria-label="Pagination">
        <PageButton
          label="Previous"
          disabled={disabled || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          ‹
        </PageButton>
        {pages.map((entry, index) =>
          entry === 'ellipsis' ? (
            <span
              key={`gap-${index}`}
              className="px-1.5 text-[13px] text-text-muted"
              aria-hidden
            >
              …
            </span>
          ) : (
            <PageButton
              key={entry}
              label={`Page ${entry}`}
              active={entry === page}
              disabled={disabled}
              onClick={() => onChange(entry)}
            >
              {entry}
            </PageButton>
          ),
        )}
        <PageButton
          label="Next"
          disabled={disabled || page >= pageCount}
          onClick={() => onChange(page + 1)}
        >
          ›
        </PageButton>
      </nav>
    </div>
  );
}

function PageButton({
  children,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-input-lg border px-2.5 text-[13px] font-medium transition ${
        active
          ? 'border-primary bg-primary text-text-on-primary'
          : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

// A compact page list: always shows first & last, the current page and its
// neighbours, and 'ellipsis' markers for the gaps in between.
function pageWindow(current: number, pageCount: number): Array<number | 'ellipsis'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, pageCount, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const result: Array<number | 'ellipsis'> = [];
  let previous = 0;
  for (const p of sorted) {
    if (p - previous > 1) result.push('ellipsis');
    result.push(p);
    previous = p;
  }
  return result;
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
          Q code {client.clientCode}
          {client.communicationPreference ? ` · Prefers ${client.communicationPreference}` : ''}
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
