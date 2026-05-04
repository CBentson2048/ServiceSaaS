import type { BleScaleAdapter, BleScaleState } from '@sheer/lab-core';

const disconnectedState: BleScaleState = {
  state: 'disconnected',
  lastChangedAt: new Date().toISOString(),
};

export function createBleScaleService(): BleScaleAdapter {
  // TODO: replace this scaffold with the production Expo/native BLE adapter.
  return {
    getState: () => disconnectedState,
    connect: async (deviceIdentifier) => ({
      state: 'reconnecting',
      deviceIdentifier,
      lastChangedAt: new Date().toISOString(),
    }),
    disconnect: async () => disconnectedState,
    readWeight: async () => null,
  };
}
