import type React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { labTheme as theme } from '../theme/labTheme';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export interface CardProps {
  children?: React.ReactNode;
  /**
   * Surface level. `surface` (default) sits on the page canvas; `raised` sits
   * on top of another card. Don't nest past `raised` — a third step has too
   * little contrast left against the canvas to read as depth.
   */
  level?: 'surface' | 'raised';
  /** Removes the internal padding, for cards whose content is a full-bleed list or table. */
  flush?: boolean;
  /** Draws the card in the brand colour — reserve for one feature card per screen. */
  accent?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The standard panel.
 *
 * Structure on a dark canvas comes from the surface stepping lighter plus a
 * hairline border — not from shadow, which barely registers at these values.
 */
export function Card({ children, level = 'surface', flush = false, accent = false, style }: CardProps): React.JSX.Element {
  return (
    <View
      style={[
        styles.card,
        level === 'raised' ? styles.raised : styles.surface,
        accent && styles.accent,
        !flush && styles.padded,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface CardHeaderProps {
  title: string;
  /** Uppercase eyebrow above the title. */
  overline?: string;
  /** Supporting line below the title. */
  subtitle?: string;
  /** Leading icon, rendered in a tinted square. */
  icon?: IconName;
  /** Count badge shown after the title — replaces the ad-hoc `countBadge` styles. */
  count?: number;
  /** Trailing content: a pill, a button, a menu. */
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Card header: optional icon, an overline/title/subtitle stack, and a trailing
 * action slot.
 *
 * Replaces `SectionHeading`, `cardHeaderRow`, `panelHead`, `sectionHead` and
 * `headerRow` — five near-identical hand-rolled headers across the screens,
 * each with slightly different spacing and title sizing.
 */
export function CardHeader({
  title,
  overline,
  subtitle,
  icon,
  count,
  action,
  style,
}: CardHeaderProps): React.JSX.Element {
  return (
    <View style={[styles.header, style]}>
      {icon ? (
        <View style={styles.headerIcon}>
          <Icon name={icon} size="base" tone="brand" />
        </View>
      ) : null}

      <View style={styles.headerText}>
        {overline ? <Text variant="overline" tone="brand">{overline}</Text> : null}
        <View style={styles.titleRow}>
          <Text variant="sectionTitle" numberOfLines={1} style={styles.titleFlex}>
            {title}
          </Text>
          {count != null ? (
            <View style={styles.countBadge}>
              <Text variant="micro" tone="brand" numeric>
                {count}
              </Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text variant="bodySm" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>

      {action ? <View style={styles.headerAction}>{action}</View> : null}
    </View>
  );
}

/** A hairline rule between sections of a card. */
export function Divider({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return <View style={[styles.divider, style]} />;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.cardLg,
    borderWidth: theme.hairline,
    gap: theme.spacing.md,
    ...theme.elevation.card,
  },
  padded: { padding: theme.spacing.lg },
  surface: { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
  raised: { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.divider },
  accent: { backgroundColor: theme.colors.hero, borderColor: theme.colors.heroBorder },

  header: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.input,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primarySoft,
  },
  headerText: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  titleFlex: { flexShrink: 1 },
  countBadge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerAction: { flexShrink: 0 },

  divider: { height: theme.hairline, backgroundColor: theme.colors.divider },
});
