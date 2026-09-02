import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { NotificationDto } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import * as api from '../auth/api';
import { configureForegroundPresentation, registerPushDevice } from './pushRegistration';
import { usePushResponse } from './usePushResponse';

/**
 * In-app notification state for the stylist app (Wrike 4507284172).
 *
 * ---------------------------------------------------------------------------
 * WHY POLLING AND NOT REALTIME
 * ---------------------------------------------------------------------------
 * This app has no React Query, no WebSocket layer and no Supabase realtime
 * subscription — nothing to hang a live feed off. Standing up one for a single
 * notification type would be a platform decision, and this ticket explicitly says
 * not to introduce a realtime architecture just for it.
 *
 * So: a light interval plus a refetch whenever the app returns to the foreground.
 * The foreground refetch is the one that actually matters in the salon — the
 * stylist picks the phone up after the push buzzes, and the badge is already
 * correct. The interval is the safety net for a phone left awake on the station.
 * Only the unread COUNT is polled (a HEAD-shaped count query on a partial index);
 * the full list is fetched when the stylist opens the screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS NEVER DOES
 * ---------------------------------------------------------------------------
 * Mark anything read as a side effect of loading. Read state is per-recipient and
 * is the stylist's own record of what they have actually seen; the list marks a
 * notification read only when they open it.
 */

/** Unread badge refresh while the app is open. Deliberately unhurried. */
const POLL_INTERVAL_MS = 60_000;

interface NotificationsState {
  unreadCount: number;
  notifications: NotificationDto[];
  loading: boolean;
  error: string | null;
  /** Reload the list and the badge. */
  refresh: () => Promise<void>;
  /** Refresh just the badge. Cheap. */
  refreshUnreadCount: () => Promise<void>;
  markRead: (notificationId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsState | undefined>(undefined);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { session, status } = useAuth();
  const accessToken = session?.accessToken;

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards a double registration when auth settles and the app foregrounds in the
  // same tick. Keyed by token so a re-login re-registers for the new user.
  const registeredFor = useRef<string | null>(null);

  const refreshUnreadCount = useCallback(async () => {
    if (!accessToken) return;
    try {
      const { unreadCount: next } = await api.getUnreadNotificationCount(accessToken);
      setUnreadCount(next);
    } catch {
      // A failed badge poll is not worth an error banner; the next tick retries.
    }
  }, [accessToken]);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.listNotifications(accessToken, { pageSize: 30 });
      setNotifications(result.notifications);
      // The list response already carries the whole-feed unread total, so the
      // badge updates without a second round trip.
      setUnreadCount(result.unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  const markRead = useCallback(
    async (notificationId: string) => {
      if (!accessToken) return;
      // Optimistic: the stylist has opened it, so it is read from their point of
      // view immediately. The server answer then corrects the badge exactly.
      setNotifications((current) =>
        current.map((item) =>
          item.id === notificationId && !item.readAt
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      );
      setUnreadCount((current) => Math.max(0, current - 1));
      try {
        const result = await api.markNotificationRead(accessToken, notificationId);
        setUnreadCount(result.unreadCount);
        setNotifications((current) =>
          current.map((item) => (item.id === notificationId ? result.notification : item)),
        );
      } catch {
        // Roll the badge back to whatever the server actually thinks.
        void refreshUnreadCount();
      }
    },
    [accessToken, refreshUnreadCount],
  );

  const markAllRead = useCallback(async () => {
    if (!accessToken) return;
    try {
      const result = await api.markAllNotificationsRead(accessToken);
      setUnreadCount(result.unreadCount);
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        current.map((item) => (item.readAt ? item : { ...item, readAt })),
      );
    } catch {
      void refreshUnreadCount();
    }
  }, [accessToken, refreshUnreadCount]);

  // Sign-out must not leave the previous stylist's badge on screen.
  useEffect(() => {
    if (accessToken) return;
    registeredFor.current = null;
    setUnreadCount(0);
    setNotifications([]);
    setError(null);
  }, [accessToken]);

  // Register this handset for push once per signed-in session. Fire-and-forget:
  // registerPushDevice never throws and never blocks the UI.
  useEffect(() => {
    if (!accessToken || status !== 'authenticated') return;
    if (registeredFor.current === accessToken) return;
    registeredFor.current = accessToken;
    configureForegroundPresentation();
    void registerPushDevice(accessToken);
  }, [accessToken, status]);

  // Initial badge, then a slow poll.
  useEffect(() => {
    if (!accessToken) return undefined;
    void refreshUnreadCount();
    const timer = setInterval(() => void refreshUnreadCount(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [accessToken, refreshUnreadCount]);

  // The one that matters in the salon: the stylist picks the phone up and the
  // badge is already right, whether or not a push arrived.
  useEffect(() => {
    if (!accessToken) return undefined;
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void refreshUnreadCount();
    });
    return () => subscription.remove();
  }, [accessToken, refreshUnreadCount]);

  // Tapping an arrival push opens the alert list rather than dumping the stylist
  // wherever the app happened to be. The badge is refreshed on the way in, so
  // the count cannot lag behind the screen the tap just opened.
  usePushResponse(refreshUnreadCount);

  const value = useMemo<NotificationsState>(
    () => ({
      unreadCount,
      notifications,
      loading,
      error,
      refresh,
      refreshUnreadCount,
      markRead,
      markAllRead,
    }),
    [unreadCount, notifications, loading, error, refresh, refreshUnreadCount, markRead, markAllRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/**
 * Notification state for the signed-in stylist.
 *
 * Returns a dormant default outside the provider rather than throwing, so a screen
 * rendered in isolation (or in a test) never crashes on a missing provider.
 */
export function useNotifications(): NotificationsState {
  const context = useContext(NotificationsContext);
  if (context) return context;
  return {
    unreadCount: 0,
    notifications: [],
    loading: false,
    error: null,
    refresh: async () => undefined,
    refreshUnreadCount: async () => undefined,
    markRead: async () => undefined,
    markAllRead: async () => undefined,
  };
}
