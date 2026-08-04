import { useEffect, useState, type ReactNode } from 'react';
import type {
  AcceleratorConditionResult,
  GreaterOfBreakdown,
  PayrollComparator,
  PaySummaryBreakdown,
} from '@sheer/domain';
import {
  ACCELERATOR_EVALUATION_LABELS,
  ACCELERATOR_METRIC_LABELS,
  HOUR_CATEGORY_LABELS,
  PAY_LINE_TYPE_LABELS,
  THRESHOLD_BASIS_LABELS,
} from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppText, StatusBadge } from '../../design';
import { Modal } from '../team/Modal';
import { formatMoney, signedMoney } from '../kpi/format';
import { formatHours, formatLocalDate, formatTimestamp } from './format';
import { PayrollWarningNotice } from './PayrollWarningNotice';
import { ApiRequestError, getPaySummary } from '../../auth/api';

const HOURS_COLS = '1.5fr 0.6fr 0.9fr 0.6fr';
const LINES_COLS = '1.7fr 0.8fr 0.8fr 0.5fr 0.9fr';

const COMPARATOR_SYMBOLS: Record<PayrollComparator, string> = {
  gte: '≥',
  gt: '>',
  lte: '≤',
  lt: '<',
  eq: '=',
};

/**
 * The explainability drill-down behind a staff row on the pay-period page:
 * everything needed to defend a figure. Hours → target derivation → each
 * commission band priced separately → accelerator condition results →
 * itemised evidence lines → greater-of comparison → adjustments → the final
 * SIGNED net payable. Lines whose transaction source is not captured render
 * an amber "Not captured" chip, never £0.
 */
