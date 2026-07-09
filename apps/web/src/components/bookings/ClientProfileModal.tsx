import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CrmClientDetailResponse } from '@sheer/domain';
import { ApiRequestError, getCrmClientDetail } from '../../auth/api';
import { Modal } from '../team/Modal';

interface ClientProfileModalProps {
  /** Client profile id to show. Null closes the modal. */
  clientId: string | null;
  accessToken?: string;
  /** Fallback name shown in the header while the profile loads. */
  clientName?: string;
  onClose: () => void;
}

/**
 * Quick-look customer profile shown when a stylist double-taps an appointment
 * tile on the Appointment Book. Fetches the full CRM detail but renders a
 * focused summary; a footer link opens the full client page.
 */
export function ClientProfileModal({ clientId, accessToken, clientName, onClose }: ClientProfileModalProps) {
  const [detail, setDetail] = useState<CrmClientDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    getCrmClientDetail(accessToken, clientId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load client profile');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, accessToken]);

  const profile = detail?.profile;
  const headerName = profile?.displayName ?? clientName ?? 'Client profile';
  const headerDescription = profile?.clientCode ? `Client ${profile.clientCode}` : undefined;

  return (
    <Modal
      open={!!clientId}
      onClose={onClose}
      title={headerName}
      description={headerDescription}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-semibold text-text-secondary transition hover:bg-surface-alt"
          >
            Close
          </button>
          {clientId ? (
            <Link
              to={`/crm/clients/${clientId}`}
              className="inline-flex h-9 items-center rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            >
              Open full profile
            </Link>
          ) : null}
        </>
      }
    >
      {loading ? (
        <p className="text-[13px] text-text-secondary">Loading client profile…</p>
      ) : error ? (
        <p className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : profile ? (
        <div className="space-y-5">
          {/* Alerts */}
          {profile.alertCounts.activeAllergies > 0 || profile.alertCounts.expiredPatchTests > 0 ? (
            <div className="flex flex-wrap gap-2">
              {profile.alertCounts.activeAllergies > 0 ? (
                <span className="inline-flex items-center rounded-pill border border-danger-border bg-danger-soft px-2.5 py-1 text-[12px] font-medium text-danger">
                  {profile.alertCounts.activeAllergies} active allerg
                  {profile.alertCounts.activeAllergies === 1 ? 'y' : 'ies'}
                </span>
              ) : null}
              {profile.alertCounts.expiredPatchTests > 0 ? (
                <span className="inline-flex items-center rounded-pill border border-warning-border bg-warning-soft px-2.5 py-1 text-[12px] font-medium text-warning">
                  {profile.alertCounts.expiredPatchTests} expired patch test
                  {profile.alertCounts.expiredPatchTests === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Contact details */}
          <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <DetailRow label="Email" value={profile.email ?? '—'} />
            <DetailRow label="Phone" value={profile.phone ?? '—'} />
            <DetailRow label="Preferred contact" value={formatPreference(profile.communicationPreference)} />
            <DetailRow label="Last visit" value={formatDate(profile.lastVisitAt)} />
          </dl>

          {profile.tags.length > 0 ? (
            <div>
              <SectionLabel>Tags</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {profile.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-pill border border-border bg-surface-alt px-2.5 py-1 text-[12px] text-text-secondary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* Active allergies */}
          {detail.allergies.filter((a) => a.isActive).length > 0 ? (
            <div>
              <SectionLabel>Allergies</SectionLabel>
              <ul className="space-y-1">
                {detail.allergies
                  .filter((a) => a.isActive)
                  .map((allergy) => (
                    <li key={allergy.id} className="text-[13px] text-text-primary">
                      <span className="font-medium">{allergy.allergenName}</span>
                      <span className="text-text-secondary"> · {allergy.severity}</span>
                      {allergy.notes ? <span className="text-text-muted"> — {allergy.notes}</span> : null}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {/* Recent visits */}
          <div>
            <SectionLabel>Recent visits</SectionLabel>
            {detail.visits.length === 0 ? (
              <p className="text-[13px] text-text-secondary">No visits recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {detail.visits.slice(0, 4).map((visit) => (
                  <li key={visit.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] text-text-primary">
                        {visit.serviceSummary ?? 'Visit'}
                      </div>
                      <div className="text-[12px] text-text-muted">
                        {formatDate(visit.occurredAt)}
                        {visit.stylistName ? ` · ${visit.stylistName}` : ''}
                      </div>
                    </div>
                    {visit.priceAmount !== undefined ? (
                      <span className="shrink-0 text-right">
                        <span className="block text-[13px] font-medium text-text-primary">
                          {formatMoney(visit.priceAmount, visit.currencyCode)}
                        </span>
                        {visit.amountKind === 'deposit' ? (
                          <span className="block text-[11px] text-text-muted">deposit</span>
                        ) : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {profile.notes ? (
            <div>
              <SectionLabel>Notes</SectionLabel>
              <p className="whitespace-pre-wrap text-[13px] text-text-secondary">{profile.notes}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] text-text-primary">{value}</dd>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-text-secondary">{children}</p>
  );
}

function formatPreference(preference?: string): string {
  if (!preference) return '—';
  switch (preference) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'sms':
      return 'SMS';
    case 'email':
      return 'Email';
    default:
      return preference;
  }
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatMoney(amount: number, currencyCode?: string): string {
  // CrmVisitSummary.priceAmount is in major currency units (e.g. pounds).
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currencyCode || 'GBP',
    maximumFractionDigits: 2,
  }).format(amount);
}
