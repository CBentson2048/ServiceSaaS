export * from './types';
export { staffTheme } from './staffTheme';
export { clientTheme } from './clientTheme';
export { webTheme } from './webTheme';

import { clientTheme } from './clientTheme';
import { staffTheme } from './staffTheme';
import { webTheme } from './webTheme';
import type { Theme, ThemeName } from './types';

export const themes: Record<ThemeName, Theme> = {
  staff: staffTheme,
  client: clientTheme,
  web: webTheme,
};
