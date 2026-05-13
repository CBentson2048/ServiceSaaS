import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StaffBookingSummary } from '@sheer/domain';
import { StatusBadge } from '../design';
import { ApiRequestError, listBookings } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

type StatusFilter = 'all' | StaffBookingSummary['status'];

const STATUS_FILTERS: StatusFilter[] = [
  'all',
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
];

export function BookingsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [scope, setScope] = useState<'owner' | 'manager' | 'stylist' | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listBookings(accessToken);
      setBookings(result.bookings);
      setScope(result.scope);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load bookings');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visibleBookings = useMemo(() => {
    const term = search.trim().toLowerCase();
    return bookings.filter((booking) => {
      if (statusFilter !== 'all' && booking.status !== statusFilter) return false;
      if (!term) return true;
      return [
        booking.clientDisplayName,
        booking.serviceNames.join(' '),
        booking.status,
        booking.locationId,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [bookings, search, statusFilter]);

  const subtitle =
    scope === 'owner'
      ? 'Showing bookings across your business.'
      : scope === 'manager'
        ? 'Showing bookings for your assigned location scope.'
        : 'Showing bookings in your permitted scope.';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Bookings</h1>
          <p className="mt-1 text-[13px] text-text-secondary">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="inline-flex h-10 items-center justify-center rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
        >
          Refresh
        </button>
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <input
          type="search"
          placeholder="Search client, service, status, or location"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 lg:w-96"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((status) => (
            <button
              key={status}
              type="button"
              className={`h-8 rounded-pill border px-3 text-[12px] font-medium transition ${
                statusFilter === status
                  ? 'border-primary bg-primary-soft text-primary-deep'
                  : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
              }`}
              onClick={() => setStatusFilter(status)}
            >
              {status === 'all' ? 'All' : formatStatus(status)}
            </button>
          ))}
        </div>
      </div>

      <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
        {loading ? (
          <EmptyState title="Loading bookings…" body="Fetching the latest appointment list." />
        ) : visibleBookings.length === 0 ? (
          <EmptyState
            title={bookings.length === 0 ? 'No bookings yet' : 'No bookings match these filters'}
            body={
              bookings.length === 0
                ? 'Bookings will appear here as clients schedule appointments.'
                : 'Try clearing the search or switching to All.'
            }
          />
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Date & time</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Deposit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleBookings.map((booking) => (
                <BookingRow key={booking.id} booking={booking} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {!loading && bookings.length > 0 ? (
        <p className="mt-3 text-[12px] text-text-secondary">
          Showing {visibleBookings.length} of {bookings.length} booking
          {bookings.length === 1 ? '' : 's'}.
        </p>
      ) : null}
    </div>
  );
}

function BookingRow({ booking }: { booking: StaffBookingSummary }) {
  return (
    <tr>
      <td className="px-4 py-3">
        <div className="font-medium text-text-primary">{booking.clientDisplayName}</div>
        {booking.clientNote ? (
          <div className="mt-0.5 max-w-xs truncate text-[12px] text-warning">
            Note: {booking.clientNote}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 text-text-secondary">
        {booking.serviceNames.join(', ') || 'Service'}
      </td>
      <td className="px-4 py-3 text-text-secondary">
        <div>{formatDate(booking.startsAt)}</div>
        <div className="text-[12px]">
          {formatTime(booking.startsAt)} - {formatTime(booking.endsAt)}
        </div>
      </td>
      <td className="px-4 py-3 text-text-secondary">
        {booking.durationMinutes ? `${booking.durationMinutes} min` : 'Not set'}
      </td>
      <td className="px-4 py-3">
        <StatusBadge label={formatStatus(booking.status)} tone={statusTone(booking.status)} />
      </td>
      <td className="px-4 py-3 text-text-secondary">{depositLabel(booking)}</td>
    </tr>
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function statusTone(status: StaffBookingSummary['status']) {
  switch (status) {
    case 'confirmed':
    case 'checked_in':
    case 'in_progress':
    case 'in_service':
      return 'success';
    case 'pending':
    case 'draft':
    case 'booked':
      return 'warning';
    case 'cancelled':
    case 'no_show':
      return 'danger';
    default:
      return 'neutral';
  }
}

function depositLabel(booking: StaffBookingSummary): string {
  if (!booking.depositRequiredAmount) return 'None';
  return booking.depositStatus ? formatStatus(booking.depositStatus) : 'Required';
}
