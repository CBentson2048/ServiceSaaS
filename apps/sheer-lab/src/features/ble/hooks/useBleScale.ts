import { useCallback, useEffect, useState } from 'react';

import { bleManagerService } from '../BleManagerService';
import type { BleScaleRuntimeState } from '../types';

export function useBleScale() {
  const [state, setState] = useState<BleScaleRuntimeState>(() => bleManagerService.getState());

  useEffect(() => bleManagerService.subscribe(setState), []);

  const requestPermissions = useCallback(() => bleManagerService.requestPermissions(), []);
  const startScan = useCallback(() => bleManagerService.startScan(), []);
  const stopScan = useCallback(() => bleManagerService.stopScan(), []);
  const connect = useCallback((deviceId: string) => bleManagerService.connect(deviceId), []);
  const disconnect = useCallback(() => bleManagerService.disconnect(), []);
  const setManualWeight = useCallback((grams: number) => bleManagerService.setManualWeight(grams), []);
  const tare = useCallback(() => bleManagerService.tare(), []);

  return {
    ...state,
    requestPermissions,
    startScan,
    stopScan,
    connect,
    disconnect,
    setManualWeight,
    tare,
  };
}
