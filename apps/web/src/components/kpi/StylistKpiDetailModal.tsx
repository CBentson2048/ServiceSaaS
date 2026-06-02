import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { StylistKpiResult } from '@sheer/domain';
import { AppText, StatusBadge } from '../../design';
import { Modal } from '../team/Modal';
import { KpiProgressBar } from './KpiProgressBar';
import { formatMoney, noteLabel } from './format';

/**
 * Full per-stylist KPI breakdown — the drill-down behind a Performance card.
 * Surfaces every field the compact card omits (rebooking source split, paid
 * visits, exact variances, the hours × rate target derivation) and, when a
 * benchmark is missing, an actionable link to set it. All values are the real
 * backend KPI outputs already loaded into the page — no extra fetch.
 */
export function StylistKpiDetailModal({
  stylist,
  periodLabel,
  canManageBenchmarks,
  onClose,
}: {
  stylist: StylistKpiResult | null;
  periodLabel: string;
  canManageBenchmarks: boolean;
  onClose: () => void;
}) {
  if (!stylist) return null;
  const { currencyCode, rebooking, retail, averageBill } = stylist;

  return (
    <Modal
      open={!!stylist}
      onClose={onClose}
      title={stylist.stylistName}
      description={`${stylist.locationName} · ${periodLabel}`}
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          <AppText as="div" variant="caption" tone="muted">
            {formatHours(stylist.hoursWorked)} worked · rate {formatMoney(stylist.hourlyRateCents, currencyCode)}/h
          </AppText>
          <StatusBadge
            label={stylist.allKpisMet ? 'Commission ready' : 'Locked'}
            tone={stylist.allKpisMet ? 'success' : 'neutral'}
          />
        </div>

        {/* Targets */}
        <Section title="Targets">
          <div className="space-y-3">
            <KpiProgressBar
              label="Service target"
              actualCents={stylist.actualServiceRevenueCents}
              targetCents={stylist.serviceTargetCents}
              progressPercent={stylist.serviceTargetProgressPercent}
              currencyCode={currencyCode}
              met={stylist.actualServiceRevenueCents >= stylist.serviceTargetCents && stylist.serviceTargetCents > 0}
            />
            <KpiProgressBar
              label="Retail target"
              actualCents={stylist.actualRetailRevenueCents}
              targetCents={stylist.retailTargetCents}
              progressPercent={stylist.retailTargetProgressPercent}
              currencyCode={currencyCode}
              met={stylist.retailKpiMet}
            />
            <AppText as="div" variant="micro" tone="muted">
              Service target = {formatHours(stylist.hoursWorked)} × {formatMoney(stylist.hourlyRateCents, currencyCode)} × 3
              · retail target = 10% of service target.
            </AppText>
          </div>
        </Section>

        {/* Rebooking */}
        <Section title="Rebooking" met={stylist.rebookingKpiMet}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Stat label="Completed visits" value={String(rebooking.completedVisits)} />
            <Stat label="Rebooked" value={String(rebooking.rebookedVisits)} />
            <Stat label="Rate" value={`${rebooking.rebookingRatePercent}%`} />
            <Stat label="By stylist" value={String(rebooking.stylistRebookedVisits)} />
            <Stat label="By client" value={String(rebooking.clientRebookedVisits)} />
            <Stat label="Target" value={`${rebooking.thresholdPercent}%`} />
          </div>
        </Section>

        {/* Retail */}
        <Section title="Retail" met={stylist.retailKpiMet}>
          <div className="grid grid-cols-3 gap-x-4 gap-y-2">
            <Stat label="Target" value={formatMoney(retail.retailTargetCents, currencyCode)} />
            <Stat label="Actual" value={formatMoney(retail.actualRetailSalesCents, currencyCode)} />
            <Stat
              label="Variance"
              value={signedMoney(retail.varianceCents, currencyCode)}
              tone={retail.varianceCents >= 0 ? 'success' : 'warning'}
            />
          </div>
        </Section>

        {/* Average bill */}
        <Section title="Average bill" met={stylist.averageBillKpiMet}>
          {averageBill.hasBenchmark ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              <Stat label="Benchmark" value={formatMoney(averageBill.benchmarkCents, currencyCode)} />
              <Stat label="Actual" value={formatMoney(averageBill.actualAverageBillCents, currencyCode)} />
              <Stat
                label="Variance"
                value={signedMoney(averageBill.varianceCents, currencyCode)}
                tone={averageBill.varianceCents >= 0 ? 'success' : 'warning'}
              />
              <Stat label="Paid visits" value={String(averageBill.paidVisits)} />
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
              <AppText as="div" variant="caption" tone="warning">
                No average-bill benchmark set, so this KPI can&apos;t be evaluated.
              </AppText>
              {canManageBenchmarks ? (
                <Link to="/team" className="text-[12px] font-medium text-primary transition hover:text-primary-deep">
                  Set a benchmark in Team →
                </Link>
              ) : null}
            </div>
          )}
        </Section>

        {stylist.notes.length > 0 ? (
          <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
            <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
              Data quality
            </AppText>
            <ul className="mt-1 space-y-0.5">
              {stylist.notes.map((note) => (
                <li key={note}>
                  <AppText as="span" variant="micro" tone="muted">
                    • {noteLabel(note)}
                  </AppText>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Section({ title, met, children }: { title: string; met?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <AppText as="div" variant="caption" weight="medium" uppercase className="text-text-subtle">
          {title}
        </AppText>
        {met !== undefined ? (
          <StatusBadge label={met ? 'Met' : 'Not met'} tone={met ? 'success' : 'warning'} />
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' }) {
  return (
    <div className="min-w-0">
      <AppText as="div" variant="micro" tone="muted" className="truncate">
        {label}
      </AppText>
      <AppText as="div" weight="medium" tone={tone ?? 'primary'} className="mt-0.5 text-[14px]">
        {value}
      </AppText>
    </div>
  );
}

function signedMoney(cents: number, currencyCode: string): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${formatMoney(Math.abs(cents), currencyCode)}`;
}

function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}
