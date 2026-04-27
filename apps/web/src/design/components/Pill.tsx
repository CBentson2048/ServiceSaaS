import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@sheer/utils';

export type PillTone = 'primary' | 'ink';

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  /**
   * Active-state colour:
   *  - `primary` (default) → brand purple, used for true CTAs / accent toggles
   *  - `ink` → dark navy, used for in-page selectors (range tabs, segmented controls)
   */
  tone?: PillTone;
}

const ACTIVE: Record<PillTone, string> = {
  primary: 'border-primary bg-primary text-text-on-primary',
  ink: 'border-surface-ink bg-surface-ink text-text-on-primary',
};

export function Pill(props: PillProps) {
  const { label, active, tone = 'primary', className, type = 'button', ...rest } = props;

  return (
    <button
      type={type}
      role="tab"
      aria-selected={!!active}
      className={cn(
        'rounded-pill px-4 py-1.5 text-[12px] font-medium transition-colors',
        'border-[1.5px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
        active
          ? ACTIVE[tone]
          : 'border-border bg-transparent text-text-secondary hover:text-text-primary',
        className,
      )}
      {...rest}
    >
      {label}
    </button>
  );
}
