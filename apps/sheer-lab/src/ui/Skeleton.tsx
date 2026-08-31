import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../theme/theme';

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * A shimmering placeholder block.
 *
 * QLAB currently shows a centred `ActivityIndicator` while a panel loads, then
 * swaps in the full content — so the layout jumps and the stylist gets no sense
 * of what is arriving. A skeleton holds the shape, which makes the wait feel
 * shorter and stops the page reflowing under a finger already reaching for it.
 */
export function Skeleton({ width = '100%', height = 16, radius, style }: SkeletonProps): React.JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.bezier(...theme.easing.standard),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.bezier(...theme.easing.standard),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.block,
        { width, height, borderRadius: radius ?? theme.radius.sm, opacity },
        style,
      ]}
    />
  );
}

/**
 * A skeleton shaped like a text block: several lines with the last one short,
 * the way a real paragraph ends.
 */
export function SkeletonText({ lines = 3, style }: { lines?: number; style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return (
    <View style={[styles.stack, style]}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? '55%' : '100%'} />
      ))}
    </View>
  );
}

/** A skeleton shaped like a list row: avatar, two lines of text, trailing pill. */
export function SkeletonRow({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return (
    <View style={[styles.row, style]}>
      <Skeleton width={40} height={40} radius={theme.radius.full} />
      <View style={styles.rowText}>
        <Skeleton height={13} width="60%" />
        <Skeleton height={11} width="85%" />
      </View>
      <Skeleton width={64} height={20} radius={theme.radius.full} />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: theme.colors.surfaceRaised },
  stack: { gap: theme.spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md, paddingVertical: theme.spacing.sm },
  rowText: { flex: 1, gap: theme.spacing.xs },
});
