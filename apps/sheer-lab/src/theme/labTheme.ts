import { clientTheme, palette, radius, spacing, staffTheme, typography } from '@sheer/design-tokens';

export const labTheme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,
    background: palette.ink[950],
    surface: palette.ink[900],
    card: palette.ink[700],
    primary: palette.brand[500],
    primaryPressed: palette.brand[700],
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
 * Light theme for the QLOOQO Lab dashboard. Built entirely from the shared
 * design tokens (clientTheme = the system's light theme) so it stays in step
 * with the rest of the platform. The remaining Lab screens keep the dark
 * `labTheme`; only the dashboard opts into this lighter surface treatment.
 *
 * The `hero*` keys give us a dark, ink-toned feature card (the "Welcome" /
 * "Start new mix" panel) that sits on the light page — still token-driven via
 * `palette.ink` and the white-alpha overlays.
 */
export const labLightTheme = {
  ...clientTheme,
  colors: {
    ...clientTheme.colors,
    background: clientTheme.colors.bg,
    surface: clientTheme.colors.surface,
    surfaceAlt: clientTheme.colors.surfaceAlt,
    card: clientTheme.colors.surface,

    hero: palette.ink[950],
    heroSoft: palette.alpha.whiteSoft,
    heroBorder: palette.alpha.whiteLine,
    heroText: palette.white,
    heroTextMuted: palette.alpha.whiteSubtle,
    onHeroButtonBg: palette.white,
    onHeroButtonText: palette.ink[900],

    // Primary/main colour for the Lab system is the darkest ink token
    // (#18141F), not the purple brand. Soft fills + pressed states use lighter
    // ink steps so selected/active surfaces stay monochrome.
    primary: palette.ink[950],
    primaryPressed: palette.ink[700],
    primarySoft: palette.ink[50],

    textPrimary: clientTheme.colors.textPrimary,
    textSecondary: clientTheme.colors.textSecondary,
    textMuted: clientTheme.colors.textMuted,
    textOnPrimary: clientTheme.colors.textOnPrimary,

    border: clientTheme.colors.border,
    borderStrong: clientTheme.colors.borderStrong,

    // Convenience aliases so dashboard components can read a flat colour.
    successText: clientTheme.colors.success.text,
    successBg: clientTheme.colors.success.bg,
    successBorder: clientTheme.colors.success.border,
    warningText: clientTheme.colors.warning.text,
    warningBg: clientTheme.colors.warning.bg,
    warningBorder: clientTheme.colors.warning.border,
    dangerText: clientTheme.colors.danger.text,
    dangerBg: clientTheme.colors.danger.bg,
    dangerBorder: clientTheme.colors.danger.border,
  },
  spacing,
  radius,
  typography,
  // Subtle card elevation, ink-toned to match the rest of the system shadows.
  cardShadow: {
    shadowColor: '#1C1628',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
} as const;

export type LabLightTheme = typeof labLightTheme;
