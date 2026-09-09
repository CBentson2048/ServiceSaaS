import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';
import type { PublicBookingAvailabilitySlot, PublicBookingStylistSummary } from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { effectiveServices, totalPrice, useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDuration, formatMoney } from '../../src/booking/bookingStyles';
import { ScreenHeader } from '../../src/navigation/ScreenHeader';
import { BG, BRAND } from '../../src/design/colors';

export default function BookingDateTimeScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();
  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  // Per-stylist pricing for the bookable stylists, so the picked slot's stylist
  // re-prices the services to match what the server will charge.
  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The day whose time slots are shown in the list below the strip.
  const [activeDay, setActiveDay] = useState<string | null>(null);
  // Anchors the Mon–Sun week strip (and drives the month/year label). Never null.
  const [weekAnchor, setWeekAnchor] = useState<string>(() => toIsoDate(new Date()));
  // The full-calendar modal and the month it is browsing (independent of the strip).
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<MonthRef>(() => monthRefOf(new Date()));

  const location = draft.location;
  // Per-stylist prices once a specific stylist is selected; base prices otherwise.
  const pricedServices = useMemo(() => effectiveServices(draft), [draft]);
  const today = useMemo(() => startOfToday(), []);
  const currentMonthIndex = monthIndex(today.getFullYear(), today.getMonth());

  const anchorDate = useMemo(() => parseIsoDate(weekAnchor), [weekAnchor]);
  // While the calendar is open we fetch the month it is browsing; otherwise the
  // month the week strip is sitting in. Keeping a single fetch driver keeps the
  // availability dots in sync with whatever the client is looking at.
  const fetchMonth: MonthRef = calendarOpen
    ? calMonth
    : { year: anchorDate.getFullYear(), month: anchorDate.getMonth() };
  const dateRange = useMemo(
    () => monthFetchRange(fetchMonth.year, fetchMonth.month),
    [fetchMonth.year, fetchMonth.month],
  );

  const load = useCallback(async () => {
    if (!accessToken || !location || draft.services.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMobileBookingAvailability(accessToken, {
        locationId: location.id,
        serviceIds: draft.services.map((service) => service.id),
        stylistId: draft.staffRequestMode === 'specific_staff' ? draft.stylist?.staffProfileId : undefined,
        nextAvailable: draft.staffRequestMode === 'next_available',
        dateFrom: dateRange.from,
        dateTo: dateRange.to,
      });
      // Keep the server-driven slot logic intact (15-min granularity, capability
      // and rota checks all happen API-side). We just cap the client list.
      setSlots(result.slots.slice(0, 240));
      setStylists(result.stylists ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load available times');
    } finally {
      setLoading(false);
    }
  }, [accessToken, dateRange, draft.services, draft.staffRequestMode, draft.stylist, location]);

  useEffect(() => {
    void load();
  }, [load]);

  // Group available slots by calendar day so we can drive the date strip and
  // only show the times for the day the client is looking at.
  const days = useMemo(() => groupByDay(slots), [slots]);
  const availableByDay = useMemo(() => {
    const map = new Map<string, DayGroup>();
    for (const day of days) map.set(day.key, day);
    return map;
  }, [days]);

  // Keep the active day in sync with the loaded month: if nothing is selected (or
  // the selection no longer exists, e.g. after a month change) snap to the soonest
  // available day *within the viewed month* and pull the strip onto its week. We
  // ignore the adjacent-month days the fetch pads in (so pressing › can't bounce
  // the view back a month). Skipped while the full calendar is open so navigating
  // months there does not move the strip.
  useEffect(() => {
    if (calendarOpen) return;
    if (activeDay && availableByDay.has(activeDay)) return;
    const year = anchorDate.getFullYear();
    const month = anchorDate.getMonth();
    const firstInMonth = days.find((day) => {
      const date = parseIsoDate(day.key);
      return date.getFullYear() === year && date.getMonth() === month;
    });
    if (firstInMonth) {
      setActiveDay(firstInMonth.key);
      setWeekAnchor(firstInMonth.key);
    } else {
      setActiveDay(null);
    }
  }, [days, availableByDay, activeDay, calendarOpen, anchorDate]);

  const weekDays = useMemo(() => buildWeek(weekAnchor), [weekAnchor]);
  const monthLabel = monthYearLabel(anchorDate);
  const canGoPrevMonth = monthIndex(anchorDate.getFullYear(), anchorDate.getMonth()) > currentMonthIndex;

  const activeSlots = useMemo(
    () => days.find((day) => day.key === activeDay)?.slots ?? [],
    [days, activeDay],
  );

  const goPrevMonth = useCallback(() => {
    setWeekAnchor(toIsoDate(addMonths(anchorDate, -1)));
  }, [anchorDate]);
  const goNextMonth = useCallback(() => {
    setWeekAnchor(toIsoDate(addMonths(anchorDate, 1)));
  }, [anchorDate]);
  const selectDay = useCallback((key: string) => {
    setActiveDay(key);
    setWeekAnchor(key);
  }, []);
  const openCalendar = useCallback(() => {
    setCalMonth({ year: anchorDate.getFullYear(), month: anchorDate.getMonth() });
    setCalendarOpen(true);
  }, [anchorDate]);
  const pickCalendarDay = useCallback((key: string) => {
    setActiveDay(key);
    setWeekAnchor(key);
    setCalendarOpen(false);
  }, []);

  if (!location) return <Redirect href="/booking/location" />;
  if (draft.services.length === 0) return <Redirect href="/booking/services" />;

  const selected = draft.selectedSlot;
  // Only show the full-screen loading card on the very first load, so month
  // navigation keeps the nav arrows / strip on screen while it refreshes.
  const firstLoad = loading && days.length === 0;

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header (matches services / profile pages) ── */}
        <ScreenHeader
          title="Select a time"
          divider={false}
          right={<Text style={s.headerStepText}>Step 3 of 5</Text>}
        />
        {/* Progress underline (step 3 of 5 = 60%) */}
        <View style={s.progressTrack}>
          <View style={s.progressFill} />
        </View>

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {error ? <ErrorCard message={error} onRetry={() => void load()} /> : null}

          {firstLoad ? (
            <Card>
              <View style={styles.loadingRow}>
                <ActivityIndicator color={palette.brand[300]} />
                <View style={styles.flex}>
                  <Text style={styles.title}>Checking availability</Text>
                  <Text style={styles.subtitle}>Loading available times...</Text>
                </View>
              </View>
            </Card>
          ) : (
            <>
              {/* ── Date selector ── */}
              <View>
                {/* Month / year with prev–next month navigation; tap the label for a full calendar. */}
                <View style={styles.calNav}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Previous month"
                    disabled={!canGoPrevMonth}
                    onPress={goPrevMonth}
                    style={({ pressed }) => [
                      styles.calNavBtn,
                      !canGoPrevMonth && styles.calNavBtnDisabled,
                      pressed && canGoPrevMonth && s.pressed,
                    ]}
                  >
                    <Text style={styles.calNavArrow}>‹</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open calendar"
                    onPress={openCalendar}
                    style={({ pressed }) => [styles.calMonthBtn, pressed && s.pressed]}
                  >
                    <Text style={styles.monthLabel}>{monthLabel}</Text>
                    <Text style={styles.calMonthCaret}>▾</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Next month"
                    onPress={goNextMonth}
                    style={({ pressed }) => [styles.calNavBtn, pressed && s.pressed]}
                  >
                    <Text style={styles.calNavArrow}>›</Text>
                  </Pressable>
                </View>

                {/* Mon–Sun week containing the selected date. */}
                <View style={styles.weekStrip}>
                  {weekDays.map((date) => {
                    const key = toIsoDate(date);
                    const available = availableByDay.has(key);
                    const past = date < today;
                    return (
                      <DateCell
                        key={key}
                        date={date}
                        available={available}
                        disabled={past || !available}
                        selected={key === activeDay}
                        onPress={() => selectDay(key)}
                      />
                    );
                  })}
                </View>
                <Text style={styles.zoneLabel}>{timezoneLabel()}</Text>
              </View>

              {/* ── Available slots ── */}
              <View style={s.sectionGap}>
                <View style={styles.sectionRow}>
                  <Text style={styles.blockHeading}>Available slots</Text>
                  <Text style={styles.slotStylist}>
                    {activeSlots.length} time{activeSlots.length === 1 ? '' : 's'}
                  </Text>
                </View>
                {loading ? (
                  <View style={styles.updatingRow}>
                    <ActivityIndicator color={palette.brand[300]} />
                    <Text style={styles.updatingText}>Updating availability…</Text>
                  </View>
                ) : days.length === 0 ? (
                  <EmptyState
                    title="No availability this month"
                    body="Try another month, or a different stylist or service selection."
                  />
                ) : activeSlots.length === 0 ? (
                  <Text style={styles.calEmptyNote}>No times left on this day. Pick another day above.</Text>
                ) : (
                  <View style={s.slotList}>
                    {activeSlots.map((slot) => (
                      <SlotRow
                        key={`${slot.staffProfileId}:${slot.startAt}`}
                        slot={slot}
                        selected={
                          selected?.startAt === slot.startAt && selected.staffProfileId === slot.staffProfileId
                        }
                        onPress={() => {
                          // Resolve the picked slot's stylist so the footer/review totals + deposit
                          // reflect that stylist's prices — what the server will actually charge.
                          const resolved = stylists.find(
                            (stylist) => stylist.staffProfileId === slot.staffProfileId,
                          );
                          updateDraft({ selectedSlot: slot, slotServicePrices: resolved?.servicePrices });
                        }}
                      />
                    ))}
                  </View>
                )}
              </View>
            </>
          )}
        </ScrollView>

        {/* ── Pinned footer (always visible, no scrolling needed) ── */}
        <SafeAreaView edges={['bottom']} style={s.footer}>
          <View style={styles.footerSummary}>
            <View style={styles.flex}>
              <Text style={styles.footerSummaryLabel}>Selected slot</Text>
              <Text style={styles.footerSummaryValue} numberOfLines={1}>
                {selected ? selectedSummary(selected) : 'Pick a time to continue'}
              </Text>
            </View>
            <View>
              <Text style={[styles.footerSummaryLabel, { textAlign: 'right' }]}>Total price</Text>
              <Text style={styles.footerPriceValue}>
                {/* Total reflects the selected stylist's prices once one is chosen. */}
                {formatMoney(totalPrice(pricedServices), location.currencyCode)}
              </Text>
            </View>
          </View>
          <AppButton
            label="Confirm and Continue"
            disabled={!selected}
            onPress={() => router.push('/booking/review')}
          />
        </SafeAreaView>

        {/* ── Full calendar (tap the month/year label to open) ── */}
        <CalendarModal
          visible={calendarOpen}
          month={calMonth}
          activeDay={activeDay}
          today={today}
          loading={loading}
          availableByDay={availableByDay}
          canGoPrev={monthIndex(calMonth.year, calMonth.month) > currentMonthIndex}
          onPrev={() => setCalMonth((m) => shiftMonth(m, -1))}
          onNext={() => setCalMonth((m) => shiftMonth(m, 1))}
          onSelect={pickCalendarDay}
          onClose={() => setCalendarOpen(false)}
        />
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Week strip cell ──────────────────────────────────────────────────────────────

