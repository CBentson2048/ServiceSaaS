import type { LabDeviceResolveResponse } from '@sheer/domain';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  type DeviceResolutionState,
  resetStoredDeviceSession,
  resolveStoredDeviceSession,
} from './deviceSession';

interface DeviceSessionContextValue {
  resolution: DeviceResolutionState;
  deviceContext?: LabDeviceResolveResponse;
  refreshDeviceSession: () => Promise<void>;
  resetDeviceSession: () => Promise<void>;
}

const DeviceSessionContext = createContext<DeviceSessionContextValue | undefined>(undefined);

export function DeviceSessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [resolution, setResolution] = useState<DeviceResolutionState>({ status: 'resolving' });

  const refreshDeviceSession = useCallback(async () => {
    setResolution({ status: 'resolving' });
    setResolution(await resolveStoredDeviceSession());
  }, []);

  const resetDeviceSession = useCallback(async () => {
    await resetStoredDeviceSession();
    setResolution({ status: 'unregistered' });
  }, []);

  useEffect(() => {
    void refreshDeviceSession();
  }, [refreshDeviceSession]);

  const value = useMemo(
    () => ({
      resolution,
      deviceContext: resolution.status === 'ready' ? resolution.context : undefined,
      refreshDeviceSession,
      resetDeviceSession,
    }),
    [refreshDeviceSession, resetDeviceSession, resolution],
  );

  return <DeviceSessionContext.Provider value={value}>{children}</DeviceSessionContext.Provider>;
}

export function useDeviceSession(): DeviceSessionContextValue {
  const context = useContext(DeviceSessionContext);
  if (!context) throw new Error('useDeviceSession must be used within DeviceSessionProvider');
  return context;
}
