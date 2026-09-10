import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useStripe } from '@stripe/stripe-react-native';
import type { PublicBookingServiceSummary } from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton } from '../../src/design';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { ScreenHeader } from '../../src/navigation/ScreenHeader';
import { serviceIcon } from '../../src/booking/serviceIcon';
import { BRAND_LIGHT, DANGER, WARNING } from '../../src/design/colors';
import {
  effectiveServices,
  totalDeposit,
  totalDuration,
  totalPrice,
  useBookingFlow,
} from '../../src/booking/BookingFlowProvider';
import {
  bookingStyles as styles,
  formatDateTime,
  formatDuration,
  formatMoney,
} from '../../src/booking/bookingStyles';
import {
  isStripeConfigured,
  STRIPE_DEFAULT_MERCHANT_COUNTRY,
  STRIPE_URL_SCHEME,
} from '../../src/payments/stripeConfig';
import { BG, BRAND } from '../../src/design/colors';

export default function BookingReviewScreen() {
  const auth = useAuth();
  const stripe = useStripe();
  const accessToken = auth.session?.accessToken ?? '';
  const { draft, updateDraft } = useBookingFlow();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const location = draft.location;
  const slot = draft.selectedSlot;

  if (!location) return <Redirect href="/booking/location" />;
  if (draft.services.length === 0) return <Redirect href="/booking/services" />;
  // A next-available booking has no calendar step — if the slot is missing
  // (deep-link / stale state) send the client back to services to re-resolve it,
  // rather than the date/time picker they intentionally skipped.
  if (!slot)
    return (
      <Redirect
        href={draft.staffRequestMode === 'next_available' ? '/booking/services' : '/booking/date-time'}
      />
    );

  // Per-stylist prices for the stylist resolved for the picked slot (base prices
  // before a slot is picked). Both the price AND the deposit follow these — the
  // deposit gate must match the server, which recomputes a percentage deposit
  // off the stylist's price and rejects a "deposit-free" booking whose deposit
  // is actually > 0.
  const pricedServices = effectiveServices(draft);
  const deposit = totalDeposit(pricedServices);
  const price = totalPrice(pricedServices);
  const duration = totalDuration(draft.services);

  async function confirm() {
    if (!accessToken || !slot) return;
    const selectedLocation = location;
    if (!selectedLocation) return;
    if (deposit > 0 && !isStripeConfigured()) {
      setError('Stripe publishable key is not configured for native mobile payments.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const payload = {
      locationId: selectedLocation.id,
      serviceIds: draft.services.map((service) => service.id),
      staffProfileId: slot.staffProfileId,
      selectedStartAt: slot.startAt,
      staffRequestMode: draft.staffRequestMode,
      communicationPreference: auth.user?.clientCommunicationPreference ?? 'email',
      clientNote: draft.clientNote?.trim() || undefined,
    } as const;
    try {
      if (deposit > 0) {
        const result = await api.startMobileBookingCheckout(accessToken, payload);
        updateDraft({
          bookingAttemptId: result.bookingAttemptId,
          paymentClientSecret: result.clientSecret,
        });
        const initResult = await stripe.initPaymentSheet({
          merchantDisplayName: selectedLocation.name,
          paymentIntentClientSecret: result.clientSecret,
          returnURL: `${STRIPE_URL_SCHEME}://stripe-redirect`,
          // Offer Apple Pay alongside card and Link. The available methods are
          // restricted to card + Link server-side; Apple Pay is a card wallet.
          applePay: {
            merchantCountryCode: selectedLocation.countryCode ?? STRIPE_DEFAULT_MERCHANT_COUNTRY,
          },
          paymentMethodOrder: ['apple_pay', 'card', 'link'],
        });
        if (initResult.error) {
          setError(initResult.error.message);
          return;
        }
        const paymentResult = await stripe.presentPaymentSheet();
        if (paymentResult.error) {
          setError(paymentResult.error.message);
          return;
        }
        const confirmedAttempt = await waitForConfirmedAttempt(accessToken, result.bookingAttemptId);
        if (!confirmedAttempt.appointment) {
          setError('Payment was received, but appointment confirmation is still processing.');
          return;
        }
        updateDraft({ appointment: confirmedAttempt.appointment });
        router.replace('/booking/success');
        return;
      }
      const result = await api.confirmMobileBooking(accessToken, payload);
      updateDraft({ appointment: result.appointment });
      router.replace('/booking/success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Booking failed. Please try another time.');
    } finally {
      setSubmitting(false);
    }
  }

  const preference = formatPreference(auth.user?.clientCommunicationPreference ?? 'email');

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header (matches services / date-time pages) ── */}
        <ScreenHeader
          title="Complete your booking"
          divider={false}
          right={<Text style={s.headerStepText}>Step 4 of 5</Text>}
        />
        {/* Progress underline (step 4 of 5 = 80%) */}
        <View style={s.progressTrack}>
          <View style={s.progressFill} />
        </View>

        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Action-needed / deposit notice ── */}
          {error ? (
            <View style={[styles.noticeBanner, styles.noticeBannerDanger]}>
              <Ionicons name="warning" size={18} color={DANGER} style={styles.noticeGlyph} />
              <View style={styles.noticeTextWrap}>
                <Text style={styles.noticeTitle}>Action needed</Text>
                <Text style={styles.noticeBody}>{error}</Text>
              </View>
            </View>
          ) : deposit > 0 ? (
            <View style={styles.noticeBanner}>
              <Ionicons name="lock-closed" size={18} color={WARNING} style={styles.noticeGlyph} />
              <View style={styles.noticeTextWrap}>
                <Text style={styles.noticeTitle}>Deposit required</Text>
                <Text style={styles.noticeBody}>
                  A {formatMoney(deposit, location.currencyCode)} deposit secures this slot. Your appointment is
                  created only after the payment succeeds, handled securely by Stripe.
                </Text>
              </View>
            </View>
          ) : null}

          {/* ── Your selection ── */}
          <View style={s.sectionGap}>
            <Text style={styles.groupLabel}>Your selection</Text>
            <View style={styles.selectionCard}>
              {/* Each line shows the selected stylist's price once one is chosen. */}
              {pricedServices.map((service, index) => (
                <View key={service.id}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <ServiceLine service={service} />
                </View>
              ))}
            </View>
          </View>

          {/* ── Appointment details ── */}
          <View style={s.sectionGap}>
            <Text style={styles.groupLabel}>Appointment details</Text>
            <View style={styles.selectionCard}>
              <DetailRow icon="location" label="Location" value={location.name} divider={false} />
              <DetailRow icon="cut" label="Stylist" value={slot.stylistName} />
              <DetailRow icon="calendar" label="When" value={formatDateTime(slot.startAt)} />
              <DetailRow icon="notifications" label="Confirmations" value={preference} />
            </View>
          </View>

          {/* ── Optional note ── */}
          <View style={s.sectionGap}>
            <Text style={styles.groupLabel}>Note for the salon</Text>
            <TextInput
              placeholder="Anything your stylist should know? (optional)"
              placeholderTextColor="rgba(255,255,255,0.4)"
              value={draft.clientNote ?? ''}
              onChangeText={(clientNote) => updateDraft({ clientNote })}
              multiline
              style={styles.input}
            />
          </View>
        </ScrollView>

        {/* ── Pinned footer: total estimate + confirm ── */}
        <SafeAreaView edges={['bottom']} style={s.footer}>
          <View style={styles.totalBar}>
            <View style={styles.flex}>
              <Text style={styles.totalBarLabel}>{deposit > 0 ? 'Due today' : 'Total estimate'}</Text>
              <Text style={styles.totalBarValue}>
                {deposit > 0
                  ? formatMoney(deposit, location.currencyCode)
                  : formatMoney(price, location.currencyCode)}
              </Text>
              {deposit > 0 ? (
                <Text style={styles.totalBarDuration}>
                  {formatMoney(price, location.currencyCode)} total · {formatDuration(duration)}
                </Text>
              ) : (
                <Text style={styles.totalBarDuration}>Est. duration · {formatDuration(duration)}</Text>
              )}
            </View>
          </View>
          <AppButton
            label={
              submitting
                ? 'Confirming...'
                : deposit > 0
                  ? 'Pay deposit & confirm'
                  : 'Confirm booking'
            }
            trailingIcon={
              submitting ? undefined : <Ionicons name="arrow-forward" size={16} color={palette.white} />
            }
            disabled={submitting}
            onPress={() => void confirm()}
          />
        </SafeAreaView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Selected-service line ─────────────────────────────────────────────────────────

