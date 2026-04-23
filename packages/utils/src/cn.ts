import clsx, { type ClassValue } from 'clsx';

/**
 * Tiny className helper — thin wrapper around `clsx` for convenience.
 * Usage: `cn('base', isActive && 'active', { 'is-disabled': disabled })`.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
