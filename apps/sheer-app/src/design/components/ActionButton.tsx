import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { BRAND } from '../colors';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export interface ActionButtonProps {
  label: string;
  onPress: () => void;
  /** Leading icon. The component owns its size and colour so they cannot drift. */
  icon?: IoniconName;
  /** Trailing count bubble. Hidden when zero or omitted. */
  count?: number;
  /** Defaults to `label`; set it when the count needs spelling out. */
  accessibilityLabel?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A SCREEN'S PRIMARY ACTION, as a compact brand pill.
 *
 * This is the treatment the Rota screen's "Request leave" button already had,
 * lifted out of that file so the Bookings screen's "New booking" button can be
 * the same thing rather than a second, subtly different one. The style values
 * are copied from that button EXACTLY — 16/8 padding, 13px/800 white label,
 * 4px icon gap, and the brand-coloured glow — so adopting this changed nothing
 * about how Rota renders.
 *
 * WHY NOT `AppButton`. AppButton is the full-width form CTA: bigger (18/10),
 * lighter (14px/500), and its primary variant draws `textOnPrimary`, which on
 * this theme is the dark ink `#18141F` rather than white. Bookings used it and
 * so ended up with a white "+" beside dark text — the mismatch that prompted
 * this. The two are different jobs, and a compact glowing pill is not a size
 * variant of a form button.
 *
 * `alignSelf: 'flex-start'` is load-bearing: these sit inside `Screen`'s
 * content column, whose children stretch by default, so without it the pill
 * would run the full width. It is inert inside Rota's flex row.
 */
export function ActionButton({
  label,
  onPress,
  icon,
  count,
  accessibilityLabel,
  disabled,
  style,
}: ActionButtonProps) {
  const badged = typeof count === 'number' && count > 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, pressed && s.pressed, disabled && s.disabled, style]}
    >
      {icon ? <Ionicons name={icon} size={16} color={palette.white} /> : null}
      <Text style={s.label}>{label}</Text>
      {badged ? (
        <View style={s.badge} accessibilityElementsHidden>
          <Text style={s.badgeText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: BRAND,
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.55 },
  label: { color: palette.white, fontSize: 13, fontWeight: '800' },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.full,
    backgroundColor: palette.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: BRAND, fontSize: 10, fontWeight: '900' },
});
