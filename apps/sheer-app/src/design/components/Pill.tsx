import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { AppText } from './AppText';

export interface PillProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  active?: boolean;
  /** When true, the pill renders inert (no press feedback). */
  staticDisplay?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Pill / segmented-tab control. Use `active` to mark the selected option.
 */
export function Pill(props: PillProps) {
  const { label, active, staticDisplay, style, ...rest } = props;
  const theme = useTheme();

  const bg = active ? theme.colors.primary : 'transparent';
  const border = active ? theme.colors.primary : theme.colors.border;
  const textColor = active ? theme.colors.textOnPrimary : theme.colors.textSecondary;

  return (
    <Pressable
      {...rest}
      disabled={staticDisplay}
      accessibilityRole={staticDisplay ? undefined : 'tab'}
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [
        {
          paddingHorizontal: theme.spacing.base,
          paddingVertical: theme.spacing.xs + 2,
          borderRadius: theme.radius.pill,
          borderWidth: 1.5,
          borderColor: border,
          backgroundColor: bg,
          opacity: pressed && !staticDisplay ? 0.85 : 1,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <AppText
        variant="caption"
        weight="medium"
        tone={active ? 'onPrimary' : 'secondary'}
        style={{ color: textColor }}
      >
        {label}
      </AppText>
    </Pressable>
  );
}
