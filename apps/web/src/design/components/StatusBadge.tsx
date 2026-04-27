import type { HTMLAttributes } from 'react';
import { cn } from '@sheer/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  label: string;
  tone?: StatusTone;
}

const TONE: Record<StatusTone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface-alt text-text-secondary',
};

export function StatusBadge({ label, tone = 'neutral', className, ...rest }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill px-2.5 py-0.5 text-[11px] font-medium',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {label}
    </span>
  );
}
