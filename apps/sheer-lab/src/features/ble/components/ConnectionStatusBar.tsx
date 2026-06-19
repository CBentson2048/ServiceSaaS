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

type StatusTone = 'connected' | 'busy' | 'error' | 'idle';

const STATUS_COPY: Record<BleConnectionStatus, string> = {
  disconnected: 'Disconnected',
  scanning: 'Scanning…',
  connecting: 'Connecting…',
  discovering: 'Discovering…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
};

function toneFor(status: BleConnectionStatus): StatusTone {
  if (status === 'connected') return 'connected';
  if (status === 'error') return 'error';
  if (status === 'disconnected') return 'idle';
  return 'busy';
}

const TONE_COLOR: Record<StatusTone, string> = {
  connected: labTheme.colors.success.text,
  busy: labTheme.colors.warning.text,
  error: labTheme.colors.danger.text,
  idle: labTheme.colors.textMuted,
};

export function ConnectionStatusBar({
  status,
  deviceName,
  weight,
  error,
}: ConnectionStatusBarProps): React.JSX.Element {
  const tone = toneFor(status);
  const accent = TONE_COLOR[tone];
  const statusLabel = error ?? STATUS_COPY[status];

  return (
    <View
      style={[
        styles.container,
        tone === 'connected' && styles.connected,
        tone === 'busy' && styles.warning,
        tone === 'error' && styles.error,
      ]}
    >
      <View style={styles.left}>
        <View style={[styles.dot, { backgroundColor: accent }]} />
        <View style={styles.identity}>
          <Text style={styles.label}>Acaia Pearl</Text>
          <Text style={styles.value} numberOfLines={1}>
            {deviceName ?? 'No scale connected'}
          </Text>
        </View>
      </View>
      <View style={styles.right}>
        <Text style={[styles.status, { color: accent }]} numberOfLines={1}>
          {statusLabel}
        </Text>
        {weight ? <Text style={styles.weight}>{weight.grams.toFixed(1)} g</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: labTheme.spacing.md,
    paddingVertical: labTheme.spacing.sm,
    paddingHorizontal: labTheme.spacing.md,
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
  error: {
    borderColor: labTheme.colors.danger.border,
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: labTheme.spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: labTheme.radius.full,
  },
  identity: {
    flex: 1,
    gap: 2,
  },
  label: {
    color: labTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  value: {
    color: labTheme.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  right: {
    alignItems: 'flex-end',
    gap: 2,
  },
  status: {
    fontSize: 12,
    fontWeight: '700',
  },
  weight: {
    color: labTheme.colors.primary,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
});
