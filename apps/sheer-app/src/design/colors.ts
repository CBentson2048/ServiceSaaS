import { palette, staffTheme } from '@sheer/design-tokens';
import { BRAND_ACCENT, sheerAppTheme } from './appTheme';

/**
 * THE app's named colours, for use inside a screen's `StyleSheet.create`.
 *
 * Every value here is READ OFF `sheerAppTheme` — the same object
 * `ThemeProvider` serves to `useTheme()`. That is the point: a screen's
 * StyleSheet and a design component now resolve the same colour from the same
 * place, so they cannot drift apart. Change `appTheme.ts` and both follow.
 *
 * (StyleSheet.create runs at module scope, outside React, so a screen cannot
 * call `useTheme()` for its static styles. That is the only reason this file
 * exists rather than screens using the hook.)
 *
 * Before this, 18 screens each declared their own constants and they had
 * drifted: `BG` and `CARD` were each written both as a raw hex and as the
 * token resolving to the same hex; `BORDER` carried four alpha values; and
 * `notifications.tsx` used the identifier `BRAND` for the colour every other
 * file called `BRAND_LIGHT`.
 *
 * STILL TO DO: the inline `'rgba(255,255,255,0.xx)'` values scattered through
 * the screens' StyleSheets. Muted body text alone is written six ways (0.4,
 * 0.45, 0.48, 0.5, 0.55, 0.6). Collapsing those changes text contrast on every
 * screen, so it wants doing with the app in front of you.
 */

/** Page background. */
export const BG = sheerAppTheme.colors.bg;

/** Raised surface: cards, sheets, the tab bar. */
export const CARD = sheerAppTheme.colors.surface;

/** Hairline dividers and card outlines. */
export const BORDER = sheerAppTheme.colors.border;

/**
 * A quieter divider, for rules INSIDE an already-outlined card. This is the
 * token package's own `border`, which the app overrides at the top level.
 */
export const BORDER_SUBTLE = staffTheme.colors.border;

/** Brand accent for text, icons and active states on the dark ground. */
export const BRAND_LIGHT = BRAND_ACCENT;

/** Brand fill for solid buttons and badges. */
export const BRAND = sheerAppTheme.colors.primary;

/** Primary body text. */
export const TEXT = sheerAppTheme.colors.textPrimary;

/** Supporting copy. */
export const TEXT_MUTED = sheerAppTheme.colors.textSecondary;

/** De-emphasised text and inactive icons. */
export const TEXT_SUBTLE = sheerAppTheme.colors.textMuted;

// The 300 shades, not the 500s: this app is dark-ground only, and the darker
// 500s do not clear the contrast bar on ink[950]. Matches what the screens
// already reach for (danger[300] 40x, success[300] 29x, warning[300] 27x).
export const SUCCESS = palette.success[300];
export const WARNING = palette.warning[300];
export const DANGER = palette.danger[300];
