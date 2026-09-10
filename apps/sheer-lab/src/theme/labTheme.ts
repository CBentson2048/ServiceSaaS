import { palette, radius, spacing, staffTheme, typography } from '@sheer/design-tokens';

import {
  breakpoint,
  disabledOpacity,
  duration,
  easing,
  elevation,
  hairline,
  hitSlop,
  iconSize,
  maxContentWidth,
  numericStyle,
  pressedOpacity,
  strokeWidth,
  touchTarget,
  type,
  weight,
} from './tokens';

/**
 * Lab-only palette for the QLAB rebrand (purple flask + infinity mark).
 * Scoped here rather than in `@sheer/design-tokens` because the shared
 * `palette` still drives the web and sheer-app themes — only the Lab app
 * carries the new identity.
 *
 * The ink ramp keeps the violet hue family of the `#19131F` canvas. The
 * accent ramp is sampled from the logo's gradient (`#601890` → `#9C0CC0`):
 * `accent` is lightened for legible accent text on the canvas (5.75:1) and
 * `accentSolid` stays deep enough to carry white text (6.51:1) — no single
 * purple can do both on a canvas this dark.
 */
export const labPalette = {
  bg: '#19131F',
  surface: '#221A2C',
  surfaceRaised: '#2D2338',
  accent: '#C46BEA',
  accentSolid: '#9C0CC0',
  accentDeep: '#7A0F9C',
  accentSoft: '#3A1548',
  hero: '#431956',
  /** Sheets and popovers floating above everything — the fourth surface step. */
  surfaceOverlay: '#342941',
} as const;

/**
 * THE Lab theme. One object, one set of values.
 *
 * WHY THIS FILE USED TO EXPORT TWO THEMES, AND WHY IT NO LONGER DOES.
 *
 * There were `labTheme` and `labLightTheme`. Both were dark (the second was
 * misnamed — its own docblock opened "Dark theme for the QLOOQO Lab dashboard"),
 * both were live, and they disagreed on four keys that screens actually read.
 * Which values a screen got depended on nothing more meaningful than whether it
 * imported the theme directly or picked up the `c` that `LabShell.tsx`
 * re-exported. Same token name, two colours, split by import path:
 *
 *   key             old labTheme        old labLightTheme    resolved to
 *   card            #2D2338             #221A2C              #2D2338
 *   surfaceAlt      #2E1F4A (inherited) #2D2338              #2D2338
 *   textOnPrimary   #18141F (inherited) white                #18141F
 *   primarySoft     #2E1F4A (inherited) #3A1548              #3A1548
 *
 * Each resolution is either a no-op or a fix, checked against the call sites:
 *
 *   `card` — no screen on the labLightTheme side ever read it, so taking
 *   #2D2338 changes nothing and keeps LabButton's secondary variant visibly
 *   raised off the surface it sits on.
 *
 *   `textOnPrimary` — this is the important one. Every control that pairs it
 *   with a `primary` fill was, on the labLightTheme side, drawing WHITE on
 *   #C46BEA: 3.16:1, which fails WCAG AA. The dark ink is 5.73:1 on the same
 *   fill. So the accessible value wins, and the rule the palette docblock
 *   already implies is now explicit: fill with `primary` and text is dark ink;
 *   fill with `accentSolid` and text is white (6.51:1). That is why
 *   `sidebarActive` is `accentSolid` rather than `primary` — it is the one
 *   surface here that must carry a white label.
 *
 *   `primarySoft` — old labTheme never declared it, so it fell through to
 *   `staffTheme`'s `palette.brand[900]` = #2E1F4A, the PRE-REBRAND indigo. Half
 *   the app was tinting selected states with the colour the QLAB rebrand
 *   replaced. Now the brand's own `accentSoft`.
 *
 *   `surfaceAlt` — same pre-rebrand fall-through (#2E1F4A); #2D2338 is the
 *   documented "inner tile" step and is a near-imperceptible shift.
 *
 * SURFACE LADDER, stated once so nothing re-decides it:
 *   page canvas          `background`   #19131F
 *   panels / top bar /   `surface`      #221A2C
 *     sidebar rail
 *   raised cards /       `card`,        #2D2338
 *     inner tiles        `surfaceAlt`
 *
 * The status tones are exposed in BOTH shapes on purpose: `success.text` (from
 * the `staffTheme` spread) and the flat `successText` alias. Screens use both,
 * and dropping either would break a caller for no gain.
 */
