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
              headerTitleAlign: 'center',
              // Show only the chevron on the back button — never the previous
              // route's title. Without this, pushing `login` from a header-less
              // route (e.g. booking/date-time) leaked the raw segment
              // "booking/date-time" as the back label.
              headerBackButtonDisplayMode: 'minimal',
              headerShadowVisible: false,
              // Unify the body background under every native-header screen with
              // the dark surface the custom-header screens already use.
              contentStyle: { backgroundColor: '#18141F' },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            {/* Auth screens own their immersive, branded canvas + back control. */}
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="signup" options={{ headerShown: false }} />
            <Stack.Screen name="dashboard" options={{ headerShown: false }} />
            <Stack.Screen name="zac" options={{ headerShown: false }} />
            <Stack.Screen name="client/visits" options={{ headerShown: false }} />
            <Stack.Screen name="client/visit-detail" options={{ headerShown: false }} />
            <Stack.Screen name="profile" options={{ headerShown: false }} />
            <Stack.Screen name="my-pay" options={{ headerShown: false }} />
            <Stack.Screen name="pay-summary" options={{ headerShown: false }} />
            <Stack.Screen name="salon-detail" options={{ headerShown: false }} />
            <Stack.Screen name="manage-appointment" options={{ headerShown: false }} />
            <Stack.Screen name="reschedule" options={{ headerShown: false }} />
            <Stack.Screen name="bookings" options={{ title: 'Bookings' }} />
            <Stack.Screen name="new-booking" options={{ title: 'New booking' }} />
            <Stack.Screen name="rota" options={{ title: 'Rota' }} />
            <Stack.Screen name="performance" options={{ headerShown: false }} />
            <Stack.Screen name="booking/location" options={{ headerShown: false }} />
            <Stack.Screen name="booking/services" options={{ headerShown: false }} />
            <Stack.Screen name="booking/date-time" options={{ headerShown: false }} />
            {/*
              The booking flow owns its own in-content step header (back, title,
              "Step X of 5", progress bar) on every step, so the native header is
              hidden across the whole flow. Showing it here produced a double
              header on review/success. success also disables the back gesture so
              the user can't swipe back into the just-completed booking.
            */}
            <Stack.Screen name="booking/review" options={{ headerShown: false }} />
            <Stack.Screen
              name="booking/success"
              options={{ headerShown: false, gestureEnabled: false }}
            />
          </Stack>
        </BookingFlowProvider>
      </AuthProvider>
    </StripeProvider>
  );
}
