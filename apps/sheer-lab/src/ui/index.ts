/**
 * The QLAB UI kit.
 *
 * Screens should import primitives from here rather than hand-rolling a
 * `StyleSheet` per component — the app currently carries ~1,180 style rules
 * across 21 files, most of which are re-derivations of the same button, card,
 * pill and table.
 *
 * ```ts
 * import { Button, Card, CardHeader, Pill, Text } from '../../ui';
 * ```
 *
 * ---------------------------------------------------------------------------
 * STATUS: UNADOPTED, EXCEPT FOR THE ICONS. READ THIS BEFORE USING OR DELETING.
 * ---------------------------------------------------------------------------
 * As of 2026-09-10 no screen imports anything from this barrel. The twelve
 * components below have zero consumers, and the screens still hand-roll their
 * equivalents. That is not because the kit is bad — it is the better-engineered
 * of the two, and it is the only code in the app that observes the
 * `touchTarget` token (44/52/60, sized for gloved hands at a colour bar).
 *
 * It is unadopted because it also depends on a SECOND, parallel design system:
 * `src/theme/theme.ts` + `src/theme/tokens.ts` (573 lines: a type ramp,
 * durations, easing, elevation, hit slops, stroke weights). Those two files
 * likewise have no importers outside this directory — dead code depending on
 * dead code — while every screen runs on `src/theme/labTheme.ts`.
 *
 * So there is a real, open architectural choice, and it is too big to make as a
 * side effect of a refactor:
 *
 *   A. MIGRATE TO THIS KIT. Merge tokens.ts into labTheme, port the ~1,180
 *      hand-rolled style rules across 19 screens to these primitives. Weeks of
 *      work, and the right end state — one kit, one token system, and the
 *      touch-target and type ramps actually observed.
 *
 *   B. DELETE IT. Removes the trap of two kits and two token systems at the
 *      cost of throwing away finished design work that nothing yet replaces.
 *
 * Until someone decides, do not add a thirteenth component here, and do not
 * assume a screen can safely import one of these — check whether its theme
 * dependency still resolves to something live.
 *
 * WHAT WAS SALVAGED. `src/ui/icons` IS now live: `Icon.tsx` was rewired from
 * the dead `theme.ts` to `labTheme`, and `src/navigation/labNav.ts` renders the
 * station nav with it. That set existed, finished, with a docblock naming the
 * exact emoji it was written to replace, while the app drew its whole
 * iconography in emoji. It only needed one import changed.
 */
export { Banner } from './Banner';
export type { BannerProps } from './Banner';

export { Button, ButtonRow, IconButton } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { Card, CardHeader, Divider } from './Card';
export type { CardHeaderProps, CardProps } from './Card';

export { DataTable } from './DataTable';
export type { Column, DataTableProps } from './DataTable';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Pill } from './Pill';
export type { PillProps } from './Pill';

export { ProgressBar } from './Progress';
export type { ProgressBarProps } from './Progress';

export { Skeleton, SkeletonRow, SkeletonText } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { Sheet } from './Sheet';
export type { SheetProps } from './Sheet';

export { StatRow, StatTile } from './StatTile';
export type { StatTileProps } from './StatTile';

export { Body, Caption, Overline, Text, Title } from './Text';
export type { LabTextProps, TextTone } from './Text';

export { TextField } from './TextField';
export type { TextFieldProps } from './TextField';

export { Icon } from './icons';
export type { IconName, IconProps, IconTone } from './icons';

export { theme, tone, resolveLayout } from '../theme/theme';
export type { LabAppTheme, LabLayout, LayoutMode, Tone, ToneTriple } from '../theme/theme';
export { useLabLayout } from '../theme/useLabLayout';
