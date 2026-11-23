/**
 * Typography tokens.
 *
 * Constraints (per product spec):
 *  - Font family: a native, system-first sans stack for fast, consistent rendering
 *  - Weights: 400 (regular) and 500 (medium) only — do NOT introduce other weights
 *  - Sizes are kept disciplined and scan-friendly for busy salon use
 *
 * Sizes and line heights are absolute pixel values so they work identically
 * in React Native (StyleSheet) and on the web (px-based).
 */
export const fontFamily = {
  // React Native consumes 'System'; web prefers modern native UI fonts.
  native: 'System',
  web: 'Aptos, Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
} as const;

export const fontSize = {
  micro: 11,
  caption: 12,
  small: 13,
  body: 14,
  bodyLg: 15,
  subtitle: 17,
  title: 20,
  heading: 24,
  display: 28,
} as const;

export const lineHeight = {
  micro: 14,
  caption: 16,
  small: 18,
  body: 20,
  bodyLg: 22,
  subtitle: 24,
  title: 26,
  heading: 30,
  display: 34,
} as const;

export const letterSpacing = {
  none: 0,
  tight: -0.2,
  wide: 0.5,
  ultra: 1,
} as const;

export const typography = {
  fontFamily,
  fontWeight,
  fontSize,
  lineHeight,
  letterSpacing,
} as const;

export type FontWeightToken = keyof typeof fontWeight;
export type FontSizeToken = keyof typeof fontSize;
export type Typography = typeof typography;
