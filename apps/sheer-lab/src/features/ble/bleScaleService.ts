import type { BleScaleAdapter, BleScaleState } from '@sheer/lab-core';

const initialState: BleScaleState = {
  state: 'disconnected',
};

export const bleScaleService: BleScaleAdapter = {
  getState() {
    return initialState;
  },
  async connect(deviceIdentifier: string) {
    return {
      state: 'connected',
      deviceIdentifier,
      lastChangedAt: new Date().toISOString(),
    };
  },
  async disconnect() {
    return {
      state: 'disconnected',
      lastChangedAt: new Date().toISOString(),
    };
  },
  async readWeight() {
    return null;
  },
};
