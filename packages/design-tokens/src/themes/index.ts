export * from './types.js';
export { staffTheme } from './staffTheme.js';
export { clientTheme } from './clientTheme.js';
export { webTheme } from './webTheme.js';

import { clientTheme } from './clientTheme.js';
import { staffTheme } from './staffTheme.js';
import { webTheme } from './webTheme.js';
import type { Theme, ThemeName } from './types.js';

export const themes: Record<ThemeName, Theme> = {
  staff: staffTheme,
  client: clientTheme,
  web: webTheme,
};
