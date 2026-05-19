type SheerLabEnvironment = 'development' | 'staging' | 'production';

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export const appConfig = {
  environment: (readEnv('SHEER_LAB_ENV') ?? 'development') as SheerLabEnvironment,
  apiBaseUrl: readEnv('SHEER_LAB_API_URL') ?? 'http://localhost:3001',
  iosBundleId: readEnv('SHEER_LAB_IOS_BUNDLE_ID') ?? 'com.sheer.lab',
  androidPackage: readEnv('SHEER_LAB_ANDROID_PACKAGE') ?? 'com.sheer.lab',
} as const;
