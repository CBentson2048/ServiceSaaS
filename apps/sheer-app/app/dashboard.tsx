import { router } from 'expo-router';
import { AppButton, Card, Screen, SectionHeader, StatTile } from '@sheer/ui-mobile';

export default function DashboardScreen() {
  return (
    <Screen>
      <SectionHeader
        title="Stylist dashboard"
        subtitle="Personal view of today, performance, bookings, rota, and commissions."
      />
      <StatTile label="Today's bookings" value="6" />
      <StatTile label="Projected commission" value="GBP 124" />
      <Card>
        <SectionHeader
          title="App boundary"
          subtitle="No BLE modules are imported here. Sheer Lab formula and scale workflows live in the separate tablet app and shared lab-core package."
        />
      </Card>
      <AppButton label="Bookings" onPress={() => router.push('/bookings')} />
      <AppButton label="Rota" variant="secondary" onPress={() => router.push('/rota')} />
      <AppButton
        label="Performance"
        variant="secondary"
        onPress={() => router.push('/performance')}
      />
    </Screen>
  );
}
