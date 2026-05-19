import type React from 'react';

import { appConfig } from '../../config/appConfig';
import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function SettingsScreen(): React.JSX.Element {
  const ble = useBleScale();

  return (
    <LabScreen title="Settings" eyebrow="Native app config">
      <ConnectionStatusBar
        status={ble.status}
        deviceName={ble.connectedDevice?.name}
        weight={ble.liveWeight}
        error={ble.error}
      />
      <PlaceholderText>
        Environment: {appConfig.environment}. Bundle identifiers and backend URL are centralized
        so they can be changed without touching screen code.
      </PlaceholderText>
      <LabButton
        label="Scan for Acaia Pearl"
        onPress={ble.startScan}
      />
      <LabButton
        label="Disconnect scale"
        variant="secondary"
        onPress={ble.disconnect}
        disabled={!ble.connectedDevice}
      />
    </LabScreen>
  );
}
