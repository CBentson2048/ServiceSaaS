import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import type { PublicBookingServiceSummary, PublicBookingUpgradeSuggestion } from '@sheer/domain';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDuration, formatMoney } from '../../src/booking/bookingStyles';

export default function BookingUpgradesScreen() {
  const { draft, updateDraft } = useBookingFlow();
  const location = draft.location;
  const selectedIds = useMemo(() => new Set(draft.services.map((service) => service.id)), [draft.services]);
  const suggestions = draft.upgradeSuggestions.filter(
    (suggestion, index, all) =>
      selectedIds.has(suggestion.triggerServiceId) &&
      !selectedIds.has(suggestion.suggestedServiceId) &&
      all.findIndex((item) => item.suggestedServiceId === suggestion.suggestedServiceId) === index,
  );

  if (!location) return <Redirect href="/booking/location" />;
  if (draft.services.length === 0) return <Redirect href="/booking/services" />;

  function addUpgrade(service: PublicBookingServiceSummary) {
    updateDraft({ services: [...draft.services, service], stylist: undefined, selectedSlot: undefined });
  }

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Step 3 of 6</Text>
          <Text style={styles.heroTitle}>Enhance your visit</Text>
          <Text style={styles.heroBody}>
            Optional upgrades are tailored to your selected services. Add what you want, or continue without extras.
          </Text>
        </View>
        {suggestions.length === 0 ? (
          <EmptyState title="No upgrades suggested" body="You can continue to stylist selection." />
        ) : (
          <View style={styles.list}>
            {suggestions.map((suggestion) => (
              <UpgradeCard key={suggestion.id} suggestion={suggestion} onAdd={() => addUpgrade(suggestion.service)} />
            ))}
          </View>
        )}
        <AppButton label="Continue" onPress={() => router.push('/booking/stylist')} />
        <AppButton label="Back to services" variant="secondary" onPress={() => router.push('/booking/services')} />
      </Screen>
    </ProtectedScreen>
  );
}

function UpgradeCard({ suggestion, onAdd }: { suggestion: PublicBookingUpgradeSuggestion; onAdd: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onAdd} style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}>
      <View style={styles.panel}>
        <View style={styles.cardTop}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>+</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.title}>{suggestion.title}</Text>
            <Text style={styles.subtitle}>{suggestion.description}</Text>
          </View>
          <View style={styles.pillSelected}>
            <Text style={styles.pillTextSelected}>Add</Text>
          </View>
        </View>
        <View style={styles.divider} />
        <View style={styles.detailGrid}>
          <Detail label="Upgrade" value={suggestion.service.name} />
          <Detail label="Duration" value={formatDuration(suggestion.service.estimatedDurationMinutes)} />
          <Detail label="Price" value={formatMoney(suggestion.service.startingPriceAmount, suggestion.service.currencyCode)} />
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
