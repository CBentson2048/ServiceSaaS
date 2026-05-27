import { cn } from '@sheer/utils';
import { AppText } from '../../design';

export interface KpiItem {
  value: string;
  label: string;
  hint?: string;
  hintTone?: 'good' | 'purple' | 'muted';
}

const HINT_CLASS: Record<NonNullable<KpiItem['hintTone']>, string> = {
  good: 'text-success-fill',
  purple: 'text-primary',
  muted: '!text-white/50',
};

export interface KpiStripProps {
  items: KpiItem[];
}

/**
 * Dark high-contrast KPI strip used as a "spotlight" surface inside the
 * otherwise-light dashboard. Always renders on `surface-ink`.
 */
export function KpiStrip({ items }: KpiStripProps) {
  return (
    <div className="grid gap-4 bg-surface-ink px-6 py-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="text-center">
          <AppText
            as="div"
            variant="title"
            weight="medium"
            tone="onPrimary"
            className="!text-white"
          >
            {item.value}
          </AppText>
          <AppText
            as="div"
            variant="micro"
            uppercase
            className="mt-1 !text-white/50"
          >
            {item.label}
          </AppText>
          {item.hint && (
            <AppText
              as="div"
              variant="micro"
              className={cn('mt-0.5', HINT_CLASS[item.hintTone ?? 'muted'])}
            >
              {item.hint}
            </AppText>
          )}
        </div>
      ))}
    </div>
  );
}