function ServiceLine({ service }: { service: PublicBookingServiceSummary }) {
  return (
    <View style={styles.selectionRow}>
      <View style={styles.selectionIcon}>
        <Ionicons name={serviceIcon(service)} size={20} color={BRAND_LIGHT} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.selectionName} numberOfLines={2}>
          {service.name}
        </Text>
        <Text style={styles.selectionMeta}>{formatDuration(service.estimatedDurationMinutes)}</Text>
      </View>
      <Text style={styles.selectionPrice}>{formatMoney(service.startingPriceAmount, service.currencyCode)}</Text>
    </View>
  );
}

// ── Appointment detail row ──────────────────────────────────────────────────────

function DetailRow({
  icon,
  label,
  value,
  divider = true,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
  divider?: boolean;
}) {
  return (
    <View>
      {divider ? <View style={styles.divider} /> : null}
      <View style={styles.reviewDetailRow}>
        <View style={styles.reviewDetailGlyph}>
          <Ionicons name={icon} size={16} color={palette.brand[300]} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.reviewDetailLabel}>{label}</Text>
          <Text style={styles.reviewDetailValue}>{value}</Text>
        </View>
      </View>
    </View>
  );
}

async function waitForConfirmedAttempt(
  accessToken: string,
  bookingAttemptId: string,
) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await api.getMobileBookingAttempt(accessToken, bookingAttemptId);
    if (result.bookingAttempt.status === 'confirmed' && result.bookingAttempt.appointment) {
      return result.bookingAttempt;
    }
    if (result.bookingAttempt.status === 'payment_failed') {
      throw new Error('Payment failed, so the booking was not confirmed.');
    }
    await delay(1000);
  }
  throw new Error('Payment was received, but confirmation is still processing. Please check your bookings shortly.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatPreference(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── Screen styles ──────────────────────────────────────────────────────────────

const BORDER_MED = 'rgba(255,255,255,0.11)';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header
  headerStepText: { color: 'rgba(255,255,255,0.4)', fontSize: 13, fontWeight: '700' },

  // ── Progress underline (step 4 of 5 = 80%)
  progressTrack: { height: 3, backgroundColor: BORDER_MED },
  progressFill: { width: '80%', height: 3, backgroundColor: BRAND },

  // ── Scroll body
  scroll: {
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  sectionGap: { gap: spacing.md },

  // ── Pinned footer
  footer: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
    backgroundColor: BG,
  },
});
