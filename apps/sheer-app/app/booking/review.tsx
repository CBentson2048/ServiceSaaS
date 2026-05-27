import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { useStripe } from '@stripe/stripe-react-native';
import { AppButton, Card, Screen, SectionHeader } from '@sheer/ui-mobile';
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
import { isStripeConfigured, STRIPE_URL_SCHEME } from '../../src/payments/stripeConfig';

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

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <Screen>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Step 6 of 6</Text>
          <Text style={styles.heroTitle}>Review and confirm</Text>
          <Text style={styles.heroBody}>
            We’ll re-check the slot before confirming. Deposit payments are handled securely by Stripe.
          </Text>
        </View>
        {error ? (
          <Card>
            <Text style={styles.title}>Action needed</Text>
            <Text style={styles.error}>{error}</Text>
          </Card>
        ) : null}
        <View style={styles.panel}>
          <Summary label="Location" value={location.name} />
          <Summary label="Services" value={draft.services.map((service) => service.name).join(', ')} />
          <Summary label="Stylist" value={slot.stylistName} />
          <Summary label="When" value={formatDateTime(slot.startAt)} />
          <Summary label="Duration" value={formatDuration(totalDuration(draft.services))} />
          <Summary label="Estimated total" value={formatMoney(totalPrice(draft.services), location.currencyCode)} />
          <Summary
            label="Deposit"
            value={deposit > 0 ? formatMoney(deposit, location.currencyCode) : 'No deposit required'}
          />
          <Summary
            label="Preference"
            value={formatPreference(auth.user?.clientCommunicationPreference ?? 'email')}
          />
        </View>
        <TextInput
          placeholder="Optional note for the salon"
          placeholderTextColor="rgba(255,255,255,0.45)"
          value={draft.clientNote ?? ''}
          onChangeText={(clientNote) => updateDraft({ clientNote })}
          multiline
          style={styles.input}
        />
        <View style={styles.totalCard}>
          <Text style={styles.eyebrow}>{deposit > 0 ? 'Secure deposit' : 'Confirmation'}</Text>
          <Text style={styles.totalValue}>
            {deposit > 0 ? formatMoney(deposit, location.currencyCode) : 'No payment due today'}
          </Text>
          <Text style={styles.subtitle}>
            {deposit > 0
              ? 'Your appointment is created only after the payment succeeds.'
              : 'We will confirm this appointment after a final availability check.'}
          </Text>
        </View>
        <AppButton
          label={submitting ? 'Confirming...' : deposit > 0 ? 'Pay deposit and confirm' : 'Confirm booking'}
          disabled={submitting}
          onPress={() => void confirm()}
        />
      </Screen>
    </ProtectedScreen>
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

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function formatPreference(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
