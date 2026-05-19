import type React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { labTheme } from '../../../theme/labTheme';
import type { BleConnectionStatus, BleWeightReading } from '../types';

interface ConnectionStatusBarProps {
  status: BleConnectionStatus;
  deviceName?: string;
  weight?: BleWeightReading;
  error?: string;
}

export function ConnectionStatusBar({
  status,
  deviceName,
  weight,
  error,
}: ConnectionStatusBarProps): React.JSX.Element {
  const connected = status === 'connected';
  const reconnecting = status === 'reconnecting';

  return (
    <View style={[styles.container, connected && styles.connected, reconnecting && styles.warning]}>
      <View>
        <Text style={styles.label}>Acaia Pearl</Text>
        <Text style={styles.value}>{deviceName ?? 'No scale connected'}</Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.status}>{error ?? status}</Text>
        {weight ? <Text style={styles.weight}>{weight.grams.toFixed(1)} g</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: labTheme.spacing.sm,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  connected: {
    borderColor: labTheme.colors.success.border,
  },
  warning: {
    borderColor: labTheme.colors.warning.border,
  },
  label: {
    color: labTheme.colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  value: {
    color: labTheme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  right: {
    gap: labTheme.spacing.xs,
  },
  status: {
    color: labTheme.colors.textSecondary,
    fontSize: 13,
  },
  weight: {
    color: labTheme.colors.primary,
    fontSize: 24,
    fontWeight: '900',
  },
});
