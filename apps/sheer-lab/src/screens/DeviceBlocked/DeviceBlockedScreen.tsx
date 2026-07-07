import type React from 'react';
import { StyleSheet, Text } from 'react-native';

import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';

export function DeviceBlockedScreen(): React.JSX.Element {
  const { resolution, refreshDeviceSession, resetDeviceSession } = useDeviceSession();
  const reason =
    resolution.status === 'disabled' || resolution.status === 'registration_required'
      ? resolution.reason
      : 'This device is not ready for Qlooqo Lab access.';

  return (
    <LabScreen title="Device needs attention" eyebrow="Qlooqo Lab device blocked">
      <Text style={styles.copy}>{reason}</Text>
      <LabButton label="Try again" onPress={() => void refreshDeviceSession()} />
      <LabButton label="Reset local registration" onPress={() => void resetDeviceSession()} variant="secondary" />
      <Text style={styles.meta}>
        Resetting removes only this iPad&apos;s local device session token. It does not change stylist PINs.
      </Text>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  copy: {
    color: labTheme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  meta: {
    color: labTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
});
