import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { BusinessLocation } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import {
  ApiRequestError,
  deactivateLocation,
  listLocations,
  reactivateLocation,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';

type StatusFilter = 'all' | 'active' | 'inactive';

export function LocationsPage() {
  const auth = useAuth();
  const role = auth.user?.primaryRole;
  const { selectedLocationId, isAllLocations } = useLocationScope();
  const canManageLocations = userHasPermission(auth.user, 'locations.manage');
  const accessToken = auth.session?.accessToken;
  const [locations, setLocations] = useState<BusinessLocation[]>([]);
  const [scope, setScope] = useState<'owner' | 'manager' | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listLocations(accessToken);
      setLocations(result.locations);
      setScope(result.scope);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load locations');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return locations.filter((location) => {
      if (statusFilter === 'active' && !location.isActive) return false;
      if (statusFilter === 'inactive' && location.isActive) return false;
      if (!term) return true;
      const haystack = [
        location.name,
        location.slug,
        location.code,
        location.city ?? '',
        location.region ?? '',
        location.timezone,
        location.email ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [locations, search, statusFilter]);

  // Managers don't get the multi-location table; they land on a single
  // location's settings. Honour the sidebar location picker so an area manager
  // who selected "Kensington" opens Kensington here (not just their first
  // salon). Fall back to the first accessible location when "All" is selected
  // or the picked one isn't among their salons. If they have no location at all
  // (edge case where the membership lost its location_id) we show a hint.
  if (auth.status === 'authenticated' && role === 'manager' && !canManageLocations) {
    if (loading) {
      return <CenteredHint message="Loading your location…" />;
    }
    if (error) {
      return <CenteredHint message={error} tone="danger" />;
    }
    const picked =
      !isAllLocations && locations.some((l) => l.id === selectedLocationId)
        ? selectedLocationId
        : locations[0]?.id;
    if (picked) {
      return <Navigate to={`/locations/${picked}`} replace />;
    }
    return (
      <CenteredHint message="No location is assigned to your account yet. Ask your business owner to assign you to a location." />
    );
  }

  if (auth.status === 'authenticated' && role !== 'owner' && !canManageLocations) {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleDeactivate(location: BusinessLocation) {
    if (!accessToken) return;
    setBusyId(location.id);
    setActionMessage(null);
    setError(null);
    try {
      const { location: updated } = await deactivateLocation(accessToken, location.id);
      setLocations((current) => current.map((l) => (l.id === updated.id ? updated : l)));
      setActionMessage(`${updated.name} has been deactivated.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not deactivate location');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReactivate(location: BusinessLocation) {
    if (!accessToken) return;
    setBusyId(location.id);
    setActionMessage(null);
    setError(null);
    try {
      const { location: updated } = await reactivateLocation(accessToken, location.id);
      setLocations((current) => current.map((l) => (l.id === updated.id ? updated : l)));
      setActionMessage(`${updated.name} has been reactivated.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reactivate location');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Locations</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Manage the salons that belong to your business. Detailed per-location settings will
            arrive in a follow-up phase.
          </p>
        </div>
        <Link
          to="/locations/new"
          className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
        >
          New location
        </Link>
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

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          placeholder="Search by name, slug, city, or timezone"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-80"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'active', 'inactive'] as const).map((status) => (
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
              {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
        {loading ? (
          <div className="px-4 py-8 text-center text-[13px] text-text-secondary">
            Loading locations…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="text-[14px] font-medium text-text-primary">
              {locations.length === 0 ? 'No locations yet' : 'No locations match these filters'}
            </div>
            <div className="mt-1 text-[13px] text-text-secondary">
              {locations.length === 0
                ? 'Create your first location to start inviting staff and taking bookings.'
                : 'Try clearing the search or switching to "All".'}
            </div>
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Slug · Code</th>
                <th className="px-4 py-3">Timezone</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((location) => (
                <LocationRow
                  key={location.id}
                  location={location}
                  busy={busyId === location.id}
                  onDeactivate={() => handleDeactivate(location)}
                  onReactivate={() => handleReactivate(location)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {scope === 'owner' && locations.length > 0 ? (
        <p className="mt-3 text-[12px] text-text-secondary">
          Showing {filtered.length} of {locations.length} location{locations.length === 1 ? '' : 's'}.
        </p>
      ) : null}
    </div>
  );
}

function LocationRow({
  location,
  busy,
  onDeactivate,
  onReactivate,
}: {
  location: BusinessLocation;
  busy: boolean;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const cityRegion = [location.city, location.region].filter(Boolean).join(', ');
  return (
    <tr>
      <td className="px-4 py-3">
        <div>
          <div className="font-medium text-text-primary">
            <Link to={`/locations/${location.id}`} className="hover:text-primary">
              {location.name}
            </Link>
          </div>
          {cityRegion ? (
            <div className="text-[12px] text-text-secondary">{cityRegion}</div>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3 text-text-secondary">
        <div className="font-mono text-[12px]">{location.slug}</div>
        <div className="text-[11px] text-text-muted">{location.code}</div>
      </td>
      <td className="px-4 py-3 text-text-secondary">{location.timezone}</td>
      <td className="px-4 py-3 text-text-secondary">
        {location.phone ? <div>{location.phone}</div> : null}
        {location.email ? (
          <div className="text-[12px] text-text-muted">{location.email}</div>
        ) : null}
        {!location.phone && !location.email ? <span className="text-text-muted">—</span> : null}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex h-6 items-center rounded-pill px-2.5 text-[11px] font-medium ${
            location.isActive
              ? 'border border-success-border bg-success-soft text-success'
              : 'border border-border-strong bg-surface-alt text-text-secondary'
          }`}
        >
          {location.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center justify-end gap-1.5">
          <Link
            to={`/locations/${location.id}`}
            className="h-8 rounded-pill border border-border-strong bg-surface px-3 text-[12px] font-medium leading-[30px] text-text-secondary transition hover:bg-surface-alt"
          >
            Detail
          </Link>
          {location.isActive ? (
            <button
              type="button"
              className="h-8 rounded-pill border border-warning-border bg-warning-soft px-3 text-[12px] font-medium text-warning transition hover:brightness-95 disabled:opacity-60"
              onClick={onDeactivate}
              disabled={busy}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              className="h-8 rounded-pill border border-success-border bg-success-soft px-3 text-[12px] font-medium text-success transition hover:brightness-95 disabled:opacity-60"
              onClick={onReactivate}
              disabled={busy}
            >
              Reactivate
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CenteredHint({ message, tone }: { message: string; tone?: 'danger' }) {
  return (
    <div className="grid min-h-[40vh] place-items-center px-6">
      <div
        className={`max-w-md rounded-card-lg border px-5 py-6 text-center text-[13px] ${
          tone === 'danger'
            ? 'border-danger-border bg-danger-soft text-danger'
            : 'border-border bg-surface text-text-secondary'
        }`}
      >
        {message}
      </div>
    </div>
  );
}
