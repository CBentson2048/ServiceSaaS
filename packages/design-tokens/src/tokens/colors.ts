/**
 * Raw colour palette. Themes map these to semantic roles.
 * Do not consume these directly from screens — use the active `Theme.colors`.
 */
export const palette = {
  white: '#FFFFFF',
  black: '#000000',

  brand: {
    50: '#F8EEE9',
    100: '#F2DDD5',
    300: '#E6A08D',
    500: '#6B3A57',
    700: '#4E263E',
    900: '#2B1927',
  },

  ink: {
    50: '#F1E8E5',
    100: '#E7D8D3',
    500: '#59434F',
    700: '#382430',
    900: '#2B1927',
    950: '#20131D',
  },

  neutral: {
    0: '#FFFFFF',
    50: '#FFFCF8',
    100: '#F5F0EA',
    150: '#F0E8E1',
    200: '#E4D9CF',
    300: '#CDBEB3',
    400: '#A7989E',
    500: '#8A7C82',
    600: '#6D6066',
    700: '#40343A',
  },

  success: {
    100: '#DCFCE7',
    300: '#4ADE80',
    500: '#22C55E',
    700: '#16A34A',
  },

  warning: {
    100: '#FEF3C7',
    300: '#F59E0B',
    500: '#D97706',
    700: '#B45309',
  },

  danger: {
    100: '#FEE2E2',
    300: '#F87171',
    500: '#EF4444',
    700: '#DC2626',
    tint: '#FEF9F9',
  },

  alpha: {
    whiteFaint: 'rgba(255,255,255,0.04)',
    whiteSoft: 'rgba(255,255,255,0.08)',
    whiteLine: 'rgba(255,255,255,0.16)',
    whiteMuted: 'rgba(255,255,255,0.4)',
    whiteSubtle: 'rgba(255,255,255,0.6)',
    whiteHi: 'rgba(255,255,255,0.85)',
    inkFaint: 'rgba(43,25,39,0.04)',
    inkSoft: 'rgba(43,25,39,0.08)',
    inkOverlay: 'rgba(32,19,29,0.56)',
  },
} as const;

export type Palette = typeof palette;
