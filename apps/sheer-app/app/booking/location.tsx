import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { PublicBookingLocationSummary } from '@sheer/domain';
import { palette } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
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
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Step 1 of 6</Text>
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
            <SectionHeader title="Available salons" subtitle={`${locations.length} location${locations.length === 1 ? '' : 's'} ready for booking.`} />
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
        <AppButton label="Continue" disabled={!draft.location} onPress={continueToServices} />
      </Screen>
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
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}
    >
      <View style={[styles.panel, selected && styles.panelSelected]}>
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

