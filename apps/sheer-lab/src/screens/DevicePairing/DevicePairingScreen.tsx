import React from 'react';

import { bleScaleService } from '../../features/ble/bleScaleService';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function DevicePairingScreen(): React.JSX.Element {
  const scaleState = bleScaleService.getState();

  return (
    <LabScreen title="Pair a scale" eyebrow="Acaia Pearl ready">
      <PlaceholderText>
        BLE scanning and connection will live behind the app-local BLE service. Native BLE
        dependencies are intentionally deferred until the hardware integration task.
      </PlaceholderText>
      <PlaceholderText>Connection state: {scaleState.state}</PlaceholderText>
    </LabScreen>
  );
}
