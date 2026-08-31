/**
 * The single canonical QLAB theme.
 *
 * ---------------------------------------------------------------------------
 * WHY A THIRD THEME OBJECT EXISTS (temporarily)
 * ---------------------------------------------------------------------------
 * `labTheme.ts` currently exports two dark themes with *incompatible shapes*:
 *
 *   - `labTheme`      — used by Auth, Formula, BuildFormula, UpdateFormula,
 *                       MixFinalized, FormulaHistory and the `LabScreen`
 *                       utility screens. Status tones are nested
 *                       (`colors.success.text`); it has no `surfaceAlt`,
 *                       `hero` or `sidebar` keys.
 *   - `labLightTheme` — used by `LabShell` and the Home dashboard. Status tones
 *                       are flat (`colors.successText`) and it adds the
 *                       `hero` / `sidebar` / `surfaceAlt` families.
 *
 * They also disagree on two colours, so screens change appearance as you
 * navigate between them:
 *   - `card`:         labTheme = surfaceRaised, labLightTheme = surface
 *   - `textOnPrimary`: labTheme = near-black ink, labLightTheme = white
 *
 * That second one matters: `primary` is the *light* accent (#C46BEA), which
 * carries white text at only ~2.5:1. Anything drawing white on `primary` today
 * is below the WCAG AA floor. This theme fixes that by splitting the brand
 * fill in two — see `primary` / `primaryStrong` below — so a caller can never
 * pick an illegible pair by accident.
 *
 * Merging the two old objects in place would have silently restyled ten
 * screens, so instead this is additive: `theme` is the target every screen
 * migrates to, while `labTheme` and `labLightTheme` keep their exact current
 * values until each screen is converted. Once the last screen is migrated,
 * delete them and rename this to `labTheme`.
 */
import { palette } from '@sheer/design-tokens';

import { labPalette } from './labTheme';
import {
  breakpoint,
  duration,
  disabledOpacity,
  easing,
  elevation,
  hairline,
  hitSlop,
  iconSize,
  maxContentWidth,
  numericStyle,
  pressedOpacity,
  radius,
  spacing,
  strokeWidth,
  touchTarget,
  type,
  weight,
} from './tokens';

/**
 * Surface ramp. On a near-black canvas depth is carried by the surface getting
 * *lighter* as it comes forward, not by shadow — so these four steps are the
 * primary structural tool in the whole UI. Never nest more than two steps deep;
 * past that the contrast between levels collapses and the hierarchy reads as
 * noise.
 */
const surfaces = {
  /** Page canvas — the furthest-back layer. */
  canvas: labPalette.bg, //          #19131F
  /** Cards and panels sitting on the canvas. */
  surface: labPalette.surface, //    #221A2C
  /** Inner tiles, inputs and table stripes sitting on a card. */
  surfaceRaised: labPalette.surfaceRaised, // #2D2338
  /** Sheets and popovers floating above everything. */
  surfaceOverlay: '#342941',
} as const;

