import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { BusinessLocation } from '@sheer/domain';
import { ApiRequestError, getLocation } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

/**
 * Phase 1 placeholder. Owners and managers both land here. The actual settings
 * surfaces (hours, services, payments, etc.) will arrive in a follow-up phase;
 * for now we just confirm access and show the contact summary.
 */
export function LocationDetailPage() {
  const auth = useAuth();
  const params = useParams<{ id: string }>();
  const accessToken = auth.session?.accessToken;
  const role = auth.user?.role;
  const [location, setLocation] = useState<BusinessLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!accessToken || !params.id) return;
      setLoading(true);
      setError(null);
      try {
        const { location: loaded } = await getLocation(accessToken, params.id);
        if (!cancelled) setLocation(loaded);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load location');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, params.id]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
      <nav className="mb-4 text-[12px] text-text-secondary">
        {role === 'owner' ? (
          <Link to="/locations" className="hover:text-text-primary">
            Locations
          </Link>
        ) : (
          <span>My location</span>
        )}
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">{location?.name ?? 'Loading…'}</span>
      </nav>

      {loading ? (
        <div className="rounded-card-lg border border-border bg-surface px-5 py-8 text-center text-[13px] text-text-secondary">
          Loading location…
        </div>
      ) : error ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : location ? (
        <>
          <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-[22px] font-semibold leading-7 text-text-primary">
                {location.name}
              </h1>
              <p className="mt-1 text-[13px] text-text-secondary">
                <span className="font-mono">{location.slug}</span> · {location.code} ·{' '}
                {location.timezone}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-7 items-center rounded-pill px-3 text-[12px] font-medium ${
                  location.isActive
                    ? 'border border-success-border bg-success-soft text-success'
                    : 'border border-border-strong bg-surface-alt text-text-secondary'
                }`}
              >
                {location.isActive ? 'Active' : 'Inactive'}
              </span>
              {role === 'owner' ? (
                <Link
                  to={`/locations/${location.id}/edit`}
                  className="inline-flex h-9 items-center justify-center rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
                >
                  Edit basics
                </Link>
              ) : null}
            </div>
          </header>

          <section className="rounded-card-lg border border-border bg-surface px-5 py-5">
            <h2 className="text-[14px] font-semibold text-text-primary">Summary</h2>
            <dl className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
              <SummaryRow label="Phone" value={location.phone} />
              <SummaryRow label="Email" value={location.email} />
              <SummaryRow
                label="Address"
                value={joinAddress(location)}
                placeholder="No address on file"
              />
              <SummaryRow label="Country" value={location.countryCode} />
            </dl>
          </section>

          <section className="mt-6 rounded-card-lg border border-dashed border-border bg-surface-alt px-5 py-8 text-center">
            <h2 className="text-[14px] font-semibold text-text-primary">
              Detailed location management
            </h2>
            <p className="mt-2 text-[13px] text-text-secondary">
              Detailed location management — opening hours, services, payments, calendar rules —
              will be added in the next phase.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

function SummaryRow({
  label,
  value,
  placeholder,
}: {
  label: string;
  value?: string | null;
  placeholder?: string;
}) {
  const display = value && value.trim() ? value : placeholder ?? '—';
  const isEmpty = !value || !value.trim();
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt/50 px-3 py-2.5">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
        {label}
      </dt>
      <dd className={`mt-1 text-[13px] ${isEmpty ? 'text-text-muted' : 'text-text-primary'}`}>
        {display}
      </dd>
    </div>
  );
}

function joinAddress(location: BusinessLocation): string | undefined {
  const lines = [
    location.addressLine1,
    location.addressLine2,
    [location.city, location.region].filter(Boolean).join(', ') || undefined,
    location.postalCode,
  ].filter((part): part is string => Boolean(part?.trim()));
  return lines.length === 0 ? undefined : lines.join('\n');
}
