import { StyleSheet, View } from 'react-native';
import { LabText } from '../ui/LabText';
import { labColors, labTheme } from '../ui/labTheme';
import { useScaleConnection, type ScaleConnectionState } from './useScaleConnection';

export function ScaleStatusBar() {
  const scale = useScaleConnection();
  const visual = VISUALS[scale.state];

  return (
    <View style={[styles.bar, { borderColor: visual.border, backgroundColor: visual.bg }]}>
      <View style={[styles.dot, { backgroundColor: visual.dot }]} />
      <LabText variant="caption" weight="bold" style={{ color: visual.text }}>
        Scale: {scale.label}
      </LabText>
      <LabText variant="caption" tone="muted">
        {scale.lastWeightGrams === null ? 'No live weight yet' : `${scale.lastWeightGrams}g live`}
      </LabText>
    </View>
  );
}

const VISUALS: Record<ScaleConnectionState, { bg: string; border: string; dot: string; text: string }> =
  {
    connected: {
      bg: labTheme.colors.success.bg,
      border: labTheme.colors.success.border,
      dot: labColors.scaleConnected,
      text: labTheme.colors.success.text,
    },
    searching: {
      bg: labTheme.colors.warning.bg,
      border: labTheme.colors.warning.border,
      dot: labColors.scaleSearching,
      text: labTheme.colors.warning.text,
    },
    offline: {
      bg: labTheme.colors.neutral.bg,
      border: labTheme.colors.neutral.border,
      dot: labTheme.colors.textMuted,
      text: labTheme.colors.textSecondary,
    },
  };

const styles = StyleSheet.create({
  bar: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
});
