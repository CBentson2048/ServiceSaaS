import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing } from '@sheer/design-tokens';
import { BORDER, TEXT, TEXT_MUTED } from '../colors';

export interface EmptyStateProps {
  title: string;
  body: string;
}

/**
 * "Nothing here" — a dashed-free, quiet card rather than a bare line of text.
 * Absorbed from `@sheer/ui-mobile`.
 */
export function EmptyState({ title, body }: EmptyStateProps) {
  return (
    <View style={s.wrap}>
      <Text style={s.title}>{title}</Text>
      <Text style={s.body}>{body}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: BORDER,
  },
  title: { color: TEXT, fontSize: 17, fontWeight: '700' },
  body: { color: TEXT_MUTED, fontSize: 14, lineHeight: 20 },
});
