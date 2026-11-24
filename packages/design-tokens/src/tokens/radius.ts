/**
 * Border radius tokens (in px).
 *
 * Recommended usage:
 *  - `input`: form fields and small inline controls (11–14)
 *  - `card`:  general cards and surfaces (18)
 *  - `cardLg`: hero/large cards (22)
 *  - `pill`: pills, chips, and segmented tabs (fully rounded)
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
