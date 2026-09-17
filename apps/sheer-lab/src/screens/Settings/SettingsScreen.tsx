import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type React from 'react';

import type { RootStackParamList } from '../../app/navigation/routes';
import { appConfig } from '../../config/appConfig';
import { confirmDestructive } from '../../lib/confirm';
import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function SettingsScreen(): React.JSX.Element {
  const ble = useBleScale();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { deviceContext, resetDeviceSession } = useDeviceSession();

  async function handleResetDevice(): Promise<void> {
    const confirmed = await confirmDestructive({
      title: 'Reset device registration?',
      message:
        'This station will be unregistered and returned to the registration screen. You will need its registration token to set it up again.',
      confirmLabel: 'Reset registration',
    });
    if (confirmed) await resetDeviceSession();
  }

  return (
    <LabScreen title="Settings" eyebrow="Native app config">
      <ConnectionStatusBar
        status={ble.status}
        deviceName={ble.connectedDevice?.name}
        weight={ble.liveWeight}
        error={ble.error}
      />
      {/* Was build-configuration prose ("Bundle identifiers and backend URL are
          centralized so they can be changed without touching screen code") on a
          screen salon operators open to pair a scale. */}
      <PlaceholderText>
        This station: {deviceContext?.device.deviceName ?? 'not registered'} · Location:{' '}
        {deviceContext?.location.name ?? 'not resolved'} · Build:{' '}
        {appConfig.environment}
      </PlaceholderText>
      {/* Was "Scan for Acaia Pearl", wired straight to `ble.startScan`. That
          only populates `ble.devices`, which this screen never reads, and there
          was no route to DevicePairing — so an operator whose scale had dropped
          watched the status go "Scanning…", then quiet, with no way to select
          what it found. It also named one model the pairing filter does not
          assume. Send them to the screen that can actually pair. */}
      <LabButton label="Pair a scale" onPress={() => navigation.navigate('DevicePairing')} />
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
        onPress={() => void handleResetDevice()}
      />
    </LabScreen>
  );
}
