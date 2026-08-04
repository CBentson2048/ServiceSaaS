/**
 * Centralised placeholders for the Sheer App deep link and store URLs used
 * by the post-account-creation completion flow.
 *
 * These are intentionally kept as overridable constants so that:
 *
 *   1. The UI can ship today with safe placeholders.
 *   2. Real values can be wired up later via Vite env vars without
 *      touching the page component.
 *
 * TODO: Replace these placeholders with the production deep link and the
 * real App Store / Play Store URLs once the mobile app ships.
 *   - VITE_SHEER_APP_DEEP_LINK   — Universal/Custom-scheme deep link that
 *                                  opens the Sheer App if installed
 *                                  (e.g. `sheerapp://account/welcome` or
 *                                  `https://app.sheer.com/welcome`).
 *   - VITE_SHEER_APP_IOS_URL     — App Store landing URL.
 *   - VITE_SHEER_APP_ANDROID_URL — Google Play landing URL.
 *   - VITE_SHEER_APP_GENERIC_URL — Marketing/landing page that auto-routes
 *                                  to the right store (used as a sensible
 *                                  fallback when the platform is unknown).
 */

const env = import.meta.env;

function fromEnv(key: string, fallback: string): string {
  const raw = env[key as keyof typeof env];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  return fallback;
}

export const sheerAppDeepLink = fromEnv(
  'VITE_SHEER_APP_DEEP_LINK',
  'https://qlooqo.com/app/welcome',
);

export const sheerAppIosUrl = fromEnv(
  'VITE_SHEER_APP_IOS_URL',
  'https://apps.apple.com/gb/app/qlooqo/id6767536395',
);

export const sheerAppAndroidUrl = fromEnv(
  'VITE_SHEER_APP_ANDROID_URL',
  'https://play.google.com/store/apps/details?id=com.qlooqo.app',
);

export const sheerAppGenericUrl = fromEnv('VITE_SHEER_APP_GENERIC_URL', 'https://qlooqo.com/app');

/**
 * Cheap UA sniff so we can pick the right store URL for download buttons.
 * Falls back to the generic landing page when SSR / unknown platforms hit
 * the page.
 */
export function detectMobileStoreUrl(): string {
  if (typeof navigator === 'undefined') return sheerAppGenericUrl;
  const ua = navigator.userAgent ?? '';
  if (/android/i.test(ua)) return sheerAppAndroidUrl;
  if (/iphone|ipad|ipod/i.test(ua)) return sheerAppIosUrl;
  return sheerAppGenericUrl;
}
