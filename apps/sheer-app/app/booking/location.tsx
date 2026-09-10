import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { PublicBookingLocationSummary, PublicSalonSummary } from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, SectionHeader } from '../../src/design';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles } from '../../src/booking/bookingStyles';
import { ScreenHeader } from '../../src/navigation/ScreenHeader';
import { BG, BRAND_LIGHT } from '../../src/design/colors';

export default function BookingLocationScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft, resetDraft } = useBookingFlow();
  const [locations, setLocations] = useState<PublicBookingLocationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PublicSalonSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolvingSalon, setResolvingSalon] = useState(false);

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

  // Debounced salon-directory search (name / Salon Code / stylist Q Code). The
  // dropdown list below is hidden while a query is active so the two don't clash.
  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      setError(null);
      api
        .searchPublicSalons(normalized)
        .then((result) => {
          if (!cancelled) setSearchResults(result.salons);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Could not search salons');
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // A searched salon comes back as a directory summary; resolve it into a full
  // bookable location (same shape as the dropdown) before selecting it.
  const chooseSalon = useCallback(
    async (salon: PublicSalonSummary) => {
      if (!accessToken) return;
      setResolvingSalon(true);
      setError(null);
      try {
        const result = await api.getMobileBookingSelection(accessToken, {
          locationId: salon.locationId,
        });
        updateDraft({ location: result.location });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open this salon');
      } finally {
        setResolvingSalon(false);
      }
    },
    [accessToken, updateDraft],
  );

  function continueToServices() {
    if (draft.location) router.push('/booking/services');
  }

  const hasQuery = query.trim().length >= 2;

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header (matches client profile page) ── */}
        <ScreenHeader
          title="Book appointment"
          divider={false}
          right={<Text style={s.headerStepText}>Step 1 of 5</Text>}
        />

        {/* ── Scrollable content ── */}
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero}>
            <Text style={styles.heroTitle}>Choose your salon</Text>
            <Text style={styles.heroBody}>
              Search by salon name, Salon Code, or your stylist&apos;s Q Code — or pick from the list below.
            </Text>
          </View>

          {/* ── Find a salon (search) ── */}
          <View style={s.searchBlock}>
            <Text style={s.searchLabel}>Find your salon</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Salon name, Salon Code, or Q Code"
              placeholderTextColor="rgba(255,255,255,0.4)"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={s.searchInput}
            />
          </View>

          {error ? <ErrorCard message={error} onRetry={() => void load()} /> : null}

          {searching ? <InfoNote text="Searching salons…" /> : null}

          {hasQuery && !searching && searchResults.length === 0 && !error ? (
            <InfoNote text="No matching salon found. Check the name or code and try again." />
          ) : null}

          {searchResults.length > 0 ? (
            <View style={styles.list}>
              <SectionHeader
                title="Search results"
                subtitle={`${searchResults.length} salon${searchResults.length === 1 ? '' : 's'} matched.`}
              />
              {searchResults.map((salon) => (
                <SalonSearchResultCard
                  key={salon.locationId}
                  salon={salon}
                  selected={draft.location?.id === salon.locationId}
                  onPress={() => void chooseSalon(salon)}
                />
              ))}
            </View>
          ) : null}

          {/* ── Full list (hidden while searching) ── */}
          {!hasQuery ? (
            loading ? (
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
            )
          ) : null}
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
          <AppButton
            label={resolvingSalon ? 'Opening salon…' : 'Continue'}
            disabled={!draft.location || resolvingSalon}
            onPress={continueToServices}
          />
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

function InfoNote({ text }: { text: string }) {
  return (
    <Card>
      <Text style={styles.subtitle}>{text}</Text>
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

function SalonSearchResultCard({
  salon,
  selected,
  onPress,
}: {
  salon: PublicSalonSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const metaLine = [salon.businessName !== salon.name ? salon.businessName : null, salon.city]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}
    >
      <View style={[styles.panel, selected && styles.panelSelected]}>
        <View style={styles.cardTop}>
          <View style={styles.iconBadge}>
            <Text style={styles.iconText}>{salon.name.charAt(0).toUpperCase()}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.title}>{salon.name}</Text>
            <Text style={styles.subtitle}>{metaLine || 'Online booking available'}</Text>
          </View>
          <View style={[styles.pill, selected && styles.pillSelected]}>
            <Text style={[styles.pillText, selected && styles.pillTextSelected]}>
              {selected ? 'Selected' : 'Choose'}
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        <Text style={s.salonCode}>Salon Code · {salon.salonCode}</Text>
      </View>
    </Pressable>
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
            {location.salonCode ? (
              <Text style={s.salonCode}>Salon Code · {location.salonCode}</Text>
            ) : null}
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
              <View style={styles.contactGlyph}>
                <Ionicons name="location" size={14} color={BRAND_LIGHT} />
              </View>
              <Text style={styles.contactText}>{addressLine}</Text>
            </View>
          ) : null}
          {location.phone ? (
            <Pressable
              accessibilityRole="link"
              onPress={callSalon}
              style={({ pressed }) => [styles.contactLine, pressed && styles.pressed]}
            >
              <View style={styles.contactGlyph}>
                <Ionicons name="call" size={14} color={BRAND_LIGHT} />
              </View>
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

const BORDER_MED = 'rgba(255,255,255,0.11)';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header
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

  // ── Search
  searchBlock: {
    gap: spacing.sm,
  },
  searchLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '700',
  },
  searchInput: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER_MED,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    color: palette.white,
    fontSize: 15,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  salonCode: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    fontVariant: ['tabular-nums'],
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
