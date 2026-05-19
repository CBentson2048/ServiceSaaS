export type BlePermissionStatus = 'unknown' | 'granted' | 'denied' | 'unavailable';

export type BleConnectionStatus =
  | 'disconnected'
  | 'scanning'
  | 'connecting'
  | 'discovering'
  | 'connected'
  | 'reconnecting'
  | 'error';

export type BleWeightSource = 'ble' | 'manual';

export interface BlePermissionState {
  status: BlePermissionStatus;
  message?: string;
}

export interface BleDeviceSummary {
  id: string;
  name: string;
  rssi?: number;
  isLikelyAcaia: boolean;
}

export interface BleWeightReading {
  grams: number;
  unit: 'g';
  stable?: boolean;
  source: BleWeightSource;
  capturedAt: string;
}

export interface AcaiaCharacteristicBinding {
  protocol: 'acaia-old' | 'acaia-new';
  serviceUUID: string;
  readCharacteristicUUID: string;
  writeCharacteristicUUID: string;
}

export interface BleScaleRuntimeState {
  permission: BlePermissionState;
  status: BleConnectionStatus;
  bluetoothPoweredOn: boolean;
  devices: BleDeviceSummary[];
  connectedDevice?: BleDeviceSummary;
  activeBinding?: AcaiaCharacteristicBinding;
  liveWeight?: BleWeightReading;
  latestManualWeight?: BleWeightReading;
  error?: string;
  lastPacketAt?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
}

export type BleScaleListener = (state: BleScaleRuntimeState) => void;
