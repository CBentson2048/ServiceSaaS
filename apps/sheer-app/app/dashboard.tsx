import { router } from 'expo-router';
import { AppButton, Card, Screen, SectionHeader, StatTile } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';

export default function DashboardScreen() {
  const { signOut, user } = useAuth();

  return (
    <ProtectedScreen allowedRoles={['stylist']}>
      <Screen>
        <SectionHeader
          title={`Hi ${user?.profile.fullName.split(' ')[0] ?? 'stylist'}`}
          subtitle="Your personal dashboard, bookings, rota, and performance."
        />
        <StatTile label="Today's bookings" value="6" />
        <StatTile label="Projected commission" value="GBP 124" />
        <Card>
          <SectionHeader
            title="App boundary"
            subtitle="Only stylist-facing areas are available here. Sheer Lab auth remains separate for the shared iPad workflow."
          />
        </Card>
        <AppButton label="Bookings" onPress={() => router.push('/bookings')} />
        <AppButton label="Rota" variant="secondary" onPress={() => router.push('/rota')} />
        <AppButton
          label="Performance"
          variant="secondary"
          onPress={() => router.push('/performance')}
        />
        <AppButton label="Logout" variant="secondary" onPress={() => void signOut()} />
      </Screen>
    </ProtectedScreen>
  );
}
