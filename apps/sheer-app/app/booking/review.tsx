import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';
import { useStripe } from '@stripe/stripe-react-native';
import type { PublicBookingServiceSummary } from '@sheer/domain';
import { palette, spacing } from '@sheer/design-tokens';
import { AppButton } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { totalDeposit, totalDuration, totalPrice, useBookingFlow } from '../../src/booking/BookingFlowProvider';
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
  if (!slot) return <Redirect href="/booking/date-time" />;

  const deposit = totalDeposit(draft.services);
  const price = totalPrice(draft.services);
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
        <View style={s.header}>
          <Pressable style={({ pressed }) => [s.headerBack, pressed && s.pressed]} onPress={() => router.back()}>
            <Text style={s.headerBackArrow}>‹</Text>
            <Text style={s.headerBackLabel}>Back</Text>
          </Pressable>
          <Text style={s.headerTitle}>Complete your booking</Text>
          <View style={s.headerStep}>
            <Text style={s.headerStepText}>Step 4 of 5</Text>
          </View>
        </View>
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
              <Text style={styles.noticeGlyph}>⚠️</Text>
              <View style={styles.noticeTextWrap}>
                <Text style={styles.noticeTitle}>Action needed</Text>
                <Text style={styles.noticeBody}>{error}</Text>
              </View>
            </View>
          ) : deposit > 0 ? (
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeGlyph}>🔒</Text>
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
              {draft.services.map((service, index) => (
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
              <DetailRow glyph="📍" label="Location" value={location.name} divider={false} />
              <DetailRow glyph="✂️" label="Stylist" value={slot.stylistName} />
              <DetailRow glyph="🗓" label="When" value={formatDateTime(slot.startAt)} />
              <DetailRow glyph="🔔" label="Confirmations" value={preference} />
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
                  ? 'Pay deposit & confirm  →'
                  : 'Confirm booking  →'
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
        <Text style={styles.selectionEmoji}>{serviceEmoji(service)}</Text>
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
  glyph,
  label,
  value,
  divider = true,
}: {
  glyph: string;
  label: string;
  value: string;
  divider?: boolean;
}) {
  return (
    <View>
      {divider ? <View style={styles.divider} /> : null}
      <View style={styles.reviewDetailRow}>
        <Text style={styles.reviewDetailGlyph}>{glyph}</Text>
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

// ── Service emoji (mirrors the services page) ──────────────────────────────────────

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
