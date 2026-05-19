import type { BleScaleListener, BleScaleRuntimeState, BleWeightReading } from '../types';

const initialState: BleScaleRuntimeState = {
  permission: {
    status: 'unknown',
  },
  status: 'disconnected',
  bluetoothPoweredOn: false,
  devices: [],
};

let state = initialState;
const listeners = new Set<BleScaleListener>();

export const bleScaleStore = {
  getState(): BleScaleRuntimeState {
    return state;
  },
  setState(update: Partial<BleScaleRuntimeState>): void {
    state = { ...state, ...update };
    emit();
  },
  setManualWeight(grams: number): BleWeightReading {
    const reading: BleWeightReading = {
      grams,
      unit: 'g',
      source: 'manual',
      capturedAt: new Date().toISOString(),
      stable: true,
    };

    state = {
      ...state,
      latestManualWeight: reading,
      liveWeight: reading,
    };
    emit();
    return reading;
  },
  resetSessionState(): void {
    state = {
      ...state,
      status: 'disconnected',
      connectedDevice: undefined,
      activeBinding: undefined,
      error: undefined,
      lastDisconnectedAt: new Date().toISOString(),
    };
    emit();
  },
  subscribe(listener: BleScaleListener): () => void {
    listeners.add(listener);
    listener(state);

    return () => {
      listeners.delete(listener);
    };
  },
};

function emit(): void {
  listeners.forEach((listener) => listener(state));
}
