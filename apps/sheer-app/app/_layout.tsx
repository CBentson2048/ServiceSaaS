import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '@stripe/stripe-react-native';
import { AuthProvider } from '../src/auth/AuthProvider';
import { AppTabBar } from '../src/navigation/AppTabBar';
import { BG } from '../src/design/colors';
import { ThemeProvider } from '../src/design/ThemeProvider';
import { sheerAppTheme } from '../src/design/appTheme';
import { BookingFlowProvider } from '../src/booking/BookingFlowProvider';
import { NotificationsProvider } from '../src/notifications/NotificationsProvider';
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
      {/*
        Mounts THE theme. Every design component reads it through useTheme(),
        and src/design/colors.ts derives its named constants from the same
        object, so a component and a screen's StyleSheet cannot disagree about
        what a border is. Until this was mounted, src/design/components was
        unusable dead code — which is why the screens hand-rolled raw
        StyleSheets and grew a second component library in @sheer/ui-mobile.
      */}
      <ThemeProvider value={sheerAppTheme}>
        <AuthProvider>
        {/*
          Inside AuthProvider because it reads the session, and outside the
          navigator because the alerts badge renders on every screen's tab bar.
        */}
        <NotificationsProvider>
          <BookingFlowProvider>
          <StatusBar style="light" />
          {/*
            THE APP SHELL: routed content and the ONE shared bottom navigation,
            as flex siblings in a column. <AppTabBar /> is mounted here and
            nowhere else — app-shell.spec.ts enforces that, and the reasons the
            position matters, which are invisible from the code:

              - inside AuthProvider: useAuth() THROWS outside it, and there is
                no error boundary above the root layout.
              - inside NotificationsProvider: useNotifications() does NOT throw
                outside it, it returns a dormant { unreadCount: 0 }. The Alerts
                badge would just stop, with a green typecheck.
              - a plain View, never a SafeAreaView and no `edges` prop:
                AppTabBar takes its own bottom inset, so an inset here would
                double-count it.

            Being a flex sibling (rather than an overlay) is also what keeps
            content clear of the bar without any screen adding bottom padding.
          */}
          <View style={s.shell}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: sheerAppTheme.colors.surface },
              headerTintColor: sheerAppTheme.colors.textPrimary,
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
              contentStyle: { backgroundColor: sheerAppTheme.colors.bg },
            }}
          >
            {/*
              EVERY route hides the native header and draws `ScreenHeader`
              instead. Mixing the two is what gave Rota a native "Rota" bar
              stacked on top of its own "My week" heading while Alerts had
              neither and Profile had only the custom one — three title
              treatments across three screens.
            */}
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
            <Stack.Screen name="bookings" options={{ headerShown: false }} />
            <Stack.Screen name="new-booking" options={{ headerShown: false }} />
            <Stack.Screen name="rota" options={{ headerShown: false }} />
            <Stack.Screen name="performance" options={{ headerShown: false }} />
            <Stack.Screen name="notifications" options={{ headerShown: false }} />
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
            <AppTabBar />
          </View>
          </BookingFlowProvider>
          </NotificationsProvider>
        </AuthProvider>
      </ThemeProvider>
    </StripeProvider>
  );
}

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: BG },
});
