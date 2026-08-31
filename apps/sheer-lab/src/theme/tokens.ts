/**
 * QLAB primitive design tokens.
 *
 * These sit one level below `theme.ts`: raw scales with no colour in them.
 * `@sheer/design-tokens` supplies the cross-app `spacing` / `radius` /
 * `typography` primitives; this module adds the scales QLAB screens were
 * previously improvising inline — a semantic type ramp, elevation, motion and
 * touch-target sizing.
 *
 * WHY THIS EXISTS
 * The Lab screens accumulated 18 distinct hardcoded `fontSize` values and six
 * font weights, plus nine hardcoded `letterSpacing` values. Nothing named the
 * intent, so "a section label" was re-derived (slightly differently) on every
 * screen. The `type` ramp below names each role once so a screen picks a role
 * rather than inventing a triple of size/weight/tracking.
 */
import { radius, spacing } from '@sheer/design-tokens';

// ---------------------------------------------------------------------------
// Type ramp
// ---------------------------------------------------------------------------

/**
 * Font weights QLAB uses.
 *
 * DELIBERATE DEVIATION from `@sheer/design-tokens`, which documents "400 and
 * 500 only". That constraint predates the Lab app and the Lab screens already
 * shipped 600/700/800/900. Rather than re-flatten every screen to 500 (which
 * would erase the hierarchy a dense weighing console needs) this caps the ramp
 * at 700 and drops 800/900: on the system font those render as Heavy/Black,
 * which is what makes the current UI read as shouty rather than authoritative.
 */
export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export type WeightToken = keyof typeof weight;

/** A fully-specified text role. Spread straight into a `Text` style. */
export interface TypeRole {
  fontSize: number;
  lineHeight: number;
  fontWeight: (typeof weight)[WeightToken];
  letterSpacing: number;
  textTransform?: 'uppercase';
}

/**
 * Semantic type roles. Screens should reference these by name
 * (`...type.sectionTitle`) instead of hand-rolling size/weight/tracking.
 *
 * Tracking follows the usual optical rule: negative on large display sizes so
 * they don't feel gappy, zero through the body range, positive on the small
 * uppercase roles where letters would otherwise collide.
 */
export const type = {
  /** Page-level hero headline. One per screen at most. */
  display: { fontSize: 28, lineHeight: 34, fontWeight: weight.bold, letterSpacing: -0.4 },
  /** Screen title (the `<h1>` of a page). */
  titleLg: { fontSize: 24, lineHeight: 30, fontWeight: weight.bold, letterSpacing: -0.3 },
  /** Card / panel title. */
  title: { fontSize: 20, lineHeight: 26, fontWeight: weight.bold, letterSpacing: -0.2 },
  /** Sub-head inside a card; also the default button label size. */
  subtitle: { fontSize: 17, lineHeight: 24, fontWeight: weight.semibold, letterSpacing: -0.1 },
  /** Section heading inside a panel. */
  sectionTitle: { fontSize: 15, lineHeight: 22, fontWeight: weight.semibold, letterSpacing: 0 },

  /** Emphasised body copy (intro lines, hero subtitles). */
  bodyLg: { fontSize: 15, lineHeight: 22, fontWeight: weight.regular, letterSpacing: 0 },
  /** Default body copy. */
  body: { fontSize: 14, lineHeight: 20, fontWeight: weight.regular, letterSpacing: 0 },
  /** Dense body copy — table cells, list rows. */
  bodySm: { fontSize: 13, lineHeight: 18, fontWeight: weight.regular, letterSpacing: 0 },
  /** Field label / row key. Same size as `bodySm`, heavier. */
  label: { fontSize: 13, lineHeight: 18, fontWeight: weight.semibold, letterSpacing: 0 },
  /** Supporting caption under a value. */
  caption: { fontSize: 12, lineHeight: 16, fontWeight: weight.medium, letterSpacing: 0 },
  /** Smallest readable text — pill labels, footnotes. */
  micro: { fontSize: 11, lineHeight: 14, fontWeight: weight.semibold, letterSpacing: 0.2 },
  /**
   * Uppercase eyebrow above a title or section. The one role that carries
   * `textTransform`, so screens stop scattering `textTransform: 'uppercase'`
   * next to an ad-hoc `letterSpacing`.
   */
  overline: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: weight.bold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  /**
   * Numeric roles. QLAB is a measurement app: live gram readouts, currency and
   * percentages need tighter tracking than prose and must not reflow as digits
   * change. Pair with `numericStyle` below for tabular figures.
   */
  numericXl: { fontSize: 40, lineHeight: 44, fontWeight: weight.bold, letterSpacing: -1 },
  numericLg: { fontSize: 30, lineHeight: 34, fontWeight: weight.bold, letterSpacing: -0.6 },
  numeric: { fontSize: 20, lineHeight: 24, fontWeight: weight.semibold, letterSpacing: -0.2 },
  numericSm: { fontSize: 15, lineHeight: 20, fontWeight: weight.semibold, letterSpacing: -0.1 },
} as const satisfies Record<string, TypeRole>;