export function PaySummaryDetailModal({
  summaryId,
  accessToken,
  periodLabel,
  onClose,
}: {
  summaryId: string | null;
  accessToken?: string;
  periodLabel: string;
  onClose: () => void;
}) {
  const [breakdown, setBreakdown] = useState<PaySummaryBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!summaryId || !accessToken) {
      setBreakdown(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBreakdown(null);
    getPaySummary(accessToken, summaryId)
      .then((res) => {
        if (!cancelled) setBreakdown(res.breakdown);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof ApiRequestError ? err.message : 'Unable to load this pay summary',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [summaryId, accessToken]);

  if (!summaryId) return null;

  const summary = breakdown?.summary ?? null;
  const currency = summary?.currencyCode ?? 'GBP';

  return (
    <Modal
      open={!!summaryId}
      onClose={onClose}
      title={breakdown?.staffName ?? 'Pay summary'}
      description={`${periodLabel}${summary ? ` · ${summary.employmentTypeSnapshot}` : ''}`}
      widthClassName="max-w-2xl"
    >
      {loading ? (
        <div className="py-10 text-center text-[13px] text-text-secondary">Loading breakdown…</div>
      ) : error ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : breakdown && summary ? (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <AppText as="div" variant="caption" tone="muted">
              Calculated {formatTimestamp(summary.generatedAt)}
            </AppText>
            <div className="flex items-center gap-2">
              {summary.isStale ? <StatusBadge label="Stale" tone="warning" /> : null}
              {summary.greaterOfApplied ? (
                <StatusBadge label="Greater-of applied" tone="neutral" />
              ) : null}
            </div>
          </div>

          {summary.isStale && summary.staleReason ? (
            <div className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
              <AppText as="div" variant="caption" tone="warning">
                Stale: {summary.staleReason}
              </AppText>
            </div>
          ) : null}

          <PayrollWarningNotice warnings={breakdown.warnings} />

          {/* Hours — where the payable base and the target derivation start */}
          <Section title="Hours">
            <div className="overflow-hidden rounded-input-lg border border-border">
              <div
                className="grid items-center bg-surface-alt px-3 py-2"
                style={{ gridTemplateColumns: HOURS_COLS }}
              >
                {['Category', 'Hours', 'Counts to target', 'Paid'].map((heading) => (
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
              {breakdown.hours.map((entry) => (
                <div
                  key={entry.id}
                  className="grid items-center border-t border-border-divider px-3 py-2"
                  style={{ gridTemplateColumns: HOURS_COLS }}
                >
                  <div className="min-w-0 pr-2">
                    <AppText as="div" className="text-[13px]">
                      {HOUR_CATEGORY_LABELS[entry.category]}
                    </AppText>
                    {entry.notes ? (
                      <AppText as="div" variant="micro" tone="muted" className="mt-0.5">
                        {entry.notes}
                      </AppText>
                    ) : null}
                  </div>
                  <AppText as="div" weight="medium" className="text-[13px]">
                    {formatHours(entry.hours)}
                  </AppText>
                  <CountedFlag counted={entry.countedTowardTarget} />
                  <CountedFlag counted={entry.countedAsPaid} />
                </div>
              ))}
            </div>
          </Section>

          {/* Service revenue target — the figure and how it was arrived at */}
          <Section title="Service revenue target">
            <div className="rounded-input-lg border border-border px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <AppText as="div" weight="medium" className="text-[14px]">
                  {breakdown.target.targetCents !== null
                    ? formatMoney(breakdown.target.targetCents, currency)
                    : 'No target'}
                </AppText>
                {breakdown.target.basis ? (
                  <AppText as="div" variant="micro" tone="muted">
                    {THRESHOLD_BASIS_LABELS[breakdown.target.basis]}
                  </AppText>
                ) : null}
              </div>
              <AppText as="div" variant="caption" tone="muted" className="mt-1">
                {breakdown.target.derivation}
              </AppText>
            </div>
            {breakdown.target.adjustments.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                {breakdown.target.adjustments.map((adjustment) => (
                  <div
                    key={adjustment.id}
                    className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2"
                  >
                    <AppText as="div" variant="caption" tone="warning">
                      Target adjusted {formatMoney(adjustment.originalTargetCents, currency)} →{' '}
                      {formatMoney(adjustment.adjustedTargetCents, currency)} — {adjustment.reason}
                    </AppText>
                    <AppText as="div" variant="micro" tone="muted" className="mt-0.5">
                      {formatTimestamp(adjustment.adjustedAt)}
                      {adjustment.notes ? ` · ${adjustment.notes}` : ''}
                    </AppText>
                  </div>
                ))}
              </div>
            ) : null}
          </Section>

          {/* Commission bands — each slice priced separately */}
          {breakdown.bands.length > 0 ? (
            <Section title="Commission bands">
              <div className="space-y-1.5">
                {breakdown.bands.map((band) => (
                  <div
                    key={band.bandId}
                    className="rounded-input-lg border border-border px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <AppText as="div" weight="medium" className="text-[13px]">
                        From {band.fromLabel}
                      </AppText>
                      <AppText as="div" weight="medium" className="text-[13px]">
                        {formatMoney(band.amountCents, currency)}
                      </AppText>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <AppText as="span" variant="micro" tone="muted">
                        {formatMoney(band.sliceFromCents, currency)} –{' '}
                        {band.sliceToCents !== null
                          ? formatMoney(band.sliceToCents, currency)
                          : 'no upper limit'}{' '}
                        at {band.ratePercentApplied}%
                      </AppText>
                      {band.acceleratorRateApplied ? (
                        <StatusBadge label="Accelerator rate" tone="success" />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Accelerator — per-condition results, incl. why one could not be evaluated */}
          {breakdown.accelerator ? (
            <Section
              title="Accelerator"
              badge={
                breakdown.accelerator.achieved === true ? (
                  <StatusBadge label="Achieved" tone="success" />
                ) : breakdown.accelerator.achieved === false ? (
                  <StatusBadge label="Not achieved" tone="neutral" />
                ) : (
                  <StatusBadge label="Could not evaluate" tone="warning" />
                )
              }
            >
              {breakdown.accelerator.evaluationMode ? (
                <AppText as="div" variant="micro" tone="muted" className="mb-2">
                  {ACCELERATOR_EVALUATION_LABELS[breakdown.accelerator.evaluationMode]}
                  {breakdown.accelerator.evaluationMode === 'at_least_n' &&
                  breakdown.accelerator.requiredConditionCount !== null
                    ? ` (${breakdown.accelerator.requiredConditionCount} required)`
                    : ''}
                </AppText>
              ) : null}
              {breakdown.accelerator.achieved === null ? (
                <AppText as="div" variant="micro" tone="warning" className="mb-2">
                  Counted as not achieved — the lower band rate applies, which is the safe
                  direction.
                </AppText>
              ) : null}
              <div className="space-y-1.5">
                {breakdown.accelerator.conditions.map((condition, index) => (
                  <div
                    key={`${condition.metric}-${index}`}
                    className="flex items-start justify-between gap-3 rounded-input-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <AppText as="div" weight="medium" className="text-[13px]">
                        {ACCELERATOR_METRIC_LABELS[condition.metric]}
                      </AppText>
                      <AppText as="div" variant="micro" tone="muted" className="mt-0.5">
                        Needs {COMPARATOR_SYMBOLS[condition.comparator]}{' '}
                        {conditionValue(condition, condition.thresholdValue, currency)} · actual{' '}
                        {conditionValue(condition, condition.actualValue, currency)}
                      </AppText>
                      {condition.unevaluableReason ? (
                        <AppText as="div" variant="micro" tone="warning" className="mt-0.5">
                          {condition.unevaluableReason}
                        </AppText>
                      ) : null}
                    </div>
                    {condition.passed === true ? (
                      <StatusBadge label="Passed" tone="success" />
                    ) : condition.passed === false ? (
                      <StatusBadge label="Not met" tone="neutral" />
                    ) : (
                      <StatusBadge label="Could not evaluate" tone="warning" />
                    )}
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Itemised lines — the drill-down to source transactions */}
          <Section title="Itemised lines">
            {breakdown.lines.length === 0 ? (
              <AppText as="div" variant="caption" tone="muted">
                No lines recorded for this summary.
              </AppText>
            ) : (
              <div className="overflow-hidden rounded-input-lg border border-border">
                <div
                  className="grid items-center bg-surface-alt px-3 py-2"
                  style={{ gridTemplateColumns: LINES_COLS }}
                >
                  {['Line', 'Date', 'Basis', 'Rate', 'Amount'].map((heading) => (
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
                {breakdown.lines.map((line) => (
                  <div
                    key={line.id}
                    className="grid items-center border-t border-border-divider px-3 py-2"
                    style={{ gridTemplateColumns: LINES_COLS }}
                  >
                    <div className="min-w-0 pr-2">
                      <AppText as="div" className="truncate text-[13px]">
                        {line.label ?? PAY_LINE_TYPE_LABELS[line.lineType]}
                      </AppText>
                      <AppText
                        as="div"
                        variant="micro"
                        className="mt-0.5 truncate text-text-subtle"
                      >
                        {PAY_LINE_TYPE_LABELS[line.lineType]}
                        {line.sourceType ? ` · ${line.sourceType.replace(/_/g, ' ')}` : ''}
                      </AppText>
                    </div>
                    <AppText as="div" variant="micro" tone="muted">
                      {line.occurredOn ? formatLocalDate(line.occurredOn) : '—'}
                    </AppText>
                    <AppText as="div" className="text-[13px]">
                      {line.basisAmountCents !== null
                        ? formatMoney(line.basisAmountCents, currency)
                        : '—'}
                    </AppText>
                    <AppText as="div" className="text-[13px]">
                      {line.ratePercent !== null ? `${line.ratePercent}%` : '—'}
                    </AppText>
                    {line.sourceUnavailable ? (
                      // "We are not recording this", NOT "this was zero" — never £0.
                      <div>
                        <StatusBadge label="Not captured" tone="warning" />
                      </div>
                    ) : (
                      <AppText as="div" weight="medium" className="text-[13px]">
                        {signedMoney(line.amountCents, currency)}
                      </AppText>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Greater-of — both sides survive, with the winner recorded */}
          {breakdown.greaterOf ? (
            <Section
              title="Whichever is higher"
              badge={
                breakdown.greaterOf.applied ? (
                  <StatusBadge label="Applied" tone="success" />
                ) : (
                  <StatusBadge label="Not applied" tone="neutral" />
                )
              }
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <GreaterOfSide
                  label="Base pay"
                  amountCents={breakdown.greaterOf.basePayCents}
                  currency={currency}
                  winner={breakdown.greaterOf.winner === 'base_pay'}
                />
                <GreaterOfSide
                  label="Commission"
                  amountCents={breakdown.greaterOf.commissionCents}
                  currency={currency}
                  winner={breakdown.greaterOf.winner === 'commission'}
                />
                {breakdown.greaterOf.revenueSplitCents !== null ? (
                  <GreaterOfSide
                    label="Revenue split"
                    amountCents={breakdown.greaterOf.revenueSplitCents}
                    currency={currency}
                    winner={breakdown.greaterOf.winner === 'revenue_split'}
                  />
                ) : null}
              </div>
              {winnerCaption(breakdown.greaterOf)}
            </Section>
          ) : null}

          {/* Adjustments carried in from earlier locked periods */}
          {breakdown.adjustments.length > 0 ? (
            <Section title="Adjustments carried in">
              <div className="space-y-1.5">
                {breakdown.adjustments.map((adjustment) => (
                  <div
                    key={adjustment.id}
                    className="flex items-start justify-between gap-3 rounded-input-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <AppText as="div" className="text-[13px]">
                        {adjustment.description}
                      </AppText>
                      <AppText as="div" variant="micro" tone="muted" className="mt-0.5 capitalize">
                        {adjustment.reason}
                      </AppText>
                    </div>
                    <AppText as="div" weight="medium" className="shrink-0 text-[13px]">
                      {signedMoney(adjustment.amountCents, currency)}
                    </AppText>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {/* Totals — the settlement statement roll-up */}
          <Section title="Totals">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <Stat label="Base pay" value={formatMoney(summary.basePayCents, currency)} />
              <Stat label="Commission" value={formatMoney(summary.commissionCents, currency)} />
              <Stat
                label="Revenue split"
                value={formatMoney(summary.revenueSplitCents, currency)}
              />
              <Stat label="Bonus" value={formatMoney(summary.bonusCents, currency)} />
              <Stat label="Chair rent" value={formatMoney(summary.chairRentCents, currency)} />
              <Stat label="Deductions" value={formatMoney(summary.deductionsCents, currency)} />
              <Stat label="Tips owed" value={formatMoney(summary.tipsOwedCents, currency)} />
              <Stat label="Adjustments" value={signedMoney(summary.adjustmentsCents, currency)} />
            </div>
            <div className="mt-3 flex items-center justify-between rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
              <AppText as="div" weight="medium" className="text-[13px]">
                Net payable
              </AppText>
              <AppText
                as="div"
                variant="title"
                weight="medium"
                tone={summary.netPayableCents > 0 ? 'success' : 'primary'}
              >
                {signedMoney(summary.netPayableCents, currency)}
              </AppText>
            </div>
            {summary.netPayableCents < 0 ? (
              <AppText as="div" variant="micro" tone="muted" className="mt-1.5">
                Negative means the staff member owes the business — normal for chair renters paying
                rent out of takings held by the salon.
              </AppText>
            ) : null}
          </Section>
        </div>
      ) : null}
    </Modal>
  );
}

function Section({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <AppText as="div" variant="caption" weight="medium" uppercase className="text-text-subtle">
          {title}
        </AppText>
        {badge ?? null}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <AppText as="div" variant="micro" tone="muted" className="truncate">
        {label}
      </AppText>
      <AppText as="div" weight="medium" className="mt-0.5 text-[14px]">
        {value}
      </AppText>
    </div>
  );
}

function CountedFlag({ counted }: { counted: boolean }) {
  return counted ? (
    <AppText as="div" weight="medium" tone="success" className="text-[13px]">
      ✓
    </AppText>
  ) : (
    <AppText as="div" tone="muted" className="text-[13px]">
      —
    </AppText>
  );
}

function GreaterOfSide({
  label,
  amountCents,
  currency,
  winner,
}: {
  label: string;
  amountCents: number;
  currency: string;
  winner: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-input-lg border px-3 py-2',
        winner ? 'border-success bg-success-soft' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <AppText as="div" variant="micro" tone="muted">
          {label}
        </AppText>
        {winner ? <StatusBadge label="Paid" tone="success" /> : null}
      </div>
      <AppText as="div" weight="medium" className="mt-0.5 text-[14px]">
        {formatMoney(amountCents, currency)}
      </AppText>
    </div>
  );
}

function winnerCaption(greaterOf: GreaterOfBreakdown): ReactNode {
  if (!greaterOf.applied || !greaterOf.winner) return null;
  return (
    <AppText as="div" variant="micro" tone="muted" className="mt-1.5">
      {PAY_LINE_TYPE_LABELS[greaterOf.winner]} was the higher figure, so it is what gets paid.
    </AppText>
  );
}

/**
 * Format an accelerator condition value in its own unit: percentage metrics as
 * %, money metrics as currency (values arrive in integer cents). A null value
 * renders as an explicit dash, never a fabricated 0.
 */
function conditionValue(
  condition: AcceleratorConditionResult,
  value: number | null,
  currency: string,
): string {
  if (value === null) return '—';
  if (condition.basis === 'target_met') return value ? 'Met' : 'Not met';
  if (condition.basis === 'percent' || condition.metric.endsWith('_percent')) {
    return `${value}%`;
  }
  return formatMoney(value, currency);
}
