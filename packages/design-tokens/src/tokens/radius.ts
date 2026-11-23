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
  input: 11,
  inputLg: 14,
  card: 18,
  cardLg: 22,
  pill: 9999,
  full: 9999,
} as const;

export type RadiusToken = keyof typeof radius;
export type Radius = typeof radius;
