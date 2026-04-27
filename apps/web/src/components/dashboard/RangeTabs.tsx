import { Pill } from '../../design';

export type DashboardRange = 'today' | 'week' | 'month';

const TABS: Array<{ id: DashboardRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'Month' },
];

export interface RangeTabsProps {
  value: DashboardRange;
  onChange: (next: DashboardRange) => void;
}

export function RangeTabs({ value, onChange }: RangeTabsProps) {
  return (
    <div role="tablist" aria-label="Date range" className="flex gap-1.5">
      {TABS.map((tab) => (
        <Pill
          key={tab.id}
          tone="ink"
          label={tab.label}
          active={tab.id === value}
          onClick={() => onChange(tab.id)}
        />
      ))}
    </div>
  );
}
