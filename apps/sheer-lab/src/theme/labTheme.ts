import { palette, radius, spacing, staffTheme, typography } from '@sheer/design-tokens';

import { iconSize, strokeWidth, touchTarget } from './tokens';

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
