import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme, tone as resolveTone, type Tone } from '../theme/theme';
import { Text } from './Text';

export interface ProgressBarProps {
  /** 0–1. Values outside the range are clamped. */
  value: number;
  tone?: Tone;
  /** Track height. Defaults to 6. */
  height?: number;
  /** Shows a percentage label to the right of the track. */
  showValue?: boolean;
  /** Accessible description, e.g. "Bleach 30 volume, 45 of 60 grams". */
  label?: string;
  style?: StyleProp<ViewStyle>;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * A horizontal progress track.
 *
 * Replaces the `track` / `trackFill` pairs in the dashboard's inventory panel
 * and the formula screens' session progress, which were static views with a
 * percentage width — so a bar filling as ingredients are weighed jumped
 * straight to its new length. Animating the fill makes the change legible at a
 * glance, which matters when the stylist is looking at the bowl, not the iPad.
 *
 * Also carries a proper `progressbar` role: the current bars are invisible to
 * assistive tech.
 */
export function ProgressBar({
  value,
  tone = 'brand',
  height = 6,
  showValue = false,
  label,
  style,
}: ProgressBarProps): React.JSX.Element {
  const target = clamp01(value);
  const anim = useRef(new Animated.Value(target)).current;
  const palette = resolveTone(tone);

  useEffect(() => {
    Animated.timing(anim, {
      toValue: target,
      duration: theme.duration.base,
      easing: Easing.bezier(...theme.easing.decelerate),
      // Width can't be driven natively; these bars are small and few, so the
      // JS-driven interpolation is not a measurable cost here.
      useNativeDriver: false,
    }).start();
  }, [anim, target]);

  const width = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={[styles.row, style]}>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(target * 100) }}
        style={[styles.track, { height, borderRadius: height / 2 }]}
      >
        <Animated.View style={[styles.fill, { width, backgroundColor: palette.text, borderRadius: height / 2 }]} />
      </View>

      {showValue ? (
        <Text variant="caption" tone="muted" numeric style={styles.value}>
          {Math.round(target * 100)}%
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  track: { flex: 1, overflow: 'hidden', backgroundColor: theme.colors.divider },
  fill: { height: '100%' },
  value: { minWidth: 34, textAlign: 'right' },
});
