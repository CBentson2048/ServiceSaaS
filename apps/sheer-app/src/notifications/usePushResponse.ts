import { useEffect } from 'react';
import { useRouter } from 'expo-router';

/**
 * What happens when a stylist TAPS an arrival push (Wrike 4507284172).
 *
 * WHY THIS EXISTS SEPARATELY. The server-side dispatcher already builds a
 * routing payload for every push it sends, but nothing in the client ever read
 * it: the notification arrived, the stylist tapped it, and the app opened on
 * whatever screen it happened to be on. The payload was written and discarded.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not introduce a deep-link routing
 * layer, a URL scheme, or a notification-to-route registry. Expo Router already
 * owns navigation here, and arrival alerts have exactly one sensible
 * destination, so this maps to an existing screen and stops. When a second
 * notification type needs a different destination, THAT is the moment to
 * generalise — inventing the abstraction now would be guessing at its shape.
 *
 * FOREGROUND vs BACKGROUND. `addNotificationResponseReceivedListener` fires for
 * a tap in both cases, including a cold start where the tap is what launched the
 * app, so one listener covers every route in. Notifications that merely ARRIVE
 * while the app is open are not handled here on purpose: the in-app alert list
 * and its unread badge already reflect them, and yanking a stylist off the
 * screen they are working on because a push landed would be hostile.
 */

/** The subset of expo-notifications this hook needs. */
interface ResponseSubscription {
  remove: () => void;
}
interface ExpoNotificationsResponseModule {
  addNotificationResponseReceivedListener: (
    listener: (response: { notification?: { request?: { content?: { data?: Record<string, unknown> } } } }) => void,
  ) => ResponseSubscription;
}

/**
 * Resolved through a guarded require for the same reason the rest of the push
 * module is: the web build and any bundle without the native module compiled in
 * must keep working, and there push simply never fires.
 */
function loadNotifications(): ExpoNotificationsResponseModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return require('expo-notifications') as ExpoNotificationsResponseModule;
  } catch {
    return null;
  }
}

/**
 * Route the app when a push is tapped.
 *
 * `onHandled` lets the caller refresh the unread badge, since opening the alert
 * list from a tap should not leave a stale count behind it.
 */
export function usePushResponse(onHandled?: () => void): void {
  const router = useRouter();

  useEffect(() => {
    const Notifications = loadNotifications();
    if (!Notifications?.addNotificationResponseReceivedListener) return;

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data ?? {};
      onHandled?.();

      // The server sends a route hint. Honour it only when it names a screen we
      // actually have — a payload is attacker-influenced in principle and a
      // router should never be handed an arbitrary string from the network.
      const target = typeof data.route === 'string' ? data.route : null;
      const allowed: Record<string, string> = {
        notifications: '/notifications',
        bookings: '/bookings',
        dashboard: '/dashboard',
      };
      const destination = (target && allowed[target]) || '/notifications';

      try {
        router.push(destination as never);
      } catch {
        // Navigation failing is not worth crashing an app that has just been
        // opened from a notification; the alert list is still reachable by hand.
      }
    });

    return () => subscription.remove();
  }, [router, onHandled]);
}
