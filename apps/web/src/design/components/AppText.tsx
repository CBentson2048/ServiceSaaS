import type { ElementType, ReactNode } from 'react';
import { cn } from '@sheer/utils';

export type AppTextVariant =
  | 'display'
  | 'heading'
  | 'title'
  | 'subtitle'
  | 'body'
  | 'caption'
  | 'micro';

export type AppTextWeight = 'regular' | 'medium';

export type AppTextTone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'onPrimary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'brand';

export interface AppTextProps {
  as?: ElementType;
  variant?: AppTextVariant;
  weight?: AppTextWeight;
  tone?: AppTextTone;
  uppercase?: boolean;
  className?: string;
  children: ReactNode;
}

const VARIANT: Record<AppTextVariant, string> = {
  display: 'text-[28px] leading-[34px]',
  heading: 'text-[24px] leading-[30px]',
  title: 'text-[20px] leading-[26px]',
  subtitle: 'text-[17px] leading-[24px]',
  body: 'text-[14px] leading-[20px]',
  caption: 'text-[12px] leading-[16px]',
  micro: 'text-[11px] leading-[14px]',
};

const WEIGHT: Record<AppTextWeight, string> = {
  regular: 'font-normal',
  medium: 'font-medium',
};

const TONE: Record<AppTextTone, string> = {
  primary: 'text-text-primary',
  secondary: 'text-text-secondary',
  muted: 'text-text-muted',
  onPrimary: 'text-text-on-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  brand: 'text-primary',
};

export function AppText(props: AppTextProps) {
  const {
    as: Component = 'span',
    variant = 'body',
    weight = 'regular',
    tone = 'primary',
    uppercase,
    className,
    children,
  } = props;

  return (
    <Component
      className={cn(
        VARIANT[variant],
        WEIGHT[weight],
        TONE[tone],
        uppercase && 'uppercase tracking-[0.08em]',
        className,
      )}
    >
      {children}
    </Component>
  );
}
