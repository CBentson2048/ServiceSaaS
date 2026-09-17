import type React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { labTheme as theme, tone as resolveTone, type Tone } from '../theme/labTheme';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export interface PillProps {
  label: string;
  /** Status colour. Defaults to `neutral`. */
  tone?: Tone;
  /** Compact height, for pills inside a dense table row. */
  size?: 'sm' | 'md';
  /** Optional leading icon. */
  icon?: IconName;
  /**
   * Prepends a solid status dot. Use on tones that carry meaning at a glance
   * (live / offline / error) so state is not signalled by colour alone —
   * important for the ~8% of men with colour-vision deficiency, and for a
   * screen glanced at across a salon.
   */
  dot?: boolean;
  /** Renders for a dark brand surface (the hero panel) rather than a card. */
  onDark?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A status pill.
 *
 * Consolidates the `Pill` implementations in `LabShell` and `HomeScreen` plus
 * the `StatusChip` / `chipToneStyle` variants in the formula screens — four
 * copies that had drifted on padding, radius and tone mapping.
 */
export function Pill({
  label,
  tone = 'neutral',
  size = 'md',
  icon,
  dot = false,
  onDark = false,
  style,
}: PillProps): React.JSX.Element {
  const palette = resolveTone(tone);
  const bg = onDark ? theme.colors.heroSoft : palette.bg;
  const border = onDark ? theme.colors.heroBorder : palette.border;
  const fg = onDark ? theme.colors.heroText : palette.text;

  return (
    <View
      style={[
        styles.pill,
        size === 'sm' ? styles.sm : styles.md,
        { backgroundColor: bg, borderColor: border },
        style,
      ]}
    >
      {dot ? <View style={[styles.dot, { backgroundColor: fg }]} /> : null}
      {icon ? <Icon name={icon} size={theme.iconSize.xs} tone="inherit" color={fg} /> : null}
      {/* `style` is applied after the tone colour inside `Text`, so the
          resolved tone/onDark colour wins here. */}
      <Text variant="micro" style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.full,
    borderWidth: theme.hairline,
    alignSelf: 'flex-start',
  },
  sm: { paddingHorizontal: theme.spacing.sm, paddingVertical: 2 },
  md: { paddingHorizontal: theme.spacing.md, paddingVertical: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
