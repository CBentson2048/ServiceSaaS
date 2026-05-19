import type React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function DevicePairingScreen(): React.JSX.Element {
  const ble = useBleScale();
  const scanning = ble.status === 'scanning';
  const busy = ble.status === 'connecting' || ble.status === 'discovering' || ble.status === 'reconnecting';

  return (
    <LabScreen title="Pair a scale" eyebrow="Acaia Pearl ready">
      <ConnectionStatusBar
        status={ble.status}
        deviceName={ble.connectedDevice?.name}
        weight={ble.liveWeight}
        error={ble.error}
      />
      <PlaceholderText>
        Request Bluetooth permissions, scan for nearby scales, then connect to the Acaia Pearl used
        at this station.
      </PlaceholderText>
      <StatusRow label="Permission" value={ble.permission.status} />
      <StatusRow label="Bluetooth" value={ble.bluetoothPoweredOn ? 'powered on' : 'off or unavailable'} />
      {ble.permission.message ? <PlaceholderText>{ble.permission.message}</PlaceholderText> : null}
      <View style={styles.actions}>
        <LabButton label="Request permission" onPress={ble.requestPermissions} />
        <LabButton
          label={scanning ? 'Stop scan' : 'Scan for scales'}
          variant="secondary"
          onPress={scanning ? ble.stopScan : ble.startScan}
          disabled={busy}
        />
        <LabButton
          label="Disconnect"
          variant="secondary"
          onPress={ble.disconnect}
          disabled={!ble.connectedDevice}
        />
      </View>
      <View style={styles.deviceList}>
        {ble.devices.length === 0 ? (
          <PlaceholderText>No devices discovered yet.</PlaceholderText>
        ) : (
          ble.devices.map((device) => (
            <View key={device.id} style={styles.deviceRow}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.deviceMeta}>
                  {device.isLikelyAcaia ? 'Likely Acaia scale' : 'Nearby BLE device'}
                  {device.rssi ? ` · RSSI ${device.rssi}` : ''}
                </Text>
              </View>
              <LabButton
                label={ble.connectedDevice?.id === device.id ? 'Connected' : 'Connect'}
                onPress={() => ble.connect(device.id)}
                disabled={busy || ble.connectedDevice?.id === device.id}
              />
            </View>
          ))
        )}
      </View>
    </LabScreen>
  );
}

function StatusRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: labTheme.spacing.sm,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: labTheme.spacing.md,
  },
  statusLabel: {
    color: labTheme.colors.textMuted,
    fontSize: 14,
  },
  statusValue: {
    color: labTheme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
  },
  deviceList: {
    gap: labTheme.spacing.md,
  },
  deviceRow: {
    gap: labTheme.spacing.md,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  deviceCopy: {
    gap: labTheme.spacing.xs,
  },
  deviceName: {
    color: labTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  deviceMeta: {
    color: labTheme.colors.textMuted,
    fontSize: 13,
  },
});
