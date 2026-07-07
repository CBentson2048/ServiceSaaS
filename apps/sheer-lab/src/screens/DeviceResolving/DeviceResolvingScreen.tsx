import type React from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';

import { labTheme } from '../../theme/labTheme';
import { LabScreen } from '../shared/LabScreen';

export function DeviceResolvingScreen(): React.JSX.Element {
  return (
    <LabScreen title="Checking this iPad" eyebrow="Qlooqo Lab device">
      <ActivityIndicator color={labTheme.colors.primary} size="large" />
      <Text style={styles.copy}>Resolving the registered device and assigned location.</Text>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  copy: {
    color: labTheme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
});
