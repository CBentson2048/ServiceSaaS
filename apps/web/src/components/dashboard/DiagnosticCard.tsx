import type { ReactNode } from 'react';
import { cn } from '@sheer/utils';
import { AppCard, AppText, type AppTextTone } from '../../design';

export type DiagnosticTone = 'good' | 'warn' | 'bad' | 'purple' | 'ink';

export interface DiagnosticRow {
  label: string;
  value: string;
  valueTone?: DiagnosticTone;
  /** Percentage 0-100 for the inline mini bar. Omit to render value only. */
  pct?: number;
  /** Optional sub-line under the value (e.g. "all salons"). */
  caption?: string;
}

const VALUE_TONE: Record<DiagnosticTone, AppTextTone> = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
  purple: 'brand',
  ink: 'primary',
};

const BAR_CLASS: Record<DiagnosticTone, string> = {
  good: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  purple: 'bg-primary',
  ink: 'bg-text-primary',
};

export interface DiagnosticCardProps {
  title: string;
  subtitle: string;
  rows: DiagnosticRow[];
  footerLabel: string;
  footerValue: ReactNode;
  footerTone?: DiagnosticTone;
}

export function DiagnosticCard(props: DiagnosticCardProps) {
  const { title, subtitle, rows, footerLabel, footerValue, footerTone = 'ink' } = props;

  return (
    <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
      <div className="border-b border-border-divider px-4 pb-2.5 pt-4">
        <AppText as="div" weight="medium" className="text-[13px]">
          {title}
        </AppText>
        <AppText as="div" variant="micro" tone="muted" className="mt-0.5">
          {subtitle}
        </AppText>
      </div>

      <div className="px-4 py-3">
        {rows.map((row, idx) => {
          const tone: DiagnosticTone = row.valueTone ?? 'ink';
          const isLast = idx === rows.length - 1;
          return (
            <div
              key={row.label}
              className={cn(
                'flex items-center justify-between py-1.5',
                !isLast && 'border-b border-surface-alt',
              )}
            >
              <AppText variant="caption" className="text-text-primary/70">
                {row.label}
              </AppText>
              <div className="text-right">
                <AppText
                  as="div"
                  weight="medium"
                  tone={VALUE_TONE[tone]}
                  className="text-[15px] leading-tight"
                >
                  {row.value}
                </AppText>
                {row.pct !== undefined && (
                  <div className="ml-auto mt-1 h-1 w-20 overflow-hidden rounded-full bg-border-divider">
                    <div
                      className={cn('h-full rounded-full', BAR_CLASS[tone])}
                      style={{ width: `${Math.max(0, Math.min(100, row.pct))}%` }}
                    />
                  </div>
                )}
                {row.caption && (
                  <AppText
                    as="div"
                    variant="micro"
                    className="mt-0.5 text-text-subtle"
                  >
                    {row.caption}
                  </AppText>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-border-divider bg-surface-alt px-4 py-2.5">
        <AppText variant="micro" uppercase className="text-text-subtle tracking-[0.08em]">
          {footerLabel}
        </AppText>
        <AppText weight="medium" tone={VALUE_TONE[footerTone]} className="text-[14px]">
          {footerValue}
        </AppText>
      </div>
    </AppCard>
  );
}
