import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { labTheme } from './labTheme';

interface LabCardProps {
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'success' | 'warning';
  style?: StyleProp<ViewStyle>;
}

export function LabCard({ children, tone = 'default', style }: LabCardProps) {
  return <View style={[styles.card, TONES[tone], style]}>{children}</View>;
}

const TONES: Record<NonNullable<LabCardProps['tone']>, ViewStyle> = {
  default: {
    backgroundColor: labTheme.colors.surface,
    borderColor: labTheme.colors.border,
  },
  accent: {
    backgroundColor: labTheme.colors.surfaceAlt,
    borderColor: '#fed7aa',
  },
  success: {
    backgroundColor: labTheme.colors.success.bg,
    borderColor: labTheme.colors.success.border,
  },
  warning: {
    backgroundColor: labTheme.colors.warning.bg,
    borderColor: labTheme.colors.warning.border,
  },
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 20,
    gap: 12,
    shadowColor: '#111827',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
});
