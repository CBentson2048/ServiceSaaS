import { palette, staffTheme, type Theme } from '@sheer/design-tokens';

/**
 * THE theme this app runs on. `_layout.tsx` feeds it to ThemeProvider, and
 * `colors.ts` derives its named constants from it, so `useTheme()` inside a
 * design component and `BORDER` inside a screen's StyleSheet can never
 * disagree about what a border is.
 *
 * It is `staffTheme` with ONE override, recorded here rather than left as a
 * mystery for whoever notices next:
 *
 *   border 0.08 -> 0.13. The app's dividers sit on a near-black ground where
 *   0.08 all but disappears on an OLED phone, and 0.13 is what most screens
 *   had independently converged on before any of this was shared. The token
 *   package's 0.08 survives as `BORDER_SUBTLE` for rules INSIDE an already
 *   outlined card, which two screens use deliberately.
 */
export const sheerAppTheme: Theme = {
  ...staffTheme,
  colors: {
    ...staffTheme.colors,
    border: 'rgba(255,255,255,0.13)',
  },
};

/**
 * The light brand tint, for text and icons on the dark ground.
 *
 * It lives beside the theme rather than in it because `Theme.colors` has no
 * slot for an accent distinct from `primary`: `primary` (brand[500]) is the
 * FILL under white button text, while this is a FOREGROUND colour, and
 * brand[500] as small text on ink[950] does not clear the contrast bar.
 * 15 screens were already using it before it had a name here.
 */
export const BRAND_ACCENT = palette.brand[300];
