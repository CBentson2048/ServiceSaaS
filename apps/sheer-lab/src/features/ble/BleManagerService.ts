import type { BleError, Device } from 'react-native-ble-plx';
import { BleManager, State, type Subscription } from 'react-native-ble-plx';

import { logger } from '../../lib/logging/logger';
import {
  ACAIA_HEARTBEAT_INTERVAL_MS,
  acaiaPacketBytes,
  decodeAcaiaWeightPacket,
  discoverAcaiaCharacteristics,
  sendAcaiaHeartbeat,
  sendAcaiaTare,
  startAcaiaSession,
} from './AcaiaProtocol';
import { sortAcaiaDevices, toDeviceSummary } from './deviceFilters';
import { requestBlePermissions } from './permissions';
import { bleScaleStore } from './store/bleScaleStore';
import type { AcaiaCharacteristicBinding, BleScaleListener } from './types';

const SCAN_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 1500;

class BleManagerService {
  private readonly manager = new BleManager();
  private stateSubscription?: Subscription;
  private notificationSubscription?: Subscription;
  private connectedDevice?: Device;
  private scanTimeout?: ReturnType<typeof setTimeout>;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private reconnectTimeout?: ReturnType<typeof setTimeout>;
  private manuallyDisconnecting = false;

  constructor() {
    this.stateSubscription = this.manager.onStateChange((state) => {
      bleScaleStore.setState({ bluetoothPoweredOn: state === State.PoweredOn });
      logger.info('BLE adapter state changed', { state });
    }, true);
  }

  subscribe(listener: BleScaleListener): () => void {
    return bleScaleStore.subscribe(listener);
  }

  getState() {
    return bleScaleStore.getState();
  }

  async requestPermissions(): Promise<void> {
    const permission = await requestBlePermissions(this.manager);
    const bluetoothState = await this.manager.state();

    bleScaleStore.setState({
      permission,
      bluetoothPoweredOn: bluetoothState === State.PoweredOn,
      error: permission.status === 'denied' ? permission.message : undefined,
    });
    logger.info('BLE permission state updated', { permission, bluetoothState });
  }

  async startScan(): Promise<void> {
    await this.requestPermissions();

    const state = bleScaleStore.getState();
    if (state.permission.status !== 'granted') return;

    const bluetoothState = await this.manager.state();
    if (bluetoothState !== State.PoweredOn) {
      bleScaleStore.setState({
        status: 'error',
        error: 'Bluetooth is not powered on.',
        bluetoothPoweredOn: false,
      });
      return;
    }

    this.stopScan();
    bleScaleStore.setState({ status: 'scanning', devices: [], error: undefined });
    logger.info('BLE scan started');

    this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        this.stopScan();
        bleScaleStore.setState({ status: 'error', error: error.message });
        logger.error('BLE scan failed', { error: error.message, reason: error.reason });
        return;
      }

      if (!device) return;

      const summary = toDeviceSummary(device);
      const current = bleScaleStore.getState().devices;
      const next = sortAcaiaDevices([
        ...current.filter((existing) => existing.id !== summary.id),
        summary,
      ]);

