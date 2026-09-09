import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { spacing } from '@sheer/design-tokens';
import { BORDER, BRAND_LIGHT, TEXT } from '../design/colors';

export interface ScreenHeaderProps {
  title: string;
  /** Show the back control. Off for a screen that is a tab destination. */
  back?: boolean;
  /** Text beside the chevron. Name the destination when it isn't obvious. */
  backLabel?: string;
  /** Defaults to `router.back()`. */
  onBack?: () => void;
  /** Optional trailing control — an action, a menu. */
  right?: ReactNode;
  /** Hairline rule under the header. */
  divider?: boolean;
}

/**
 * THE in-content screen header.
 *
 * 17 of this app's 24 routes set `headerShown: false` and draw their own
 * header, so 13 screens had hand-rolled one. They were the same header three
 * times over and had drifted in every dimension that could drift:
 *
 *   my-pay · pay-summary · client/visits   back 90  arrow 28  title 17/700  rule
 *   reschedule · manage-appointment        back 84  arrow 28  title 17/700  none
 *   salon-detail                           back 80  arrow 26  title 16/800  none
 *
 * …with two naming conventions for the same styles (`backBtn`/`backArrow`/
 * `backLabel` versus `headerBack`/`headerBackArrow`/`headerBackLabel`).
 *
 * The centring is done with flex rather than the matched `minWidth` spacer each
 * screen used, so the title stays optically centred whatever the back label
 * says — that trick was why the widths had to agree in the first place, and
 * why they silently stopped agreeing.
 */
export function ScreenHeader({
  title,
  back = true,
  backLabel = 'Back',
  onBack,
  right,
  divider = true,
}: ScreenHeaderProps) {
  return (
    <View style={[s.header, divider && s.divider]}>
      <View style={s.side}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={backLabel === 'Back' ? 'Go back' : `Back to ${backLabel}`}
            hitSlop={8}
            style={({ pressed }) => [s.backBtn, pressed && s.pressed]}
            onPress={onBack ?? (() => router.back())}
          >
            <Ionicons name="chevron-back" size={26} color={BRAND_LIGHT} style={s.backArrow} />
            <Text style={s.backLabel} numberOfLines={1}>
              {backLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={s.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>

      <View style={[s.side, s.sideRight]}>{right}</View>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  // Equal flex on both sides is what centres the title; the old matched
  // minWidths only worked while every screen agreed on the number.
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  sideRight: { justifyContent: 'flex-end' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 0, marginLeft: -6 },
  pressed: { opacity: 0.6 },
  backArrow: { marginRight: -2 },
  backLabel: { color: BRAND_LIGHT, fontSize: 15, fontWeight: '600' },
  title: {
    flex: 2,
    textAlign: 'center',
    color: TEXT,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
});
