import { useCallback, useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { NotificationDto } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { StylistTabBar } from '../src/navigation/StylistTabBar';
import { useNotifications } from '../src/notifications/NotificationsProvider';

/**
 * The stylist's alerts (Wrike 4507284172).
 *
 * SCOPE. This is the minimum in-app surface the arrival-alert acceptance needs —
 * the alert is visible, its unread state is honest, and it opens the appointment.
 * It is deliberately NOT the Week 10 notification centre: no type filters, no
 * grouping, no preferences, no history search.
 *
 * READ STATE IS EARNED, NOT ASSUMED. Opening this list does not mark anything
 * read. `readAt` is this stylist's own record of what they have actually looked
 * at, and a list that clears its own badge on render would make it meaningless.
 * A notification is marked read when it is tapped.
 */
export default function NotificationsScreen() {
  const { notifications, unreadCount, loading, error, refresh, markRead, markAllRead } =
    useNotifications();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (notification: NotificationDto) => {
      if (!notification.readAt) {
        // Not awaited: navigation should feel instant, and markRead already
        // updates the badge optimistically and reconciles with the server.
        void markRead(notification.id);
      }
      if (notification.actionPath) {
        router.push(notification.actionPath as never);
      }
    },
    [markRead],
  );

  return (
    <ProtectedScreen allowedRoles={['manager', 'stylist']}>
      <Screen>
        <ScrollView
          contentContainerStyle={s.content}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={BRAND} />
          }
        >
          <View style={s.header}>
            <SectionHeader title="Alerts" />
            {unreadCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Mark all alerts read"
                onPress={() => void markAllRead()}
                style={({ pressed }) => [s.markAll, pressed && s.pressed]}
              >
                <Text style={s.markAllLabel}>Mark all read</Text>
              </Pressable>
            ) : null}
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}

          {!loading && notifications.length === 0 ? (
            <EmptyState
              title="No alerts yet"
              body="You'll be told here the moment one of your clients checks in."
            />
          ) : null}

          {notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onPress={() => void open(notification)}
            />
          ))}
        </ScrollView>
        <StylistTabBar />
      </Screen>
    </ProtectedScreen>
  );
}

function NotificationRow({
  notification,
  onPress,
}: {
  notification: NotificationDto;
  onPress: () => void;
}) {
  const unread = !notification.readAt;
  return (
    <Pressable
      accessibilityRole="button"
      // The unread state is spoken, not only coloured — the dot alone is invisible
      // to a screen reader.
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${notification.title}. ${notification.body}`}
      onPress={onPress}
      style={({ pressed }) => [s.row, unread && s.rowUnread, pressed && s.pressed]}
    >
      <View style={s.iconWrap}>
        <Ionicons
          name={notification.type === 'client_arrived' ? 'person-circle-outline' : 'notifications-outline'}
          size={22}
          color={unread ? BRAND : INACTIVE}
        />
      </View>
      <View style={s.rowBody}>
        <Text style={[s.title, unread && s.titleUnread]} numberOfLines={1}>
          {notification.title}
        </Text>
        <Text style={s.body} numberOfLines={2}>
          {notification.body}
        </Text>
        <Text style={s.time}>{formatWhen(notification.createdAt)}</Text>
      </View>
      {unread ? <View style={s.dot} accessibilityElementsHidden /> : null}
    </Pressable>
  );
}

/**
 * Relative time, because "3 min ago" is what tells a stylist whether the client is
 * still waiting. Falls back to a date once an alert is older than a day.
 */
function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString();
}

const CARD = '#211A2E';
const BORDER = 'rgba(255,255,255,0.13)';
const BRAND = palette.brand[300];
const INACTIVE = 'rgba(255,255,255,0.4)';

const s = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  markAll: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.input },
  markAllLabel: { color: BRAND, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  error: { color: '#FF9C9C', fontSize: 13, paddingVertical: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: CARD,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER,
    padding: spacing.md,
  },
  rowUnread: { borderColor: BRAND },
  iconWrap: { width: 30, alignItems: 'center' },
  rowBody: { flex: 1, gap: 2 },
  title: { color: 'rgba(255,255,255,0.82)', fontSize: 14, fontWeight: '600' },
  titleUnread: { color: '#FFFFFF', fontWeight: '800' },
  body: { color: 'rgba(255,255,255,0.66)', fontSize: 13 },
  time: { color: INACTIVE, fontSize: 11, marginTop: 2 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: BRAND },
});
