import type React from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../theme/theme';
import { Icon } from './icons';
import { Text } from './Text';

export interface Column<Row> {
  key: string;
  /** Column heading. Rendered as an overline in the header row. */
  header: string;
  /** Cell renderer. Return a `<Text>` or any node. */
  render: (row: Row) => React.ReactNode;
  /** Proportional width. Defaults to 1. */
  flex?: number;
  /** Fixed width in pt — wins over `flex`. */
  width?: number;
  align?: 'left' | 'right';
  /**
   * Hides the column below the wide breakpoint. Use for supporting detail that
   * the stacked card layout can drop.
   */
  wideOnly?: boolean;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  keyExtractor: (row: Row) => string;
  /**
   * When false the table renders as a stack of cards instead of rows — the
   * responsive fallback the History, Home and Inventory screens each improvise
   * today.
   */
  wide: boolean;
  onRowPress?: (row: Row) => void;
  /** Primary column shown as the card title in the stacked (narrow) layout. */
  titleColumnKey?: string;
  /** Rendered in place of the rows when `rows` is empty. */
  empty?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

function columnStyle<Row>(col: Column<Row>): ViewStyle {
  return {
    flex: col.width != null ? undefined : (col.flex ?? 1),
    width: col.width,
    alignItems: col.align === 'right' ? 'flex-end' : 'flex-start',
  };
}

/**
 * A responsive table.
 *
 * The dashboard, history and inventory screens each build their own
 * `tableHeader` / `tr` / `th` / `td` set plus a separate stacked-card branch for
 * narrow widths — the same logic written three times, with three different
 * header treatments. This owns both layouts.
 *
 * Rows are pressable where `onRowPress` is supplied, and carry a chevron so it
 * is visible that they lead somewhere; the current tables give no affordance
 * that a row is tappable at all.
 */
export function DataTable<Row>({
  columns,
  rows,
  keyExtractor,
  wide,
  onRowPress,
  titleColumnKey,
  empty,
  style,
}: DataTableProps<Row>): React.JSX.Element {
  const visible = wide ? columns : columns.filter((col) => !col.wideOnly);

  if (rows.length === 0 && empty) {
    return <View style={style}>{empty}</View>;
  }

  if (!wide) {
    const titleCol = columns.find((col) => col.key === titleColumnKey) ?? columns[0];
    const restCols = visible.filter((col) => col.key !== titleCol.key);

    return (
      <View style={[styles.cardStack, style]}>
        {rows.map((row) => {
          const content = (
            <>
              <View style={styles.cardTop}>
                <View style={styles.cardTitle}>{titleCol.render(row)}</View>
                {onRowPress ? <Icon name="chevronRight" size="sm" tone="muted" /> : null}
              </View>
              {restCols.map((col) => (
                <View key={col.key} style={styles.cardField}>
                  <Text variant="caption" tone="muted">
                    {col.header}
                  </Text>
                  <View style={styles.cardValue}>{col.render(row)}</View>
                </View>
              ))}
            </>
          );

          return onRowPress ? (
            <Pressable
              key={keyExtractor(row)}
              accessibilityRole="button"
              onPress={() => onRowPress(row)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              {content}
            </Pressable>
          ) : (
            <View key={keyExtractor(row)} style={styles.card}>
              {content}
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <View style={style}>
      <View style={styles.headerRow}>
        {visible.map((col) => (
          <View key={col.key} style={columnStyle(col)}>
            <Text variant="overline" tone="muted" numberOfLines={1}>
              {col.header}
            </Text>
          </View>
        ))}
        {onRowPress ? <View style={styles.chevronCell} /> : null}
      </View>

      {rows.map((row) => {
        const cells = (
          <>
            {visible.map((col) => (
              <View key={col.key} style={columnStyle(col)}>
                {col.render(row)}
              </View>
            ))}
            {onRowPress ? (
              <View style={styles.chevronCell}>
                <Icon name="chevronRight" size="sm" tone="muted" />
              </View>
            ) : null}
          </>
        );

        return onRowPress ? (
          <Pressable
            key={keyExtractor(row)}
            accessibilityRole="button"
            onPress={() => onRowPress(row)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            {cells}
          </Pressable>
        ) : (
          <View key={keyExtractor(row)} style={styles.row}>
            {cells}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: theme.hairline,
    borderBottomColor: theme.colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    borderBottomWidth: theme.hairline,
    borderBottomColor: theme.colors.divider,
    minHeight: theme.touchTarget.base,
  },
  rowPressed: { backgroundColor: theme.colors.surfaceRaised },
  chevronCell: { width: 20, alignItems: 'flex-end' },

  cardStack: { gap: theme.spacing.sm },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.card,
    borderWidth: theme.hairline,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceRaised,
  },
  pressed: { opacity: theme.pressedOpacity },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  cardTitle: { flex: 1 },
  cardField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.md },
  cardValue: { flexShrink: 1, alignItems: 'flex-end' },
});
