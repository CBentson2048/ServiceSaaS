import {
  SHEER_LAB_ANDROID_PACKAGE,
  SHEER_LAB_API_URL,
  SHEER_LAB_ENV,
  SHEER_LAB_IOS_BUNDLE_ID,
} from '@env';

import { REVIEW_MODE_ENABLED } from './reviewMode'; // REVIEW MODE — also selects the review (develop) backend; see below

type SheerLabEnvironment = 'development' | 'staging' | 'production';

// Build-type-driven config. `__DEV__` is `true` for a development build (Metro /
// `react-native run-ios|run-android`) and `false` for a Release/archive build
// (Xcode "Archive", `gradlew bundleRelease`).
//
//   • Development build → the local API, or a SHEER_LAB_API_URL override from
//     `.env` (e.g. your Mac's LAN IP for a physical device, or
//     `http://10.0.2.2:3001` for the Android emulator).
//   • Release / archive build → the Railway backend selected by
//     REVIEW_MODE_ENABLED (src/config/reviewMode.ts):
//       - REVIEW_MODE_ENABLED === true  → DEVELOP backend. This is the App Store
//         *review* build; the develop DB holds the seeded Kensington demo device
//         and the reviewer's PIN, kept isolated from real salon data.
//       - REVIEW_MODE_ENABLED === false → PRODUCTION backend. This is the build
//         shipped to real users. Flipping that one flag off for production
//         switches BOTH the review-mode UI and this backend target together, so
//         a production build can never ship pointing at develop.
//     Any SHEER_LAB_API_URL / SHEER_LAB_ENV override in `.env` is intentionally
//     IGNORED in Release/archive builds.
const DEV_API_BASE_URL = 'http://localhost:3001';
const DEVELOP_API_BASE_URL = 'https://sheer-platform-develop.up.railway.app';
const PRODUCTION_API_BASE_URL = 'https://sheer-platform-production.up.railway.app';
// REVIEW MODE — while true, Release targets develop (seeded reviewer data).
const RELEASE_API_BASE_URL = REVIEW_MODE_ENABLED ? DEVELOP_API_BASE_URL : PRODUCTION_API_BASE_URL;

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
  // The footer chip reads PRODUCTION for any Release/archive build (both the
  // production and the App Store review build) to avoid confusing a reviewer
  // with a "staging" label; the .env override only applies in development. The
  // actual backend is chosen by RELEASE_API_BASE_URL above.
  environment: __DEV__ ? readEnvironment(readEnv(SHEER_LAB_ENV)) : 'production',
  apiBaseUrl: normalizeApiBaseUrl(
    __DEV__ ? (readEnv(SHEER_LAB_API_URL) ?? DEV_API_BASE_URL) : RELEASE_API_BASE_URL,
  ),
  iosBundleId: readEnv(SHEER_LAB_IOS_BUNDLE_ID) ?? 'com.sheer.lab',
  androidPackage: readEnv(SHEER_LAB_ANDROID_PACKAGE) ?? 'com.sheer.lab',
} as const;
