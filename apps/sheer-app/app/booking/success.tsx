import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Redirect, router } from 'expo-router';
import type { PublicBookingLocationSummary } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton } from '../../src/design';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles, formatDuration, formatMoney } from '../../src/booking/bookingStyles';
import { BG } from '../../src/design/colors';

export default function BookingSuccessScreen() {
  const { draft, resetDraft } = useBookingFlow();
  const appointment = draft.appointment;
  const location = draft.location;

  if (!appointment) return <Redirect href="/dashboard" />;

  function goHome() {
    resetDraft();
    router.replace('/dashboard');
  }

  const start = new Date(appointment.scheduledStartAt);
  const dateLabel = start.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeLabel = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const serviceLabel = appointment.serviceNames.join(', ');
  const priceLabel = formatMoney(appointment.totalPriceAmount, appointment.currencyCode);
  const addressLine = location ? formatAddress(location) : '';
  const salonName = location?.name ?? 'Your salon';

  function openMap() {
    if (!addressLine) return;
    const query = encodeURIComponent(`${salonName}, ${addressLine}`);
    void Linking.openURL(`https://maps.google.com/?q=${query}`);
  }

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {/* ── Confirmation hero ── */}
          <View style={s.heroBlock}>
            <View style={s.successMark}>
              <Text style={s.successMarkText}>✓</Text>
            </View>
            <Text style={s.heroTitle}>Booking Confirmed!</Text>
            <Text style={s.heroBody}>Your appointment is all set.</Text>
          </View>

          {/* ── Receipt card ── */}
          <View style={s.card}>
            {/* Salon identity */}
            <View style={s.salonRow}>
              <View style={s.salonAvatar}>
                <Text style={s.salonAvatarText}>{salonName.charAt(0).toUpperCase()}</Text>
              </View>
              <View style={bookingStyles.flex}>
                <Text style={s.salonName} numberOfLines={1}>
                  {salonName}
                </Text>
                {location?.phone ? (
                  <Pressable
                    accessibilityRole="link"
                    onPress={() => void Linking.openURL(`tel:${location.phone}`)}
                  >
                    <Text style={s.salonContact}>{location.phone}</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={s.statusPill}>
                <Text style={s.statusPillText}>{formatStatus(appointment.status)}</Text>
              </View>
            </View>

            <View style={s.dashedDivider} />

            {/* Date + time */}
            <View style={s.metaGrid}>
              <Meta icon="calendar-outline" label="Date" value={dateLabel} />
              <Meta icon="time-outline" label="Time" value={timeLabel} />
            </View>

            <View style={s.dashedDivider} />

            {/* Service + price */}
            <View style={s.serviceRow}>
              <View style={bookingStyles.flex}>
                <Text style={s.serviceLabel}>Service</Text>
                <Text style={s.serviceName} numberOfLines={2}>
                  {serviceLabel}
                </Text>
                <Text style={s.serviceMeta}>
                  with {appointment.stylistName} · {formatDuration(appointment.totalDurationMinutes)}
                </Text>
              </View>
              <View style={s.priceCol}>
                <Text style={s.priceLabel}>Price</Text>
                <Text style={s.priceValue}>{priceLabel}</Text>
              </View>
            </View>

            {/* Address */}
            {addressLine ? (
              <>
                <View style={s.dashedDivider} />
                <Pressable
                  accessibilityRole="link"
                  onPress={openMap}
                  style={({ pressed }) => [s.addressRow, pressed && s.pressed]}
                >
                  <Ionicons name="location-outline" size={16} color={palette.brand[300]} />
                  <Text style={s.addressText} numberOfLines={2}>
                    {addressLine}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.4)" />
                </Pressable>
              </>
            ) : null}
          </View>
        </ScrollView>

        {/* ── Pinned footer actions ── */}
        <SafeAreaView edges={['bottom']} style={s.footer}>
          <AppButton label="View appointment" onPress={() => router.replace('/bookings')} />
          <AppButton label="Return home" variant="secondary" onPress={goHome} />
        </SafeAreaView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

function Meta({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={s.meta}>
      <Text style={s.metaLabel}>{label}</Text>
      <View style={s.metaValueRow}>
        <Ionicons name={icon} size={16} color={palette.brand[300]} />
        <Text style={s.metaValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
    </View>
  );
}

function formatStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

  scroll: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },

  // ── Hero
  heroBlock: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  successMark: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: 'rgba(74,222,128,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.42)',
    marginBottom: spacing.xs,
  },
  successMarkText: {
    color: palette.success[300],
    fontSize: 30,
    fontWeight: '800',
  },
  heroTitle: {
    color: palette.white,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  heroBody: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 15,
    textAlign: 'center',
  },

  // ── Receipt card
  card: {
    gap: spacing.base,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  dashedDivider: {
    height: 1,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: 'rgba(255,255,255,0.14)',
  },

  // ── Salon identity
  salonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  salonAvatar: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.inputLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.32)',
    backgroundColor: 'rgba(196,160,245,0.18)',
  },
  salonAvatarText: {
    color: palette.white,
    fontSize: 18,
    fontWeight: '800',
  },
  salonName: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  salonContact: {
    color: palette.brand[300],
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
  },
  statusPill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: 'rgba(74,222,128,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.4)',
  },
  statusPillText: {
    color: palette.success[300],
    fontSize: 12,
    fontWeight: '800',
  },

  // ── Date / time grid
  metaGrid: {
    flexDirection: 'row',
    gap: spacing.base,
  },
  meta: {
    flex: 1,
    gap: spacing.xs,
  },
  metaLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  metaValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  metaValue: {
    flex: 1,
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
  },

  // ── Service / price
  serviceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  serviceLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  serviceName: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
    marginTop: spacing.xs,
  },
  serviceMeta: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  priceCol: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  priceLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  priceValue: {
    color: palette.brand[300],
    fontSize: 18,
    fontWeight: '800',
  },

  // ── Address
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  addressText: {
    flex: 1,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
  },

  // ── Footer
  footer: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
    backgroundColor: BG,
  },
});
