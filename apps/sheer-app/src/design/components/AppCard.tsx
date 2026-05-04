import { Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { shadow as shadowTokens } from '@sheer/design-tokens';
import { useTheme } from '../ThemeProvider';

export type AppCardVariant = 'default' | 'hero' | 'success' | 'warning' | 'danger';
export type AppCardPadding = 'none' | 'sm' | 'md' | 'lg';
export type AppCardElevation = 'none' | 'card' | 'hero';

export interface AppCardProps {
  variant?: AppCardVariant;
  padding?: AppCardPadding;
  elevation?: AppCardElevation;
  /** Render as a Pressable when an `onPress` is provided. */
  onPress?: PressableProps['onPress'];
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  testID?: string;
}

export function AppCard(props: AppCardProps) {
  const {
    variant = 'default',
    padding = 'md',
    elevation = 'card',
    onPress,
    style,
    children,
    testID,
  } = props;
  const theme = useTheme();

  const visual = resolveVisual(theme, variant);
  const pad = PADDING[padding](theme);
  const shadowStyle = shadowTokens[elevation].native;

  const baseStyle: ViewStyle = {
    backgroundColor: visual.bg,
    borderRadius: variant === 'hero' ? theme.radius.cardLg : theme.radius.card,
    borderWidth: visual.borderWidth,
    borderColor: visual.border,
    padding: pad,
    ...shadowStyle,
  };

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [baseStyle, { opacity: pressed ? 0.92 : 1 }, style]}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View testID={testID} style={[baseStyle, style]}>
      {children}
    </View>
  );
}

function resolveVisual(theme: ReturnType<typeof useTheme>, variant: AppCardVariant) {
  switch (variant) {
    case 'default':
      return {
        bg: theme.colors.surface,
        border: theme.colors.border,
        borderWidth: 1,
      };
    case 'hero':
      return {
        bg: theme.colors.surfaceAlt,
        border: theme.colors.borderStrong,
        borderWidth: 1,
      };
    case 'success':
      return {
        bg: theme.colors.surface,
        border: theme.colors.success.border,
        borderWidth: 1.5,
      };
    case 'warning':
      return {
        bg: theme.colors.surface,
        border: theme.colors.warning.border,
        borderWidth: 1.5,
      };
    case 'danger':
      return {
        bg: theme.colors.surface,
        border: theme.colors.danger.border,
        borderWidth: 1.5,
      };
  }
}

const PADDING: Record<AppCardPadding, (t: ReturnType<typeof useTheme>) => number> = {
  none: () => 0,
  sm: (t) => t.spacing.md,
  md: (t) => t.spacing.base,
  lg: (t) => t.spacing.xl,
};
