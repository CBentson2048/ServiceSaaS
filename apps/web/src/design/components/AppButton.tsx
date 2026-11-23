import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@sheer/utils';

export type AppButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'danger';
export type AppButtonSize = 'sm' | 'md' | 'lg';

export interface AppButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const VARIANT: Record<AppButtonVariant, string> = {
  primary:
    'bg-primary text-text-on-primary border-transparent shadow-card hover:-translate-y-0.5 hover:bg-primary-deep hover:shadow-hero active:translate-y-0 focus-visible:ring-primary/40',
  secondary:
    'bg-transparent text-text-primary border-border-strong hover:bg-surface-alt focus-visible:ring-primary/30',
  ghost:
    'bg-transparent text-text-secondary border-transparent hover:text-text-primary hover:bg-surface-alt focus-visible:ring-primary/20',
  success:
    'bg-success-soft text-success border-success-border hover:brightness-95 focus-visible:ring-success/30',
  danger:
    'bg-danger-soft text-danger border-danger-border hover:brightness-95 focus-visible:ring-danger/30',
};

const SIZE: Record<AppButtonSize, string> = {
  sm: 'px-3.5 py-1.5 text-[12px] leading-4',
  md: 'px-4.5 py-2 text-[14px] leading-5',
  lg: 'px-6 py-3 text-[15px] leading-5',
};

export const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(function AppButton(
  props,
  ref,
) {
  const {
    variant = 'primary',
    size = 'md',
    fullWidth,
    loading,
    disabled,
    leadingIcon,
    trailingIcon,
    className,
    children,
    type = 'button',
    ...rest
  } = props;

  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-pill border-[1.5px] font-medium transition-all duration-200',
        'focus:outline-none focus-visible:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-55',
        SIZE[size],
        VARIANT[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
      ) : (
        <>
          {leadingIcon}
          {children}
          {trailingIcon}
        </>
      )}
    </button>
  );
});
