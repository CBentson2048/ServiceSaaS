import { Redirect, router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { ScaleStatusBar } from '../src/ble/ScaleStatusBar';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';

export default function ActiveAppointmentsScreen() {
  const { boundSalon, stylistSession } = useSheerLabSession();

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/locked" />;
  }

  return (
    <LabScreen>
      <ScaleStatusBar />
      <View style={styles.header}>
        <View style={styles.copy}>
          <StatusPill label="Stylist view" />
          <LabText variant="display" weight="bold">
            Today{"'"}s appointments
          </LabText>
          <LabText tone="secondary">
            Showing appointments for {stylistSession.stylistName} at {boundSalon.name}.
          </LabText>
        </View>
        <LabButton label="Settings / logout" variant="secondary" onPress={() => router.push('/settings')} />
      </View>

      <View style={styles.grid}>
        {['Ava Morgan', 'Leah Brooks', 'Mina Shah'].map((clientName) => (
          <LabCard key={clientName} style={styles.card}>
            <LabText variant="title" weight="bold">
              {clientName}
            </LabText>
            <LabText tone="secondary">Colour service ready for formula capture.</LabText>
            <LabButton label="Start formula" onPress={() => router.push('/mix')} />
          </LabCard>
        ))}
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 18,
  },
  copy: {
    flex: 1,
    gap: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  card: {
    width: 320,
  },
});
