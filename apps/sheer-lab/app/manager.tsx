import { Redirect, router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { ScaleStatusBar } from '../src/ble/ScaleStatusBar';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';

export default function ManagerLabViewScreen() {
  const { boundSalon, stylistSession } = useSheerLabSession();

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/locked" />;
  }

  if (stylistSession.role !== 'manager') {
    return <Redirect href="/appointments" />;
  }

  return (
    <LabScreen>
      <ScaleStatusBar />
      <View style={styles.header}>
        <View style={styles.copy}>
          <StatusPill label="Manager view" tone="success" />
          <LabText variant="display" weight="bold">
            Location Lab operations
          </LabText>
          <LabText tone="secondary">
            Manager sessions can access all Sheer Lab activity for {boundSalon.name}.
          </LabText>
        </View>
        <LabButton label="Settings / logout" variant="secondary" onPress={() => router.push('/settings')} />
      </View>

      <View style={styles.grid}>
        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Active mixes
          </LabText>
          <LabText tone="secondary">Location-wide mix queue placeholder.</LabText>
          <StatusPill label="4 active" tone="warning" />
        </LabCard>
        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            PIN management
          </LabText>
          <LabText tone="secondary">Assign/reset stylist PINs from manager tools.</LabText>
          <StatusPill label="API scaffolded" />
        </LabCard>
        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Device and scale
          </LabText>
          <LabText tone="secondary">Pairing state for this iPad and salon scale.</LabText>
          <LabButton label="Open device status" onPress={() => router.push('/device')} />
        </LabCard>
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
