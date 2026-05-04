import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#ffffff' },
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
    </>
  );
}
