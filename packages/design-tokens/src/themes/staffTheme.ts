import { palette } from '../tokens/colors';
import { radius } from '../tokens/radius';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import type { Theme } from './types';

/**
 * Staff mobile theme — dark.
 * Used by stylists, front-desk, managers on the staff app.
 */
export const staffTheme: Theme = {
  name: 'staff',
  mode: 'dark',
  colors: {
    bg: palette.ink[950],
    surface: palette.ink[700],
    surfaceAlt: palette.ink[500],

    textPrimary: palette.white,
    textSecondary: palette.alpha.whiteHi,
    textMuted: palette.alpha.whiteMuted,
    textOnPrimary: palette.ink[950],

    border: palette.alpha.whiteSoft,
    borderStrong: palette.alpha.whiteLine,

    primary: palette.brand[300],
    primarySoft: palette.brand[900],

    success: {
      text: palette.success[300],
      bg: 'rgba(74,222,128,0.12)',
      border: 'rgba(74,222,128,0.32)',
    },
    warning: {
      text: palette.warning[300],
      bg: 'rgba(245,158,11,0.12)',
      border: 'rgba(245,158,11,0.32)',
    },
    danger: {
      text: palette.danger[300],
      bg: 'rgba(248,113,113,0.12)',
      border: 'rgba(248,113,113,0.32)',
    },
    neutral: {
      text: palette.alpha.whiteSubtle,
      bg: palette.alpha.whiteSoft,
      border: palette.alpha.whiteLine,
    },

    inputBg: palette.alpha.whiteFaint,
    inputBorder: palette.alpha.whiteLine,
    inputPlaceholder: palette.alpha.whiteMuted,

    overlay: 'rgba(0,0,0,0.55)',
  },
  spacing,
  radius,
  typography,
};
