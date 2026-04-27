import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../ThemeProvider';
import { AppText, type AppTextTone } from './AppText';

export type AppButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'danger';
export type AppButtonSize = 'sm' | 'md' | 'lg';

export interface AppButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function AppButton(props: AppButtonProps) {
  const {
    label,
    variant = 'primary',
    size = 'md',
    fullWidth,
    loading,
    leadingIcon,
    trailingIcon,
    disabled,
    style,
    ...pressable
  } = props;
  const theme = useTheme();

  const sizing = SIZE[size](theme);
  const visual = resolveVisual(theme, variant);
  const isDisabled = disabled || loading;

  return (
    <Pressable
      {...pressable}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: visual.bg,
          borderColor: visual.border,
          borderWidth: visual.border === 'transparent' ? 0 : StyleSheet.hairlineWidth * 2,
          opacity: isDisabled ? 0.55 : pressed ? 0.85 : 1,
          paddingHorizontal: sizing.paddingHorizontal,
          paddingVertical: sizing.paddingVertical,
          borderRadius: theme.radius.pill,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator color={visual.textColor} size="small" />
        ) : (
          <>
            {leadingIcon ? <View style={{ marginRight: 6 }}>{leadingIcon}</View> : null}
            <AppText
              variant={sizing.textVariant}
              weight="medium"
              tone={visual.textTone}
              style={{ color: visual.textColor }}
            >
              {label}
            </AppText>
            {trailingIcon ? <View style={{ marginLeft: 6 }}>{trailingIcon}</View> : null}
          </>
        )}
      </View>
    </Pressable>
  );
}

interface ButtonVisual {
  bg: string;
  border: string;
  textTone: AppTextTone;
  textColor: string;
}

function resolveVisual(theme: ReturnType<typeof useTheme>, variant: AppButtonVariant): ButtonVisual {
  switch (variant) {
    case 'primary':
      return {
        bg: theme.colors.primary,
        border: 'transparent',
        textTone: 'onPrimary',
        textColor: theme.colors.textOnPrimary,
      };
    case 'secondary':
      return {
        bg: 'transparent',
        border: theme.colors.borderStrong,
        textTone: 'primary',
        textColor: theme.colors.textPrimary,
      };
    case 'ghost':
      return {
        bg: 'transparent',
        border: 'transparent',
        textTone: 'secondary',
        textColor: theme.colors.textSecondary,
      };
    case 'success':
      return {
        bg: theme.colors.success.bg,
        border: theme.colors.success.border,
        textTone: 'success',
        textColor: theme.colors.success.text,
      };
    case 'danger':
      return {
        bg: theme.colors.danger.bg,
        border: theme.colors.danger.border,
        textTone: 'danger',
        textColor: theme.colors.danger.text,
      };
  }
}

type SizeFn = (t: ReturnType<typeof useTheme>) => {
  paddingHorizontal: number;
  paddingVertical: number;
  textVariant: 'caption' | 'body' | 'subtitle';
};

const SIZE: Record<AppButtonSize, SizeFn> = {
  sm: () => ({ paddingHorizontal: 14, paddingVertical: 6, textVariant: 'caption' }),
  md: () => ({ paddingHorizontal: 18, paddingVertical: 10, textVariant: 'body' }),
  lg: () => ({ paddingHorizontal: 22, paddingVertical: 14, textVariant: 'subtitle' }),
};

const styles = StyleSheet.create({
  base: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
