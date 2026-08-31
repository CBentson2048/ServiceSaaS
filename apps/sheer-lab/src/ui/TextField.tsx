import type React from 'react';
import { useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { theme } from '../theme/theme';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  /** Visible field label. Also becomes the accessible name. */
  label?: string;
  /** Helper text below the field. Replaced by `error` when one is present. */
  hint?: string;
  /** Error message. Switches the field to the danger tone. */
  error?: string;
  /** Leading icon inside the field — e.g. `search` on a filter input. */
  icon?: IconName;
  /** Trailing adornment: a unit suffix ("g", "%"), a clear button, a picker. */
  suffix?: React.ReactNode;
  /** Right-aligns the value. Use for numeric entry so decimals line up. */
  numeric?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}

/**
 * A themed text field.
 *
 * Replaces the ~10 bare `TextInput`s across the app, each of which carried its
 * own border, radius, padding and `placeholderTextColor`, and none of which had
 * a focus state — so there was no visual indication of which field had the
 * keyboard.
 */
export function TextField({
  label,
  hint,
  error,
  icon,
  suffix,
  numeric = false,
  containerStyle,
  editable = true,
  onFocus,
  onBlur,
  ...rest
}: TextFieldProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const invalid = Boolean(error);

  return (
    <View style={[styles.container, containerStyle]}>
      {label ? (
        <Text variant="label" tone="secondary">
          {label}
        </Text>
      ) : null}

      <View
        style={[
          styles.field,
          focused && styles.fieldFocused,
          invalid && styles.fieldInvalid,
          !editable && styles.fieldDisabled,
        ]}
      >
        {icon ? <Icon name={icon} size="sm" tone={focused ? 'brand' : 'muted'} /> : null}

        <TextInput
          accessibilityLabel={label}
          editable={editable}
          placeholderTextColor={theme.colors.inputPlaceholder}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, numeric && styles.inputNumeric]}
          {...rest}
        />

        {suffix ? <View style={styles.suffix}>{suffix}</View> : null}
      </View>

      {error ? (
        <Text variant="caption" tone="danger">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: theme.spacing.xs },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: theme.touchTarget.base,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.inputLg,
    borderWidth: theme.hairline,
    borderColor: theme.colors.inputBorder,
    backgroundColor: theme.colors.inputBg,
  },
  // A visible focus ring: the current inputs give no indication of which field
  // holds the keyboard, which is disorienting on a large iPad form.
  fieldFocused: { borderColor: theme.colors.inputBorderFocus, borderWidth: 2 },
  fieldInvalid: { borderColor: theme.colors.dangerBorder },
  fieldDisabled: { opacity: theme.disabledOpacity },
  input: {
    flex: 1,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.textPrimary,
    ...theme.type.body,
  },
  inputNumeric: { textAlign: 'right', ...theme.numericStyle },
  suffix: { flexShrink: 0 },
});
