import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { DevicePlatform } from '@sheer/domain';
import * as api from '../auth/api';

/**
 * Device registration for push (Wrike 4507284172).
 *
 * ---------------------------------------------------------------------------
 * WHY expo-notifications IS LOADED OPTIONALLY
 * ---------------------------------------------------------------------------
 * The ticket asks for push "where supported", and there are real, permanent
 * runtime conditions where it is not:
 *
 *   - the web build (`expo start --web`, react-native-web) has no native push;
 *   - a JS-only bundle running without the native module compiled in;
 *   - a simulator, which Apple never issues push tokens to.
 *
 * On any of those the app must run completely normally and the stylist must still
 * get the arrival alert in-app. Loading the module through a guarded require and
 * treating its absence as "push unsupported" is therefore the behaviour the ticket
 * specifies, not a workaround: there is exactly one code path, and it is the one
 * that already has to work.
 *
 * BUILD STATE: `expo-notifications` (~55.0.27) and `expo-device` (~55.0.21) are
 * now dependencies of apps/sheer-app, matched to Expo SDK 55 by `expo install`,
 * so a native build resolves them and this module takes the supported path. The
 * guarded require stays because the web build and the simulator still legitimately
 * have no push — it is the mechanism for "where supported", not a stopgap.
 *
 * STILL PENDING: a real handset. Nothing here has been exercised against a
 * physical device or an EAS build, so a token has never actually been minted.
 * Treat push as CODE COMPLETE, NOT DEVICE VERIFIED until that happens.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEVER DONE HERE
 * ---------------------------------------------------------------------------
 * Nothing in this module throws into a caller. Registration is a background
 * courtesy that runs after sign-in; a stylist must never be blocked from using the
 * app because a push token could not be minted. It also never logs a token: that
 * is a delivery address for someone's phone.
 */

/** Where the stable per-installation id lives, alongside the auth session. */
const DEVICE_ID_KEY = 'sheer.sheer-app.device-id';
/** The server-side device row id, kept so sign-out can disable exactly this device. */
const DEVICE_ROW_KEY = 'sheer.sheer-app.device-row-id';

export type PushSupport =
  | 'granted'
  /** The OS prompt was shown and declined, or push is off in system settings. */
  | 'denied'
  /** No native module, web, or a simulator: push cannot work on this build at all. */
  | 'unsupported'
  /** The device row was registered but no token could be obtained this launch. */
  | 'registered-without-token';

export interface PushRegistrationResult {
  support: PushSupport;
  /** comms.user_devices row id, when registration reached the server. */
  deviceId?: string;
}

interface ExpoNotificationsModule {
  getPermissionsAsync(): Promise<{ status: string; canAskAgain?: boolean }>;
  requestPermissionsAsync(): Promise<{ status: string }>;
  getExpoPushTokenAsync(options: { projectId?: string }): Promise<{ data: string }>;
  setNotificationChannelAsync(name: string, channel: Record<string, unknown>): Promise<unknown>;
  setNotificationHandler(handler: unknown): void;
  AndroidImportance: Record<string, number>;
}

/**
 * Resolve expo-notifications if this build has it. Returns null otherwise, which
 * every caller treats as "push unsupported here".
 */
function loadNotifications(): ExpoNotificationsModule | null {
  // Web has no native notification module regardless of what is installed.
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    return require('expo-notifications') as ExpoNotificationsModule;
  } catch {
    return null;
  }
}

/** True on a real handset. Simulators are never issued push tokens by Apple. */
function isPhysicalDevice(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const device = require('expo-device') as { isDevice?: boolean };
    return device.isDevice !== false;
  } catch {
    // Without expo-device, assume physical and let the token request decide.
    return true;
  }
}

function currentPlatform(): DevicePlatform {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/**
 * A stable id for this installation, created once and kept in secure storage.
 * It identifies the DEVICE across push-token rotations, so a token refresh
 * updates one row instead of accumulating dead ones.
 */
export async function getDeviceIdentifier(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY).catch(() => null);
  if (existing) return existing;

  // Prefer the platform RNG; fall back to a timestamp+random composite that still
  // clears the API's 8-character minimum on the rare build without global crypto.
  const generated =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  await SecureStore.setItemAsync(DEVICE_ID_KEY, generated).catch(() => undefined);
  return generated;
}

