import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type {
  ListPaySummariesResponse,
  PayPeriodDetailResponse,
  PayrollMissingInput,
  PayrollReadiness,
  PayrollStaffReadiness,
  PayrollWarning,
} from '@sheer/domain';
import {
  PAY_PERIOD_FREQUENCY_LABELS,
  PAY_PERIOD_KIND_LABELS,
  PAY_PERIOD_STATUS_LABELS,
  isBlockingPayrollWarning,
  userHasPermission,
} from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppButton, AppCard, AppText, StatusBadge, type StatusTone } from '../design';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { formatMoney, signedMoney } from '../components/kpi/format';
import {
  PAY_PERIOD_STATUS_TONES,
  formatHours,
  formatTimestamp,
  payPeriodWindowLabel,
} from '../components/payroll/format';
import { PayrollWarningNotice } from '../components/payroll/PayrollWarningNotice';
import { PaySummaryDetailModal } from '../components/payroll/PaySummaryDetailModal';
import { AssignStructureModal } from '../components/payroll/AssignStructureModal';
import { useAuth } from '../auth/AuthProvider';
import {
  ApiRequestError,
  generatePayPeriod,
  getPayPeriod,
  listPaySummaries,
  transitionPayPeriod,
  type PayPeriodTransitionAction,
} from '../auth/api';

const COLS = '1.5fr 1.1fr 0.6fr 0.85fr 0.9fr 0.85fr 0.9fr 0.8fr 0.85fr 1fr';

type BusyAction = 'generate' | PayPeriodTransitionAction;

/**
 * One pay period: readiness, workflow transitions and the per-staff summary
 * table. Every workflow button is gated by BOTH the actor's permission and the
 * period's current status — there are deliberately no un-approve/revert
 * controls (locked periods are corrected in the next period, never reopened).
 */
