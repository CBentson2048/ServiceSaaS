import { Text, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';

export type AppTextVariant =
  | 'display'
  | 'heading'
  | 'title'
  | 'subtitle'
  | 'body'
  | 'caption'
  | 'micro';

export type AppTextWeight = 'regular' | 'medium';

export type AppTextTone =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'onPrimary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'brand';

export interface AppTextProps extends TextProps {
  variant?: AppTextVariant;
  weight?: AppTextWeight;
  tone?: AppTextTone;
  align?: TextStyle['textAlign'];
  uppercase?: boolean;
}

export function AppText(props: AppTextProps) {
  const {
    variant = 'body',
    weight = 'regular',
    tone = 'primary',
    align,
    uppercase,
    style,
    ...rest
  } = props;
  const theme = useTheme();

  const variantStyle = VARIANT_STYLE[variant](theme.typography);
  const toneColor = resolveTone(theme, tone);

  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: theme.typography.fontFamily.native,
          fontWeight: theme.typography.fontWeight[weight],
          color: toneColor,
          textAlign: align,
          textTransform: uppercase ? 'uppercase' : undefined,
          letterSpacing: uppercase ? theme.typography.letterSpacing.wide : undefined,
        },
        variantStyle,
        style,
      ]}
    />
  );
}

type TypographyShape = ReturnType<typeof useTheme>['typography'];

const VARIANT_STYLE: Record<AppTextVariant, (t: TypographyShape) => TextStyle> = {
  display: (t) => ({ fontSize: t.fontSize.display, lineHeight: t.lineHeight.display }),
  heading: (t) => ({ fontSize: t.fontSize.heading, lineHeight: t.lineHeight.heading }),
  title: (t) => ({ fontSize: t.fontSize.title, lineHeight: t.lineHeight.title }),
  subtitle: (t) => ({ fontSize: t.fontSize.subtitle, lineHeight: t.lineHeight.subtitle }),
  body: (t) => ({ fontSize: t.fontSize.body, lineHeight: t.lineHeight.body }),
  caption: (t) => ({ fontSize: t.fontSize.caption, lineHeight: t.lineHeight.caption }),
  micro: (t) => ({ fontSize: t.fontSize.micro, lineHeight: t.lineHeight.micro }),
};

function resolveTone(theme: ReturnType<typeof useTheme>, tone: AppTextTone): string {
  switch (tone) {
    case 'primary':
      return theme.colors.textPrimary;
    case 'secondary':
      return theme.colors.textSecondary;
    case 'muted':
      return theme.colors.textMuted;
    case 'onPrimary':
      return theme.colors.textOnPrimary;
    case 'success':
      return theme.colors.success.text;
    case 'warning':
      return theme.colors.warning.text;
    case 'danger':
      return theme.colors.danger.text;
    case 'brand':
      return theme.colors.primary;
  }
}
