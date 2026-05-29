import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';
import type { PublicBookingAvailabilitySlot } from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { totalPrice, useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDuration, formatMoney } from '../../src/booking/bookingStyles';

export default function BookingDateTimeScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();
  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);

  const location = draft.location;
  const dateRange = useMemo(() => nextFourWeeks(), []);

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

  // Default the active day to the first day that actually has availability, and
  // re-sync if the loaded availability no longer contains the active day.
  useEffect(() => {
    if (days.length === 0) {
      setActiveDay(null);
      return;
    }
    setActiveDay((current) =>
      current && days.some((day) => day.key === current) ? current : days[0].key,
    );
  }, [days]);

  const activeSlots = useMemo(
    () => days.find((day) => day.key === activeDay)?.slots ?? [],
    [days, activeDay],
  );

  if (!location) return <Redirect href="/booking/location" />;
  if (draft.services.length === 0) return <Redirect href="/booking/services" />;

  const selected = draft.selectedSlot;
  const monthLabel = monthHeading(days, activeDay);

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header (matches services / profile pages) ── */}
        <View style={s.header}>
          <Pressable style={({ pressed }) => [s.headerBack, pressed && s.pressed]} onPress={() => router.back()}>
            <Text style={s.headerBackArrow}>‹</Text>
            <Text style={s.headerBackLabel}>Back</Text>
          </Pressable>
          <Text style={s.headerTitle}>Select a time</Text>
          <View style={s.headerStep}>
            <Text style={s.headerStepText}>Step 3 of 5</Text>
          </View>
        </View>
        {/* Progress underline (step 3 of 5 = 60%) */}
        <View style={s.progressTrack}>
          <View style={s.progressFill} />
        </View>

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {error ? <ErrorCard message={error} onRetry={() => void load()} /> : null}

          {loading ? (
            <Card>
              <View style={styles.loadingRow}>
                <ActivityIndicator color={palette.brand[300]} />
                <View style={styles.flex}>
                  <Text style={styles.title}>Checking availability</Text>
                  <Text style={styles.subtitle}>Loading available times...</Text>
                </View>
              </View>
            </Card>
          ) : days.length === 0 ? (
            <EmptyState title="No available times" body="Try a different stylist or service selection." />
          ) : (
            <>
              {/* ── Date selector ── */}
              <View>
                <View style={styles.sectionRow}>
                  <Text style={styles.monthLabel}>{monthLabel}</Text>
                  <Text style={styles.zoneLabel}>{timezoneLabel()}</Text>
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.dateStrip}
                >
                  {days.map((day) => (
                    <DateCell
                      key={day.key}
                      day={day}
                      selected={day.key === activeDay}
                      onPress={() => setActiveDay(day.key)}
                    />
                  ))}
                </ScrollView>
              </View>

              {/* ── Available slots ── */}
              <View style={s.sectionGap}>
                <View style={styles.sectionRow}>
                  <Text style={styles.blockHeading}>Available slots</Text>
                  <Text style={styles.slotStylist}>
                    {activeSlots.length} time{activeSlots.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <View style={s.slotList}>
                  {activeSlots.map((slot) => (
                    <SlotRow
                      key={`${slot.staffProfileId}:${slot.startAt}`}
                      slot={slot}
                      selected={
                        selected?.startAt === slot.startAt && selected.staffProfileId === slot.staffProfileId
                      }
                      onPress={() => updateDraft({ selectedSlot: slot })}
                    />
                  ))}
                </View>
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
                {formatMoney(totalPrice(draft.services), location.currencyCode)}
              </Text>
            </View>
          </View>
          <AppButton
            label="Confirm and Continue"
            disabled={!selected}
            onPress={() => router.push('/booking/review')}
          />
        </SafeAreaView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Date strip cell ─────────────────────────────────────────────────────────────

function DateCell({
  day,
  selected,
  onPress,
}: {
  day: DayGroup;
  selected: boolean;
  onPress: () => void;
}) {
  const date = new Date(day.key);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.dateCell, selected && styles.dateCellSelected, pressed && s.pressed]}
    >
      <Text style={[styles.dateDow, selected && styles.dateDowSelected]}>
        {date.toLocaleDateString(undefined, { weekday: 'short' })}
      </Text>
      <Text style={styles.dateDay}>{date.getDate()}</Text>
      <View style={[styles.dateDot, selected && styles.dateDotSelected]} />
    </Pressable>
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
        <Text style={styles.slotStart}>{formatTime(slot.startAt)}</Text>
        <Text style={styles.slotEnd}>{formatTime(slot.endAt)}</Text>
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
  const date = new Date(slot.startAt);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthHeading(days: DayGroup[], activeDay: string | null): string {
  const key = activeDay ?? days[0]?.key;
  if (!key) return '';
  return new Date(key).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function slotMinutes(slot: PublicBookingAvailabilitySlot): number {
  return Math.max(0, Math.round((new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime()) / 60_000));
}

function selectedSummary(slot: PublicBookingAvailabilitySlot): string {
  const date = new Date(slot.startAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${date}, ${formatTime(slot.startAt)}`;
}

function nextFourWeeks(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 28);
  return { from: from.toISOString(), to: to.toISOString() };
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

const BG = '#18141F';
const BORDER_MED = 'rgba(255,255,255,0.11)';
const BRAND = palette.brand[500];
const BRAND_LIGHT = palette.brand[300];

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    backgroundColor: BG,
  },
  headerBack: { flexDirection: 'row', alignItems: 'center', gap: 1, minWidth: 84 },
  headerBackArrow: { color: BRAND_LIGHT, fontSize: 28, lineHeight: 30, fontWeight: '300', marginTop: -2 },
  headerBackLabel: { color: BRAND_LIGHT, fontSize: 15, fontWeight: '600' },
  headerTitle: { color: palette.white, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  headerStep: { minWidth: 84, alignItems: 'flex-end' },
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
