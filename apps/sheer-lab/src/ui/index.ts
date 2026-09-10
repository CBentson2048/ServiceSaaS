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
 * STATUS: LIVE, PARTLY ADOPTED.
 * ---------------------------------------------------------------------------
 * This kit had zero importers until 2026-09-10, for one reason: every component
 * imported `src/theme/theme.ts` — a second, parallel semantic theme that
 * nothing outside this directory used, while every screen ran on
 * `src/theme/labTheme.ts`. Dead code depending on dead code.
 *
 * That is resolved. There is now ONE semantic theme (`labTheme`) over ONE token
 * layer (`tokens.ts`), and this kit runs on it. `theme.ts` and the duplicate
 * `useLabLayout` beside it are deleted; `labTheme` absorbed the seven semantic
 * keys and twelve primitive scales they contributed, so nothing was lost.
 *
 * ADOPTION IS INCREMENTAL, ON PURPOSE. The screens still carry ~1,180
 * hand-rolled style rules, and porting all nineteen of them in one sweep would
 * be a large unreviewable visual change. `Banner` is adopted (Inventory and
 * Billing Rules, replacing a recipe that had been hand-copied byte-for-byte
 * into both) and `Icon` is adopted app-wide. The rest are ready to use: prefer
 * them when you next touch a screen, rather than re-deriving a card, pill,
 * table or field.
 *
 * Two things this kit still has that the screens do not, and which are reasons
 * to prefer it: it observes the `touchTarget` scale (44/52/60, sized for gloved
 * hands at a colour bar) and the `type` ramp. No screen does either.
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

export { labTheme as theme, tone } from '../theme/labTheme';
export type { LabTheme as LabAppTheme, Tone, ToneTriple } from '../theme/labTheme';
// The layout resolver lives in `src/screens/shared/LabShell.tsx`, which is the
// only thing that renders a sidebar. `src/theme/theme.ts` carried a SECOND copy
// (with a `useLabLayout` wrapper beside it) that nothing but this barrel ever
// referenced; both are deleted.
export { useLabLayout } from '../screens/shared/LabShell';
export type { LabLayout, LayoutMode } from '../screens/shared/LabShell';
