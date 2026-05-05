import { Redirect, router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { ScaleStatusBar } from '../src/ble/ScaleStatusBar';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';

export default function SessionHomeScreen() {
  const { boundSalon, stylistSession, signOutStylist } = useSheerLabSession();

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/locked" />;
  }

  function handleSignOut() {
    signOutStylist();
  }

  return (
    <LabScreen>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <StatusPill label={boundSalon.name} />
          <LabText variant="display" weight="bold">
            Sheer Lab queue
          </LabText>
          <LabText tone="secondary">
            Fast access for basin formulas, colour usage, and billing handoff.
          </LabText>
        </View>
        <LabButton label="End stylist session" variant="secondary" onPress={handleSignOut} />
      </View>

      <ScaleStatusBar />

      <View style={styles.grid}>
        <LabCard tone="accent" style={styles.card}>
          <LabText variant="micro" tone="muted" weight="bold">
            Current stylist
          </LabText>
          <LabText variant="heading" weight="bold">
            {stylistSession.stylistName}
          </LabText>
          <LabText tone="secondary">
            {stylistSession.role === 'manager' ? 'Manager session' : 'Stylist session'} scoped to
            {` ${boundSalon.name}`}
          </LabText>
        </LabCard>

        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Today{"'"}s appointments
          </LabText>
          <LabText tone="secondary">
            Placeholder for booked clients, walk-in lookup, and linking a formula to a service.
          </LabText>
          <StatusPill label="3 colour clients queued" tone="warning" />
        </LabCard>

        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Start new mix
          </LabText>
          <LabText tone="secondary">
            Launch the formula capture flow with client context, ingredient tracking, and billing
            preview.
          </LabText>
          <LabButton label="Start mix" onPress={() => router.push('/mix')} />
        </LabCard>

        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Recent formulas
          </LabText>
          <LabText tone="secondary">
            Rebooked colour clients will surface prior formulas here for quick adjustments.
          </LabText>
          <StatusPill label="Formula history placeholder" />
        </LabCard>

        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Active device
          </LabText>
          <LabText tone="secondary">
            {boundSalon.deviceLabel} at {boundSalon.locationName}
          </LabText>
          <StatusPill label="BLE scale app-local" tone="success" />
        </LabCard>
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 20,
  },
  headerCopy: {
    flex: 1,
    gap: 8,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  card: {
    width: 330,
    minHeight: 188,
  },
});
