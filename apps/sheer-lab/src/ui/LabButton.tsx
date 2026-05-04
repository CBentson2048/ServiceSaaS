import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { LabText } from './LabText';
import { labTheme } from './labTheme';

type LabButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface LabButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: LabButtonVariant;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function LabButton({
  label,
  variant = 'primary',
  fullWidth,
  disabled,
  style,
  ...pressableProps
}: LabButtonProps) {
  const visual = VARIANTS[variant];

  return (
    <Pressable
      {...pressableProps}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        {
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          backgroundColor: visual.bg,
          borderColor: visual.border,
          opacity: disabled ? 0.5 : pressed ? 0.82 : 1,
        },
        style,
      ]}
    >
      <LabText
        variant="body"
        weight="bold"
        tone={variant === 'primary' ? 'primary' : 'brand'}
        style={{ color: visual.text }}
      >
        {label}
      </LabText>
    </Pressable>
  );
}

const VARIANTS: Record<LabButtonVariant, { bg: string; border: string; text: string }> = {
  primary: {
    bg: labTheme.colors.primary,
    border: labTheme.colors.primary,
    text: '#ffffff',
  },
  secondary: {
    bg: '#ffffff',
    border: labTheme.colors.borderStrong,
    text: labTheme.colors.textPrimary,
  },
  ghost: {
    bg: 'transparent',
    border: 'transparent',
    text: labTheme.colors.primary,
  },
  danger: {
    bg: labTheme.colors.danger.bg,
    border: labTheme.colors.danger.border,
    text: labTheme.colors.danger.text,
  },
};

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    minWidth: 148,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
});
