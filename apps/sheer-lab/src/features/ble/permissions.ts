import { PermissionsAndroid, Platform } from 'react-native';
import type { BleManager} from 'react-native-ble-plx';
import { State } from 'react-native-ble-plx';

import { logger } from '../../lib/logging/logger';
import type { BlePermissionState } from './types';

export async function requestBlePermissions(manager: BleManager): Promise<BlePermissionState> {
  if (Platform.OS === 'android') {
    return requestAndroidBlePermissions();
  }

  const bluetoothState = await manager.state();

  if (bluetoothState === State.Unauthorized) {
    return {
      status: 'denied',
      message: 'Bluetooth permission is denied. Enable Bluetooth access in Settings.',
    };
  }

  if (bluetoothState === State.Unsupported) {
    return {
      status: 'unavailable',
      message: 'This device does not support Bluetooth Low Energy.',
    };
  }

  return {
    status: 'granted',
    message:
      bluetoothState === State.PoweredOff
        ? 'Bluetooth permission is granted, but Bluetooth is off.'
        : undefined,
  };
}

async function requestAndroidBlePermissions(): Promise<BlePermissionState> {
  if (Platform.OS !== 'android') {
    return { status: 'granted' };
  }

  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  // API 31+: the manifest declares BLUETOOTH_SCAN with `neverForLocation`, so location is not
  // required for scanning and ACCESS_FINE_LOCATION is capped at maxSdkVersion=30. Requesting it
  // here would resolve to `never_ask_again` (no dialog) and poison the aggregate result.
  const permissions =
    apiLevel >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const result = await PermissionsAndroid.requestMultiple(permissions);
  const deniedPermission = permissions.find(
    (permission) => result[permission] !== PermissionsAndroid.RESULTS.GRANTED,
  );

  const state: BlePermissionState = deniedPermission
    ? {
        status: 'denied',
        message: 'Bluetooth permissions are required to scan for the Acaia scale.',
      }
    : { status: 'granted' };

  logger.info('BLE permission result', { platform: Platform.OS, apiLevel, result, state });
  return state;
}