export type TypeToken = keyof typeof type;

/**
 * Tabular (monospaced) figures. Apply to any number that updates live — the
 * scale readout, timers, running totals — so digits keep a fixed advance width
 * and the value doesn't jitter horizontally as it counts.
 */
export const numericStyle: { fontVariant: ['tabular-nums'] } = {
  // Not `as const` — RN's `TextStyle.fontVariant` is a mutable array type, so a
  // readonly tuple here would not be assignable to a style prop.
  fontVariant: ['tabular-nums'],
};

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * Elevation for a near-black canvas.
 *
 * On dark surfaces a drop shadow barely reads — depth comes from the surface
 * stepping lighter (see the `surface` ramp in `theme.ts`) with a hairline
 * border. The shadows here are therefore subtle and exist mainly to lift
 * floating elements (sheets, popovers) off the content behind them.
 */
export const elevation = {
  none: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  /** Resting cards and panels. */
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.18,
    shadowRadius: 3,
    elevation: 1,
  },
  /** Raised affordances — the primary CTA, an active tile. */
  raised: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.24,
    shadowRadius: 8,
    elevation: 4,
  },
  /** Bars pinned above content (bottom action bar, sticky header). */
  bar: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.24,
    shadowRadius: 10,
    elevation: 8,
  },
  /** Modals, sheets, popovers. */
  overlay: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.42,
    shadowRadius: 28,
    elevation: 16,
  },
} as const;

export type ElevationToken = keyof typeof elevation;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * Motion tokens. QLAB currently ships zero animation, so every state change is
 * an instant cut — panels pop in, presses have no travel, sheets appear fully
 * formed. These durations are deliberately short: this is a working tool used
 * with wet hands and a timer running, so motion should confirm an action, never
 * make anyone wait for it.
 */
export const duration = {
  /** Press feedback, tint changes — must feel instant. */
  instant: 90,
  /** Default UI transition: chips, toggles, expanding rows. */
  fast: 160,
  /** Sheets, toasts, screen-level reveals. */
  base: 240,
  /** Long-running affordances only (progress rings settling). */
  slow: 360,
} as const;

/**
 * Easing curves as cubic-bezier control points, for `Easing.bezier(...)`.
 * Kept as tuples rather than `Easing` instances so this module stays free of
 * react-native imports and can be unit-tested in isolation.
 */
export const easing = {
  /** Symmetric — for things that move within the screen. */
  standard: [0.4, 0, 0.2, 1],
  /** Fast out, slow in — for entering elements. */
  decelerate: [0, 0, 0.2, 1],
  /** Slow out, fast in — for exiting elements. */
  accelerate: [0.4, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Opacity a pressable drops to while held. */
export const pressedOpacity = 0.72;
/** Opacity applied to any disabled control. */
export const disabledOpacity = 0.4;

// ---------------------------------------------------------------------------
// Sizing / geometry
// ---------------------------------------------------------------------------

/**
 * Minimum touch targets. Apple's HIG floor is 44pt; QLAB is used standing at a
 * colour bar, often with gloves on, so the comfortable target is larger and the
 * 44 is treated as an absolute minimum rather than the norm.
 */
export const touchTarget = {
  /** Absolute minimum — icon buttons in a dense toolbar. */
  min: 44,
  /** Default control height (buttons, inputs, rows). */
  base: 52,
  /** Primary actions and the numeric keypad. */
  large: 60,
} as const;

/** Icon sizes, matched to the type ramp so a glyph optically aligns to a label. */
export const iconSize = {
  xs: 14,
  sm: 16,
  base: 20,
  md: 24,
  lg: 28,
  xl: 36,
} as const;

export type IconSizeToken = keyof typeof iconSize;

/**
 * Stroke weight for the SVG icon set. A single value across every icon is what
 * makes a set look drawn by one hand; scaling it with icon size (rather than
 * fixing it at 2) keeps small icons from going muddy and large ones from
 * looking hairline.
 */
export const strokeWidth = {
  base: 1.75,
  bold: 2.25,
} as const;

/** Hairline used for card borders and dividers on the dark canvas. */
export const hairline = 1;

/** Standard `hitSlop` for small pressables (adds 8pt of grab area all round). */
export const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 } as const;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Responsive breakpoints. These values were previously retyped in six separate
 * screen files (`width >= 1024`, `width >= 1280`, `width >= 700`); naming them
 * once means a future change to the tablet threshold lands everywhere.
 */
export const breakpoint = {
  /** Below this: phone layout — no sidebar, single column, horizontal nav. */
  tablet: 700,
  /** At/above this: sidebar plus multi-column content. */
  wide: 1024,
  /** At/above this: roomier padding and a wider sidebar (12.9" iPad, desktop). */
  xwide: 1280,
} as const;

/** Caps content width on very large displays so line lengths stay readable. */
export const maxContentWidth = 1600;

export { radius, spacing };
