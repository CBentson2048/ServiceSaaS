import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '@stripe/stripe-react-native';
import { AuthProvider } from '../src/auth/AuthProvider';
import { BookingFlowProvider } from '../src/booking/BookingFlowProvider';
import {
  STRIPE_MERCHANT_IDENTIFIER,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_URL_SCHEME,
} from '../src/payments/stripeConfig';

export default function RootLayout() {
  return (
    <StripeProvider
      publishableKey={STRIPE_PUBLISHABLE_KEY}
      urlScheme={STRIPE_URL_SCHEME}
      merchantIdentifier={STRIPE_MERCHANT_IDENTIFIER}
    >
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
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ title: 'Sign in' }} />
            <Stack.Screen name="dashboard" options={{ headerShown: false }} />
            <Stack.Screen name="client/visits" options={{ headerShown: false }} />
            <Stack.Screen name="profile" options={{ headerShown: false }} />
            <Stack.Screen name="bookings" options={{ title: 'Bookings' }} />
            <Stack.Screen name="new-booking" options={{ title: 'New booking' }} />
            <Stack.Screen name="rota" options={{ title: 'Rota' }} />
            <Stack.Screen name="performance" options={{ headerShown: false }} />
            <Stack.Screen name="booking/location" options={{ headerShown: false }} />
            <Stack.Screen name="booking/services" options={{ headerShown: false }} />
            <Stack.Screen name="booking/date-time" options={{ headerShown: false }} />
            <Stack.Screen name="booking/review" options={{ title: 'Review booking' }} />
            <Stack.Screen name="booking/success" options={{ title: 'Booking confirmed' }} />
          </Stack>
        </BookingFlowProvider>
      </AuthProvider>
    </StripeProvider>
  );
}
