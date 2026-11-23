import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@sheer/utils';

export type AppCardVariant = 'default' | 'hero' | 'success' | 'warning' | 'danger';
export type AppCardPadding = 'none' | 'sm' | 'md' | 'lg';
export type AppCardElevation = 'none' | 'card' | 'hero';

export interface AppCardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AppCardVariant;
  padding?: AppCardPadding;
  elevation?: AppCardElevation;
  /** When true, render with hover/focus affordances suitable for an interactive card. */
  interactive?: boolean;
  children: ReactNode;
}

const VARIANT: Record<AppCardVariant, string> = {
  default: 'bg-surface border-border',
  hero: 'bg-surface-alt border-border-strong rounded-card-lg',
  success: 'bg-surface border-success-border border-[1.5px]',
  warning: 'bg-surface border-warning-border border-[1.5px]',
  danger: 'bg-surface border-danger-border border-[1.5px]',
};

const PADDING: Record<AppCardPadding, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

const ELEVATION: Record<AppCardElevation, string> = {
  none: '',
  card: 'shadow-card',
  hero: 'shadow-hero',
};

export function AppCard(props: AppCardProps) {
  const {
    variant = 'default',
    padding = 'md',
    elevation = 'card',
    interactive,
    className,
    children,
    ...rest
  } = props;

  return (
    <div
      className={cn(
        'rounded-card border bg-surface text-text-primary transition-[border-color,box-shadow,transform] duration-200',
        VARIANT[variant],
        PADDING[padding],
        ELEVATION[elevation],
        interactive &&
          'cursor-pointer hover:-translate-y-0.5 hover:border-border-strong hover:shadow-hero focus-within:border-border-strong focus-within:shadow-hero',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
