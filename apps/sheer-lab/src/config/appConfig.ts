import {
  SHEER_LAB_ANDROID_PACKAGE,
  SHEER_LAB_API_URL,
  SHEER_LAB_ENV,
  SHEER_LAB_IOS_BUNDLE_ID,
} from '@env';

type SheerLabEnvironment = 'development' | 'staging' | 'production';

// Build-type-driven config. `__DEV__` is `true` for a development build (Metro /
// `react-native run-ios|run-android`) and `false` for a Release/archive build
// (Xcode "Archive", `gradlew bundleRelease`).
//
//   • Development build → the local API, or a SHEER_LAB_API_URL override from
//     `.env` (e.g. your Mac's LAN IP for a physical device, or
//     `http://10.0.2.2:3001` for the Android emulator).
//   • Release / archive build → ALWAYS the Railway production deployment. Any
//     SHEER_LAB_API_URL / SHEER_LAB_ENV override in `.env` is intentionally
//     IGNORED here, so an archived build can never ship pointing at localhost or
//     a stale URL — nothing to remember to flip before release.
const DEV_API_BASE_URL = 'http://localhost:3001';
const PROD_API_BASE_URL = 'https://sheer-platform-develop.up.railway.app';

function readEnv(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function readEnvironment(value: string | undefined): SheerLabEnvironment {
  if (value === 'development' || value === 'staging' || value === 'production') return value;
  return __DEV__ ? 'development' : 'production';
}

export const appConfig = {
  // Release/archive (__DEV__ === false) is always production; the .env override
  // only applies in development.
  environment: __DEV__ ? readEnvironment(readEnv(SHEER_LAB_ENV)) : 'production',
  apiBaseUrl: normalizeApiBaseUrl(
    __DEV__ ? (readEnv(SHEER_LAB_API_URL) ?? DEV_API_BASE_URL) : PROD_API_BASE_URL,
  ),
  iosBundleId: readEnv(SHEER_LAB_IOS_BUNDLE_ID) ?? 'com.sheer.lab',
  androidPackage: readEnv(SHEER_LAB_ANDROID_PACKAGE) ?? 'com.sheer.lab',
} as const;
