import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { AppText } from './AppText';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  style?: StyleProp<ViewStyle>;
}

/**
 * Compact pill that signals a state — On track, Needs attention, Behind, etc.
 */
export function StatusBadge({ label, tone = 'neutral', style }: StatusBadgeProps) {
  const theme = useTheme();
  const tokens = theme.colors[tone];

  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          paddingHorizontal: theme.spacing.md,
          paddingVertical: 3,
          borderRadius: theme.radius.pill,
          backgroundColor: tokens.bg,
        },
        style,
      ]}
    >
      <AppText
        variant="micro"
        weight="medium"
        style={{ color: tokens.text }}
      >
        {label}
      </AppText>
    </View>
  );
}
