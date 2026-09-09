import { StyleSheet, Text, View } from 'react-native';
import { spacing } from '@sheer/design-tokens';
import { TEXT, TEXT_MUTED } from '../colors';

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
}

/**
 * A heading for a section WITHIN a page.
 *
 * Absorbed from `@sheer/ui-mobile`. Note what it is not: it is not a screen
 * title. Several screens were using it as one, which is why Alerts showed a
 * big left-aligned "Alerts" while Profile showed a centred one and Rota showed
 * both a native "Rota" and its own "My week". A screen's title belongs in
 * `ScreenHeader`; this labels a block of content underneath.
 */
export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
  return (
    <View style={s.wrap}>
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: spacing.xs },
  title: { color: TEXT, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
  subtitle: { color: TEXT_MUTED, fontSize: 14 },
});
