import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '@stripe/stripe-react-native';
import { AuthProvider } from '../src/auth/AuthProvider';
import { BookingFlowProvider } from '../src/booking/BookingFlowProvider';
import { STRIPE_PUBLISHABLE_KEY, STRIPE_URL_SCHEME } from '../src/payments/stripeConfig';

export default function RootLayout() {
  return (
    <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY} urlScheme={STRIPE_URL_SCHEME}>
      <AuthProvider>
        <BookingFlowProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: '#1C1628' },
              headerTintColor: '#ffffff',
              headerTitleStyle: { fontWeight: '600' },
            }}
          >
            <Stack.Screen name="index" options={{ title: 'Sheer App' }} />
            <Stack.Screen name="login" options={{ title: 'Sign in' }} />
            <Stack.Screen name="dashboard" options={{ headerShown: false }} />
            <Stack.Screen name="client/visits" options={{ headerShown: false }} />
            <Stack.Screen name="profile" options={{ headerShown: false }} />
            <Stack.Screen name="bookings" options={{ title: 'Bookings' }} />
            <Stack.Screen name="rota" options={{ title: 'Rota' }} />
            <Stack.Screen name="performance" options={{ title: 'Performance' }} />
            <Stack.Screen name="booking/location" options={{ title: 'Book appointment' }} />
            <Stack.Screen name="booking/services" options={{ title: 'Choose services' }} />
            <Stack.Screen name="booking/upgrades" options={{ title: 'Upgrades' }} />
            <Stack.Screen name="booking/stylist" options={{ title: 'Choose stylist' }} />
            <Stack.Screen name="booking/date-time" options={{ title: 'Choose time' }} />
            <Stack.Screen name="booking/review" options={{ title: 'Review booking' }} />
            <Stack.Screen name="booking/success" options={{ title: 'Booking confirmed' }} />
          </Stack>
        </BookingFlowProvider>
      </AuthProvider>
    </StripeProvider>
  );
}
