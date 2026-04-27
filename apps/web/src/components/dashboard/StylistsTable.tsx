import { cn } from '@sheer/utils';
import { AppCard, AppText, StatusBadge, type AppTextTone, type StatusTone } from '../../design';

export type StylistStatus = 'on-track' | 'above-3x' | 'behind';

export interface StylistRow {
  id: string;
  name: string;
  location: string;
  generated: string;
  generatedOf: string;
  generatedTone?: 'default' | 'good' | 'bad';
  target: string;
  projected: string;
  projectedTone: 'good' | 'bad' | 'default';
  status: StylistStatus;
}

const STATUS_TONE: Record<StylistStatus, StatusTone> = {
  'on-track': 'warning',
  'above-3x': 'success',
  behind: 'danger',
};

const STATUS_LABEL: Record<StylistStatus, string> = {
  'on-track': 'On track',
  'above-3x': 'Above 3x',
  behind: 'Behind',
};

const VALUE_TONE: Record<'default' | 'good' | 'bad', AppTextTone> = {
  default: 'primary',
  good: 'success',
  bad: 'danger',
};

const COLS = '2fr 1fr 1fr 1fr 80px';

export interface StylistsTableProps {
  rows: StylistRow[];
}

export function StylistsTable({ rows }: StylistsTableProps) {
  return (
    <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
      <div
        className="grid items-center bg-surface-alt px-4 py-2.5"
        style={{ gridTemplateColumns: COLS }}
      >
        {['Stylist', 'Generated', 'Target', 'Projected', 'Status'].map((heading) => (
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

      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            'grid items-center border-t border-border-divider px-4 py-3',
            row.status === 'behind' ? 'bg-danger-tint' : 'bg-surface',
          )}
          style={{ gridTemplateColumns: COLS }}
        >
          <div>
            <AppText as="div" weight="medium" className="text-[13px]">
              {row.name}
            </AppText>
            <AppText as="div" variant="micro" className="mt-0.5 text-text-subtle">
              {row.location}
            </AppText>
          </div>
          <div>
            <AppText
              as="div"
              weight="medium"
              tone={VALUE_TONE[row.generatedTone ?? 'default']}
              className="text-[13px]"
            >
              {row.generated}
            </AppText>
            <AppText as="div" variant="micro" className="mt-0.5 text-text-subtle">
              of {row.generatedOf}
            </AppText>
          </div>
          <AppText as="div" weight="medium" className="text-[13px]">
            {row.target}
          </AppText>
          <AppText
            as="div"
            weight="medium"
            tone={VALUE_TONE[row.projectedTone]}
            className="text-[13px]"
          >
            {row.projected}
          </AppText>
          <StatusBadge label={STATUS_LABEL[row.status]} tone={STATUS_TONE[row.status]} />
        </div>
      ))}
    </AppCard>
  );
}
