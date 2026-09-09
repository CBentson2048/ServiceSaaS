import type { ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type RefreshControlProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spacing } from '@sheer/design-tokens';
import { BG } from '../colors';

export interface ScreenProps {
  children: ReactNode;
  /**
   * Off for a screen that manages its own scrolling (a FlatList, a chat
   * transcript) or that must not scroll at all.
   */
  scroll?: boolean;
  /** Off when the content draws its own edge-to-edge surfaces. */
  padded?: boolean;
  /**
   * A `ScreenHeader`. Rendered INSIDE the safe area but OUTSIDE the scroll
   * view, so the title stays put while the content moves under it — and so a
   * screen never has to nest a second SafeAreaView to place one.
   */
  header?: ReactNode;
  /** Passed through to the ScrollView (pull to refresh). */
  refreshControl?: React.ReactElement<RefreshControlProps>;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * The page frame: background, safe-area insets, scrolling and padding.
 *
 * Absorbed from `@sheer/ui-mobile`, which this app no longer depends on, and
 * fixed on the way in. The old version took `<SafeAreaView>` with NO `edges`
 * prop, which insets ALL FOUR sides — so every screen using it paid the bottom
 * inset a second time on top of the one `AppTabBar` already applies, leaving a
 * dead band above the tab bar. It also hard-coded `padding: spacing.lg` with no
 * way to opt out, which is why the Alerts screen has a large gap under its
 * title.
 *
 * The bottom edge is deliberately NOT inset here: `AppTabBar` owns it on
 * screens that have a bar, and screens that don't are free to inset their own
 * footer.
 */
export function Screen({
  children,
  scroll = true,
  padded = true,
  header,
  refreshControl,
  contentStyle,
}: ScreenProps) {
  const body = padded ? [s.content, contentStyle] : contentStyle;

  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      {header}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[s.grow, body]}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[s.grow, body]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  grow: { flexGrow: 1 },
  content: { gap: spacing.base, padding: spacing.lg },
});
