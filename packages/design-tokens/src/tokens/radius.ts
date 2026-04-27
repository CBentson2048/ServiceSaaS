/**
 * Border radius tokens (in px).
 *
 * Recommended usage:
 *  - `input`: form fields and small inline controls (10–12)
 *  - `card`:  general cards and surfaces (14)
 *  - `cardLg`: hero/large cards (16)
 *  - `pill`: pills, chips, segmented tabs (20)
 *  - `full`: avatars, circular badges
 */
export const radius = {
  none: 0,
  sm: 8,
  input: 10,
  inputLg: 12,
  card: 14,
  cardLg: 16,
  pill: 20,
  full: 9999,
} as const;

export type RadiusToken = keyof typeof radius;
export type Radius = typeof radius;
