import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import type { PublicBookingStylistSummary } from '@sheer/domain';
import { palette } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDateTime } from '../../src/booking/bookingStyles';

export default function BookingStylistScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();
  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const location = draft.location;

  const load = useCallback(async () => {
    if (!accessToken || !location || draft.services.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMobileBookingStylists(accessToken, {
        locationId: location.id,
        serviceIds: draft.services.map((service) => service.id),
      });
      setStylists(result.stylists);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load stylists');
    } finally {
      setLoading(false);
    }
  }, [accessToken, draft.services, location]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!location) return <Redirect href="/booking/location" />;
  if (draft.services.length === 0) return <Redirect href="/booking/services" />;

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Step 4 of 6</Text>
          <Text style={styles.heroTitle}>Choose your stylist</Text>
          <Text style={styles.heroBody}>
            Pick a preferred professional, or let Sheer find the earliest stylist who can perform your services.
          </Text>
        </View>
        {error ? <ErrorCard message={error} onRetry={() => void load()} /> : null}
        {loading ? (
          <Card>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={palette.brand[300]} />
              <View style={styles.flex}>
                <Text style={styles.title}>Checking stylists</Text>
                <Text style={styles.subtitle}>Loading stylists...</Text>
              </View>
            </View>
          </Card>
        ) : stylists.length === 0 ? (
          <EmptyState title="No stylists available" body="Try a different salon or service selection." />
        ) : (
          <View style={styles.list}>
            {location.allowNextAvailable ? (
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  updateDraft({ staffRequestMode: 'next_available', stylist: undefined, selectedSlot: undefined })
                }
                style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}
              >
                <View style={[styles.panel, draft.staffRequestMode === 'next_available' && styles.panelSelected]}>
                  <View style={styles.cardTop}>
                    <View style={styles.iconBadge}>
                      <Text style={styles.iconText}>∞</Text>
                    </View>
                    <View style={styles.flex}>
                      <Text style={styles.title}>Next available</Text>
                      <Text style={styles.subtitle}>Let Sheer find the earliest matching stylist and time.</Text>
                    </View>
                    <View style={[styles.pill, draft.staffRequestMode === 'next_available' && styles.pillSelected]}>
                      <Text style={[styles.pillText, draft.staffRequestMode === 'next_available' && styles.pillTextSelected]}>
                        {draft.staffRequestMode === 'next_available' ? 'Selected' : 'Choose'}
                      </Text>
                    </View>
                  </View>
                </View>
              </Pressable>
            ) : null}
            {stylists.map((stylist) => (
              <StylistCard
                key={stylist.staffProfileId}
                stylist={stylist}
                selected={draft.stylist?.staffProfileId === stylist.staffProfileId}
                onPress={() =>
                  updateDraft({ staffRequestMode: 'specific_staff', stylist, selectedSlot: undefined })
                }
              />
            ))}
          </View>
        )}
        <AppButton
          label="Continue"
          disabled={draft.staffRequestMode === 'specific_staff' && !draft.stylist}
          onPress={() => router.push('/booking/date-time')}
        />
      </Screen>
    </ProtectedScreen>
  );
}

function StylistCard({
  stylist,
  selected,
  onPress,
}: {
  stylist: PublicBookingStylistSummary;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}>
      <View style={[styles.panel, selected && styles.panelSelected]}>
        <View style={styles.cardTop}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>{stylist.displayName.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.title}>{stylist.displayName}</Text>
            <Text style={styles.subtitle}>
              {stylist.nextAvailableAt ? `Next ${formatDateTime(stylist.nextAvailableAt)}` : 'Availability varies'}
            </Text>
          </View>
          <View style={[styles.pill, selected && styles.pillSelected]}>
            <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{selected ? 'Selected' : 'Choose'}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <Text style={styles.title}>Stylists unavailable</Text>
      <Text style={styles.error}>{message}</Text>
      <AppButton label="Try again" variant="secondary" onPress={onRetry} />
    </Card>
  );
}
