import { palette } from '@sheer/design-tokens';

/**
 * THE app's named colours. One definition each, imported by every screen.
 *
 * Before this file, 18 screens each declared their own `const BG = …`,
 * `const CARD = …`, `const BORDER = …` at the bottom of the module, and they
 * had drifted:
 *
 *  - `BG` was written as the raw hex `'#18141F'` on 11 screens and as
 *    `palette.ink[950]` on 6 — the same colour, spelled two ways.
 *  - `CARD` likewise: `'#211A2E'` and `palette.ink[700]`.
 *  - `BORDER` had FOUR alpha values across the app (0.13, 0.12, 0.08, 0.07)
 *    where only two were ever intended.
 *  - `notifications.tsx` used the name `BRAND` for `brand[300]`, which every
 *    other screen calls `BRAND_LIGHT` — the same identifier meaning two
 *    different colours depending on which file you had open.
 *
 * Everything resolves through `@sheer/design-tokens`, so this app and the web
 * dashboard cannot drift apart either.
 *
 * TWO DELIBERATE DIVERGENCES from `staffTheme` in the token package, recorded
 * here rather than left as a mystery for whoever notices next:
 *
 *  - `BORDER` is alpha 0.13, not `staffTheme.border`'s 0.08. The app's dividers
 *    sit on a near-black ground where 0.08 all but disappears on an OLED phone;
 *    0.13 is what most screens had already converged on. 0.08 survives as
 *    `BORDER_SUBTLE` because two screens use both weights deliberately.
 *  - `BRAND_LIGHT` is `brand[300]`, not `staffTheme.primary` (`brand[500]`).
 *    15 screens use the lighter tint for text and icons because brand[500] on
 *    ink[950] does not clear the contrast bar for small text.
 *
 * If either should change, change it HERE and the whole app follows.
 *
 * STILL TO DO: the inline `'rgba(255,255,255,0.xx)'` values scattered through
 * the screens' StyleSheets. Muted body text alone is written six ways (0.4,
 * 0.45, 0.48, 0.5, 0.55, 0.6). Collapsing those is a visual change on every
 * screen, so it wants doing deliberately rather than as a find-and-replace.
 */

/** Page background. */
export const BG = palette.ink[950];

/** Raised surface: cards, sheets, the tab bar. */
export const CARD = palette.ink[700];

/** Hairline dividers and card outlines. */
export const BORDER = 'rgba(255,255,255,0.13)';

/** A quieter divider, for rules INSIDE an already-outlined card. */
export const BORDER_SUBTLE = 'rgba(255,255,255,0.08)';

/** Brand accent for text, icons and active states on the dark ground. */
export const BRAND_LIGHT = palette.brand[300];

/** Brand fill for solid buttons and badges. */
export const BRAND = palette.brand[500];

/** Primary body text. */
export const TEXT = palette.white;

/** De-emphasised text and inactive icons. */
export const TEXT_SUBTLE = 'rgba(255,255,255,0.4)';
