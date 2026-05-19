import type { Device } from 'react-native-ble-plx';

import type { BleDeviceSummary } from './types';

const ACAIA_NAME_PREFIXES = ['ACAIA', 'PEARL', 'LUNAR', 'PYXIS', 'CINCO', 'PROCH', 'BOOKO'];

export function isLikelyAcaiaDeviceName(name?: string | null): boolean {
  if (!name) return false;

  const normalized = name.trim().toUpperCase();
  return ACAIA_NAME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function toDeviceSummary(device: Device): BleDeviceSummary {
  const name = device.name ?? device.localName ?? 'Unknown BLE device';

  return {
    id: device.id,
    name,
    rssi: device.rssi ?? undefined,
    isLikelyAcaia: isLikelyAcaiaDeviceName(name),
  };
}

export function sortAcaiaDevices(devices: BleDeviceSummary[]): BleDeviceSummary[] {
  return [...devices].sort((a, b) => {
    if (a.isLikelyAcaia !== b.isLikelyAcaia) return a.isLikelyAcaia ? -1 : 1;
    return (b.rssi ?? -999) - (a.rssi ?? -999);
  });
}
