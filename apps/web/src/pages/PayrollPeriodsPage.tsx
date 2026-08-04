import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { PayPeriodListItem } from '@sheer/domain';
import {
  PAY_PERIOD_FREQUENCY_LABELS,
  PAY_PERIOD_KIND_LABELS,
  PAY_PERIOD_STATUS_LABELS,
  userHasPermission,
} from '@sheer/domain';
import { AppButton, AppCard, AppText, StatusBadge } from '../design';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { signedMoney } from '../components/kpi/format';
import {
  PAY_PERIOD_STATUS_TONES,
  payPeriodWindowLabel,
  todayLocalIso,
} from '../components/payroll/format';
import { useAuth } from '../auth/AuthProvider';
import { ApiRequestError, createPayPeriod, listPayPeriods } from '../auth/api';

const COLS = '1.9fr 1fr 0.9fr 1.2fr 0.5fr 1fr 72px';

/**
 * Owner/manager pay-period list — the entry point of the payroll review
 * workflow. Pay periods are BUSINESS-WIDE, so this page deliberately ignores
 * the sidebar location scope. Row figures come from the server's period
 * roll-up; a period with no roll-up simply has not been generated yet.
 */
export function PayrollPeriodsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canView = userHasPermission(auth.user, 'payroll.view');
  const canEdit = userHasPermission(auth.user, 'payroll.edit');
  const navigate = useNavigate();

  const [periods, setPeriods] = useState<PayPeriodListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listPayPeriods(accessToken);
      setPeriods(res.periods);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load pay periods');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(async () => {
    if (!accessToken) return;
    setCreating(true);
    setError(null);
    try {
      // No explicit window: the server derives the period containing today
      // from the business's payroll settings (frequency + week start day).
      await createPayPeriod(accessToken, { referenceDate: todayLocalIso() });
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to create the pay period');
    } finally {
      setCreating(false);
    }
  }, [accessToken, load]);

  if (auth.user && !canView) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium">
            Staff pay
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-1">
            Pay periods for the whole business — generate, review, approve and lock.
          </AppText>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AppButton size="sm" variant="ghost" onClick={() => navigate('/payroll/structures')}>
            Pay structures
          </AppButton>
          {canEdit ? (
            <AppButton size="sm" onClick={() => void handleCreate()} loading={creating}>
              Create period
            </AppButton>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading pay periods…
        </div>
      ) : periods.length === 0 ? (
        <div className="rounded-input-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-text-secondary">
          No pay periods yet. Create the first one to get started.
        </div>
      ) : (
        <>
          <SectionLabel>Pay periods</SectionLabel>
          <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
            <div
              className="grid items-center bg-surface-alt px-4 py-2.5"
              style={{ gridTemplateColumns: COLS }}
            >
              {['Period', 'Kind', 'Frequency', 'Status', 'Staff', 'Net payable', ''].map(
                (heading, idx) => (
                  <AppText
                    key={heading || idx}
                    as="div"
                    variant="micro"
                    weight="medium"
                    uppercase
                    className="text-text-subtle"
                  >
                    {heading}
                  </AppText>
                ),
              )}
            </div>

            {periods.map(({ period, totals }) => (
              <button
                key={period.id}
                type="button"
                onClick={() => navigate(`/payroll/periods/${period.id}`)}
                className="grid w-full items-center border-t border-border-divider bg-surface px-4 py-3 text-left transition hover:bg-surface-alt"
                style={{ gridTemplateColumns: COLS }}
              >
                <div className="min-w-0">
                  <AppText as="div" weight="medium" className="truncate text-[13px]">
                    {payPeriodWindowLabel(period)}
                  </AppText>
                  {period.label ? (
                    <AppText as="div" variant="micro" className="mt-0.5 truncate text-text-subtle">
                      {period.label}
                    </AppText>
                  ) : null}
                </div>
                <AppText as="div" className="text-[13px]">
                  {PAY_PERIOD_KIND_LABELS[period.kind]}
                </AppText>
                <AppText as="div" className="text-[13px]">
                  {PAY_PERIOD_FREQUENCY_LABELS[period.frequency]}
                </AppText>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    label={PAY_PERIOD_STATUS_LABELS[period.status]}
                    tone={PAY_PERIOD_STATUS_TONES[period.status]}
                  />
                  {totals && totals.staleCount > 0 ? (
                    <StatusBadge label={`${totals.staleCount} stale`} tone="warning" />
                  ) : null}
                </div>
                <AppText as="div" weight="medium" className="text-[13px]">
                  {totals ? String(totals.staffCount) : '—'}
                </AppText>
                {totals ? (
                  <AppText
                    as="div"
                    weight="medium"
                    tone={totals.totalNetPayableCents > 0 ? 'success' : 'primary'}
                    className="text-[13px]"
                  >
                    {signedMoney(totals.totalNetPayableCents, totals.currencyCode)}
                  </AppText>
                ) : (
                  <AppText as="div" variant="micro" tone="muted">
                    Not generated
                  </AppText>
                )}
                <span className="justify-self-end text-[11px] font-medium text-primary">
                  Review →
                </span>
              </button>
            ))}
          </AppCard>
        </>
      )}
    </div>
  );
}
