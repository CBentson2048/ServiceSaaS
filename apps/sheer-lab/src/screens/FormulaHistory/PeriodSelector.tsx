import type React from 'react';
import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LabCustomRange, LabPeriod } from '../../features/analytics/period';
import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';

const T = labTheme;
const C = T.colors;

const TABS: Array<{ id: LabPeriod; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'Month' },
  { id: 'custom', label: 'Custom' },
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface PeriodSelectorProps {
  period: LabPeriod;
  onPeriodChange: (next: LabPeriod) => void;
  customRange: LabCustomRange;
  onCustomRangeChange: (next: LabCustomRange) => void;
}

export function PeriodSelector({
  period,
  onPeriodChange,
  customRange,
  onCustomRangeChange,
}: PeriodSelectorProps): React.JSX.Element {
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const today = todayYmd();

  return (
    <View style={styles.wrap}>
      <View style={styles.tabs}>
        {TABS.map((tab) => {
          const active = tab.id === period;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onPeriodChange(tab.id)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {period === 'custom' ? (
        <View style={styles.customRow}>
          <DateField label="From" value={customRange.from} onPress={() => setPicker('from')} />
          <Text style={styles.customTo}>to</Text>
          <DateField label="To" value={customRange.to} onPress={() => setPicker('to')} />
        </View>
      ) : null}

      <CalendarModal
        // Remount per field so the grid re-seeds to the relevant month.
        key={picker ?? 'none'}
        visible={picker !== null}
        title={picker === 'to' ? 'Select end date' : 'Select start date'}
        value={picker === 'to' ? customRange.to : customRange.from}
        // Keep the range coherent: the start can't be after the end, the end
        // can't be before the start, and neither can be in the future.
        min={picker === 'to' ? customRange.from || undefined : undefined}
        max={picker === 'to' ? today : customRange.to || today}
        onClose={() => setPicker(null)}
        onSelect={(ymd) => {
          if (picker === 'to') onCustomRangeChange({ from: customRange.from, to: ymd });
          else onCustomRangeChange({ from: ymd, to: customRange.to });
          setPicker(null);
        }}
      />
    </View>
  );
}

function DateField({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.dateField}>
      <Text style={styles.dateFieldLabel}>{label}</Text>
      <Text style={[styles.dateFieldValue, !value && styles.dateFieldPlaceholder]}>
        {value ? formatHuman(value) : 'Pick a date'}
      </Text>
    </Pressable>
  );
}

function CalendarModal({
  visible,
  title,
  value,
  min,
  max,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  value: string;
  min?: string;
  max?: string;
  onSelect: (ymd: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  // The month the grid is showing. Seeds from the current value, else the max
  // bound, else today — so the picker opens near the relevant dates. The parent
  // remounts this modal per field (via `key`), so seeding once is enough.
  const [cursor, setCursor] = useState(() => firstOfMonth(value || max || todayYmd()));

  const cells = useMemo(() => buildMonthCells(cursor), [cursor]);
  // Never page past the month containing the max bound (default: today).
  const canNext = cursor < firstOfMonth(max ?? todayYmd());

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.calendarCard} onPress={() => {}}>
          <View style={styles.calendarHead}>
            <Text style={styles.calendarTitle}>{title}</Text>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onClose}>
              <Text style={styles.calendarClose}>Done</Text>
            </Pressable>
          </View>

          <View style={styles.monthNav}>
            <Pressable
              accessibilityLabel="Previous month"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setCursor(addMonths(cursor, -1))}
              style={styles.monthArrow}
            >
              <Icon name="chevronLeft" size={18} tone="primary" />
            </Pressable>
            <Text style={styles.monthLabel}>
              {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
            </Text>
            <Pressable
              accessibilityLabel="Next month"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => canNext && setCursor(addMonths(cursor, 1))}
              style={[styles.monthArrow, !canNext && styles.monthArrowDisabled]}
            >
              <Icon name="chevronRight" size={18} tone="primary" />
            </Pressable>
          </View>

          <View style={styles.weekRow}>
            {WEEKDAYS.map((day) => (
              <Text key={day} style={styles.weekday}>
                {day}
              </Text>
            ))}
          </View>

          <ScrollView style={styles.grid} contentContainerStyle={styles.gridContent}>
            <View style={styles.gridRows}>
              {cells.map((cell, index) => {
                if (cell === null) {
                  // eslint-disable-next-line react/no-array-index-key
                  return <View key={`blank-${index}`} style={styles.dayCell} />;
                }
                const disabled = (min && cell < min) || (max && cell > max);
                const selected = cell === value;
                return (
                  <Pressable
                    key={cell}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: Boolean(disabled) }}
                    disabled={Boolean(disabled)}
                    onPress={() => onSelect(cell)}
                    style={[styles.dayCell, selected && styles.dayCellSelected]}
                  >
                    <Text
                      style={[
                        styles.dayText,
                        selected && styles.dayTextSelected,
                        disabled && styles.dayTextDisabled,
                      ]}
                    >
                      {Number(cell.slice(8, 10))}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// --- date helpers (dependency-free, local time) ----------------------------

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayYmd(): string {
  return ymd(new Date());
}

function firstOfMonth(source: string): Date {
  const base = source ? new Date(`${source}T00:00:00`) : new Date();
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

/** Month grid as 'YYYY-MM-DD' strings, Monday-first, padded with leading nulls. */
function buildMonthCells(monthStart: Date): Array<string | null> {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const leading = (monthStart.getDay() + 6) % 7; // Monday = 0
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let day = 1; day <= days; day += 1) cells.push(`${year}-${pad(month + 1)}-${pad(day)}`);
  return cells;
}

function formatHuman(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const styles = StyleSheet.create({
  wrap: { gap: T.spacing.sm },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: T.spacing.xs },
  tab: {
    paddingVertical: T.spacing.xs,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
  },
  tabActive: { borderColor: C.primary, backgroundColor: C.primarySoft },
  tabLabel: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  tabLabelActive: { color: C.primary },

  customRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  customTo: { color: C.textMuted, fontSize: 12 },
  dateField: {
    flex: 1,
    minWidth: 120,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.inputLg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    backgroundColor: C.inputBg,
    gap: 2,
  },
  dateFieldLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  dateFieldValue: { color: C.textPrimary, fontSize: 14, fontWeight: '700' },
  dateFieldPlaceholder: { color: C.textMuted, fontWeight: '500' },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: T.spacing.lg,
  },
  calendarCard: {
    width: '100%',
    maxWidth: 360,
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderRadius: T.radius.cardLg,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  calendarHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  calendarTitle: { color: C.textPrimary, fontSize: 16, fontWeight: '800' },
  calendarClose: { color: C.primary, fontSize: 14, fontWeight: '800' },
  monthNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monthArrow: {
    width: 36,
    height: 36,
    borderRadius: T.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.border,
  },
  monthArrowDisabled: { opacity: 0.35 },
  monthLabel: { color: C.textPrimary, fontSize: 15, fontWeight: '800' },
  weekRow: { flexDirection: 'row' },
  weekday: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    color: C.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  grid: { maxHeight: 264 },
  gridContent: {},
  gridRows: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: T.radius.full,
  },
  dayCellSelected: { backgroundColor: C.primary },
  dayText: { color: C.textPrimary, fontSize: 14, fontWeight: '600' },
  dayTextSelected: { color: C.textOnPrimary, fontWeight: '800' },
  dayTextDisabled: { color: C.textMuted, opacity: 0.4 },
});
