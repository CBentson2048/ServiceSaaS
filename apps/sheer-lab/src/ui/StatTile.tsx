import type React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { labTheme as theme, tone as resolveTone, type Tone } from '../theme/labTheme';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export interface StatTileProps {
  label: string;
  value: string;
  /** Supporting line under the value — the unit, comparison or qualifier. */
  hint?: string;
  /** Colours the value. Defaults to neutral (plain white). */
  tone?: Tone;
  /** Leading icon in a tinted square. */
  icon?: IconName;
  /** A trend indicator drawn beside the hint. */
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
  /** Fills available width in a row of tiles. */
  flexible?: boolean;
  /** Size of the value text. `lg` for a hero metric, `md` (default) for a KPI strip. */
  size?: 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

/**
 * A single metric.
 *
 * Consolidates `StatTile` (Home), `StatTile` (MixFinalized), `KpiCard`
 * (Inventory), `MiniStat` (Home) and `MetricsRow` (History) — five takes on the
 * same label/value/hint block.
 *
 * The value is always rendered with tabular figures so a KPI strip doesn't
 * shift horizontally when the numbers change on refresh.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  trend,
  flexible = false,
  size = 'md',
  style,
}: StatTileProps): React.JSX.Element {
  const palette = resolveTone(tone);
  const valueColor = tone === 'neutral' ? theme.colors.textPrimary : palette.text;

  return (
    <View style={[styles.tile, flexible && styles.flex, style]}>
      <View style={styles.head}>
        {icon ? (
          <View style={styles.iconWrap}>
            <Icon name={icon} size="sm" tone="brand" />
          </View>
        ) : null}
        <Text variant="overline" tone="muted" numberOfLines={1} style={styles.labelFlex}>
          {label}
        </Text>
      </View>

      <Text variant={size === 'lg' ? 'numericLg' : 'numeric'} numeric style={{ color: valueColor }} numberOfLines={1}>
        {value}
      </Text>

      {hint || trend ? (
        <View style={styles.foot}>
          {trend ? (
            <Icon
              name={trend.direction === 'down' ? 'arrowDown' : trend.direction === 'up' ? 'trendUp' : 'minus'}
              size="xs"
              tone={trend.direction === 'down' ? 'danger' : trend.direction === 'up' ? 'success' : 'muted'}
            />
          ) : null}
          <Text variant="caption" tone="muted" numberOfLines={1} style={styles.labelFlex}>
            {trend?.label ?? hint}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Lays stat tiles out in a wrapping row with even spacing. */
export function StatRow({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  tile: {
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
    borderRadius: theme.radius.card,
    borderWidth: theme.hairline,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceRaised,
    minWidth: 140,
  },
  flex: { flex: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  labelFlex: { flexShrink: 1 },
  iconWrap: {
    width: 24,
    height: 24,
    borderRadius: theme.radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primarySoft,
  },
  foot: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs },
});
