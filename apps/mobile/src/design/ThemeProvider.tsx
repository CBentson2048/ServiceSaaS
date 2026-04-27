import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { staffTheme, type Theme, type ThemeName, themes } from '@sheer/design-tokens';

const ThemeContext = createContext<Theme>(staffTheme);

export interface ThemeProviderProps {
  /** Pick a named theme. Defaults to `staff` (dark). */
  theme?: ThemeName;
  /** Or pass a fully-formed theme object (advanced). */
  value?: Theme;
  children: ReactNode;
}

/**
 * Wraps the app and exposes a `Theme` to descendants via `useTheme()`.
 *
 *  <ThemeProvider theme="staff">
 *    <App />
 *  </ThemeProvider>
 */
export function ThemeProvider({ theme = 'staff', value, children }: ThemeProviderProps) {
  const resolved = useMemo<Theme>(() => value ?? themes[theme], [theme, value]);
  return <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>;
}

/** Hook used by every primitive — never read raw tokens from screens. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
