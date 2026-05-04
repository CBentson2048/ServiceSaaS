import { StyleSheet, View } from 'react-native';
import { LabText } from './LabText';
import { labTheme } from './labTheme';

interface StatusPillProps {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}

export function StatusPill({ label, tone = 'neutral' }: StatusPillProps) {
  const visual = TONES[tone];

  return (
    <View style={[styles.pill, { backgroundColor: visual.bg, borderColor: visual.border }]}>
      <LabText variant="caption" weight="bold" style={{ color: visual.text }}>
        {label}
      </LabText>
    </View>
  );
}

const TONES = {
  neutral: labTheme.colors.neutral,
  success: labTheme.colors.success,
  warning: labTheme.colors.warning,
  danger: labTheme.colors.danger,
};

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
