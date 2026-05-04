import { useMemo } from 'react';

export type ScaleConnectionState = 'connected' | 'searching' | 'offline';

export interface ScaleConnection {
  state: ScaleConnectionState;
  label: string;
  lastWeightGrams: number | null;
}

export function useScaleConnection(): ScaleConnection {
  return useMemo(
    () => ({
      state: 'searching',
      label: 'BLE scale ready to pair',
      lastWeightGrams: null,
    }),
    [],
  );
}
