import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import type { PublicBookingAvailabilitySlot } from '@sheer/domain';
import { palette } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDateTime } from '../../src/booking/bookingStyles';

export default function BookingDateTimeScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();
  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setSlots(result.slots.slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load available times');
    } finally {
      setLoading(false);
    }
  }, [accessToken, dateRange, draft.services, draft.staffRequestMode, draft.stylist, location]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!location) return <Redirect href="/booking/location" />;
  if (draft.services.length === 0) return <Redirect href="/booking/services" />;

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Step 5 of 6</Text>
          <Text style={styles.heroTitle}>Select a time</Text>
          <Text style={styles.heroBody}>
            These slots are checked by Sheer against rota, service duration, stylist capability, and existing bookings.
          </Text>
        </View>
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
        ) : slots.length === 0 ? (
          <EmptyState title="No available times" body="Try a different stylist or service selection." />
        ) : (
          <View style={styles.list}>
            {slots.map((slot) => (
              <SlotCard
                key={`${slot.staffProfileId}:${slot.startAt}`}
                slot={slot}
                selected={draft.selectedSlot?.startAt === slot.startAt && draft.selectedSlot.staffProfileId === slot.staffProfileId}
                onPress={() => updateDraft({ selectedSlot: slot })}
              />
            ))}
          </View>
        )}
        <AppButton
          label="Continue"
          disabled={!draft.selectedSlot}
          onPress={() => router.push('/booking/review')}
        />
      </Screen>
    </ProtectedScreen>
  );
}

function SlotCard({
  slot,
  selected,
  onPress,
}: {
  slot: PublicBookingAvailabilitySlot;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}>
      <View style={[styles.panel, selected && styles.panelSelected]}>
        <View style={styles.cardTop}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>{new Date(slot.startAt).getDate()}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.title}>{formatDateTime(slot.startAt)}</Text>
            <Text style={styles.subtitle}>{slot.stylistName}</Text>
          </View>
          <View style={[styles.pill, selected && styles.pillSelected]}>
            <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{selected ? 'Selected' : 'Choose'}</Text>
          </View>
        </View>
        <View style={styles.divider} />
        <View style={styles.detailGrid}>
          <Detail label="Starts" value={formatTime(slot.startAt)} />
          <Detail label="Ends" value={formatTime(slot.endAt)} />
          <Detail label="Stylist" value={slot.stylistName} />
        </View>
      </View>
    </Pressable>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
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
