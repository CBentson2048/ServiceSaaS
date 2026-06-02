import type { ReactNode } from 'react';
import type { StylistKpiResult } from '@sheer/domain';
import { AppCard, AppText, StatusBadge } from '../../design';
import { KpiProgressBar } from './KpiProgressBar';
import { formatMoney, noteLabel } from './format';

/**
 * Owner/manager-facing KPI card for one stylist over the selected period.
 * Shows the live targets, target progress, the three KPI verdicts, and the
 * overall commission unlock state — all from real backend KPI outputs.
 */
export function StylistKpiCard({
  stylist,
  onOpenDetail,
}: {
  stylist: StylistKpiResult;
  onOpenDetail?: () => void;
}) {
  const { currencyCode, rebooking, retail, averageBill } = stylist;

  return (
    <AppCard padding="none" elevation="card" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border bg-surface-alt/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-text-on-primary"
            aria-hidden
          >
            {initials(stylist.stylistName)}
          </span>
          <div className="min-w-0">
            <AppText as="div" variant="body" weight="medium" className="truncate">
              {stylist.stylistName}
            </AppText>
            <AppText as="div" variant="micro" tone="muted" className="truncate">
              {stylist.locationName} · {formatHours(stylist.hoursWorked)} worked
            </AppText>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusBadge
            label={stylist.allKpisMet ? 'Commission ready' : 'Locked'}
            tone={stylist.allKpisMet ? 'success' : 'neutral'}
          />
          {onOpenDetail ? (
            <button
              type="button"
              onClick={onOpenDetail}
              className="text-[11px] font-medium text-primary transition hover:text-primary-deep focus:outline-none focus-visible:underline"
            >
              Breakdown →
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 px-4 py-3.5">
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
      </div>

      <div className="divide-y divide-border border-t border-border">
        <KpiRow
          label="Rebooking"
          detail={`${rebooking.rebookedVisits}/${rebooking.completedVisits} visits · ${rebooking.rebookingRatePercent}% (target ${rebooking.thresholdPercent}%)`}
          met={stylist.rebookingKpiMet}
        />
        <KpiRow
          label="Retail"
          detail={`${formatMoney(retail.actualRetailSalesCents, currencyCode)} vs ${formatMoney(
            retail.retailTargetCents,
            currencyCode,
          )} (${signedMoney(retail.varianceCents, currencyCode)})`}
          met={stylist.retailKpiMet}
        />
        <KpiRow
          label="Average bill"
          detail={
            averageBill.hasBenchmark
              ? `${formatMoney(averageBill.actualAverageBillCents, currencyCode)} vs ${formatMoney(
                  averageBill.benchmarkCents,
                  currencyCode,
                )} benchmark`
              : 'No benchmark set'
          }
          met={stylist.averageBillKpiMet}
        />
      </div>

      {stylist.notes.length > 0 ? (
        <div className="border-t border-border bg-surface-alt/40 px-4 py-2">
          <AppText as="div" variant="micro" tone="muted">
            {stylist.notes.map(noteLabel).join(' · ')}
          </AppText>
        </div>
      ) : null}
    </AppCard>
  );
}

function KpiRow({ label, detail, met }: { label: string; detail: ReactNode; met: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <AppText as="div" variant="caption" weight="medium">
          {label}
        </AppText>
        <AppText as="div" variant="micro" tone="muted" className="truncate">
          {detail}
        </AppText>
      </div>
      <StatusBadge label={met ? 'Met' : 'Not met'} tone={met ? 'success' : 'warning'} />
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
