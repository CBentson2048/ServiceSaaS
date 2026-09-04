import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AmendAppointmentServicesResponse,
  AppointmentServiceChange,
  AppointmentServiceLineSummary,
  PublicBookingServiceSummary,
  StaffBookingSummary,
  UpsellSuggestion,
} from '@sheer/domain';
import { AppButton, StatusBadge } from '../../design';
import {
  ApiRequestError,
  addAppointmentService,
  getAppointmentServiceChanges,
  getStaffBookingSelection,
  removeAppointmentService,
} from '../../auth/api';
import { UpsellSuggestions } from './UpsellSuggestions';

/**
 * The services on a visit AFTER the client has arrived — what was booked, what
 * has been added or taken off since, and who did it — with the controls to
 * change them (0110).
 *
 * Every change here goes through the ONE canonical mutation path
 * (`POST /lab/appointments/:id/services`, `.../services/:lineId/remove`): a
 * consultation decision, a manual search and an accepted upsell suggestion are
 * the same request. Nothing is added automatically; a suggestion is a button.
 *
 * The panel never edits the diary. Adding a toner does not move the next
 * client — the booked schedule is preserved separately from the performed set.
 */
export function VisitServicesPanel({
  booking,
  accessToken,
  staffNames,
  suggestions = [],
  canAmend,
  onChanged,
  compact = false,
}: {
  booking: StaffBookingSummary;
  accessToken: string;
  /** staffProfileId -> display name, for attribution labels. */
  staffNames?: Map<string, string>;
  suggestions?: UpsellSuggestion[];
  /** Whether the signed-in user holds bookings.services.modify_after_checkin. */
  canAmend: boolean;
  /** The server's answer after a change — the parent adopts the appointment and bill. */
  onChanged: (response: AmendAppointmentServicesResponse) => void;
  compact?: boolean;
}) {
  const lines = useMemo(() => booking.serviceLines ?? [], [booking.serviceLines]);
  const performed = useMemo(() => lines.filter((line) => line.performed), [lines]);
  const removed = useMemo(() => lines.filter((line) => !line.performed), [lines]);
  const changedDuringVisit = lines.some((line) => line.origin !== 'booked' || !line.performed);
  const currencyCode = 'GBP';

  const [catalog, setCatalog] = useState<PublicBookingServiceSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  // The performed line a chosen service will REPLACE, when staff pick "Replace…".
  const [replaceTarget, setReplaceTarget] = useState<AppointmentServiceLineSummary | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AppointmentServiceChange[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // The catalogue loads lazily, only once staff open the add list.
  useEffect(() => {
    if (!adding || catalog !== null) return;
    let cancelled = false;
    setCatalogError(null);
    getStaffBookingSelection(accessToken, { locationId: booking.locationId })
      .then((response) => {
        if (!cancelled) setCatalog(response.services);
      })
      .catch(() => {
        if (!cancelled) setCatalogError('Could not load the service list.');
      });
    return () => {
      cancelled = true;
    };
  }, [adding, catalog, accessToken, booking.locationId]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await getAppointmentServiceChanges(accessToken, booking.id);
      setHistory(response.changes);
    } catch {
      setHistory([]);
    }
  }, [accessToken, booking.id]);

  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory, lines.length]);

  const openSuggestions = useMemo(() => {
    const onVisit = new Set(performed.map((line) => line.serviceId).filter(Boolean));
    return suggestions.filter((suggestion) => !onVisit.has(suggestion.serviceId));
  }, [suggestions, performed]);

  const filteredCatalog = useMemo(() => {
    if (!catalog) return [];
    const needle = search.trim().toLowerCase();
    return catalog.filter((service) => !needle || service.name.toLowerCase().includes(needle));
  }, [catalog, search]);

  async function add(serviceId: string, key: string) {
    if (!canAmend || busyKey) return;
    setBusyKey(key);
    setError(null);
    try {
      const response = await addAppointmentService(accessToken, booking.id, {
        serviceId,
        replacesAppointmentServiceId: replaceTarget?.id,
        // One key per click: a retried request cannot add the service twice.
        idempotencyKey: newIdempotencyKey(),
      });
      onChanged(response);
      setReplaceTarget(null);
      setAdding(false);
      setSearch('');
      if (historyOpen) void loadHistory();
    } catch (err: unknown) {
      setError(toMessage(err, 'Could not add the service'));
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(line: AppointmentServiceLineSummary) {
    if (!canAmend || busyKey) return;
    if (!window.confirm(`Take ${line.name} off this visit? It stays on the record as booked but not performed.`)) {
      return;
    }
    setBusyKey(`remove:${line.id}`);
    setError(null);
    try {
      const response = await removeAppointmentService(accessToken, booking.id, line.id, {
        idempotencyKey: newIdempotencyKey(),
      });
      onChanged(response);
      if (historyOpen) void loadHistory();
    } catch (err: unknown) {
      setError(toMessage(err, 'Could not remove the service'));
    } finally {
      setBusyKey(null);
    }
  }

  const performedTotal = performed.reduce((sum, line) => sum + line.priceAmount, 0);

  return (
    <section
      aria-label="Services on this visit"
      className={`rounded-input-lg border border-border bg-surface ${compact ? 'p-3' : 'p-4'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">Services on this visit</h3>
          <p className="text-[11px] text-text-muted">
            {changedDuringVisit
              ? 'Changed after check-in — the original booking is kept below.'
              : 'As booked. Add or replace services as the consultation decides.'}
          </p>
        </div>
        <span className="text-[13px] font-semibold tabular-nums text-text-primary">
          {formatPrice(performedTotal, currencyCode)}
        </span>
      </div>

      {error ? (
        <div role="alert" className="mt-2 rounded-input border border-danger-border bg-danger-soft px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      <ul className="mt-2 flex flex-col gap-1.5">
        {performed.map((line) => (
          <li
            key={line.id}
            className={`flex items-center justify-between gap-3 rounded-input border px-3 py-2 ${
              replaceTarget?.id === line.id ? 'border-primary bg-primary/5' : 'border-border bg-surface'
            }`}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-text-primary">{line.name}</span>
                {line.origin === 'post_checkin_add' ? (
                  <StatusBadge label="Added during visit" tone="success" />
                ) : line.origin === 'post_checkin_replace' ? (
                  <StatusBadge label="Replaced during visit" tone="success" />
                ) : null}
              </div>
              <div className="text-[11px] text-text-secondary">
                {formatPrice(line.priceAmount, currencyCode)}
                {line.assignedStaffProfileId
                  ? ` · ${staffNames?.get(line.assignedStaffProfileId) ?? 'Assigned stylist'}`
                  : ''}
              </div>
            </div>
            {canAmend ? (
              <div className="flex shrink-0 items-center gap-1">
                <AppButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReplaceTarget((current) => (current?.id === line.id ? null : line));
                    setAdding(true);
                  }}
                  disabled={Boolean(busyKey)}
                >
                  {replaceTarget?.id === line.id ? 'Choosing…' : 'Replace'}
                </AppButton>
                <AppButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(line)}
                  loading={busyKey === `remove:${line.id}`}
                  disabled={Boolean(busyKey) || performed.length <= 1}
                >
                  Remove
                </AppButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {removed.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {removed.map((line) => (
            <li key={line.id} className="flex items-center justify-between gap-3 px-3 text-[12px] text-text-muted">
              <span className="truncate line-through">{line.name}</span>
              <span className="shrink-0">Booked, not performed</span>
            </li>
          ))}
        </ul>
      ) : null}

      {canAmend ? (
        <div className="mt-3">
          {!adding ? (
            <AppButton size="sm" variant="secondary" onClick={() => setAdding(true)} disabled={Boolean(busyKey)}>
              + Add a service
            </AppButton>
          ) : (
            <div className="rounded-input-lg border border-border bg-surface-alt p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-text-secondary">
                  {replaceTarget ? `Replace ${replaceTarget.name} with…` : 'Add a service'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setReplaceTarget(null);
                    setSearch('');
                  }}
                  className="text-[12px] text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search services…"
                aria-label="Search services"
                className="mt-2 h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
              />
              {catalogError ? (
                <div className="mt-2 text-[12px] text-warning">{catalogError}</div>
              ) : !catalog ? (
                <div className="mt-2 text-[12px] text-text-muted">Loading services…</div>
              ) : filteredCatalog.length === 0 ? (
                <div className="mt-2 text-[12px] text-text-muted">No services match.</div>
              ) : (
                <ul className="mt-2 grid max-h-48 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
                  {filteredCatalog.map((service) => (
                    <li key={service.id}>
                      <button
                        type="button"
                        onClick={() => void add(service.id, `add:${service.id}`)}
                        disabled={Boolean(busyKey)}
                        className="flex w-full items-center justify-between gap-2 rounded-input border border-border bg-surface px-3 py-2 text-left transition hover:border-primary hover:bg-primary/5 disabled:opacity-60"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-text-primary">{service.name}</span>
                          <span className="block text-[11px] text-text-secondary">
                            {service.estimatedDurationMinutes} min · {formatPrice(service.startingPriceAmount, service.currencyCode)}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] font-medium text-primary-deep">
                          {busyKey === `add:${service.id}` ? '…' : replaceTarget ? 'Use' : '+ Add'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Suggestions stay suggestions: the Add button is the SAME add path. */}
      {openSuggestions.length > 0 ? (
        <div className="mt-3">
          <UpsellSuggestions
            suggestions={openSuggestions}
            onAdd={canAmend ? (suggestion) => void add(suggestion.serviceId, `add:${suggestion.serviceId}`) : undefined}
            addingServiceId={busyKey?.startsWith('add:') ? busyKey.slice(4) : null}
            compact
          />
        </div>
      ) : null}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          className="text-[12px] font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
        >
          {historyOpen ? 'Hide change history' : 'Show change history'}
        </button>
        {historyOpen ? (
          history === null ? (
            <div className="mt-1 text-[12px] text-text-muted">Loading…</div>
          ) : history.length === 0 ? (
            <div className="mt-1 text-[12px] text-text-muted">No changes since check-in.</div>
          ) : (
            <ol className="mt-1 flex flex-col gap-1 text-[12px] text-text-secondary">
              {history.map((change) => (
                <li key={change.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="tabular-nums text-text-muted">{formatTime(change.createdAt)}</span>
                  <span className="font-medium text-text-primary">{change.actorDisplayName ?? 'Staff'}</span>
                  <span>{describeChange(change, staffNames, currencyCode)}</span>
                </li>
              ))}
            </ol>
          )
        ) : null}
      </div>
    </section>
  );
}

/** One sentence per change: what happened, at what price, attributed to whom. */
export function describeChange(
  change: AppointmentServiceChange,
  staffNames: Map<string, string> | undefined,
  currencyCode: string,
): string {
  const price = (amount?: number) => (amount == null ? '' : ` ${formatPrice(amount, currencyCode)}`);
  const stylist = (id?: string, fallback?: string) =>
    id ? staffNames?.get(id) ?? fallback ?? 'assigned stylist' : undefined;
  switch (change.action) {
    case 'added': {
      const who = stylist(change.after?.staffProfileId, change.after?.staffDisplayName);
      return `added ${change.after?.serviceName ?? 'a service'}${price(change.after?.priceAmount)}${who ? ` · ${who}` : ''}`;
    }
    case 'removed':
      return `removed ${change.before?.serviceName ?? 'a service'}${change.reason ? ` — ${change.reason}` : ''}`;
    case 'replaced':
      return `replaced ${change.before?.serviceName ?? 'a service'} with ${change.after?.serviceName ?? 'a service'}${price(change.after?.priceAmount)}`;
    case 'reassigned':
      return `reassigned ${change.before?.serviceName ?? 'a service'} to ${stylist(change.after?.staffProfileId, change.after?.staffDisplayName) ?? 'another stylist'}`;
    default:
      return 'changed a service';
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatPrice(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
