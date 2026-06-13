import type React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { labTheme } from '../../theme/labTheme';

interface LabButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  /** Shows an inline spinner and blocks presses while a task is running. */
  loading?: boolean;
}

export function LabButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
}: LabButtonProps): React.JSX.Element {
  const isDisabled = disabled || loading;
  const spinnerColor =
    variant === 'secondary' ? labTheme.colors.textPrimary : labTheme.colors.textOnPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.secondary,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
      ]}
    >
      <View style={styles.inner}>
        {loading ? <ActivityIndicator size="small" color={spinnerColor} /> : null}
        <Text style={[styles.label, variant === 'secondary' && styles.secondaryLabel]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    paddingVertical: labTheme.spacing.md,
    paddingHorizontal: labTheme.spacing.lg,
    borderRadius: labTheme.radius.full,
    backgroundColor: labTheme.colors.primary,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: labTheme.spacing.sm,
  },
  secondary: {
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    backgroundColor: labTheme.colors.card,
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    color: labTheme.colors.textOnPrimary,
    fontSize: labTheme.typography.fontSize.subtitle,
    fontWeight: '800',
  },
  secondaryLabel: {
    color: labTheme.colors.textPrimary,
  },
});
