import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import type { PublicBookingServiceSummary } from '@sheer/domain';
import { palette } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { totalDuration, totalPrice, useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDuration, formatMoney } from '../../src/booking/bookingStyles';

export default function BookingServicesScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();
  const [services, setServices] = useState<PublicBookingServiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const location = draft.location;
  const selectedIds = useMemo(() => new Set(draft.services.map((service) => service.id)), [draft.services]);

  const load = useCallback(async () => {
    if (!accessToken || !location) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMobileBookingSelection(accessToken, { locationId: location.id });
      setServices(result.services);
      updateDraft({
        finishingRequirements: result.finishingRequirements,
        upgradeSuggestions: result.upgradeSuggestions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load services');
    } finally {
      setLoading(false);
    }
  }, [accessToken, location, updateDraft]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!location) return <Redirect href="/booking/location" />;

  function toggleService(service: PublicBookingServiceSummary) {
    const next = selectedIds.has(service.id)
      ? draft.services.filter((item) => item.id !== service.id)
      : [...draft.services, service];
    updateDraft({ services: next, stylist: undefined, selectedSlot: undefined });
  }

  function missingRequirement() {
    const ids = new Set(draft.services.map((service) => service.id));
    return draft.finishingRequirements.find(
      (rule) => ids.has(rule.triggerServiceId) && !rule.requiredServiceIds.some((serviceId) => ids.has(serviceId)),
    );
  }

  const missing = missingRequirement();

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Step 2 of 6</Text>
          <Text style={styles.heroTitle}>Build your appointment</Text>
          <Text style={styles.heroBody}>
            Choose one or more services. We’ll stack the duration and keep your price snapshot ready for confirmation.
          </Text>
        </View>
        {error ? <ErrorCard message={error} onRetry={() => void load()} /> : null}
        {loading ? (
          <Card>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={palette.brand[300]} />
              <View style={styles.flex}>
                <Text style={styles.title}>Preparing services</Text>
                <Text style={styles.subtitle}>Loading services...</Text>
              </View>
            </View>
          </Card>
        ) : services.length === 0 ? (
          <EmptyState title="No services available" body="This salon does not have online services available yet." />
        ) : (
          <View style={styles.list}>
            {services.map((service) => (
              <ServiceCard
                key={service.id}
                service={service}
                selected={selectedIds.has(service.id)}
                onPress={() => toggleService(service)}
              />
            ))}
          </View>
        )}
        <View style={styles.totalCard}>
          <Text style={styles.eyebrow}>Appointment estimate</Text>
          <Text style={styles.totalValue}>
            {formatDuration(totalDuration(draft.services))} · {formatMoney(totalPrice(draft.services), location.currencyCode)}
          </Text>
          <Text style={styles.subtitle}>{draft.services.length} service{draft.services.length === 1 ? '' : 's'} selected</Text>
          {missing ? (
            <Text style={styles.warning}>
              {missing.title}: add {missing.requiredServices.map((service) => service.name).join(' or ')} to continue.
            </Text>
          ) : null}
        </View>
        <AppButton
          label="Continue"
          disabled={draft.services.length === 0 || Boolean(missing)}
          onPress={() => router.push('/booking/upgrades')}
        />
      </Screen>
    </ProtectedScreen>
  );
}

function ServiceCard({
  service,
  selected,
  onPress,
}: {
  service: PublicBookingServiceSummary;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}>
      <View style={[styles.panel, selected && styles.panelSelected]}>
        <View style={styles.cardTop}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>{service.name.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.title}>{service.name}</Text>
            {service.category ? <Text style={styles.subtitle}>{service.category}</Text> : null}
          </View>
          <View style={[styles.pill, selected && styles.pillSelected]}>
            <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{selected ? 'Added' : 'Add'}</Text>
          </View>
        </View>
        <View style={styles.divider} />
        <View style={styles.detailGrid}>
          <Detail label="Duration" value={formatDuration(service.estimatedDurationMinutes)} />
          <Detail label="Price" value={formatMoney(service.startingPriceAmount, service.currencyCode)} />
          <Detail label="Deposit" value={service.depositRequiredAmount > 0 ? formatMoney(service.depositRequiredAmount, service.currencyCode) : 'None'} />
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
      <Text style={styles.title}>Services unavailable</Text>
      <Text style={styles.error}>{message}</Text>
      <AppButton label="Try again" variant="secondary" onPress={onRetry} />
    </Card>
  );
}