function DateCell({
  date,
  available,
  disabled,
  selected,
  onPress,
}: {
  date: Date;
  available: boolean;
  disabled: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.weekCell,
        selected && styles.dateCellSelected,
        disabled && styles.dateCellDisabled,
        pressed && !disabled && s.pressed,
      ]}
    >
      <Text style={[styles.dateDow, selected && styles.dateDowSelected]}>
        {date.toLocaleDateString(undefined, { weekday: 'short' })}
      </Text>
      <Text style={styles.dateDay}>{date.getDate()}</Text>
      <View style={[styles.dateDot, !available && styles.dateDotEmpty, selected && styles.dateDotSelected]} />
    </Pressable>
  );
}

// ── Full calendar modal ──────────────────────────────────────────────────────────

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function CalendarModal({
  visible,
  month,
  activeDay,
  today,
  loading,
  availableByDay,
  canGoPrev,
  onPrev,
  onNext,
  onSelect,
  onClose,
}: {
  visible: boolean;
  month: MonthRef;
  activeDay: string | null;
  today: Date;
  loading: boolean;
  availableByDay: Map<string, DayGroup>;
  canGoPrev: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (key: string) => void;
  onClose: () => void;
}) {
  const weeks = useMemo(() => monthMatrix(month.year, month.month), [month.year, month.month]);
  const title = new Date(month.year, month.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.calBackdrop} onPress={onClose}>
        {/* Inner press is swallowed so taps inside the sheet don't dismiss it. */}
        <Pressable style={styles.calSheet} onPress={() => {}}>
          <View style={styles.calSheetHeader}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              disabled={!canGoPrev}
              onPress={onPrev}
              style={({ pressed }) => [
                styles.calNavBtn,
                !canGoPrev && styles.calNavBtnDisabled,
                pressed && canGoPrev && styles.pressed,
              ]}
            >
              <Text style={styles.calNavArrow}>‹</Text>
            </Pressable>
            <Text style={styles.calSheetTitle}>{title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next month"
              onPress={onNext}
              style={({ pressed }) => [styles.calNavBtn, pressed && styles.pressed]}
            >
              <Text style={styles.calNavArrow}>›</Text>
            </Pressable>
          </View>

          <View style={styles.calWeekHead}>
            {WEEKDAY_LABELS.map((label) => (
              <Text key={label} style={styles.calWeekHeadCell}>
                {label}
              </Text>
            ))}
          </View>

          <View style={styles.calGrid}>
            {weeks.map((week) => (
              <View key={toIsoDate(week[0])} style={styles.calRow}>
                {week.map((date) => {
                  const key = toIsoDate(date);
                  const inMonth = date.getMonth() === month.month;
                  const available = availableByDay.has(key);
                  const past = date < today;
                  const disabled = past || !available;
                  const selected = key === activeDay;
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="button"
                      disabled={disabled}
                      onPress={() => onSelect(key)}
                      style={({ pressed }) => [
                        styles.calCell,
                        selected && styles.calCellSelected,
                        pressed && !disabled && styles.pressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.calCellText,
                          (!inMonth || disabled) && styles.calCellMuted,
                          selected && styles.calCellSelectedText,
                        ]}
                      >
                        {date.getDate()}
                      </Text>
                      <View
                        style={[styles.calDot, !available && styles.dateDotEmpty, selected && styles.dateDotSelected]}
                      />
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>

          {loading ? (
            <View style={styles.updatingRow}>
              <ActivityIndicator color={palette.brand[300]} />
              <Text style={styles.updatingText}>Updating availability…</Text>
            </View>
          ) : null}

          <AppButton label="Close" variant="secondary" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Time slot row ───────────────────────────────────────────────────────────────

function SlotRow({
  slot,
  selected,
  onPress,
}: {
  slot: PublicBookingAvailabilitySlot;
  selected: boolean;
  onPress: () => void;
}) {
  const duration = slot.totalDurationMinutes
    ? formatDuration(slot.totalDurationMinutes)
    : formatDuration(slotMinutes(slot));
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.slotRow, selected && styles.slotRowSelected, pressed && s.pressed]}
    >
      <View style={styles.slotTimes}>
        <View style={styles.slotTimeRow}>
          <Text style={styles.slotTimeLabel} numberOfLines={1}>
            Start
          </Text>
          <Text style={styles.slotStart}>{formatTime(slot.startAt)}</Text>
        </View>
        <View style={styles.slotTimeRow}>
          <Text style={styles.slotTimeLabel} numberOfLines={1}>
            End
          </Text>
          <Text style={styles.slotEnd}>{formatTime(slot.endAt)}</Text>
        </View>
      </View>
      <View style={styles.slotMid}>
        <View style={styles.durationChip}>
          <Text style={styles.durationChipText}>{duration}</Text>
        </View>
        <Text style={styles.slotStylist} numberOfLines={1}>
          {slot.stylistName}
        </Text>
      </View>
      <Radio selected={selected} />
    </Pressable>
  );
}

function Radio({ selected }: { selected: boolean }) {
  return (
    <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
      {selected ? <View style={styles.radioInner} /> : null}
    </View>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <Text style={styles.title}>Availability unavailable</Text>
      <Text style={styles.error}>{message}</Text>
      <AppButton label="Try again" variant="secondary" onPress={onRetry} />
    </Card>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

interface DayGroup {
  key: string; // ISO date (YYYY-MM-DD)
  slots: PublicBookingAvailabilitySlot[];
}

interface MonthRef {
  year: number;
  month: number; // 0-indexed
}

/** Group slots into calendar days, preserving the server's chronological order. */
function groupByDay(slots: PublicBookingAvailabilitySlot[]): DayGroup[] {
  const order: string[] = [];
  const byDay = new Map<string, PublicBookingAvailabilitySlot[]>();
  for (const slot of slots) {
    const key = dayKey(slot);
    const existing = byDay.get(key);
    if (existing) {
      existing.push(slot);
    } else {
      byDay.set(key, [slot]);
      order.push(key);
    }
  }
  return order.map((key) => ({ key, slots: byDay.get(key) ?? [] }));
}

function dayKey(slot: PublicBookingAvailabilitySlot): string {
  if (slot.date) return slot.date.slice(0, 10);
  return toIsoDate(new Date(slot.startAt));
}

function slotMinutes(slot: PublicBookingAvailabilitySlot): number {
  return Math.max(0, Math.round((new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime()) / 60_000));
}

function selectedSummary(slot: PublicBookingAvailabilitySlot): string {
  const date = new Date(slot.startAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${date}, ${formatTime(slot.startAt)}`;
}

/** Availability fetch window for a month, padded out to the Mon–Sun weeks that the
 *  strip and calendar can show (so days spilling in from the adjacent month still
 *  light up). Never reaches into the past. */
function monthFetchRange(year: number, month: number): { from: string; to: string } {
  const today = startOfToday();
  let from = startOfWeekMonday(new Date(year, month, 1));
  if (from < today) from = today;
  const lastSunday = addDays(startOfWeekMonday(new Date(year, month + 1, 0)), 6);
  const to = new Date(lastSunday.getFullYear(), lastSunday.getMonth(), lastSunday.getDate(), 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The seven Mon–Sun dates of the week containing the anchor day. */
function buildWeek(anchorIso: string): Date[] {
  const monday = startOfWeekMonday(parseIsoDate(anchorIso));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Weeks (Mon–Sun rows) covering a whole month for the full-calendar grid. */
function monthMatrix(year: number, month: number): Date[][] {
  const lastDay = new Date(year, month + 1, 0);
  const weeks: Date[][] = [];
  let cursor = startOfWeekMonday(new Date(year, month, 1));
  while (cursor <= lastDay) {
    const start = cursor;
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function monthYearLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Monday of the ISO week containing `date` (local midnight). */
function startOfWeekMonday(date: Date): Date {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (local.getDay() + 6) % 7; // 0 = Mon … 6 = Sun
  local.setDate(local.getDate() - offset);
  return local;
}

function addDays(date: Date, count: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

/** First day of the month `count` months away from `date`. */
function addMonths(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

function shiftMonth(ref: MonthRef, count: number): MonthRef {
  const date = addMonths(new Date(ref.year, ref.month, 1), count);
  return { year: date.getFullYear(), month: date.getMonth() };
}

function monthRefOf(date: Date): MonthRef {
  return { year: date.getFullYear(), month: date.getMonth() };
}

function monthIndex(year: number, month: number): number {
  return year * 12 + month;
}

function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse a YYYY-MM-DD key as a *local* date (avoids the UTC shift of `new Date(iso)`). */
function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function timezoneLabel(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? `Timezone · ${zone}` : 'Local time';
  } catch {
    return 'Local time';
  }
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

// ── Screen styles ──────────────────────────────────────────────────────────────

const BORDER_MED = 'rgba(255,255,255,0.11)';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header
  headerStepText: { color: 'rgba(255,255,255,0.4)', fontSize: 13, fontWeight: '700' },

  // ── Progress underline (step 3 of 5 = 60%)
  progressTrack: { height: 3, backgroundColor: BORDER_MED },
  progressFill: { width: '60%', height: 3, backgroundColor: BRAND },

  // ── Scroll body
  scroll: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  sectionGap: { gap: spacing.md },
  slotList: { gap: spacing.md },

  // ── Pinned footer
  footer: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
    backgroundColor: BG,
  },
});
