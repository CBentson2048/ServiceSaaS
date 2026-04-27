/**
 * Spacing rhythm (in px). Use these values for padding, margin, and gaps.
 * The base step is 4 — every value is a multiple to keep layouts consistent.
 */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 40,
  '4xl': 48,
} as const;

export type SpacingToken = keyof typeof spacing;
export type Spacing = typeof spacing;
