import { Pill } from '../../design';

export type DashboardRange = 'today' | 'week' | 'month' | 'custom';

/** Inclusive calendar-day bounds from the date pickers, as 'YYYY-MM-DD' strings. */
export interface CustomRange {
  from: string;
  to: string;
}

const BASE_TABS: Array<{ id: DashboardRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'Month' },
];

export interface RangeTabsProps {
  value: DashboardRange;
  onChange: (next: DashboardRange) => void;
  /** Opt in to the "Custom" tab + date pickers. Off by default so existing callers are unchanged. */
  allowCustom?: boolean;
  customRange?: CustomRange;
  onCustomRangeChange?: (next: CustomRange) => void;
}

const DATE_INPUT_CLASS =
  'h-9 rounded-input-lg border border-border-strong bg-surface px-2.5 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';

export function RangeTabs({
  value,
  onChange,
  allowCustom = false,
  customRange,
  onCustomRangeChange,
}: RangeTabsProps) {
  const tabs = allowCustom ? [...BASE_TABS, { id: 'custom' as DashboardRange, label: 'Custom' }] : BASE_TABS;

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div role="tablist" aria-label="Date range" className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => (
          <Pill
            key={tab.id}
            tone="ink"
            label={tab.label}
            active={tab.id === value}
            onClick={() => onChange(tab.id)}
          />
        ))}
      </div>

      {allowCustom && value === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            aria-label="From date"
            value={customRange?.from ?? ''}
            max={customRange?.to || undefined}
            onChange={(event) =>
              onCustomRangeChange?.({ from: event.target.value, to: customRange?.to ?? '' })
            }
            className={DATE_INPUT_CLASS}
          />
          <span className="text-[12px] text-text-muted">to</span>
          <input
            type="date"
            aria-label="To date"
            value={customRange?.to ?? ''}
            min={customRange?.from || undefined}
            onChange={(event) =>
              onCustomRangeChange?.({ from: customRange?.from ?? '', to: event.target.value })
            }
            className={DATE_INPUT_CLASS}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Resolve a custom calendar-day selection to a half-open ISO window
 * [from 00:00, to+1day 00:00). Returns null when the selection is incomplete
 * or inverted, so callers can skip fetching until both dates are valid.
 */
export function resolveCustomWindow(custom: CustomRange | undefined): { from: string; to: string } | null {
  if (!custom?.from || !custom?.to) return null;
  const from = new Date(`${custom.from}T00:00:00`);
  const toStart = new Date(`${custom.to}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toStart.getTime()) || from > toStart) return null;
  const to = new Date(toStart);
  to.setDate(to.getDate() + 1); // end is exclusive; include the whole final day
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Build KPI/analytics query params from the current selection. Presets send a
 * named `period` (resolved to UTC boundaries server-side); custom sends an
 * explicit from/to. Returns null when a custom range isn't fully chosen yet.
 */
export function rangeToQueryParams(
  range: DashboardRange,
  custom?: CustomRange,
): { period?: 'today' | 'week' | 'month'; from?: string; to?: string } | null {
  if (range !== 'custom') return { period: range };
  const window = resolveCustomWindow(custom);
  return window ? { from: window.from, to: window.to } : null;
}
