import type React from 'react';
import { useMemo } from 'react';
import Svg, { Path } from 'react-native-svg';

import { theme } from '../../theme/theme';
import type { IconSizeToken } from '../../theme/tokens';
import { FILLED_ICONS, ICON_VIEWBOX, iconPaths, type IconName } from './paths';

/**
 * Semantic colour roles an icon can take. Naming the role rather than passing a
 * hex means an icon automatically follows a future palette change, and it keeps
 * screens from reaching into `theme.colors` for one-off tints.
 */
export type IconTone =
  | 'primary' // high-contrast white — the default for actionable icons
  | 'secondary' // 85% white — icons beside secondary text
  | 'muted' // 60% white — decorative or resting-state icons
  | 'brand' // the light accent
  | 'onBrand' // sits on a `primaryStrong` fill
  | 'success'
  | 'warning'
  | 'danger'
  | 'inherit'; // caller supplies `color` directly

export interface IconProps {
  name: IconName;
  /** A token from the icon scale, or an explicit pt size. Defaults to `base` (20). */
  size?: IconSizeToken | number;
  /** Semantic colour role. Defaults to `secondary`. */
  tone?: IconTone;
  /** Explicit colour — only honoured when `tone` is `'inherit'`. */
  color?: string;
  /**
   * Overrides the computed stroke weight. Leave unset: the default scales with
   * size so small icons stay crisp and large ones don't look hairline.
   */
  strokeWidth?: number;
  /**
   * Accessible name. Provide it when the icon is the *only* content of a
   * control; omit it for icons that sit beside a visible text label, where
   * announcing both would be redundant.
   */
  label?: string;
}

function resolveTone(tone: IconTone, color?: string): string {
  switch (tone) {
    case 'primary':
      return theme.colors.textPrimary;
    case 'muted':
      return theme.colors.textMuted;
    case 'brand':
      return theme.colors.primary;
    case 'onBrand':
      return theme.colors.onPrimaryStrong;
    case 'success':
      return theme.colors.successText;
    case 'warning':
      return theme.colors.warningText;
    case 'danger':
      return theme.colors.dangerText;
    case 'inherit':
      return color ?? theme.colors.textSecondary;
    default:
      return theme.colors.textSecondary;
  }
}

/**
 * Scales the stroke so icons stay optically even across the size ramp.
 *
 * A fixed 1.75 stroke looks heavy at 14pt and thin at 36pt, because stroke
 * weight should grow sub-linearly with size. The square-root relationship below
 * is the usual approximation, clamped so it never leaves the 1.25–2.4 band
 * where the set still reads as one weight.
 */
function resolveStroke(size: number, override?: number): number {
  if (override != null) return override;
  const scaled = theme.strokeWidth.base * Math.sqrt(size / theme.iconSize.base);
  return Math.min(2.4, Math.max(1.25, Number(scaled.toFixed(2))));
}

/**
 * The QLAB icon.
 *
 * Replaces the emoji and Unicode glyphs the app used as iconography. Unlike an
 * emoji this takes the theme's tint, aligns to the type ramp, and can carry an
 * accessible name.
 *
 * ```tsx
 * <Icon name="flask" size="md" tone="brand" />
 * <Icon name="refresh" label="Refresh dashboard" />   // icon-only button
 * ```
 */
export function Icon({
  name,
  size = 'base',
  tone = 'secondary',
  color,
  strokeWidth,
  label,
}: IconProps): React.JSX.Element {
  const px = typeof size === 'number' ? size : theme.iconSize[size];
  const resolved = resolveTone(tone, color);
  const filled = FILLED_ICONS.has(name);
  const stroke = useMemo(() => resolveStroke(px, strokeWidth), [px, strokeWidth]);

  return (
    <Svg
      width={px}
      height={px}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      fill="none"
      // An unlabelled icon is decorative: hide it from the accessibility tree
      // so screen readers announce the surrounding control's label once,
      // instead of reading a stray glyph name alongside it.
      accessibilityElementsHidden={label == null}
      importantForAccessibility={label == null ? 'no-hide-descendants' : 'yes'}
      accessibilityRole={label != null ? 'image' : undefined}
      accessibilityLabel={label}
    >
      <Path
        d={iconPaths[name]}
        stroke={filled ? 'none' : resolved}
        fill={filled ? resolved : 'none'}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
