import { Text, type TextProps, type TextStyle } from 'react-native';
import { labTheme } from './labTheme';

type LabTextVariant = 'display' | 'heading' | 'title' | 'body' | 'caption' | 'micro';
type LabTextTone = 'primary' | 'secondary' | 'muted' | 'brand' | 'success' | 'warning' | 'danger';

interface LabTextProps extends TextProps {
  variant?: LabTextVariant;
  tone?: LabTextTone;
  weight?: 'regular' | 'medium' | 'bold';
  align?: TextStyle['textAlign'];
}

export function LabText({
  variant = 'body',
  tone = 'primary',
  weight = 'regular',
  align,
  style,
  ...textProps
}: LabTextProps) {
  return (
    <Text
      {...textProps}
      style={[
        {
          color: TONES[tone],
          fontFamily: labTheme.typography.fontFamily.native,
          fontWeight: WEIGHTS[weight],
          textAlign: align,
        },
        VARIANTS[variant],
        style,
      ]}
    />
  );
}

const VARIANTS: Record<LabTextVariant, TextStyle> = {
  display: { fontSize: 36, lineHeight: 42 },
  heading: { fontSize: 28, lineHeight: 34 },
  title: { fontSize: 20, lineHeight: 26 },
  body: { fontSize: 16, lineHeight: 23 },
  caption: { fontSize: 13, lineHeight: 18 },
  micro: { fontSize: 11, lineHeight: 14, letterSpacing: 0.8, textTransform: 'uppercase' },
};

const TONES: Record<LabTextTone, string> = {
  primary: labTheme.colors.textPrimary,
  secondary: labTheme.colors.textSecondary,
  muted: labTheme.colors.textMuted,
  brand: labTheme.colors.primary,
  success: labTheme.colors.success.text,
  warning: labTheme.colors.warning.text,
  danger: labTheme.colors.danger.text,
};

const WEIGHTS: Record<NonNullable<LabTextProps['weight']>, TextStyle['fontWeight']> = {
  regular: '400',
  medium: '600',
  bold: '700',
};