export function PayrollPeriodDetailPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const params = useParams<{ periodId: string }>();
  const periodId = params.periodId;

  const canView = userHasPermission(auth.user, 'payroll.view');
  const canEdit = userHasPermission(auth.user, 'payroll.edit');
  const canApprove = userHasPermission(auth.user, 'payroll.approve');
  const canLock = userHasPermission(auth.user, 'payroll.lock');

  const [detail, setDetail] = useState<PayPeriodDetailResponse | null>(null);
  const [summariesRes, setSummariesRes] = useState<ListPaySummariesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Readiness from a 422 generate refusal — takes precedence over the loaded one. */
  const [blockedReadiness, setBlockedReadiness] = useState<PayrollReadiness | null>(null);
  const [selectedSummaryId, setSelectedSummaryId] = useState<string | null>(null);
  /** Staff member an "Assign pay plan…" modal is open for. */
  const [assignTarget, setAssignTarget] = useState<{
    staffProfileId: string;
    staffName: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !periodId) return;
    setLoading(true);
    setError(null);
    try {
      const [detailRes, listRes] = await Promise.all([
        getPayPeriod(accessToken, periodId),
        listPaySummaries(accessToken, periodId),
      ]);
      setDetail(detailRes);
      setSummariesRes(listRes);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load the pay period');
    } finally {
      setLoading(false);
    }
  }, [accessToken, periodId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleGenerate = useCallback(async () => {
    if (!accessToken || !periodId) return;
    setActionBusy('generate');
    setActionError(null);
    setBlockedReadiness(null);
    try {
      await generatePayPeriod(accessToken, periodId);
      await load();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 422) {
        // The engine refused rather than silently producing £0 statements.
        const details = err.details as { readiness?: PayrollReadiness } | undefined;
        if (details?.readiness) setBlockedReadiness(details.readiness);
        setActionError(err.message);
      } else {
        setActionError(
          err instanceof ApiRequestError ? err.message : 'Unable to calculate pay for this period',
        );
      }
    } finally {
      setActionBusy(null);
    }
  }, [accessToken, periodId, load]);

  const handleTransition = useCallback(
    async (action: PayPeriodTransitionAction) => {
      if (!accessToken || !periodId) return;
      setActionBusy(action);
      setActionError(null);
      try {
        await transitionPayPeriod(accessToken, periodId, action);
        await load();
      } catch (err) {
        setActionError(
          err instanceof ApiRequestError ? err.message : 'Unable to update this pay period',
        );
      } finally {
        setActionBusy(null);
      }
    },
    [accessToken, periodId, load],
  );

  if (auth.user && !canView) {
    return <Navigate to="/dashboard" replace />;
  }

  const period = detail?.period ?? null;
  const totals = detail?.totals ?? null;
  const readiness = blockedReadiness ?? detail?.readiness ?? null;
  const summaries = summariesRes?.summaries ?? [];
  const stamps = period
    ? [
        period.generatedAt ? `Calculated ${formatTimestamp(period.generatedAt)}` : null,
        period.approvedAt ? `Approved ${formatTimestamp(period.approvedAt)}` : null,
        period.lockedAt ? `Locked ${formatTimestamp(period.lockedAt)}` : null,
        period.paidAt ? `Paid ${formatTimestamp(period.paidAt)}` : null,
      ].filter((stamp): stamp is string => stamp !== null)
    : [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <Link
        to="/payroll"
        className="text-[12px] font-medium text-primary transition hover:text-primary-deep"
      >
        ← All pay periods
      </Link>

      {loading && !detail ? (
        <div className="mt-4 rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading pay period…
        </div>
      ) : error && !detail ? (
        <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : period ? (
        <>
          <header className="mb-6 mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <AppText as="h1" variant="heading" weight="medium">
                  {payPeriodWindowLabel(period)}
                </AppText>
                <StatusBadge
                  label={PAY_PERIOD_STATUS_LABELS[period.status]}
                  tone={PAY_PERIOD_STATUS_TONES[period.status]}
                />
              </div>
              <AppText as="p" variant="caption" tone="muted" className="mt-1">
                {PAY_PERIOD_KIND_LABELS[period.kind]} ·{' '}
                {PAY_PERIOD_FREQUENCY_LABELS[period.frequency]}
                {period.label ? ` · ${period.label}` : ''}
              </AppText>
              {stamps.length > 0 ? (
                <AppText as="p" variant="micro" tone="muted" className="mt-1">
                  {stamps.join(' · ')}
                </AppText>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {period.status === 'draft' && canEdit ? (
                <>
                  <AppButton
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleGenerate()}
                    loading={actionBusy === 'generate'}
                    disabled={actionBusy !== null && actionBusy !== 'generate'}
                  >
                    {period.generatedAt ? 'Recalculate pay' : 'Calculate pay'}
                  </AppButton>
                  <AppButton
                    size="sm"
                    onClick={() => void handleTransition('ready')}
                    loading={actionBusy === 'ready'}
                    disabled={actionBusy !== null && actionBusy !== 'ready'}
                  >
                    Send for review
                  </AppButton>
                </>
              ) : null}
              {period.status === 'ready_for_review' && canApprove ? (
                <AppButton
                  size="sm"
                  onClick={() => void handleTransition('approve')}
                  loading={actionBusy === 'approve'}
                  disabled={actionBusy !== null && actionBusy !== 'approve'}
                >
                  Approve
                </AppButton>
              ) : null}
              {period.status === 'approved' && canLock ? (
                <AppButton
                  size="sm"
                  onClick={() => void handleTransition('lock')}
                  loading={actionBusy === 'lock'}
                  disabled={actionBusy !== null && actionBusy !== 'lock'}
                >
                  Lock
                </AppButton>
              ) : null}
              {period.status === 'locked' && canLock ? (
                <AppButton
                  size="sm"
                  onClick={() => void handleTransition('mark-paid')}
                  loading={actionBusy === 'mark-paid'}
                  disabled={actionBusy !== null && actionBusy !== 'mark-paid'}
                >
                  Mark paid
                </AppButton>
              ) : null}
            </div>
          </header>

          {actionError ? (
            <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {actionError}
            </div>
          ) : null}

          {readiness ? (
            <ReadinessPanel
              readiness={readiness}
              canEdit={canEdit}
              onAssignStructure={(staff) =>
                setAssignTarget({
                  staffProfileId: staff.staffProfileId,
                  staffName: staff.staffName,
                })
              }
            />
          ) : null}

          {totals ? (
            <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryStat label="Staff" value={String(totals.staffCount)} />
              <SummaryStat
                label="Base pay"
                value={formatMoney(totals.totalBasePayCents, totals.currencyCode)}
              />
              <SummaryStat
                label="Commission"
                value={formatMoney(totals.totalCommissionCents, totals.currencyCode)}
              />
              <SummaryStat
                label="Net payable"
                value={signedMoney(totals.totalNetPayableCents, totals.currencyCode)}
                tone={totals.totalNetPayableCents > 0 ? 'success' : 'primary'}
              />
            </div>
          ) : null}

          {totals && totals.staleCount > 0 ? (
            <div className="mb-5 rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3">
              <AppText as="div" variant="caption" tone="warning">
                {totals.staleCount} {totals.staleCount === 1 ? 'summary is' : 'summaries are'} stale
                — the underlying data changed after pay was calculated. Recalculate pay before
                approving.
              </AppText>
            </div>
          ) : null}

          {summariesRes && summariesRes.periodWarnings.length > 0 ? (
            <CollapsedCaptureNotice warnings={summariesRes.periodWarnings} className="mb-5" />
          ) : null}

          <SectionLabel>Staff summaries</SectionLabel>
          {summaries.length === 0 ? (
            <div className="rounded-input-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-text-secondary">
              {period.generatedAt
                ? 'No staff summaries in this period. No staff member was on a pay plan over this window.'
                : 'Pay has not been calculated yet. Use "Calculate pay" to work out what each person earned.'}
            </div>
          ) : (
            <AppCard padding="none" elevation="none" className="overflow-x-auto border-[1.5px]">
              <div className="min-w-[960px]">
                <div
                  className="grid items-center bg-surface-alt px-4 py-2.5"
                  style={{ gridTemplateColumns: COLS }}
                >
                  {[
                    'Staff',
                    'Pay plan',
                    'Hours',
                    'Target',
                    'Service rev.',
                    'Base pay',
                    'Commission',
                    'Accelerator',
                    'Deductions',
                    'Net payable',
                  ].map((heading) => (
                    <AppText
                      key={heading}
                      as="div"
                      variant="micro"
                      weight="medium"
                      uppercase
                      className="text-text-subtle"
                    >
                      {heading}
                    </AppText>
                  ))}
                </div>

                {summaries.map((summary) => (
                  <button
                    key={summary.summaryId}
                    type="button"
                    onClick={() => setSelectedSummaryId(summary.summaryId)}
                    className="grid w-full items-center border-t border-border-divider bg-surface px-4 py-3 text-left transition hover:bg-surface-alt"
                    style={{ gridTemplateColumns: COLS }}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <AppText as="div" weight="medium" className="truncate text-[13px]">
                          {summary.staffName}
                        </AppText>
                        {summary.isStale ? <StatusBadge label="Stale" tone="warning" /> : null}
                      </div>
                      {summary.warnings.length > 0 ? (
                        <AppText as="div" variant="micro" tone="warning" className="mt-0.5">
                          {summary.warnings.length}{' '}
                          {summary.warnings.length === 1 ? 'warning' : 'warnings'}
                        </AppText>
                      ) : null}
                    </div>
                    <div className="min-w-0 pr-2">
                      <AppText as="div" className="truncate text-[13px]">
                        {summary.structureName ?? '—'}
                      </AppText>
                      {summary.structureVersionNo !== null ? (
                        <AppText as="div" variant="micro" className="mt-0.5 text-text-subtle">
                          v{summary.structureVersionNo}
                        </AppText>
                      ) : null}
                    </div>
                    <AppText as="div" className="text-[13px]">
                      {formatHours(summary.payableHours)}
                    </AppText>
                    <AppText as="div" className="text-[13px]">
                      {summary.serviceRevenueTargetCents !== null
                        ? formatMoney(summary.serviceRevenueTargetCents, summary.currencyCode)
                        : '—'}
                    </AppText>
                    <AppText as="div" className="text-[13px]">
                      {formatMoney(summary.serviceRevenueCents, summary.currencyCode)}
                    </AppText>
                    <AppText as="div" className="text-[13px]">
                      {formatMoney(summary.basePayCents, summary.currencyCode)}
                    </AppText>
                    <AppText as="div" className="text-[13px]">
                      {formatMoney(summary.commissionCents, summary.currencyCode)}
                    </AppText>
                    <div>
                      {summary.acceleratorAchieved === true ? (
                        <AppText as="span" weight="medium" tone="success" className="text-[13px]">
                          ✓
                        </AppText>
                      ) : summary.acceleratorAchieved === false ? (
                        <AppText as="span" tone="muted" className="text-[13px]">
                          —
                        </AppText>
                      ) : (
                        <StatusBadge label="Can't evaluate" tone="warning" />
                      )}
                    </div>
                    <AppText as="div" className="text-[13px]">
                      {formatMoney(summary.deductionsCents, summary.currencyCode)}
                    </AppText>
                    <AppText
                      as="div"
                      weight="medium"
                      tone={summary.netPayableCents > 0 ? 'success' : 'primary'}
                      className="text-[13px]"
                    >
                      {signedMoney(summary.netPayableCents, summary.currencyCode)}
                    </AppText>
                  </button>
                ))}
              </div>
            </AppCard>
          )}

          <PaySummaryDetailModal
            summaryId={selectedSummaryId}
            accessToken={accessToken}
            periodLabel={payPeriodWindowLabel(period)}
            onClose={() => setSelectedSummaryId(null)}
          />

          {assignTarget ? (
            <AssignStructureModal
              staffProfileId={assignTarget.staffProfileId}
              staffName={assignTarget.staffName}
              defaultEffectiveFrom={period?.periodStart}
              onClose={() => setAssignTarget(null)}
              onAssigned={() => {
                // The 422-blocked snapshot is stale once an assignment lands.
                setBlockedReadiness(null);
                void load();
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** True when this staff member's warnings include the given missing input. */
function hasMissingInput(staff: PayrollStaffReadiness, input: PayrollMissingInput): boolean {
  return staff.warnings.some(
    (warning) => warning.kind === 'input_missing' && warning.input === input,
  );
}

/** True when this staff member is blocked for want of a pay structure. */
function needsPayStructure(staff: PayrollStaffReadiness): boolean {
  return hasMissingInput(staff, 'pay_structure');
}

/** One plain-English status chip per staff member. Detail stays one click away. */
function staffReadinessChip(staff: PayrollStaffReadiness): { label: string; tone: StatusTone } {
  if (staff.canGenerate) {
    return staff.warnings.length === 0
      ? { label: 'Ready ✓', tone: 'success' }
      : { label: 'Ready — notes', tone: 'warning' };
  }
  if (needsPayStructure(staff)) return { label: 'Needs pay plan', tone: 'danger' };
  if (hasMissingInput(staff, 'hourly_rate')) return { label: 'Needs hourly rate', tone: 'danger' };
  return { label: 'Needs setup', tone: 'danger' };
}

/**
 * Business-level capture notices, folded to one plain sentence. The full
 * per-source list (and any blocking warnings, which are never folded) stays one
 * "Details" click away — information is folded here, never deleted.
 */
function CollapsedCaptureNotice({
  warnings,
  className,
}: {
  warnings: PayrollWarning[];
  className?: string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const blocking = warnings.filter((warning) => isBlockingPayrollWarning(warning));
  const advisory = warnings.filter((warning) => !isBlockingPayrollWarning(warning));
  if (warnings.length === 0) return null;
  return (
    <div className={cn('space-y-2', className)}>
      {blocking.length > 0 ? <PayrollWarningNotice warnings={blocking} /> : null}
      {advisory.length > 0 ? (
        <div className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AppText as="span" variant="caption" tone="warning">
              Retail, tips, refunds and cancellation fees aren't tracked yet, so they can't affect
              pay.
            </AppText>
            <button
              type="button"
              onClick={() => setShowDetails((value) => !value)}
              className="text-[12px] font-medium text-warning underline underline-offset-2"
            >
              {showDetails ? 'Hide details' : 'Details'}
            </button>
          </div>
          {showDetails ? <PayrollWarningNotice warnings={advisory} className="mt-2" /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One readiness row: name + status chip; the warning detail unfolds on click. */
function StaffReadinessRow({
  staff,
  canEdit,
  onAssignStructure,
}: {
  staff: PayrollStaffReadiness;
  canEdit: boolean;
  onAssignStructure: (staff: PayrollStaffReadiness) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const chip = staffReadinessChip(staff);
  const hasDetails = staff.warnings.length > 0;
  return (
    <div className="rounded-input-lg border border-border-divider bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => hasDetails && setExpanded((value) => !value)}
          disabled={!hasDetails}
          className={cn(
            'flex min-w-0 items-center gap-2 text-left',
            hasDetails ? 'cursor-pointer' : 'cursor-default',
          )}
          aria-expanded={hasDetails ? expanded : undefined}
        >
          {hasDetails ? (
            <span
              className={cn(
                'text-[10px] text-text-subtle transition-transform',
                expanded && 'rotate-90',
              )}
              aria-hidden
            >
              ▶
            </span>
          ) : null}
          <AppText as="span" variant="caption" weight="medium" className="truncate">
            {staff.staffName}
          </AppText>
          <StatusBadge label={chip.label} tone={chip.tone} />
        </button>
        {canEdit && needsPayStructure(staff) ? (
          <AppButton size="sm" variant="secondary" onClick={() => onAssignStructure(staff)}>
            Assign pay plan…
          </AppButton>
        ) : null}
      </div>
      {expanded && hasDetails ? (
        <PayrollWarningNotice warnings={staff.warnings} className="mt-2" />
      ) : null}
    </div>
  );
}

/**
 * Pre-flight readiness. Red when calculation is blocked (missing pay inputs —
 * calculating anyway would silently pay £0), amber when the figures would only
 * carry data notes. Staff missing a pay plan get an inline assign action so
 * the fix is one click away from the refusal. Rows fold their warning detail
 * behind a chip; nothing is deleted, only folded.
 */
function ReadinessPanel({
  readiness,
  canEdit,
  onAssignStructure,
}: {
  readiness: PayrollReadiness;
  canEdit: boolean;
  onAssignStructure: (staff: PayrollStaffReadiness) => void;
}) {
  const warnedStaff = readiness.staff.filter(
    (staff) => staff.canGenerate && staff.warnings.length > 0,
  );
  if (readiness.canGenerate && readiness.warnings.length === 0 && warnedStaff.length === 0) {
    return null;
  }
  return (
    <AppCard
      variant={readiness.canGenerate ? 'warning' : 'danger'}
      padding="md"
      elevation="none"
      className="mb-5"
    >
      <AppText
        as="div"
        variant="caption"
        weight="medium"
        uppercase
        tone={readiness.canGenerate ? 'warning' : 'danger'}
      >
        {readiness.canGenerate ? "Notes about this week's numbers" : 'Before you can calculate pay'}
      </AppText>
      {!readiness.canGenerate ? (
        <AppText as="p" variant="caption" tone="muted" className="mt-1">
          Some people below are missing something payroll needs — without it their pay would come
          out as £0. Fix each one, then calculate pay.
        </AppText>
      ) : null}
      <div className="mt-3 space-y-2">
        <CollapsedCaptureNotice warnings={readiness.warnings} />
        {readiness.staff.map((staff) => (
          <StaffReadinessRow
            key={staff.staffProfileId}
            staff={staff}
            canEdit={canEdit}
            onAssignStructure={onAssignStructure}
          />
        ))}
      </div>
    </AppCard>
  );
}

function SummaryStat({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'success' | 'muted';
}) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 shadow-sm">
      <AppText as="div" variant="micro" tone="muted" uppercase>
        {label}
      </AppText>
      <AppText
        as="div"
        variant="title"
        weight="medium"
        tone={tone === 'success' ? 'success' : tone === 'muted' ? 'muted' : 'primary'}
        className="mt-0.5"
      >
        {value}
      </AppText>
    </div>
  );
}
