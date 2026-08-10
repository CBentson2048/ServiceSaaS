import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type { CrmClientSummary, CrmClientsPagination } from '@sheer/domain';
import { userHasAnyRole } from '@sheer/domain';
import { ApiRequestError, createCrmClient, listCrmClients } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useDebounce } from '../hooks/useDebounce';

const PAGE_SIZE_OPTIONS = [5, 10, 15, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 20;

export function CrmClientsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  // Locations the signed-in user can attach a client to. When they manage more
  // than one, they must choose (a NULL-location client is invisible to every
  // non-owner and 403s on open). A single location is assigned automatically.
  const locations = auth.user?.locations ?? [];
  // The table's query state (search term, page, page size) lives in the URL so
  // the address bar always describes exactly what is on screen — copying the
  // link gives the receiver the same page of results the sender was seeing.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const page = parsePage(searchParams.get('page'));
  const pageSize = parsePageSize(searchParams.get('pageSize'));
  const [clients, setClients] = useState<CrmClientSummary[]>([]);
  const [pagination, setPagination] = useState<CrmClientsPagination | null>(null);
  const [search, setSearch] = useState(urlQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  // Create-form errors are kept separate from the list `error` so they live and
  // die with the form and never co-mingle with a list-load failure.
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicateConflict, setDuplicateConflict] = useState<{
    id: string;
    displayName: string;
    clientCode: string;
  } | null>(null);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    primaryLocationId: '',
    communicationPreference: '' as '' | 'email' | 'sms' | 'whatsapp',
    marketingOptIn: false,
  });
  // Monotonic id so only the most recently issued reload applies its result —
  // otherwise a slow response for an earlier query can clobber a later one.
  const reloadIdRef = useRef(0);

  const reload = useCallback(
    async (term: string, pageArg: number) => {
      if (!accessToken) return;
      const requestId = ++reloadIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await listCrmClients(accessToken, {
          q: term || undefined,
          page: pageArg,
          pageSize,
        });
        if (requestId !== reloadIdRef.current) return; // superseded by a newer reload
        setClients(result.clients);
        setPagination(result.pagination ?? null);
      } catch (err: unknown) {
        if (requestId !== reloadIdRef.current) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load clients');
      } finally {
        if (requestId === reloadIdRef.current) setLoading(false);
      }
    },
    [accessToken, pageSize],
  );

  // Writes table state into the URL — the single source of truth for what the
  // table shows. `replace` for keystroke-driven updates so typing doesn't flood
  // the history; explicit page navigation pushes so Back walks pages.
  const applyParams = useCallback(
    (
      updates: { q?: string | null; page?: number | null; pageSize?: number | null },
      options: { replace: boolean },
    ) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === undefined || value === '') next.delete(key);
            else next.set(key, String(value));
          }
          return next;
        },
        { replace: options.replace },
      );
    },
    [setSearchParams],
  );

  // Commit the input to the URL once typing pauses (trimmed, so "Luke" and
  // "Luke " share one link). A new term always restarts at page 1.
  const debouncedSearch = useDebounce(search, 250);
  // Last q this tab wrote or adopted: lets external URL changes (palette
  // hand-off, back/forward, a pasted link) update the input, while our own
  // debounced writes don't loop back into it.
  const lastQRef = useRef(urlQuery);
  useEffect(() => {
    const term = debouncedSearch.trim();
    if (term === lastQRef.current) return;
    lastQRef.current = term;
    applyParams({ q: term || null, page: null }, { replace: true });
  }, [debouncedSearch, applyParams]);

  useEffect(() => {
    if (urlQuery !== lastQRef.current) {
      lastQRef.current = urlQuery;
      setSearch(urlQuery);
    }
  }, [urlQuery]);

  // Fetch whenever the URL state changes. The URL is already debounced, so a
  // deep link or a shared link loads immediately with the right page.
  useEffect(() => {
    if (!accessToken) return;
    void reload(urlQuery, page);
  }, [accessToken, urlQuery, page, reload]);

  // Safety net: if the dataset shrank (e.g. a client was removed elsewhere) and
  // the current page no longer exists, snap back to the last valid page.
  useEffect(() => {
    if (pagination && page > pagination.pageCount) {
      applyParams(
        { page: pagination.pageCount === 1 ? null : pagination.pageCount },
        { replace: true },
      );
    }
  }, [pagination, page, applyParams]);

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

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCreate(false);
  }

  async function submitCreate(allowDuplicate: boolean) {
    if (!accessToken) return;
    // Trim client-side so whitespace-only names fail here with an inline message
    // instead of round-tripping to a raw backend 400.
    const firstName = form.firstName.trim();
    const lastName = form.lastName.trim();
    if (!firstName || !lastName) {
      setCreateError('First and last name are required.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    setDuplicateConflict(null);
    try {
      // A single-location user is auto-scoped server-side; when they manage more
      // than one, the required picker supplies the choice.
      const resolvedLocationId =
        form.primaryLocationId || (locations.length === 1 ? locations[0].id : '');
      const result = await createCrmClient(accessToken, {
        firstName,
        lastName,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        primaryLocationId: resolvedLocationId || undefined,
        communicationPreference: form.communicationPreference || undefined,
        marketingOptIn: form.marketingOptIn,
        allowDuplicate: allowDuplicate || undefined,
      });
      setForm({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        primaryLocationId: '',
        communicationPreference: '',
        marketingOptIn: false,
      });
      setShowCreate(false);
      setActionMessage(`${result.client.displayName} has been added to Client Hub.`);
      // A new client sorts to the top (most-recently-updated). Clear any active
      // search and jump to page 1 so the new record is actually visible — a
      // lingering search term would filter it out and contradict the toast.
      setSearch('');
      lastQRef.current = '';
      if (urlQuery || page !== 1) applyParams({ q: null, page: null }, { replace: true });
      else void reload('', 1);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError && err.status === 409) {
        const existing = extractExistingClient(err.details);
        if (existing) setDuplicateConflict(existing);
        setCreateError(err.message);
      } else {
        setCreateError(err instanceof Error ? err.message : 'Could not create client');
      }
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
            onClick={() => {
              setShowCreate((current) => !current);
              setCreateError(null);
              setDuplicateConflict(null);
              setActionMessage(null);
            }}
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
          {createError ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger sm:col-span-2">
              <p>{createError}</p>
              {duplicateConflict ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Link
                    to={`/crm/clients/${duplicateConflict.id}`}
                    className="font-medium text-primary hover:text-primary-deep"
                  >
                    Open {duplicateConflict.displayName} ({duplicateConflict.clientCode})
                  </Link>
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => void submitCreate(true)}
                    className="rounded-pill border border-danger-border px-3 py-1 text-[12px] font-semibold text-danger transition hover:bg-danger-soft disabled:opacity-60"
                  >
                    {creating ? 'Saving…' : 'Create anyway'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
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
          {locations.length > 1 ? (
            <label className="text-[12px] font-medium text-text-secondary">
              Primary location
              <select
                value={form.primaryLocationId}
                required
                onChange={(event) =>
                  setForm((current) => ({ ...current, primaryLocationId: event.target.value }))
                }
                className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value="">Select a location</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-[12px] font-medium text-text-secondary">
            Preferred communication
            <select
              value={form.communicationPreference}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  communicationPreference: event.target.value as '' | 'email' | 'sms' | 'whatsapp',
                }))
              }
              className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">No preference</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[12px] font-medium text-text-secondary sm:col-span-2">
            <input
              type="checkbox"
              checked={form.marketingOptIn}
              onChange={(event) =>
                setForm((current) => ({ ...current, marketingOptIn: event.target.checked }))
              }
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary/20"
            />
            Client consents to marketing communications
          </label>
          <div className="flex items-end justify-end sm:col-span-2">
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
          // Explicit submit commits immediately (skipping the debounce) and
          // starts a fresh history entry at page 1.
          const term = search.trim();
          lastQRef.current = term;
          applyParams({ q: term || null, page: null }, { replace: false });
        }}
      >
        <input
          type="search"
          placeholder="Search by name, phone, email, or Q code"
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
            onChange={(next) => applyParams({ page: next === 1 ? null : next }, { replace: false })}
            onPageSizeChange={(next) => {
              // New page size invalidates the current offset — restart at page 1.
              applyParams(
                { pageSize: next === DEFAULT_PAGE_SIZE ? null : next, page: null },
                { replace: false },
              );
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

// Pull the existing-client payload out of a 409 Conflict body so the form can
// offer "open existing" and "create anyway". Defensive: any shape mismatch just
// yields null and the plain message is shown.
function extractExistingClient(
  details: unknown,
): { id: string; displayName: string; clientCode: string } | null {
  if (!details || typeof details !== 'object') return null;
  const existing = (details as { existingClient?: unknown }).existingClient;
  if (!existing || typeof existing !== 'object') return null;
  const { id, displayName, clientCode } = existing as Record<string, unknown>;
  if (typeof id === 'string' && typeof displayName === 'string' && typeof clientCode === 'string') {
    return { id, displayName, clientCode };
  }
  return null;
}

function formatDate(value?: string): string {
  if (!value) return 'No visits';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

// Parse table state from the URL, falling back safely on junk values so a
// hand-edited or truncated link can never break the page.
function parsePage(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function parsePageSize(value: string | null): number {
  const parsed = Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}
