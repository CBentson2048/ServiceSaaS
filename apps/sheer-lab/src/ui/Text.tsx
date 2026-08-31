import type React from 'react';
import { StyleSheet, Text as RNText, type StyleProp, type TextProps, type TextStyle } from 'react-native';

import { theme } from '../theme/theme';
import { numericStyle, type TypeToken } from '../theme/tokens';

export type TextTone = 'primary' | 'secondary' | 'muted' | 'faint' | 'brand' | 'success' | 'warning' | 'danger' | 'onBrand';

export interface LabTextProps extends Omit<TextProps, 'style'> {
  /** A role from the type ramp. Defaults to `body`. */
  variant?: TypeToken;
  /** Semantic colour. Defaults to `primary`. */
  tone?: TextTone;
  /**
   * Renders digits with a fixed advance width. Set this on any number that
   * updates live (scale readout, totals, timers) so it doesn't jitter as the
   * digits change.
   */
  numeric?: boolean;
  align?: TextStyle['textAlign'];
  style?: StyleProp<TextStyle>;
  children?: React.ReactNode;
}

const toneColor: Record<TextTone, string> = {
  primary: theme.colors.textPrimary,
  secondary: theme.colors.textSecondary,
  muted: theme.colors.textMuted,
  faint: theme.colors.textFaint,
  brand: theme.colors.primary,
  success: theme.colors.successText,
  warning: theme.colors.warningText,
  danger: theme.colors.dangerText,
  onBrand: theme.colors.onPrimaryStrong,
};

/**
 * Themed text.
 *
 * Every `<Text>` in QLAB currently carries its own `fontSize` / `fontWeight` /
 * `letterSpacing` / `color` quartet, which is how the app ended up with 18
 * distinct font sizes and six weights. Naming the role instead
 * (`variant="sectionTitle"`) keeps the ramp closed.
 *
 * ```tsx
 * <Text variant="overline" tone="brand">BLE Scale</Text>
 * <Text variant="numericXl" numeric>{grams.toFixed(1)}</Text>
 * ```
 */
export function Text({
  variant = 'body',
  tone = 'primary',
  numeric = false,
  align,
  style,
  children,
  ...rest
}: LabTextProps): React.JSX.Element {
  return (
    <RNText
      style={[
        theme.type[variant] as TextStyle,
        { color: toneColor[tone] },
        numeric && numericStyle,
        align != null && { textAlign: align },
        style,
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
}

/**
 * Convenience wrappers. These exist so a screen reads as structure
 * (`<Title>`, `<Overline>`) rather than as styling.
 */
export function Title(props: Omit<LabTextProps, 'variant'>): React.JSX.Element {
  return <Text variant="title" {...props} />;
}

export function Overline(props: Omit<LabTextProps, 'variant' | 'tone'> & { tone?: TextTone }): React.JSX.Element {
  return <Text variant="overline" tone={props.tone ?? 'muted'} {...props} />;
}

export function Body(props: Omit<LabTextProps, 'variant'>): React.JSX.Element {
  return <Text variant="body" {...props} />;
}

export function Caption(props: Omit<LabTextProps, 'variant' | 'tone'> & { tone?: TextTone }): React.JSX.Element {
  return <Text variant="caption" tone={props.tone ?? 'muted'} {...props} />;
}

export const textStyles = StyleSheet.create({
  /** Truncation helper for values that must stay on one line in a table cell. */
  ellipsis: { flexShrink: 1 },
});
