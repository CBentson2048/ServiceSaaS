import * as Keychain from 'react-native-keychain';

export interface StoredDeviceSession {
  sharedDeviceId: string;
  deviceSessionToken: string;
  installationId?: string;
}

export class SecureDeviceStorageUnavailableError extends Error {
  constructor() {
    super('Secure device storage is unavailable. Rebuild the Qlooqo Lab app so native Keychain/Keystore support is linked.');
    this.name = 'SecureDeviceStorageUnavailableError';
  }
}

const SERVICE = 'com.sheer.lab.device-session';
const USERNAME = 'shared-device';

export async function saveDeviceSession(session: StoredDeviceSession): Promise<void> {
  assertSecureStorageAvailable();
  await Keychain.setGenericPassword(USERNAME, JSON.stringify(session), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadDeviceSession(): Promise<StoredDeviceSession | undefined> {
  assertSecureStorageAvailable();
  const credential = await Keychain.getGenericPassword({ service: SERVICE });
  if (!credential) return undefined;

  try {
    const parsed = JSON.parse(credential.password) as Partial<StoredDeviceSession>;
    if (!parsed.sharedDeviceId || !parsed.deviceSessionToken) {
      await clearDeviceSession();
      return undefined;
    }
    return {
      sharedDeviceId: parsed.sharedDeviceId,
      deviceSessionToken: parsed.deviceSessionToken,
      installationId: parsed.installationId,
    };
  } catch {
    await clearDeviceSession();
    return undefined;
  }
}

export async function clearDeviceSession(): Promise<void> {
  assertSecureStorageAvailable();
  await Keychain.resetGenericPassword({ service: SERVICE });
}

function assertSecureStorageAvailable(): void {
  if (
    typeof Keychain.getGenericPassword !== 'function' ||
    typeof Keychain.setGenericPassword !== 'function' ||
    typeof Keychain.resetGenericPassword !== 'function'
  ) {
    throw new SecureDeviceStorageUnavailableError();
  }
}
