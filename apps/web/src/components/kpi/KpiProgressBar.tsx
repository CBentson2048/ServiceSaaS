import { clampPercent, formatMoney } from './format';

type ProgressTone = 'brand' | 'success' | 'warning';

const FILL: Record<ProgressTone, string> = {
  brand: 'bg-primary',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
};

/**
 * A labelled target-progress bar: "label … £actual / £target (xx%)" with a
 * filled track. The numeric percentage can exceed 100%, but the bar fill is
 * capped at 100% so an over-target stylist doesn't overflow the track.
 */
export function KpiProgressBar({
  label,
  actualCents,
  targetCents,
  progressPercent,
  currencyCode,
  met,
}: {
  label: string;
  actualCents: number;
  targetCents: number;
  progressPercent: number;
  currencyCode: string;
  met: boolean;
}) {
  const tone: ProgressTone = met ? 'success' : progressPercent >= 60 ? 'warning' : 'brand';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="text-[12px] tabular-nums text-text-primary">
          <span className="font-medium">{formatMoney(actualCents, currencyCode)}</span>
          <span className="text-text-muted"> / {formatMoney(targetCents, currencyCode)}</span>
          <span className="ml-1 text-text-muted">({progressPercent}%)</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-pill bg-border">
        <div
          className={`h-full rounded-pill transition-all ${FILL[tone]}`}
          style={{ width: `${clampPercent(progressPercent)}%` }}
        />
      </div>
    </div>
  );
}
