import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import type { PublicBookingAvailabilitySlot } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, EmptyState } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { ScreenHeader } from '../src/navigation/ScreenHeader';
import { BG, BRAND, BRAND_LIGHT } from '../src/design/colors';

// How far ahead we offer slots when rebooking. A rolling window keeps the request
// bounded; the server still owns the slot logic (rota, capability, granularity).
const WINDOW_DAYS = 35;

interface DayGroup {
  key: string; // YYYY-MM-DD
  date: Date;
  slots: PublicBookingAvailabilitySlot[];
}

export default function RescheduleScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const params = useLocalSearchParams<{
    id?: string;
    locationId?: string;
    serviceIds?: string;
    stylistId?: string;
    label?: string;
  }>();

  const appointmentId = params.id ?? '';
  const locationId = params.locationId ?? '';
  const serviceIds = useMemo(
    () => (params.serviceIds ? params.serviceIds.split(',').filter(Boolean) : []),
    [params.serviceIds],
  );
  const stylistId = params.stylistId || undefined;

  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<PublicBookingAvailabilitySlot | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !locationId || serviceIds.length === 0) {
      setError('We couldn’t start a rebooking for this appointment. Please contact the salon.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const from = new Date();
      const to = new Date();
      to.setDate(to.getDate() + WINDOW_DAYS);
      const result = await api.getMobileBookingAvailability(accessToken, {
        locationId,
        serviceIds,
        stylistId,
        nextAvailable: !stylistId,
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
      });
      setSlots(result.slots.slice(0, 240));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load available times');
    } finally {
      setLoading(false);
    }
  }, [accessToken, locationId, serviceIds, stylistId]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => groupByDay(slots), [slots]);

  // Default the open day to the soonest with availability.
  useEffect(() => {
    if (activeDay && days.some((day) => day.key === activeDay)) return;
    setActiveDay(days[0]?.key ?? null);
  }, [days, activeDay]);

  const activeSlots = useMemo(
    () => days.find((day) => day.key === activeDay)?.slots ?? [],
    [days, activeDay],
  );

  const confirm = useCallback(async () => {
    if (!accessToken || !appointmentId || !selected) return;
    setBusy(true);
    try {
      await api.rescheduleAppointment(accessToken, appointmentId, { scheduledStartAt: selected.startAt });
      Alert.alert(
        'Appointment rebooked',
        `Your appointment is now ${formatDayFull(selected.startAt)} at ${formatTime(selected.startAt)}.`,
        [{ text: 'Done', onPress: () => router.replace('/dashboard') }],
      );
    } catch (err) {
      Alert.alert('Could not rebook', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [accessToken, appointmentId, selected]);

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <ScreenHeader title="Pick a new time" />

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {params.label ? <Text style={s.subhead}>{params.label}</Text> : null}

          {error ? (
            <View style={s.card}>
              <Text style={s.cardTitle}>Availability unavailable</Text>
              <Text style={s.muted}>{error}</Text>
              <AppButton label="Try again" variant="secondary" onPress={() => void load()} />
            </View>
          ) : loading ? (
            <View style={s.loadingCard}>
              <ActivityIndicator color={palette.brand[300]} />
              <Text style={s.muted}>Checking availability…</Text>
            </View>
          ) : days.length === 0 ? (
            <EmptyState
              title="No availability"
              body="There are no open times in the next few weeks. Please contact the salon."
            />
          ) : (
            <>
              {/* Day selector */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.dayStrip}
              >
                {days.map((day) => {
                  const isActive = day.key === activeDay;
                  return (
                    <Pressable
                      key={day.key}
                      onPress={() => setActiveDay(day.key)}
                      style={({ pressed }) => [s.dayCell, isActive && s.dayCellActive, pressed && s.pressed]}
                    >
                      <Text style={[s.dayDow, isActive && s.dayActiveText]}>
                        {day.date.toLocaleDateString(undefined, { weekday: 'short' })}
                      </Text>
                      <Text style={[s.dayNum, isActive && s.dayActiveText]}>{day.date.getDate()}</Text>
                      <Text style={[s.dayMon, isActive && s.dayActiveText]}>
                        {day.date.toLocaleDateString(undefined, { month: 'short' })}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Slots for the active day */}
              <View style={s.slotList}>
                {activeSlots.length === 0 ? (
                  <Text style={s.muted}>No times left on this day. Pick another day above.</Text>
                ) : (
                  activeSlots.map((slot) => {
                    const isSelected =
                      selected?.startAt === slot.startAt && selected.staffProfileId === slot.staffProfileId;
                    return (
                      <Pressable
                        key={`${slot.staffProfileId}:${slot.startAt}`}
                        onPress={() => setSelected(slot)}
                        style={({ pressed }) => [s.slotRow, isSelected && s.slotRowSelected, pressed && s.pressed]}
                      >
                        <Text style={s.slotTime}>{formatTime(slot.startAt)}</Text>
                        <Text style={s.slotStylist} numberOfLines={1}>
                          {slot.stylistName}
                        </Text>
                        <View style={[s.radioOuter, isSelected && s.radioOuterSelected]}>
                          {isSelected ? <View style={s.radioInner} /> : null}
                        </View>
                      </Pressable>
                    );
                  })
                )}
              </View>
            </>
          )}
        </ScrollView>

        {!loading && !error && days.length > 0 ? (
          <SafeAreaView edges={['bottom']} style={s.footer}>
            <Text style={s.footerSummary} numberOfLines={1}>
              {selected ? `${formatDayFull(selected.startAt)} · ${formatTime(selected.startAt)}` : 'Pick a time to continue'}
            </Text>
            <AppButton
              label={busy ? 'Rebooking…' : 'Confirm new time'}
              disabled={!selected || busy}
              onPress={() => void confirm()}
            />
          </SafeAreaView>
        ) : null}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function groupByDay(slots: PublicBookingAvailabilitySlot[]): DayGroup[] {
  const order: string[] = [];
  const byDay = new Map<string, PublicBookingAvailabilitySlot[]>();
  for (const slot of slots) {
    const date = new Date(slot.startAt);
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const existing = byDay.get(key);
    if (existing) {
      existing.push(slot);
    } else {
      byDay.set(key, [slot]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const [y, m, d] = key.split('-').map(Number);
    return { key, date: new Date(y, m - 1, d), slots: byDay.get(key) ?? [] };
  });
}

function formatDayFull(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const BORDER_MED = 'rgba(255,255,255,0.11)';
const CARD_BG = 'rgba(255,255,255,0.05)';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },


  scroll: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xl },
  subhead: { color: 'rgba(255,255,255,0.8)', fontSize: 15, fontWeight: '600' },

  loadingCard: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },

  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
  },
  cardTitle: { color: palette.white, fontSize: 16, fontWeight: '700' },
  muted: { color: 'rgba(255,255,255,0.65)', fontSize: 14, lineHeight: 20 },

  dayStrip: { gap: spacing.sm, paddingVertical: spacing.xs },
  dayCell: {
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.card,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
  },
  dayCellActive: { backgroundColor: BRAND, borderColor: BRAND },
  dayDow: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  dayNum: { color: palette.white, fontSize: 18, fontWeight: '700' },
  dayMon: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '600' },
  dayActiveText: { color: palette.white },

  slotList: { gap: spacing.md },
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.card,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
  },
  slotRowSelected: { borderColor: BRAND_LIGHT, backgroundColor: 'rgba(167,139,250,0.12)' },
  slotTime: { color: palette.white, fontSize: 16, fontWeight: '700', minWidth: 72 },
  slotStylist: { color: 'rgba(255,255,255,0.7)', fontSize: 14, flex: 1 },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterSelected: { borderColor: BRAND_LIGHT },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: BRAND_LIGHT },

  footer: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
    backgroundColor: BG,
  },
  footerSummary: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600' },
});
