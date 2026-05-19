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
