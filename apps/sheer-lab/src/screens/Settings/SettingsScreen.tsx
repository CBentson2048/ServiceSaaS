import type React from 'react';

import { appConfig } from '../../config/appConfig';
import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function SettingsScreen(): React.JSX.Element {
  const ble = useBleScale();
  const { deviceContext, resetDeviceSession } = useDeviceSession();

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
      <PlaceholderText>
        Device: {deviceContext?.device.deviceName ?? 'unregistered'} · Location:{' '}
        {deviceContext?.location.name ?? 'not resolved'}
      </PlaceholderText>
      <LabButton
        label="Scan for Acaia Pearl"
        onPress={ble.startScan}
      />
      <LabButton
        label="Tare / Zero scale"
        variant="secondary"
        onPress={ble.tare}
        disabled={ble.status !== 'connected'}
      />
      <LabButton
        label="Disconnect scale"
        variant="secondary"
        onPress={ble.disconnect}
        disabled={!ble.connectedDevice}
      />
      <LabButton
        label="Reset device registration"
        variant="secondary"
        onPress={() => void resetDeviceSession()}
      />
    </LabScreen>
  );
}
