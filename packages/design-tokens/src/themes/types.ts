import type { Radius } from '../tokens/radius.js';
import type { Spacing } from '../tokens/spacing.js';
import type { Typography } from '../tokens/typography.js';

export type ThemeMode = 'light' | 'dark';
export type ThemeName = 'staff' | 'client' | 'web';

/**
 * Tone keys used by status-driven UI (badges, alerts, projection deltas).
 * Themes provide a `text` and a `bg` flavour for each tone so the same
 * primitives work on both light and dark surfaces.
 */
export interface ToneColor {
  text: string;
  bg: string;
  border: string;
}

export interface SemanticColors {
  /** Page background */
  bg: string;
  /** Primary card / surface colour, sits on `bg` */
  surface: string;
  /** Secondary surface (e.g. nested cards, subtle wells) */
  surfaceAlt: string;

  /** High-contrast body text */
  textPrimary: string;
  /** Less prominent text (subtitles, captions) */
  textSecondary: string;
  /** Lowest-contrast text (labels, micro copy) */
  textMuted: string;
  /** Text/icon colour to render on top of `primary` */
  textOnPrimary: string;

  /** Default divider/outline */
  border: string;
  /** Stronger divider (focus, hover, emphasised cards) */
  borderStrong: string;

  /** Brand colour — primary actions, key accents */
  primary: string;
  /** Soft brand fill (for chip/pill backgrounds) */
  primarySoft: string;

  /** Status tones used across the product */
  success: ToneColor;
  warning: ToneColor;
  danger: ToneColor;
  neutral: ToneColor;

  /** Form field tokens */
  inputBg: string;
  inputBorder: string;
  inputPlaceholder: string;

  /** Modal / drawer scrim */
  overlay: string;
}

/**
 * A theme is the single source of truth a screen reads from.
 * It bundles semantic colours and references to global tokens so screens
 * never need to import raw palette/spacing/etc. directly.
 */
export interface Theme {
  name: ThemeName;
  mode: ThemeMode;
  colors: SemanticColors;
  spacing: Spacing;
  radius: Radius;
  typography: Typography;
}
