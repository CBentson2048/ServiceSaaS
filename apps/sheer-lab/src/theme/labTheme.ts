import { palette, radius, spacing, staffTheme, typography } from '@sheer/design-tokens';

/**
 * Lab-only palette for the QLAB rebrand (purple flask + infinity mark).
 * Scoped here rather than in `@sheer/design-tokens` because the shared
 * `palette` still drives the web and sheer-app themes — only the Lab app
 * carries the new identity.
 *
 * The ink ramp keeps the violet hue family of the `#19131F` canvas. The
 * accent ramp is sampled from the logo's gradient (`#601890` → `#9C0CC0`):
 * `accent` is lightened for legible accent text on the canvas (5.8:1) and
 * `accentSolid` stays deep enough to carry white text (6.5:1) — no single
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

export const labTheme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,
    background: labPalette.bg,
    surface: labPalette.surface,
    card: labPalette.surfaceRaised,
    primary: labPalette.accent,
    primaryPressed: labPalette.accentSolid,
    // Active sidebar item: a solid, saturated brand pill with white text/glyph
    // (the lighter `accent` is too pale for legible white text).
    sidebarActive: labPalette.accentSolid,
    sidebarActiveText: palette.white,
    textPrimary: palette.white,
    textSecondary: palette.alpha.whiteHi,
    textMuted: palette.alpha.whiteSubtle,
    border: palette.alpha.whiteLine,
  },
  spacing,
  radius,
  typography,
} as const;

export type LabTheme = typeof labTheme;

/**
 * Dark theme for the QLOOQO Lab dashboard. Built on the shared dark `staffTheme`
 * so the dashboard (and the `LabShell` screens that consume this theme) match the
 * dark `labTheme` used by the rest of the Lab screens (Formula History, Formula,
 * etc.). It keeps the dashboard-specific semantic keys (the `hero` and `sidebar`
 * tokens and the flat `success` / `warning` / `danger` aliases) on the dark base.
 *
 * Surfaces step up from the near-black canvas: page = `labPalette.bg`, cards /
 * top bar / sidebar = `labPalette.surface`, inner tiles = `labPalette.surfaceRaised`.
 * Accents stay on the purple brand, tuned lighter (`labPalette.accent`) so they
 * read on the dark ink.
 */
export const labLightTheme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,
    background: labPalette.bg,
    surface: labPalette.surface,
    surfaceAlt: labPalette.surfaceRaised,
    card: labPalette.surface,

    // Side navigation rail: a subtly elevated dark panel with light text and a
    // deep-purple highlight (`primarySoft`) on the active item.
    sidebar: labPalette.surface,
    sidebarBorder: palette.alpha.whiteLine,
    sidebarText: palette.alpha.whiteHi,
    sidebarTextMuted: palette.alpha.whiteSubtle,
    // Active item: a solid, saturated brand pill with white text/glyph (the
    // lighter `accent` primary is too pale to carry legible white text).
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

    // Brand purple tuned for dark surfaces: the lighter `accent` reads on
    // near-black, and soft fills use the deep `accentSoft` for selected/active
    // surfaces (active nav, avatars, count badges).
    primary: labPalette.accent,
    primaryPressed: labPalette.accentSolid,
    primarySoft: labPalette.accentSoft,

    textPrimary: palette.white,
    textSecondary: palette.alpha.whiteHi,
    textMuted: palette.alpha.whiteSubtle,
    textOnPrimary: palette.white,

    border: palette.alpha.whiteLine,
    borderStrong: palette.alpha.whiteMuted,

    // Status tones in their dark-surface variants (brighter text on a translucent
    // fill) so success/warning/danger stay legible on the ink cards.
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

export type LabLightTheme = typeof labLightTheme;