/**
 * Foreground presentation. Without this an arrival push that lands while the
 * stylist is already looking at the app is swallowed silently by the OS.
 * Safe to call when push is unsupported: it simply does nothing.
 */
export function configureForegroundPresentation(): void {
  const Notifications = loadNotifications();
  if (!Notifications) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

/**
 * Register this installation for the signed-in stylist. Idempotent: safe on every
 * launch and every token rotation.
 *
 * ORDER MATTERS. The device row is registered FIRST, with whatever token we have
 * (possibly none), because a known installation with no token is still useful
 * information and because `comms.register_user_device` preserves an existing token
 * when one is omitted. Permission is then requested only when it has not already
 * been decided, so the stylist is never re-prompted on every launch.
 */
export async function registerPushDevice(accessToken: string): Promise<PushRegistrationResult> {
  try {
    const deviceIdentifier = await getDeviceIdentifier();
    const platform = currentPlatform();
    const Notifications = loadNotifications();

    if (!Notifications || !isPhysicalDevice()) {
      // Still record the installation so the stylist shows up as a known device;
      // it simply never receives a push. This is the graceful-degradation path.
      const deviceId = await registerRow(accessToken, deviceIdentifier, platform);
      return { support: 'unsupported', deviceId };
    }

    // Android needs a channel before a notification can be shown with any
    // importance above default; the id matches the `channelId` the API sends.
    // Deliberately ONE channel covering every notification type — see the note in
    // apps/api/src/notifications/push/expo-push.provider.ts.
    if (platform === 'android') {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Alerts',
        importance: Notifications.AndroidImportance?.HIGH ?? 4,
        sound: 'default',
      }).catch(() => undefined);
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    // Only prompt when the OS says we still may. Re-prompting a stylist who has
    // already declined is both futile and irritating.
    if (status !== 'granted' && existing.canAskAgain !== false) {
      status = (await Notifications.requestPermissionsAsync()).status;
    }

    if (status !== 'granted') {
      const deviceId = await registerRow(accessToken, deviceIdentifier, platform);
      return { support: 'denied', deviceId };
    }

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId;
    const token = await Notifications.getExpoPushTokenAsync({ projectId })
      .then((result) => result.data)
      .catch(() => undefined);

    const deviceId = await registerRow(accessToken, deviceIdentifier, platform, token);
    return { support: token ? 'granted' : 'registered-without-token', deviceId };
  } catch {
    // Never surface a registration problem to the stylist: the in-app alert is
    // unaffected and is what the acceptance criteria actually depend on.
    return { support: 'unsupported' };
  }
}

async function registerRow(
  accessToken: string,
  deviceIdentifier: string,
  platform: DevicePlatform,
  pushToken?: string,
): Promise<string | undefined> {
  try {
    const { device } = await api.registerPushDevice(accessToken, {
      deviceIdentifier,
      platform,
      // Omitted rather than sent empty: omitting PRESERVES a stored token, while
      // sending an empty value would fail the API's MinLength check.
      ...(pushToken ? { pushToken } : {}),
    });
    await SecureStore.setItemAsync(DEVICE_ROW_KEY, device.id).catch(() => undefined);
    return device.id;
  } catch {
    return undefined;
  }
}

/**
 * Stop pushing to this handset on sign-out. Best effort by design: a failure here
 * must never block the stylist from signing out, and the server-side token
 * takeover already prevents a handset from receiving another user's alerts.
 */
export async function disablePushDevice(accessToken?: string): Promise<void> {
  if (!accessToken) return;
  try {
    const deviceRowId = await SecureStore.getItemAsync(DEVICE_ROW_KEY).catch(() => null);
    if (!deviceRowId) return;
    await api.disablePushDevice(accessToken, deviceRowId);
    await SecureStore.deleteItemAsync(DEVICE_ROW_KEY).catch(() => undefined);
  } catch {
    // Intentionally silent.
  }
}
