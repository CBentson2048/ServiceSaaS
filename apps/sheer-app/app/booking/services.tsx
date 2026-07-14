import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';
import type {
  PublicBookingAvailabilitySlot,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  PublicBookingUpgradeSuggestion,
} from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { effectiveServices, totalDuration, totalPrice, useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDateTime, formatDuration, formatMoney } from '../../src/booking/bookingStyles';

export default function BookingServicesScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();

  const [services, setServices] = useState<PublicBookingServiceSummary[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);

  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [stylistsLoading, setStylistsLoading] = useState(false);
  const [stylistsError, setStylistsError] = useState<string | null>(null);

  // Resolving the soonest slot for a "Next available" booking — mirrors the web
  // flow: auto-pick the earliest slot across the lookahead window and skip the
  // date/time calendar entirely.
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const location = draft.location;
  const selectedIds = useMemo(() => new Set(draft.services.map((service) => service.id)), [draft.services]);
  // Effective (per-stylist) prices for the SELECTED services: once a specific
  // stylist is chosen these are that stylist's prices, otherwise base prices.
  const pricedServices = useMemo(() => effectiveServices(draft), [draft]);
  // Map of serviceId -> effective price so each selected card shows the chosen
  // stylist's price; unselected catalog cards keep their base "from" price.
  const effectivePriceById = useMemo(
    () => new Map(pricedServices.map((service) => [service.id, service.startingPriceAmount])),
    [pricedServices],
  );
  const serviceIdsKey = useMemo(
    () => draft.services.map((service) => service.id).sort().join(','),
    [draft.services],
  );
  // Group the catalogue under category headers, ordered by the category order
  // configured by the salon. Services keep their (sort_order) order within each.
  const groupedServices = useMemo(() => groupServicesByCategory(services), [services]);

  const loadServices = useCallback(async () => {
    if (!accessToken || !location) return;
    setServicesLoading(true);
    setServicesError(null);
    try {
      const result = await api.getMobileBookingSelection(accessToken, { locationId: location.id });
      setServices(result.services);
      updateDraft({
        finishingRequirements: result.finishingRequirements,
        upgradeSuggestions: result.upgradeSuggestions,
      });
    } catch (err) {
      setServicesError(err instanceof Error ? err.message : 'Could not load services');
    } finally {
      setServicesLoading(false);
    }
  }, [accessToken, location, updateDraft]);

  // Live-load stylists whenever the service selection changes.
  const loadStylists = useCallback(async () => {
    if (!accessToken || !location || !serviceIdsKey) {
      setStylists([]);
      return;
    }
    setStylistsLoading(true);
    setStylistsError(null);
    try {
      const result = await api.getMobileBookingStylists(accessToken, {
        locationId: location.id,
        serviceIds: serviceIdsKey.split(','),
      });
      setStylists(result.stylists);
    } catch (err) {
      setStylistsError(err instanceof Error ? err.message : 'Could not load stylists');
    } finally {
      setStylistsLoading(false);
    }
  }, [accessToken, location, serviceIdsKey]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  useEffect(() => {
    void loadStylists();
  }, [loadStylists]);

  // A changed service/stylist selection invalidates any stale "no availability"
  // message left over from a previous Next-available attempt.
  useEffect(() => {
    setResolveError(null);
  }, [serviceIdsKey, draft.staffRequestMode, draft.stylist]);

  if (!location) return <Redirect href="/booking/location" />;

  function toggleService(service: PublicBookingServiceSummary) {
    const next = selectedIds.has(service.id)
      ? draft.services.filter((item) => item.id !== service.id)
      : [...draft.services, service];
    // Service change invalidates stylist/time selection.
    updateDraft({ services: next, stylist: undefined, selectedSlot: undefined, slotServicePrices: undefined });
  }

  function addUpgrade(service: PublicBookingServiceSummary) {
    updateDraft({ services: [...draft.services, service], stylist: undefined, selectedSlot: undefined, slotServicePrices: undefined });
  }

  function chooseNextAvailable() {
    updateDraft({ staffRequestMode: 'next_available', stylist: undefined, selectedSlot: undefined, slotServicePrices: undefined });
  }

  function chooseStylist(stylist: PublicBookingStylistSummary) {
    updateDraft({ staffRequestMode: 'specific_staff', stylist, selectedSlot: undefined, slotServicePrices: undefined });
  }

  const upgrades = draft.upgradeSuggestions.filter(
    (suggestion, index, all) =>
      selectedIds.has(suggestion.triggerServiceId) &&
      !selectedIds.has(suggestion.suggestedServiceId) &&
      all.findIndex((item) => item.suggestedServiceId === suggestion.suggestedServiceId) === index,
  );

  const missing = draft.finishingRequirements.find(
    (rule) =>
      selectedIds.has(rule.triggerServiceId) &&
      !rule.requiredServiceIds.some((serviceId) => selectedIds.has(serviceId)),
  );

  const hasServices = draft.services.length > 0;
  const stylistChosen = draft.staffRequestMode === 'next_available' || Boolean(draft.stylist);
  const canContinue = hasServices && !missing && stylistChosen;

  // A specific stylist routes through the date/time picker. "Next available"
  // matches the web flow: resolve the soonest slot across the lookahead window
  // right here and jump straight to review, skipping the calendar.
  async function continueFromServices() {
    if (!canContinue || resolving) return;
    if (draft.staffRequestMode !== 'next_available') {
      router.push('/booking/date-time');
      return;
    }
    if (!accessToken || !location) return;
    setResolving(true);
    setResolveError(null);
    try {
      const { dateFrom, dateTo } = nextAvailableSearchRange();
      const result = await api.getMobileBookingAvailability(accessToken, {
        locationId: location.id,
        serviceIds: draft.services.map((service) => service.id),
        nextAvailable: true,
        dateFrom,
        dateTo,
      });
      const slot = earliestSlot(result.slots);
      if (!slot) {
        setResolveError('No upcoming availability was found. Try a specific stylist or different services.');
        return;
      }
      // Resolve the stylist behind the picked slot so the review totals + deposit
      // reflect that stylist's prices — what the server will actually charge.
      const resolved = result.stylists?.find((stylist) => stylist.staffProfileId === slot.staffProfileId);
      updateDraft({ selectedSlot: slot, slotServicePrices: resolved?.servicePrices });
      router.push('/booking/review');
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Could not find the next available slot.');
    } finally {
      setResolving(false);
    }
  }

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header (matches client profile page) ── */}
        <View style={s.header}>
          <Pressable style={({ pressed }) => [s.headerBack, pressed && s.pressed]} onPress={() => router.back()}>
            <Text style={s.headerBackArrow}>‹</Text>
            <Text style={s.headerBackLabel}>Back</Text>
          </Pressable>
          <Text style={s.headerTitle}>Choose a service</Text>
          <View style={s.headerStep}>
            <Text style={s.headerStepText}>Step 2 of 5</Text>
          </View>
        </View>
        {/* Progress underline */}
        <View style={s.progressTrack}>
          <View style={s.progressFill} />
        </View>

        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Services ── */}
          <View>
            <Text style={styles.blockHeading}>What would you like?</Text>
            <Text style={styles.blockSub}>
              {location.name}
              {location.city ? ` · ${location.city}` : ''}
            </Text>
          </View>

          {servicesError ? <ErrorCard title="Services unavailable" message={servicesError} onRetry={() => void loadServices()} /> : null}

          {servicesLoading ? (
            <LoadingCard title="Preparing services" label="Loading services..." />
          ) : services.length === 0 ? (
            <EmptyState title="No services available" body="This salon does not have online services available yet." />
          ) : (
            <View style={s.categoryList}>
              {groupedServices.map((group) => {
                // Hide the header only when the whole catalogue is uncategorised.
                const showHeader = groupedServices.length > 1 || group.key !== UNCATEGORISED_KEY;
                return (
                  <View key={group.key} style={s.categoryBlock}>
                    {showHeader ? (
                      <View style={s.categoryHeader}>
                        {group.colorHex ? (
                          <View style={[s.categoryDot, { backgroundColor: group.colorHex }]} />
                        ) : null}
                        <Text style={s.categoryTitle}>{group.name}</Text>
                      </View>
                    ) : null}
                    <View style={styles.serviceGrid}>
                      {group.services.map((service) => (
                        <ServiceCard
                          key={service.id}
                          service={service}
                          selected={selectedIds.has(service.id)}
                          // When this service is selected and a specific stylist is chosen,
                          // show that stylist's price; otherwise the base "from" price.
                          priceAmount={
                            selectedIds.has(service.id)
                              ? effectivePriceById.get(service.id) ?? service.startingPriceAmount
                              : service.startingPriceAmount
                          }
                          onPress={() => toggleService(service)}
                        />
                      ))}
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {missing ? (
            <Text style={styles.warning}>
              {missing.title}: add {missing.requiredServices.map((service) => service.name).join(' or ')} to continue.
            </Text>
          ) : null}

          {/* ── Inline upgrades ── */}
          {upgrades.length > 0 ? (
            <View style={s.sectionGap}>
              <Text style={styles.groupLabel}>Recommended add-ons</Text>
              {upgrades.map((upgrade) => (
                <UpgradeRow key={upgrade.id} suggestion={upgrade} onAdd={() => addUpgrade(upgrade.service)} />
              ))}
            </View>
          ) : null}

          {/* ── Stylists ── */}
          {hasServices ? (
            <View style={s.sectionGap}>
              <Text style={styles.groupLabel}>Choose your stylist</Text>

              {stylistsError ? (
                <ErrorCard title="Stylists unavailable" message={stylistsError} onRetry={() => void loadStylists()} />
              ) : stylistsLoading ? (
                <LoadingCard title="Checking stylists" label="Loading stylists..." />
              ) : (
                <View style={s.stylistList}>
                  {stylists.map((stylist) => (
                    <StylistRow
                      key={stylist.staffProfileId}
                      stylist={stylist}
                      selected={
                        draft.staffRequestMode === 'specific_staff' &&
                        draft.stylist?.staffProfileId === stylist.staffProfileId
                      }
                      onPress={() => chooseStylist(stylist)}
                    />
                  ))}

                  {location.allowNextAvailable ? (
                    <NextAvailableRow
                      selected={draft.staffRequestMode === 'next_available'}
                      onPress={chooseNextAvailable}
                    />
                  ) : null}

                  {stylists.length === 0 && !location.allowNextAvailable ? (
                    <EmptyState title="No stylists available" body="Try a different service selection." />
                  ) : null}
                </View>
              )}
            </View>
          ) : (
            <View style={s.sectionGap}>
              <Text style={styles.groupLabel}>Choose your stylist</Text>
              <View style={s.stylistHint}>
                <Text style={styles.stylistMeta}>Select a service above to see available stylists.</Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* ── Pinned footer ── */}
        <SafeAreaView edges={['bottom']} style={s.footer}>
          {resolveError ? (
            <Text style={s.footerError} numberOfLines={2}>
              {resolveError}
            </Text>
          ) : hasServices ? (
            <Text style={s.footerHint} numberOfLines={1}>
              {draft.services.length} service{draft.services.length === 1 ? '' : 's'} ·{' '}
              {formatDuration(totalDuration(draft.services))} ·{' '}
              {/* Total uses the selected stylist's prices once one is chosen. */}
              {formatMoney(totalPrice(pricedServices), location.currencyCode)}
            </Text>
          ) : (
            <Text style={s.footerHintMuted}>Pick at least one service to continue</Text>
          )}
          <AppButton
            label={resolving ? 'Finding next available…' : 'Continue  →'}
            disabled={!canContinue || resolving}
            onPress={() => void continueFromServices()}
          />
        </SafeAreaView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Next-available resolution helpers ───────────────────────────────────────────

/** Lookahead window for the soonest-slot search (mirrors the web booking flow). */
function nextAvailableSearchRange(): { dateFrom: string; dateTo: string } {
  const from = new Date();
  const to = new Date(from);
  to.setDate(to.getDate() + 60);
  return { dateFrom: from.toISOString(), dateTo: to.toISOString() };
}

/** The earliest slot by start time (the server already sorts; sort again defensively). */
function earliestSlot(
  slots: PublicBookingAvailabilitySlot[],
): PublicBookingAvailabilitySlot | undefined {
  return [...slots].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())[0];
}

// ── Service card (2-col grid) ───────────────────────────────────────────────────

function ServiceCard({
  service,
  selected,
  priceAmount,
  onPress,
}: {
  service: PublicBookingServiceSummary;
  selected: boolean;
  // Effective price to display: the selected stylist's price when one is chosen,
  // otherwise the service base price.
  priceAmount: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.serviceCard, selected && styles.serviceCardSelected, pressed && styles.pressed]}
    >
      <View style={styles.serviceCardHead}>
        <Text style={styles.serviceEmoji}>{serviceEmoji(service)}</Text>
        {selected ? (
          <View style={styles.serviceCheck}>
            <Text style={styles.serviceCheckMark}>✓</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.serviceName} numberOfLines={2}>
        {service.name}
      </Text>
      <Text style={styles.serviceMeta}>{formatDuration(service.estimatedDurationMinutes)}</Text>
      <Text style={styles.servicePrice}>From {formatMoney(priceAmount, service.currencyCode)}</Text>
    </Pressable>
  );
}

// ── Stylist row ─────────────────────────────────────────────────────────────────

function StylistRow({
  stylist,
  selected,
  onPress,
}: {
  stylist: PublicBookingStylistSummary;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.stylistCard, selected && styles.stylistCardSelected, pressed && styles.pressed]}
    >
      {stylist.photoUrl ? (
        <Image source={{ uri: stylist.photoUrl }} style={styles.stylistAvatar} resizeMode="cover" />
      ) : (
        <View style={[styles.stylistAvatar, { backgroundColor: stylist.colorHex ?? palette.brand[500] }]}>
          <Text style={styles.stylistAvatarText}>{initials(stylist.displayName)}</Text>
        </View>
      )}
      <View style={styles.flex}>
        <Text style={styles.stylistName}>{stylist.displayName}</Text>
        <Text style={styles.stylistMeta}>
          {stylist.nextAvailableAt ? `Next available: ${formatDateTime(stylist.nextAvailableAt)}` : 'Availability varies'}
        </Text>
      </View>
      <Radio selected={selected} />
    </Pressable>
  );
}

function NextAvailableRow({ selected, onPress }: { selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.stylistCard, selected && styles.stylistCardSelected, pressed && styles.pressed]}
    >
      <View style={[styles.stylistAvatar, { backgroundColor: palette.success[500] }]}>
        <Text style={styles.stylistAvatarText}>NA</Text>
      </View>
      <View style={styles.flex}>
        <Text style={styles.stylistName}>Next available</Text>
        <Text style={styles.stylistMeta}>Any stylist · earliest slot</Text>
        <Text style={styles.stylistBadge}>Best availability</Text>
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

// ── Inline upgrade row ──────────────────────────────────────────────────────────

function UpgradeRow({ suggestion, onAdd }: { suggestion: PublicBookingUpgradeSuggestion; onAdd: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onAdd} style={({ pressed }) => [styles.stylistCard, pressed && styles.pressed]}>
      <View style={[styles.stylistAvatar, { backgroundColor: palette.brand[700] }]}>
        <Text style={styles.stylistAvatarText}>+</Text>
      </View>
      <View style={styles.flex}>
        <Text style={styles.stylistName}>{suggestion.title}</Text>
        <Text style={styles.stylistMeta} numberOfLines={2}>
          {suggestion.description}
        </Text>
      </View>
      <View style={styles.pillSelected}>
        <Text style={styles.pillTextSelected}>Add</Text>
      </View>
    </Pressable>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────────────

function LoadingCard({ title, label }: { title: string; label: string }) {
  return (
    <Card>
      <View style={styles.loadingRow}>
        <ActivityIndicator color={palette.brand[300]} />
        <View style={styles.flex}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{label}</Text>
        </View>
      </View>
    </Card>
  );
}

function ErrorCard({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <Card>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.error}>{message}</Text>
      <AppButton label="Try again" variant="secondary" onPress={onRetry} />
    </Card>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SERVICE_EMOJI: { keywords: string[]; emoji: string }[] = [
  { keywords: ['colour', 'color', 'tint', 'highlight', 'balayage', 'toner'], emoji: '🎨' },
  { keywords: ['cut', 'style', 'trim', 'fringe'], emoji: '✂️' },
  { keywords: ['blow', 'dry', 'wave', 'curl'], emoji: '💨' },
  { keywords: ['treatment', 'condition', 'mask', 'keratin', 'olaplex'], emoji: '✨' },
  { keywords: ['wash', 'shampoo'], emoji: '🧴' },
  { keywords: ['perm', 'relax', 'smooth'], emoji: '🌀' },
  { keywords: ['braid', 'updo', 'extension'], emoji: '💇' },
  { keywords: ['beard', 'shave', 'barber'], emoji: '🪒' },
  { keywords: ['nail', 'manicure', 'pedicure'], emoji: '💅' },
];

function serviceEmoji(service: PublicBookingServiceSummary): string {
  const haystack = `${service.name} ${service.category ?? ''}`.toLowerCase();
  for (const entry of SERVICE_EMOJI) {
    if (entry.keywords.some((keyword) => haystack.includes(keyword))) return entry.emoji;
  }
  return '💇';
}

// ── Category grouping ─────────────────────────────────────────────────────────────

const UNCATEGORISED_KEY = '__uncategorised';

interface ServiceGroup {
  key: string;
  name: string;
  colorHex?: string;
  sortOrder: number;
  services: PublicBookingServiceSummary[];
}

// Buckets services under their category, ordered by the salon-configured category
// order (uncategorised last). Service order within a category is preserved from
// the API (service sort_order), so the configured sequence is respected.
function groupServicesByCategory(services: PublicBookingServiceSummary[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const service of services) {
    const key = service.serviceCategoryId ?? UNCATEGORISED_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: service.category ?? 'Other',
        colorHex: service.categoryColorHex,
        sortOrder: service.categorySortOrder ?? Number.MAX_SAFE_INTEGER,
        services: [],
      };
      groups.set(key, group);
    }
    group.services.push(service);
  }
  return Array.from(groups.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
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

  // ── Progress underline (step 2 of 5 ≈ 40%)
  progressTrack: {
    height: 3,
    backgroundColor: BORDER_MED,
  },
  progressFill: {
    width: '40%',
    height: 3,
    backgroundColor: BRAND,
  },

  // ── Scroll body
  scroll: {
    gap: spacing.base,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  sectionGap: { gap: spacing.md },
  categoryList: { gap: spacing.base },
  categoryBlock: { gap: spacing.sm },
  categoryHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  categoryDot: { width: 10, height: 10, borderRadius: 5 },
  categoryTitle: { color: palette.white, fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
  stylistList: { gap: spacing.md },
  stylistHint: {
    padding: spacing.base,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: BORDER_MED,
    backgroundColor: 'rgba(255,255,255,0.03)',
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
  footerHint: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  footerHintMuted: { color: 'rgba(255,255,255,0.4)', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  footerError: { color: palette.danger[300], fontSize: 12, fontWeight: '700', textAlign: 'center' },
});
