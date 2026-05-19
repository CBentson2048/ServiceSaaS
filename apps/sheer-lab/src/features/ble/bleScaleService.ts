import type { BleScaleAdapter, BleScaleState } from '@sheer/lab-core';

import { bleManagerService } from './BleManagerService';

export const bleScaleService: BleScaleAdapter = {
  getState() {
    const state = bleManagerService.getState();
    const adapterState =
      state.status === 'reconnecting'
        ? 'reconnecting'
        : state.status === 'connected'
          ? 'connected'
          : 'disconnected';

    return {
      state: adapterState,
      deviceIdentifier: state.connectedDevice?.id,
      deviceName: state.connectedDevice?.name,
      lastWeightGrams: state.liveWeight?.grams,
      lastChangedAt: state.liveWeight?.capturedAt ?? state.lastConnectedAt ?? state.lastDisconnectedAt,
    } satisfies BleScaleState;
  },
  async connect(deviceIdentifier: string) {
    await bleManagerService.connect(deviceIdentifier);
    return this.getState();
  },
  async disconnect() {
    await bleManagerService.disconnect();
    return this.getState();
  },
  async readWeight() {
    return bleManagerService.getState().liveWeight?.grams ?? null;
  },
};