export const theme = {
  colors: {
    // --- Structure --------------------------------------------------------
    background: surfaces.canvas,
    surface: surfaces.surface,
    /** Alias of `surfaceRaised`, kept because `labLightTheme` named it this. */
    surfaceAlt: surfaces.surfaceRaised,
    surfaceRaised: surfaces.surfaceRaised,
    surfaceOverlay: surfaces.surfaceOverlay,
    /**
     * Cards resolve to `surface`. (`labTheme` mapped `card` to the raised step,
     * which is why cards on the older screens sit a shade lighter than cards on
     * the dashboard.)
     */
    card: surfaces.surface,

    // --- Brand ------------------------------------------------------------
    /**
     * The light accent. Use for *text, icons and hairlines* on dark surfaces,
     * where it reads at 5.8:1 — and for filled surfaces that carry `onPrimary`
     * (dark ink), never white.
     */
    primary: labPalette.accent, //      #C46BEA
    /** Ink for text/icons sitting on a `primary` fill. */
    onPrimary: labPalette.bg,
    /**
     * The saturated brand fill. Deep enough to carry white text at 6.5:1 — this
     * is the one to use for primary buttons and the active sidebar pill.
     */
    primaryStrong: labPalette.accentSolid, // #9C0CC0
    /** Text/icons sitting on a `primaryStrong` fill. */
    onPrimaryStrong: palette.white,
    /** Pressed state for `primaryStrong`. */
    primaryPressed: labPalette.accentDeep, // #7A0F9C
    /** Soft brand wash — selected rows, avatars, count badges. */
    primarySoft: labPalette.accentSoft, //    #3A1548

    // --- Hero -------------------------------------------------------------
    hero: labPalette.hero,
    heroSoft: palette.alpha.whiteSoft,
    heroBorder: palette.alpha.whiteLine,
    heroText: palette.white,
    heroTextMuted: palette.alpha.whiteSubtle,
    onHeroButtonBg: palette.white,
    onHeroButtonText: labPalette.bg,

    // --- Navigation rail --------------------------------------------------
    sidebar: surfaces.surface,
    sidebarBorder: palette.alpha.whiteLine,
    sidebarText: palette.alpha.whiteHi,
    sidebarTextMuted: palette.alpha.whiteSubtle,
    sidebarActive: labPalette.accentSolid,
    sidebarActiveText: palette.white,

    // --- Text -------------------------------------------------------------
    textPrimary: palette.white,
    textSecondary: palette.alpha.whiteHi, //    85%
    textMuted: palette.alpha.whiteSubtle, //    60%
    /**
     * 40% white. Below AA for body copy — reserve for genuinely decorative
     * text (disabled labels, watermark hints), never for information the
     * stylist needs to act on.
     */
    textFaint: palette.alpha.whiteMuted,
    /** Legacy alias — see `onPrimary`, which is the unambiguous name. */
    textOnPrimary: labPalette.bg,

    // --- Lines ------------------------------------------------------------
    border: palette.alpha.whiteLine, //   16%
    borderStrong: palette.alpha.whiteMuted, // 40%
    /** Faintest divider, for rows inside an already-bordered card. */
    divider: palette.alpha.whiteSoft, //  8%

    // --- Inputs -----------------------------------------------------------
    inputBg: surfaces.surfaceRaised,
    inputBorder: palette.alpha.whiteLine,
    inputBorderFocus: labPalette.accent,
    inputPlaceholder: palette.alpha.whiteMuted,

    // --- Overlay ----------------------------------------------------------
    /** Scrim behind modals and sheets. */
    overlay: 'rgba(0,0,0,0.62)',

    // --- Status tones -----------------------------------------------------
    /**
     * Provided in BOTH shapes on purpose: nested for code migrating from
     * `labTheme` (`colors.success.text`) and flat for code migrating from
     * `labLightTheme` (`colors.successText`). New code should prefer
     * `tone('success')` below, which returns the whole triple.
     */
    success: { text: palette.success[300], bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.32)' },
    warning: { text: palette.warning[300], bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.32)' },
    danger: { text: palette.danger[300], bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.32)' },
    neutral: { text: palette.alpha.whiteSubtle, bg: palette.alpha.whiteSoft, border: palette.alpha.whiteLine },
    brand: { text: labPalette.accent, bg: labPalette.accentSoft, border: labPalette.accentSoft },

    successText: palette.success[300],
    successBg: 'rgba(74,222,128,0.12)',
    successBorder: 'rgba(74,222,128,0.32)',
    warningText: palette.warning[300],
    warningBg: 'rgba(245,158,11,0.12)',
    warningBorder: 'rgba(245,158,11,0.32)',
    dangerText: palette.danger[300],
    dangerBg: 'rgba(248,113,113,0.12)',
    dangerBorder: 'rgba(248,113,113,0.32)',
  },

  spacing,
  radius,
  type,
  weight,
  elevation,
  duration,
  easing,
  iconSize,
  strokeWidth,
  touchTarget,
  breakpoint,
  hairline,
  hitSlop,
  maxContentWidth,
  numericStyle,
  pressedOpacity,
  disabledOpacity,
} as const;

export type LabAppTheme = typeof theme;

// ---------------------------------------------------------------------------
// Tone helpers
// ---------------------------------------------------------------------------

/** Status tones available to pills, banners, stat tiles and table cells. */
export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand';

export interface ToneTriple {
  text: string;
  bg: string;
  border: string;
}

/**
 * Resolves a tone to its `{ text, bg, border }` triple.
 *
 * Replaces the `toneStyle` switch that was copied into `LabShell`, `HomeScreen`
 * and (as `chipToneStyle`) two more screens — all four drifted apart.
 */
export function tone(name: Tone): ToneTriple {
  return theme.colors[name];
}

// ---------------------------------------------------------------------------
// Layout helper
// ---------------------------------------------------------------------------

export type LayoutMode = 'phone' | 'tablet' | 'wide';

export interface LabLayout {
  mode: LayoutMode;
  /** True at >= 1024pt — sidebar plus multi-column content. */
  isWide: boolean;
  /** True at >= 700pt — a sidebar is shown at all. */
  isTablet: boolean;
  /** True at >= 1280pt — the roomier padding/sidebar step. */
  isXWide: boolean;
  sidebarWidth: number;
  /** Screen padding. */
  pad: number;
  /** Gap between sibling panels. */
  gap: number;
}

/**
 * The single responsive resolver.
 *
 * `getLayout` was previously reimplemented in six screens with the same
 * 700/1024/1280 thresholds retyped each time; `HomeScreen` and `FormulaScreen`
 * had already drifted on the values they returned.
 */
export function resolveLayout(width: number): LabLayout {
  if (width >= breakpoint.wide) {
    const xwide = width >= breakpoint.xwide;
    return {
      mode: 'wide',
      isWide: true,
      isTablet: true,
      isXWide: xwide,
      sidebarWidth: xwide ? 248 : 216,
      pad: xwide ? spacing.xl : spacing.base,
      gap: spacing.lg,
    };
  }
  if (width >= breakpoint.tablet) {
    return {
      mode: 'tablet',
      isWide: false,
      isTablet: true,
      isXWide: false,
      sidebarWidth: 208,
      pad: spacing.base,
      gap: spacing.base,
    };
  }
  return {
    mode: 'phone',
    isWide: false,
    isTablet: false,
    isXWide: false,
    sidebarWidth: 0,
    pad: spacing.base,
    gap: spacing.base,
  };
}
