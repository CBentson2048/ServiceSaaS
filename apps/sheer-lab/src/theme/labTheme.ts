import { palette, radius, spacing, staffTheme, typography } from '@sheer/design-tokens';

export const labTheme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,
    background: palette.ink[950],
    surface: palette.ink[900],
    card: palette.ink[700],
    primary: palette.brand[500],
    primaryPressed: palette.brand[700],
    // Active sidebar item: a solid, saturated brand pill with white text/glyph
    // (the lighter `brand[500]` is too pale for legible white text).
    sidebarActive: palette.brand[700],
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
 * Surfaces step up from the near-black canvas: page = `ink[950]`, cards / top bar
 * / sidebar = `ink[900]`, inner tiles = `ink[700]`. Accents stay on the purple
 * brand, tuned lighter (`brand[500]`) so they read on the dark ink.
 */
export const labLightTheme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,
    background: palette.ink[950],
    surface: palette.ink[900],
    surfaceAlt: palette.ink[700],
    card: palette.ink[900],

    // Side navigation rail: a subtly elevated dark panel with light text and a
    // deep-purple highlight (`primarySoft`) on the active item.
    sidebar: palette.ink[900],
    sidebarBorder: palette.alpha.whiteLine,
    sidebarText: palette.alpha.whiteHi,
    sidebarTextMuted: palette.alpha.whiteSubtle,
    // Active item: a solid, saturated brand pill with white text/glyph (the
    // lighter `brand[500]` primary is too pale to carry legible white text).
    sidebarActive: palette.brand[700],
    sidebarActiveText: palette.white,

    // Hero "Welcome" panel — a deep-purple brand feature card that stands off
    // the near-black canvas; keeps the white CTA button from the mockup.
    hero: palette.brand[900],
    heroSoft: palette.alpha.whiteSoft,
    heroBorder: palette.alpha.whiteLine,
    heroText: palette.white,
    heroTextMuted: palette.alpha.whiteSubtle,
    onHeroButtonBg: palette.white,
    onHeroButtonText: palette.ink[900],

    // Brand purple tuned for dark surfaces: the lighter `brand[500]` reads on
    // near-black, and soft fills use the deep `brand[900]` for selected/active
    // surfaces (active nav, avatars, count badges).
    primary: palette.brand[500],
    primaryPressed: palette.brand[700],
    primarySoft: palette.brand[900],

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
