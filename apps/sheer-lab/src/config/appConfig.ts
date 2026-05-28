import {
  SHEER_LAB_ANDROID_PACKAGE,
  SHEER_LAB_API_URL,
  SHEER_LAB_ENV,
  SHEER_LAB_IOS_BUNDLE_ID,
} from '@env';

type SheerLabEnvironment = 'development' | 'staging' | 'production';

function readEnv(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function readEnvironment(value: string | undefined): SheerLabEnvironment {
  if (value === 'development' || value === 'staging' || value === 'production') return value;
  return 'development';
}

export const appConfig = {
  environment: readEnvironment(readEnv(SHEER_LAB_ENV)),
  apiBaseUrl: normalizeApiBaseUrl(readEnv(SHEER_LAB_API_URL) ?? 'http://localhost:3001'),
  iosBundleId: readEnv(SHEER_LAB_IOS_BUNDLE_ID) ?? 'com.sheer.lab',
  androidPackage: readEnv(SHEER_LAB_ANDROID_PACKAGE) ?? 'com.sheer.lab',
} as const;
