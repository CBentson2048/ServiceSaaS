import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { labTheme } from '../../theme/labTheme';

interface PlaceholderTextProps {
  children: React.ReactNode;
}

export function PlaceholderText({ children }: PlaceholderTextProps): React.JSX.Element {
  return <Text style={styles.text}>{children}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: labTheme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 24,
  },
});
