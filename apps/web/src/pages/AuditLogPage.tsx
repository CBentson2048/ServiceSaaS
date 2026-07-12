import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { AuditLogEntry } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { ApiRequestError, listAuditEvents } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';

const FIELD =
  'rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-primary';

const ENTITY_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All activity' },
  { value: 'booking', label: 'Bookings' },
  { value: 'payment', label: 'Payments' },
  { value: 'stock', label: 'Stock' },
  { value: 'security_level', label: 'Security levels' },
  { value: 'membership', label: 'Permissions' },
  { value: 'account', label: 'Account' },
];

const ACTION_LABELS: Record<string, string> = {
  'booking.created': 'Booking created',
  'booking.cancelled': 'Booking cancelled',
  'payment.recorded': 'Payment recorded',
  'stock.adjusted': 'Stock adjusted',
  'security_level.created': 'Security level created',
  'security_level.updated': 'Security level updated',
  'security_level.deleted': 'Security level deleted',
  'membership.security_level.changed': 'Member security level changed',
  'account.tier.changed': 'Account plan changed',
};

const PAGE_SIZE = 50;

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AuditLogPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canRead = userHasPermission(auth.user, 'audit.read');

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [entityType, setEntityType] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (!accessToken) return;
      const append = Boolean(cursor);
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await listAuditEvents(accessToken, {
          entityType: entityType || undefined,
          limit: PAGE_SIZE,
          cursor,
        });
        setEntries((prev) => (append ? [...prev, ...res.entries] : res.entries));
        setNextCursor(res.nextCursor);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Unable to load the audit log');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, entityType],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.user && !canRead) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-text-primary">Audit log</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            A tamper-evident trail of who did what and when: bookings, cancellations, payments,
            stock adjustments, permission changes and account changes.
          </p>
        </div>
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className={FIELD}
          aria-label="Filter activity"
        >
          {ENTITY_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="py-16 text-center text-[13px] text-text-secondary">Loading…</div>
      ) : entries.length === 0 ? (
        <p className="rounded-input-lg border border-dashed border-border-strong bg-surface px-3 py-8 text-center text-[13px] text-text-secondary">
          No activity recorded yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-card border border-border-strong">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-surface-muted text-left text-[12px] uppercase tracking-[0.06em] text-text-secondary">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-border-strong align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                    {formatTimestamp(entry.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-text-primary">{entry.actor.name || 'System'}</div>
                    {entry.actor.role ? (
                      <div className="text-[11px] uppercase tracking-[0.06em] text-text-secondary">
                        {entry.actor.role}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-text-primary">{actionLabel(entry.action)}</td>
                  <td className="px-3 py-2 text-text-secondary">{entry.locationName ?? '—'}</td>
                  <td className="px-3 py-2">
                    <AuditDetails entry={entry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor ? (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => void load(nextCursor)}
            disabled={loadingMore}
            className="rounded-input-lg border border-border-strong bg-surface px-4 py-2 text-[13px] font-medium text-text-primary hover:border-primary disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AuditDetails({ entry }: { entry: AuditLogEntry }) {
  const hasBefore = entry.before && Object.keys(entry.before).length > 0;
  const hasAfter = entry.after && Object.keys(entry.after).length > 0;
  const hasMeta = entry.metadata && Object.keys(entry.metadata).length > 0;

  if (!hasBefore && !hasAfter && !hasMeta) {
    return <span className="text-text-secondary">—</span>;
  }

  return (
    <details>
      <summary className="cursor-pointer select-none text-[12px] font-medium text-primary">
        View
      </summary>
      <div className="mt-2 space-y-2">
        {hasBefore ? (
          <DetailBlock label="Before" value={entry.before} />
        ) : null}
        {hasAfter ? <DetailBlock label="After" value={entry.after} /> : null}
        {hasMeta ? <DetailBlock label="Context" value={entry.metadata} /> : null}
      </div>
    </details>
  );
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.06em] text-text-secondary">{label}</div>
      <pre className="mt-1 overflow-x-auto rounded-input-lg border border-border-strong bg-surface-muted px-2 py-1 text-[11px] text-text-primary">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
