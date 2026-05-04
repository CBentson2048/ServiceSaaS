import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';
import type { LabActivityEvent } from '@sheer/lab-core';
import { useSheerLabSession } from './SheerLabSessionProvider';
import { useLabInactivityLock } from './useLabInactivityLock';

const LabActivityContext = createContext<(event: LabActivityEvent) => void>(() => undefined);

export function LabActivityBoundary({ children }: { children: ReactNode }) {
  const { stylistSession, signOutStylist } = useSheerLabSession();
  const { recordActivity } = useLabInactivityLock(() => {
    if (stylistSession) {
      signOutStylist();
    }
  });

  return (
    <LabActivityContext.Provider value={recordActivity}>
      <View
        style={{ flex: 1 }}
        onTouchStart={() => {
          if (stylistSession) {
            recordActivity('screen_tap');
          }
        }}
      >
        {children}
      </View>
    </LabActivityContext.Provider>
  );
}

export function useLabActivity() {
  return useContext(LabActivityContext);
}
