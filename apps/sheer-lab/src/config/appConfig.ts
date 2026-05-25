type SheerLabEnvironment = 'development' | 'staging' | 'production';

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

export const appConfig = {
  environment: (readEnv('SHEER_LAB_ENV') ?? 'development') as SheerLabEnvironment,
  apiBaseUrl: normalizeApiBaseUrl(readEnv('SHEER_LAB_API_URL') ?? 'http://localhost:3001'),
  iosBundleId: readEnv('SHEER_LAB_IOS_BUNDLE_ID') ?? 'com.sheer.lab',
  androidPackage: readEnv('SHEER_LAB_ANDROID_PACKAGE') ?? 'com.sheer.lab',
} as const;
