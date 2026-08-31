import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme, tone as resolveTone, type Tone } from '../theme/theme';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export interface BannerProps {
  message: string;
  /** Colour + default icon. `danger` for failures, `success` for confirmations. */
  tone?: Tone;
  /** Bold lead-in before the message. */
  title?: string;
  /** Overrides the icon implied by `tone`. */
  icon?: IconName;
  /** Inline action — most often "Retry" on an error. */
  action?: { label: string; onPress: () => void };
  /** Renders a dismiss button. */
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

const TONE_ICON: Record<Tone, IconName> = {
  success: 'checkCircle',
  warning: 'alert',
  danger: 'alert',
  neutral: 'info',
  brand: 'info',
};

/**
 * An inline status banner.
 *
 * Today feedback is a bare coloured `<Text>` — `notice`, `errorText`,
 * `errorBanner`, `draftMessage` — styled differently on each screen, so a
 * success and a failure often look identical apart from the wording. This gives
 * both a consistent shape, an icon that signals the outcome without relying on
 * colour alone, and somewhere to hang a retry.
 *
 * It fades and slides in on mount so a message that appears after an action is
 * noticed rather than silently swapped into place.
 */
export function Banner({ message, tone = 'neutral', title, icon, action, onDismiss, style }: BannerProps): React.JSX.Element {
  const palette = resolveTone(tone);
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: theme.duration.base,
      easing: Easing.bezier(...theme.easing.decelerate),
      useNativeDriver: true,
    }).start();
  }, [enter]);

  return (
    <Animated.View
      accessibilityRole="alert"
      style={[
        styles.banner,
        { backgroundColor: palette.bg, borderColor: palette.border },
        {
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }],
        },
        style,
      ]}
    >
      <Icon name={icon ?? TONE_ICON[tone]} size="base" tone="inherit" color={palette.text} />

      <View style={styles.body}>
        {title ? (
          <Text variant="label" style={{ color: palette.text }}>
            {title}
          </Text>
        ) : null}
        <Text variant="bodySm" style={{ color: palette.text }}>
          {message}
        </Text>
      </View>

      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          hitSlop={theme.hitSlop}
        >
          <Text variant="label" style={{ color: palette.text }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}

      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss message" onPress={onDismiss} hitSlop={theme.hitSlop}>
          <Icon name="close" size="sm" tone="inherit" color={palette.text} />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.card,
    borderWidth: theme.hairline,
  },
  body: { flex: 1, gap: 2 },
});
