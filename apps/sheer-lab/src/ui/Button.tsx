import type React from 'react';
import { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { theme } from '../theme/theme';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export type ButtonVariant =
  /** The one affirmative action on a screen. Saturated brand fill, white label. */
  | 'primary'
  /** Supporting actions. Outlined, sits on a card. */
  | 'secondary'
  /** Low-emphasis actions in a dense toolbar. No fill, no border. */
  | 'ghost'
  /** Destructive or irreversible actions. */
  | 'danger';

export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon rendered before the label. */
  icon?: IconName;
  /** Icon rendered after the label — use for "next"-style forward motion. */
  iconAfter?: IconName;
  disabled?: boolean;
  /** Shows a spinner in place of the leading icon and blocks presses. */
  loading?: boolean;
  /** Stretches the button to fill its container. */
  block?: boolean;
  /**
   * Accessible name, when the visible label isn't self-explanatory out of
   * context (e.g. a "Save" that needs to read as "Save billing rules").
   */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

const SIZES: Record<ButtonSize, { height: number; padH: number; gap: number; icon: number }> = {
  sm: { height: theme.touchTarget.min, padH: theme.spacing.md, gap: theme.spacing.xs, icon: theme.iconSize.sm },
  md: { height: theme.touchTarget.base, padH: theme.spacing.lg, gap: theme.spacing.sm, icon: theme.iconSize.base },
  lg: { height: theme.touchTarget.large, padH: theme.spacing.xl, gap: theme.spacing.sm, icon: theme.iconSize.md },
};

/**
 * Resolves the fill, border and content colour for a variant.
 *
 * Note `primary` uses `primaryStrong` (#9C0CC0), not `primary` (#C46BEA). The
 * light accent cannot carry white text — it lands around 2.5:1, well under the
 * AA floor — so filled buttons take the deep brand and white, while the light
 * accent is reserved for text and icons ON dark surfaces. See `theme.ts`.
 */
function variantStyle(variant: ButtonVariant): {
  bg: string;
  border: string;
  content: 'primary' | 'secondary' | 'onBrand' | 'danger';
  contentColor: string;
} {
  switch (variant) {
    case 'primary':
      return {
        bg: theme.colors.primaryStrong,
        border: theme.colors.primaryStrong,
        content: 'onBrand',
        contentColor: theme.colors.onPrimaryStrong,
      };
    case 'danger':
      return {
        bg: theme.colors.dangerBg,
        border: theme.colors.dangerBorder,
        content: 'danger',
        contentColor: theme.colors.dangerText,
      };
    case 'ghost':
      return {
        bg: 'transparent',
        border: 'transparent',
        content: 'secondary',
        contentColor: theme.colors.textSecondary,
      };
    default:
      return {
        bg: theme.colors.surfaceRaised,
        border: theme.colors.border,
        content: 'primary',
        contentColor: theme.colors.textPrimary,
      };
  }
}

/**
 * The QLAB button.
 *
 * Replaces `LabButton` (2 variants, one size, opacity-only press feedback) and
 * the ~15 bespoke `Pressable`+`Text` button pairs scattered across the screens,
 * each with its own height, radius and disabled treatment.
 *
 * Every instance gets a real pressed state — a brief scale-down plus a tint
 * shift — which is the difference between a control that feels responsive and
 * one that feels like a static image.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconAfter,
  disabled = false,
  loading = false,
  block = false,
  accessibilityLabel,
  style,
}: ButtonProps): React.JSX.Element {
  const dims = SIZES[size];
  const v = variantStyle(variant);
  const isDisabled = disabled || loading;
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (to: number, ms: number) => {
    Animated.timing(scale, {
      toValue: to,
      duration: ms,
      easing: Easing.bezier(...theme.easing.standard),
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[block && styles.block, { transform: [{ scale }] }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        disabled={isDisabled}
        onPress={onPress}
        onPressIn={() => animate(0.97, theme.duration.instant)}
        onPressOut={() => animate(1, theme.duration.fast)}
        style={({ pressed }) => [
          styles.base,
          {
            minHeight: dims.height,
            paddingHorizontal: dims.padH,
            gap: dims.gap,
            backgroundColor: v.bg,
            borderColor: v.border,
          },
          variant === 'primary' && !isDisabled && theme.elevation.raised,
          pressed && !isDisabled && styles.pressed,
          isDisabled && styles.disabled,
        ]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={v.contentColor} />
        ) : icon ? (
          <Icon name={icon} size={dims.icon} tone="inherit" color={v.contentColor} />
        ) : null}

        <Text variant={size === 'sm' ? 'label' : 'subtitle'} tone={v.content} numberOfLines={1}>
          {label}
        </Text>

        {iconAfter ? <Icon name={iconAfter} size={dims.icon} tone="inherit" color={v.contentColor} /> : null}
      </Pressable>
    </Animated.View>
  );
}

/**
 * An icon-only button — toolbar refresh, settings, close.
 *
 * `label` is required rather than optional: with no visible text, the
 * accessible name is the only thing a screen reader has to announce. The
 * unlabelled `⟳` / `⚙︎` / `‹` controls in the current top bar announce nothing
 * at all.
 */
export function IconButton({
  icon,
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  style,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const dims = SIZES[size];
  const v = variantStyle(variant);
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (to: number, ms: number) => {
    Animated.timing(scale, {
      toValue: to,
      duration: ms,
      easing: Easing.bezier(...theme.easing.standard),
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => animate(0.94, theme.duration.instant)}
        onPressOut={() => animate(1, theme.duration.fast)}
        hitSlop={theme.hitSlop}
        style={({ pressed }) => [
          styles.iconBase,
          {
            width: dims.height,
            height: dims.height,
            backgroundColor: v.bg,
            borderColor: v.border,
          },
          pressed && !disabled && styles.pressed,
          disabled && styles.disabled,
        ]}
      >
        <Icon name={icon} size={dims.icon} tone="inherit" color={v.contentColor} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
    borderWidth: theme.hairline,
  },
  iconBase: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
    borderWidth: theme.hairline,
  },
  block: { alignSelf: 'stretch' },
  pressed: { opacity: theme.pressedOpacity },
  disabled: { opacity: theme.disabledOpacity },
});

/** Groups buttons in a row with consistent spacing and wrapping. */
export function ButtonRow({
  children,
  align = 'right',
  style,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right' | 'fill';
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return (
    <View
      style={[
        rowStyles.row,
        align === 'right' && rowStyles.right,
        align === 'fill' && rowStyles.fill,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' },
  right: { justifyContent: 'flex-end' },
  fill: { justifyContent: 'space-between' },
});
