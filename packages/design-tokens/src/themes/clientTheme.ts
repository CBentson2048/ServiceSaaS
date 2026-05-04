import { palette } from '../tokens/colors';
import { radius } from '../tokens/radius';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import type { Theme } from './types';

/**
 * Client mobile theme — light.
 * Used by salon clients on the consumer-facing mobile app.
 */
export const clientTheme: Theme = {
  name: 'client',
  mode: 'light',
  colors: {
    bg: palette.neutral[50],
    surface: palette.white,
    surfaceAlt: palette.ink[50],

    textPrimary: palette.ink[900],
    textSecondary: palette.neutral[600],
    textMuted: palette.neutral[500],
    textOnPrimary: palette.white,

    border: palette.neutral[200],
    borderStrong: palette.neutral[300],

    primary: palette.brand[500],
    primarySoft: palette.brand[50],

    success: {
      text: palette.success[700],
      bg: 'rgba(74,222,128,0.12)',
      border: 'rgba(22,163,74,0.32)',
    },
    warning: {
      text: palette.warning[700],
      bg: 'rgba(245,158,11,0.12)',
      border: 'rgba(180,83,9,0.32)',
    },
    danger: {
      text: palette.danger[700],
      bg: 'rgba(248,113,113,0.12)',
      border: 'rgba(220,38,38,0.32)',
    },
    neutral: {
      text: palette.neutral[600],
      bg: palette.ink[50],
      border: palette.neutral[200],
    },

    inputBg: palette.white,
    inputBorder: palette.neutral[200],
    inputPlaceholder: palette.neutral[500],

    overlay: palette.alpha.inkOverlay,
  },
  spacing,
  radius,
  typography,
};
