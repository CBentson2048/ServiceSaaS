import { Redirect, router } from 'expo-router';
import { Text, View } from 'react-native';
import { AppButton, Screen } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useBookingFlow } from '../../src/booking/BookingFlowProvider';
import { bookingStyles as styles, formatDateTime, formatMoney } from '../../src/booking/bookingStyles';

export default function BookingSuccessScreen() {
  const { draft, resetDraft } = useBookingFlow();
  const appointment = draft.appointment;

  if (!appointment) return <Redirect href="/dashboard" />;

  function goHome() {
    resetDraft();
    router.replace('/dashboard');
  }

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <Screen>
        <View style={styles.hero}>
          <View style={styles.successMark}>
            <Text style={styles.successMarkText}>✓</Text>
          </View>
          <Text style={styles.eyebrow}>Booking confirmed</Text>
          <Text style={styles.heroTitle}>You’re all set</Text>
          <Text style={styles.heroBody}>Your appointment has been added and the salon has your booking details.</Text>
        </View>
        <View style={styles.panel}>
          <Summary label="When" value={formatDateTime(appointment.scheduledStartAt)} />
          <Summary label="Services" value={appointment.serviceNames.join(', ')} />
          <Summary label="Stylist" value={appointment.stylistName} />
          <Summary label="Duration" value={`${appointment.totalDurationMinutes} min`} />
          <Summary label="Total" value={formatMoney(appointment.totalPriceAmount, appointment.currencyCode)} />
          <Text style={styles.success}>Confirmation complete</Text>
        </View>
        <AppButton label="View appointment" onPress={() => router.replace('/bookings')} />
        <AppButton label="Return home" variant="secondary" onPress={goHome} />
      </Screen>
    </ProtectedScreen>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}
