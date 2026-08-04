import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { PayPeriodListItem, PayStructureSummary } from '@sheer/domain';
import {
  PAY_PERIOD_FREQUENCY_LABELS,
  PAY_PERIOD_KIND_LABELS,
  PAY_PERIOD_STATUS_LABELS,
  userHasPermission,
} from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppButton, AppCard, AppText, StatusBadge } from '../design';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { signedMoney } from '../components/kpi/format';
import {
  PAY_PERIOD_STATUS_TONES,
  payPeriodWindowLabel,
  todayLocalIso,
} from '../components/payroll/format';
import { useAuth } from '../auth/AuthProvider';
import {
  ApiRequestError,
  createPayPeriod,
  listPayPeriods,
  listPayStructures,
  listStaff,
} from '../auth/api';

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

  // "Getting set up" checklist inputs. Both load silently: a failure just means
  // the checklist (an aid, not a gate) stays hidden or shows less.
  const [structures, setStructures] = useState<PayStructureSummary[] | null>(null);
  const [activeStaffCount, setActiveStaffCount] = useState<number | null>(null);

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

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    listPayStructures(accessToken)
      .then((res) => {
        if (!cancelled) setStructures(res.structures);
      })
      .catch(() => {
        // Silent: without the structure list the checklist simply doesn't show.
      });
    listStaff(accessToken)
      .then((res) => {
        if (cancelled) return;
        // Only members with a staff profile can hold a pay plan.
        setActiveStaffCount(
          res.staff.filter((member) => member.membershipStatus === 'active' && member.staffProfile)
            .length,
        );
      })
      .catch(() => {
        // Silent: step 2 falls back to counting assignments only.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

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

  // --- "Getting set up" checklist state -------------------------------------
  const assignedCount = structures
    ? structures.reduce((sum, structure) => sum + structure.assignedStaffCount, 0)
    : 0;
  const step1Done = structures !== null && structures.length > 0;
  const step2Done =
    activeStaffCount !== null
      ? activeStaffCount > 0 && assignedCount >= activeStaffCount
      : assignedCount > 0;
  const step3Done = periods.some(
    ({ period, totals }) => totals !== null || period.generatedAt !== null,
  );
  const latestDraft = periods.find(({ period }) => period.status === 'draft') ?? null;
  // Render only once the structure list is in; hide entirely when all done.
  const showChecklist = !loading && structures !== null && !(step1Done && step2Done && step3Done);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium">
            Staff pay
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-1">
            Run your team's pay: create pay plans, put people on them, then calculate each week.
          </AppText>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AppButton size="sm" variant="ghost" onClick={() => navigate('/payroll/structures')}>
            Pay plans
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

      {showChecklist ? (
        <AppCard padding="md" elevation="none" className="mb-6 border-[1.5px]">
          <AppText
            as="div"
            variant="caption"
            weight="medium"
            uppercase
            className="text-text-subtle"
          >
            Getting set up
          </AppText>
          <div className="mt-3 space-y-3">
            <ChecklistStep
              index={1}
              done={step1Done}
              title="Create a pay plan"
              detail="A pay plan says how someone gets paid — base pay, commission and any extras."
              ctaLabel="Create a pay plan"
              onCta={() => navigate('/payroll/structures/new')}
            />
            <ChecklistStep
              index={2}
              done={step2Done}
              title="Put your team on plans"
              detail={
                activeStaffCount !== null
                  ? `${assignedCount} of ${activeStaffCount} team members are on a plan.`
                  : `${assignedCount} team ${assignedCount === 1 ? 'member is' : 'members are'} on a plan.`
              }
              ctaLabel="Put people on plans"
              onCta={() => navigate('/payroll/structures')}
            />
            <ChecklistStep
              index={3}
              done={step3Done}
              title="Calculate this week's pay"
              detail="Open a pay period and calculate what everyone earned."
              ctaLabel={
                latestDraft ? 'Open the latest draft' : canEdit ? 'Create period' : undefined
              }
              ctaLoading={!latestDraft && creating}
              onCta={() =>
                latestDraft
                  ? navigate(`/payroll/periods/${latestDraft.period.id}`)
                  : void handleCreate()
              }
            />
          </div>
        </AppCard>
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

/** One "Getting set up" step: plain sentence, a ✓ when done, one CTA when not. */
function ChecklistStep({
  index,
  done,
  title,
  detail,
  ctaLabel,
  ctaLoading,
  onCta,
}: {
  index: number;
  done: boolean;
  title: string;
  detail?: string;
  ctaLabel?: string;
  ctaLoading?: boolean;
  onCta?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
            done
              ? 'border-success-border bg-success-soft text-success'
              : 'border-border-strong bg-surface text-text-secondary',
          )}
        >
          {done ? '✓' : index}
        </span>
        <div className="min-w-0">
          <AppText as="div" weight="medium" className="text-[13px]">
            {title}
          </AppText>
          {detail ? (
            <AppText as="div" variant="caption" tone="muted" className="mt-0.5">
              {detail}
            </AppText>
          ) : null}
        </div>
      </div>
      {!done && ctaLabel && onCta ? (
        <AppButton size="sm" variant="secondary" onClick={onCta} loading={ctaLoading}>
          {ctaLabel}
        </AppButton>
      ) : null}
    </div>
  );
}