export const labTheme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,

    background: labPalette.bg,
    surface: labPalette.surface,
    card: labPalette.surfaceRaised,
    surfaceAlt: labPalette.surfaceRaised,

    // Side navigation rail: an elevated dark panel with light text and a solid
    // brand pill on the active item.
    sidebar: labPalette.surface,
    sidebarBorder: palette.alpha.whiteLine,
    sidebarText: palette.alpha.whiteHi,
    sidebarTextMuted: palette.alpha.whiteSubtle,
    sidebarActive: labPalette.accentSolid,
    sidebarActiveText: palette.white,

    // Hero "Welcome" panel — a deep-purple brand feature card that stands off
    // the near-black canvas; keeps the white CTA button from the mockup.
    hero: labPalette.hero,
    heroSoft: palette.alpha.whiteSoft,
    heroBorder: palette.alpha.whiteLine,
    heroText: palette.white,
    heroTextMuted: palette.alpha.whiteSubtle,
    onHeroButtonBg: palette.white,
    onHeroButtonText: labPalette.bg,

    // Brand purple tuned for dark surfaces. `accent` reads on near-black;
    // `accentSoft` fills selected/active surfaces.
    primary: labPalette.accent,
    primaryPressed: labPalette.accentSolid,
    primarySoft: labPalette.accentSoft,
    // Dark ink, NOT white — 5.73:1 on the `primary` fill versus white's 3.16:1.
    // See the docblock above before changing this.
    textOnPrimary: palette.ink[950],

    textPrimary: palette.white,
    textSecondary: palette.alpha.whiteHi,
    textMuted: palette.alpha.whiteSubtle,

    border: palette.alpha.whiteLine,
    borderStrong: palette.alpha.whiteMuted,
    /** Hairline between rows inside one card — softer than a card border. */
    divider: palette.alpha.whiteSoft,
    inputBorderFocus: labPalette.accent,

    /**
     * The DEEP accent, for a fill that must carry white text. `primary` is the
     * pale accent and cannot (3.16:1); this is 6.51:1 with white. Anything that
     * needs a white label fills with this — see the contrast note above.
     */
    primaryStrong: labPalette.accentSolid,
    onPrimaryStrong: palette.white,

    /** Explicit alias of the raised step, for callers naming the ladder. */
    surfaceRaised: labPalette.surfaceRaised,
    surfaceOverlay: labPalette.surfaceOverlay,

    /** Below `textMuted` — timestamps, row hints, unit suffixes. */
    textFaint: palette.alpha.whiteMuted,

    /**
     * Tone triples for the two tones `staffTheme` does not define. `success`,
     * `warning` and `danger` arrive nested from the spread above; these complete
     * the set so `tone()` is a plain lookup rather than a switch.
     *
     * Both values below settle a real divergence. The tone switch existed in
     * FOUR live copies — LabShell (exported, and used by Inventory and Billing
     * Rules through `Pill`), HomeScreen, and as `chipToneStyle` in FormulaScreen
     * and FormulaHistoryScreen — and they disagreed on exactly these two:
     *
     *   brand border:  primarySoft (LabShell, Home) vs primary (the other two)
     *   neutral bg:    surfaceAlt  (LabShell, Home) vs inputBg
     *   neutral border: border     (LabShell, Home) vs borderStrong
     *
     * `brand` takes the VISIBLE border: primarySoft is the same colour as the
     * fill, so that variant drew a chip with no edge at all — a bug rather than
     * a style. `neutral` takes the opaque raised step from the documented
     * surface ladder, rather than a translucent input recess, because this is a
     * chip sitting on a card and not a field.
     */
    brand: {
      text: labPalette.accent,
      bg: labPalette.accentSoft,
      border: labPalette.accent,
    },
    neutral: {
      text: palette.alpha.whiteHi,
      bg: labPalette.surfaceRaised,
      border: palette.alpha.whiteLine,
    },

    // Flat aliases for the nested `success`/`warning`/`danger` tones above.
    successText: staffTheme.colors.success.text,
    successBg: staffTheme.colors.success.bg,
    successBorder: staffTheme.colors.success.border,
    warningText: staffTheme.colors.warning.text,
    warningBg: staffTheme.colors.warning.bg,
    warningBorder: staffTheme.colors.warning.border,
    dangerText: staffTheme.colors.danger.text,
    dangerBg: staffTheme.colors.danger.bg,
    dangerBorder: staffTheme.colors.danger.border,
  },
  spacing,
  radius,
  typography,
  /**
   * Icon geometry, re-exported from `src/theme/tokens.ts` so `src/ui/icons`
   * can run on this theme rather than on the unadopted `src/theme/theme.ts`.
   * See the note at the top of `src/ui/index.ts` about those two files.
   */
  iconSize,
  strokeWidth,
  /**
   * Minimum comfortable control heights, sized for gloved hands at a colour
   * bar. Note these are currently observed only by the icon kit and `src/ui` —
   * the screens predate the token and use their own numbers.
   */
  touchTarget,
  /**
   * The remaining primitive scales, from `src/theme/tokens.ts`.
   *
   * These arrived with `src/theme/theme.ts` — a SECOND semantic theme that
   * duplicated this file's job and was imported by nothing except the `src/ui`
   * kit, which in turn was imported by nothing. Dead code depending on dead
   * code, while every screen ran on this file. theme.ts is deleted; tokens.ts
   * stays, because raw scales are a legitimate layer beneath a semantic theme.
   * The kit now runs on this theme, so there is one of each.
   */
  type,
  weight,
  elevation,
  duration,
  easing,
  breakpoint,
  hairline,
  hitSlop,
  maxContentWidth,
  numericStyle,
  pressedOpacity,
  disabledOpacity,
  // Elevation reads as a soft black drop on the dark surfaces; cards still lean
  // on their `border` for separation.
  cardShadow: {
    shadowColor: palette.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 2,
  },
} as const;

export type LabTheme = typeof labTheme;
export type { IconSizeToken } from './tokens';

/** The status tones a chip, pill or banner can take. */
export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand';

export interface ToneTriple {
  text: string;
  bg: string;
  border: string;
}

/**
 * Resolves a tone to its `{ text, bg, border }` triple — THE one implementation.
 *
 * Replaces four copies of the same switch that had drifted apart on `brand` and
 * `neutral` (see the note beside those keys above).
 */
export function tone(name: Tone): ToneTriple {
  return labTheme.colors[name];
}