      bleScaleStore.setState({ devices: next });
      logger.info('BLE device discovered', { device: summary });
    });

    this.scanTimeout = setTimeout(() => {
      this.stopScan();
    }, SCAN_TIMEOUT_MS);
  }

  stopScan(): void {
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = undefined;
    }

    this.manager.stopDeviceScan();

    if (bleScaleStore.getState().status === 'scanning') {
      bleScaleStore.setState({ status: 'disconnected' });
    }

    logger.info('BLE scan stopped');
  }

  async connect(deviceId: string, options?: { isReconnect?: boolean }): Promise<void> {
    this.stopScan();
    this.clearReconnect();
    this.manuallyDisconnecting = false;
    bleScaleStore.setState({ status: 'connecting', error: undefined });

    try {
      logger.info('BLE connect started', { deviceId });
      const device = await this.manager.connectToDevice(deviceId, { timeout: 10000 });
      this.connectedDevice = device;
      const connectedSummary = toDeviceSummary(device);

      bleScaleStore.setState({
        status: 'discovering',
        connectedDevice: connectedSummary,
      });

      const discoveredDevice = await device.discoverAllServicesAndCharacteristics();
      const binding = await discoverAcaiaCharacteristics(discoveredDevice);
      logger.info('Acaia characteristics discovered', { binding });

      await startAcaiaSession(discoveredDevice, binding);
      this.startHeartbeat(discoveredDevice, binding);
      this.startNotifications(discoveredDevice, binding);

      // Auto-zero on a fresh, user-initiated connect so an empty pan reads 0.0 g.
      // Skipped on auto-reconnect to avoid wiping an in-progress measurement.
      if (!options?.isReconnect) {
        await sendAcaiaTare(discoveredDevice, binding).catch((error) => {
          logger.warn('Acaia auto-tare failed', { error: toErrorMessage(error) });
        });
      }

      discoveredDevice.onDisconnected((error) => {
        this.handleDisconnect(error);
      });

      bleScaleStore.setState({
        status: 'connected',
        activeBinding: binding,
        connectedDevice: connectedSummary,
        lastConnectedAt: new Date().toISOString(),
        error: undefined,
      });
      logger.info('BLE connect completed', { device: connectedSummary });
    } catch (error) {
      const message = toErrorMessage(error, 'Could not connect to the Acaia scale.');
      bleScaleStore.setState({ status: 'error', error: message });
      logger.error('BLE connect failed', { deviceId, error: message });
    }
  }

  async disconnect(): Promise<void> {
    this.manuallyDisconnecting = true;
    this.clearRuntimeHandles();

    const device = this.connectedDevice;
    this.connectedDevice = undefined;

    if (device) {
      try {
        await device.cancelConnection();
      } catch (error) {
        logger.warn('BLE disconnect warning', { error: toErrorMessage(error) });
      }
    }

    bleScaleStore.resetSessionState();
    logger.info('BLE disconnected by user');
  }

  setManualWeight(grams: number): void {
    const reading = bleScaleStore.setManualWeight(grams);
    logger.info('Manual weight entered', { reading });
  }

  async tare(): Promise<void> {
    const device = this.connectedDevice;
    const binding = bleScaleStore.getState().activeBinding;
    if (!device || !binding) {
      logger.warn('Tare ignored — no scale connected');
      return;
    }

    try {
      await sendAcaiaTare(device, binding);
      logger.info('Acaia tare sent by user');
    } catch (error) {
      logger.warn('Acaia tare failed', { error: toErrorMessage(error) });
    }
  }

  dispose(): void {
    this.stopScan();
    this.clearRuntimeHandles();
    this.stateSubscription?.remove();
    this.manager.destroy();
  }

  private startNotifications(device: Device, binding: AcaiaCharacteristicBinding): void {
    this.notificationSubscription?.remove();
    this.notificationSubscription = device.monitorCharacteristicForService(
      binding.serviceUUID,
      binding.readCharacteristicUUID,
      (error, characteristic) => {
        if (error) {
          bleScaleStore.setState({ status: 'reconnecting', error: error.message, liveWeight: undefined });
          logger.error('Acaia notification error', { error: error.message });
          this.handleDisconnect(error);
          return;
        }

        const payload = characteristic?.value;
        if (!payload) return;

        // Temporary diagnostic: log raw bytes + decoded grams for every packet so
        // the decoder can be validated against a real Acaia (empty-scale offset check).
        const bytes = acaiaPacketBytes(payload);
        const reading = decodeAcaiaWeightPacket(payload);
        logger.info('Acaia packet received', {
          bytes,
          length: bytes.length,
          parsed: Boolean(reading),
          grams: reading?.grams,
        });

        if (reading) {
          bleScaleStore.setState({
            liveWeight: reading,
            lastPacketAt: reading.capturedAt,
            error: undefined,
          });
        }
      },
    );
    logger.info('Acaia notification subscription started', { binding });
  }

  private startHeartbeat(device: Device, binding: AcaiaCharacteristicBinding): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(() => {
      sendAcaiaHeartbeat(device, binding).catch((error) => {
        logger.warn('Acaia heartbeat failed', { error: toErrorMessage(error) });
      });
    }, ACAIA_HEARTBEAT_INTERVAL_MS);
    logger.info('Acaia heartbeat started');
  }

  private handleDisconnect(error?: BleError | null): void {
    this.clearRuntimeHandles();
    const latestState = bleScaleStore.getState();

    if (this.manuallyDisconnecting) {
      this.connectedDevice = undefined;
      this.manuallyDisconnecting = false;
      return;
    }

    bleScaleStore.setState({
      status: 'reconnecting',
      lastDisconnectedAt: new Date().toISOString(),
      liveWeight: undefined,
      error: error?.message,
    });
    logger.warn('BLE disconnected unexpectedly', { error: error?.message });

    const deviceId = latestState.connectedDevice?.id;
    if (!deviceId) {
      bleScaleStore.setState({ status: 'error', error: error?.message ?? 'Scale disconnected.' });
      return;
    }

    this.reconnectTimeout = setTimeout(() => {
      this.connect(deviceId, { isReconnect: true }).catch((connectError) => {
        bleScaleStore.setState({
          status: 'error',
          error: toErrorMessage(connectError, 'Reconnect failed. Manual entry remains available.'),
        });
      });
    }, RECONNECT_DELAY_MS);
  }

  private clearRuntimeHandles(): void {
    this.notificationSubscription?.remove();
    this.notificationSubscription = undefined;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    this.clearReconnect();
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
  }
}

function toErrorMessage(error: unknown, fallback = 'Unexpected BLE error'): string {
  return error instanceof Error ? error.message : fallback;
}

export const bleManagerService = new BleManagerService();
