import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { PublicBookingLocationSummary } from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles } from '../../src/booking/bookingStyles';

export default function BookingLocationScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft, resetDraft } = useBookingFlow();
  const [locations, setLocations] = useState<PublicBookingLocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMobileBookingLocations(accessToken);
      setLocations(result.locations);
      if (result.locations.length === 1) {
        updateDraft({ location: result.locations[0] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load locations');
    } finally {
      setLoading(false);
    }
  }, [accessToken, updateDraft]);

  useEffect(() => {
    resetDraft();
  }, [accessToken, resetDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  function continueToServices() {
    if (draft.location) router.push('/booking/services');
  }

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header (matches client profile page) ── */}
        <View style={s.header}>
          <Pressable
            style={({ pressed }) => [s.headerBack, pressed && s.pressed]}
            onPress={() => router.back()}
          >
            <Text style={s.headerBackArrow}>‹</Text>
            <Text style={s.headerBackLabel}>Back</Text>
          </Pressable>

          <Text style={s.headerTitle}>Book appointment</Text>

          <View style={s.headerStep}>
            <Text style={s.headerStepText}>Step 1 of 5</Text>
          </View>
        </View>

        {/* ── Scrollable content ── */}
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <Text style={styles.heroTitle}>Choose your salon</Text>
            <Text style={styles.heroBody}>
              Select the salon that works best for your appointment. Availability, services, and stylists are tailored to this location.
            </Text>
          </View>

          {error ? <ErrorCard message={error} onRetry={() => void load()} /> : null}

          {loading ? (
            <LoadingCard label="Loading locations..." />
          ) : locations.length === 0 ? (
            <EmptyState title="No salons available" body="Online booking is not available right now." />
          ) : (
            <View style={styles.list}>
              <SectionHeader
                title="Available salons"
                subtitle={`${locations.length} location${locations.length === 1 ? '' : 's'} ready for booking.`}
              />
              {locations.map((location) => (
                <SalonCard
                  key={location.id}
                  location={location}
                  selected={draft.location?.id === location.id}
                  onPress={() => updateDraft({ location })}
                />
              ))}
            </View>
          )}
        </ScrollView>

        {/* ── Pinned footer: Continue always visible, no scroll needed ── */}
        <SafeAreaView edges={['bottom']} style={s.footer}>
          {draft.location ? (
            <Text style={s.footerHint} numberOfLines={1}>
              Selected · {draft.location.name}
            </Text>
          ) : (
            <Text style={s.footerHintMuted}>Select a salon to continue</Text>
          )}
          <AppButton label="Continue" disabled={!draft.location} onPress={continueToServices} />
        </SafeAreaView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <Card>
      <View style={styles.loadingRow}>
        <ActivityIndicator color={palette.brand[300]} />
        <View style={styles.flex}>
          <Text style={styles.title}>Preparing salons</Text>
          <Text style={styles.subtitle}>{label}</Text>
        </View>
      </View>
    </Card>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <Text style={styles.title}>We couldn’t load salons</Text>
      <Text style={styles.error}>{message}</Text>
      <AppButton label="Try again" variant="secondary" onPress={onRetry} />
    </Card>
  );
}

function SalonCard({
  location,
  selected,
  onPress,
}: {
  location: PublicBookingLocationSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const addressLine = formatAddress(location);

  function callSalon() {
    if (location.phone) void Linking.openURL(`tel:${location.phone}`);
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}
    >
      <View style={[styles.panel, selected && styles.panelSelected]}>
        {/* Title row */}
        <View style={styles.cardTop}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>{location.name.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.title}>{location.name}</Text>
            <Text style={styles.subtitle}>Professional booking · {location.currencyCode}</Text>
          </View>
          <View style={[styles.pill, selected && styles.pillSelected]}>
            <Text style={[styles.pillText, selected && styles.pillTextSelected]}>
              {selected ? 'Selected' : 'Choose'}
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Address + phone */}
        <View style={styles.contactGroup}>
          {addressLine ? (
            <View style={styles.contactLine}>
              <Text style={styles.contactGlyph}>◉</Text>
              <Text style={styles.contactText}>{addressLine}</Text>
            </View>
          ) : null}
          {location.phone ? (
            <Pressable
              accessibilityRole="link"
              onPress={callSalon}
              style={({ pressed }) => [styles.contactLine, pressed && styles.pressed]}
            >
              <Text style={styles.contactGlyph}>✆</Text>
              <Text style={styles.contactLink}>{location.phone}</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.divider} />

        {/* Booking details */}
        <View style={styles.detailGrid}>
          <Detail label="Slot rhythm" value={`${location.appointmentSlotMinutes} min`} />
          <Detail label="Stylist choice" value={location.allowNextAvailable ? 'Next available' : 'Specific stylist'} />
          <Detail
            label="Cancellation"
            value={
              location.cancellationNoticeHours
                ? `${location.cancellationNoticeHours}h notice`
                : 'Salon policy'
            }
          />
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

function formatAddress(location: PublicBookingLocationSummary): string {
  const cityLine = [location.city, location.postalCode].filter(Boolean).join(' ');
  return [location.addressLine1, location.addressLine2, cityLine, location.region]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ');
}

const BG = '#18141F';
const BORDER_MED = 'rgba(255,255,255,0.11)';
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
    backgroundColor: BG,
  },
  headerBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    minWidth: 90,
  },
  headerBackArrow: {
    color: BRAND_LIGHT,
    fontSize: 28,
    lineHeight: 30,
    fontWeight: '300',
    marginTop: -2,
  },
  headerBackLabel: {
    color: BRAND_LIGHT,
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  headerStep: {
    minWidth: 90,
    alignItems: 'flex-end',
  },
  headerStepText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontWeight: '700',
  },

  // ── Scroll body
  scroll: {
    gap: spacing.base,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },

  // ── Pinned footer
  footer: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
    backgroundColor: BG,
  },
  footerHint: {
    color: BRAND_LIGHT,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  footerHintMuted: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
});
