import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { labTheme } from '../../theme/labTheme';

interface LabButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
}

export function LabButton({
  label,
  onPress,
  variant = 'primary',
}: LabButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.secondary,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.label, variant === 'secondary' && styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    paddingVertical: labTheme.spacing.md,
    paddingHorizontal: labTheme.spacing.lg,
    borderRadius: labTheme.radius.full,
    backgroundColor: labTheme.colors.primary,
  },
  secondary: {
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    backgroundColor: labTheme.colors.card,
  },
  pressed: {
    opacity: 0.78,
  },
  label: {
    color: labTheme.colors.textOnPrimary,
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryLabel: {
    color: labTheme.colors.textPrimary,
  },
});
