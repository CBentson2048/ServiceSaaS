import { clientTheme, palette } from '@sheer/design-tokens';

export const labTheme = {
  ...clientTheme,
  colors: {
    ...clientTheme.colors,
    bg: '#f6f1eb',
    surfaceAlt: '#fff7ed',
    primary: palette.brand[700],
    primarySoft: palette.brand[50],
  },
};

export const labColors = {
  basin: '#0f766e',
  basinSoft: '#ccfbf1',
  ink: '#1f2937',
  amber: '#b45309',
  scaleConnected: '#16a34a',
  scaleSearching: '#f59e0b',
};
