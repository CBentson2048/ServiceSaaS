/**
 * Raw colour palette. Themes map these to semantic roles.
 * Do not consume these directly from screens — use the active `Theme.colors`.
 */
export const palette = {
  white: '#FFFFFF',
  black: '#000000',

  brand: {
    50: '#F5F3FF',
    100: '#EDE9FE',
    300: '#C4A0F5',
    500: '#A67CF5',
    700: '#7C3AED',
    900: '#2E1F4A',
  },

  ink: {
    50: '#F0EDF8',
    100: '#E0DCF0',
    500: '#3A3047',
    700: '#211A2E',
    900: '#1C1628',
    950: '#18141F',
  },

  neutral: {
    0: '#FFFFFF',
    50: '#F8F6FD',
    100: '#F0EEF6',
    150: '#F0EDF8',
    200: '#EAE8F0',
    300: '#D0CCE0',
    400: '#AAAAAA',
    500: '#999999',
    600: '#6B6480',
    700: '#3A3047',
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
    inkFaint: 'rgba(28,22,40,0.04)',
    inkSoft: 'rgba(28,22,40,0.08)',
    inkOverlay: 'rgba(28,22,40,0.5)',
  },
} as const;

export type Palette = typeof palette;
