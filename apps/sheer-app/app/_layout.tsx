import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../src/auth/AuthProvider';

export default function RootLayout() {
  return (
    <AuthProvider>
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
        <Stack.Screen name="dashboard" options={{ title: 'Dashboard' }} />
        <Stack.Screen name="bookings" options={{ title: 'Bookings' }} />
        <Stack.Screen name="rota" options={{ title: 'Rota' }} />
        <Stack.Screen name="performance" options={{ title: 'Performance' }} />
      </Stack>
    </AuthProvider>
  );
}
