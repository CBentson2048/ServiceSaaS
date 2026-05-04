import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LabActivityBoundary } from '../src/session/LabActivityBoundary';
import { SheerLabSessionProvider } from '../src/session/SheerLabSessionProvider';

export default function RootLayout() {
  return (
    <SheerLabSessionProvider>
      <LabActivityBoundary>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#f6f1eb' },
          }}
        />
      </LabActivityBoundary>
    </SheerLabSessionProvider>
  );
}
