import type { ReactNode } from 'react';
import { AppCard } from './AppCard';

export interface CardProps {
  children: ReactNode;
}

/**
 * The plain content card the screens use.
 *
 * Absorbed from `@sheer/ui-mobile` as a thin call onto {@link AppCard} rather
 * than a second implementation — one card, one look. `elevation="none"`
 * reproduces the flat surface the ui-mobile version had; AppCard's default
 * adds a shadow, which reads oddly on a near-black ground.
 */
export function Card({ children }: CardProps) {
  return <AppCard elevation="none">{children}</AppCard>;
}
