import type React from 'react';
import { useState } from 'react';
import { StyleSheet, TextInput, type StyleProp, type TextStyle } from 'react-native';

import { parseDecimal, sanitiseDecimal } from '../../lib/decimal';
import { labTheme } from '../../theme/labTheme';

export interface DecimalInputProps {
  /** The committed number, or undefined when the field is empty. */
  value: number | undefined;
  /** Fires with the parsed number, or undefined when the field is cleared. */
  onChangeNumber: (value: number | undefined) => void;
  placeholder?: string;
  /** The field's box style. The component owns everything that must not drift. */
  style?: StyleProp<TextStyle>;
  editable?: boolean;
  accessibilityLabel?: string;
}

/**
 * A DECIMAL FIELD THAT CAN ACTUALLY ACCEPT A DECIMAL POINT.
 *
 * The bug this exists to prevent: a `decimal-pad` TextInput whose `value` is
 * derived from the parsed number, e.g.
 *
 *     onChangeText={(v) => setGrams(Number(v))}
 *     value={grams?.toString() ?? ''}
 *
 * Type "1", "." , "5" into that and you get 15. `Number('1.')` is `1`, the
 * field re-renders as "1", the point is erased the instant it is typed, and the
 * next digit lands in the units column. On the Lab screens that meant 1.5g of
 * waste being recorded as 15g, and 1.5p/g of cost as 15p/g — a tenfold error
 * with no warning, in figures that feed the colour charge.
 *
 * The fix is that the TEXT is the state and the number is derived from it, not
 * the other way round. `text` holds exactly what was typed, so "1.", "1.50" and
 * "" all survive a re-render. An external change is still adopted: if `value`
 * no longer agrees with what the text parses to, the change came from the
 * parent (a different row, a reset) and the text is replaced. Comparing the
 * PARSED text rather than the raw text is what makes both halves work at once —
 * "1." parses to 1, which still equals `value`, so it is left alone.
 *
 * Sanitisation is here rather than at the call sites because `decimal-pad` is
 * not a guarantee: it emits a locale separator in some regions, hardware and
 * Bluetooth keyboards send arbitrary characters, and it will happily send a
 * second ".".
 */
export function DecimalInput({
  value,
  onChangeNumber,
  placeholder = '0',
  style,
  editable,
  accessibilityLabel,
}: DecimalInputProps): React.JSX.Element {
  const [text, setText] = useState(() => (value == null ? '' : String(value)));

  // Derived, not synced through an effect — see the docblock.
  const display = parseDecimal(text) === value ? text : value == null ? '' : String(value);

  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      editable={editable}
      keyboardType="decimal-pad"
      onChangeText={(raw) => {
        const next = sanitiseDecimal(raw);
        setText(next);
        onChangeNumber(parseDecimal(next));
      }}
      placeholder={placeholder}
      placeholderTextColor={labTheme.colors.inputPlaceholder}
      style={[s.input, style]}
      value={display}
    />
  );
}

const s = StyleSheet.create({
  // Only the properties that must not vary. The box (height, radius, fill) is
  // the screen's, passed via `style`.
  input: { color: labTheme.colors.textPrimary },
});
