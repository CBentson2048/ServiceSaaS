import { Redirect, router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { ScaleStatusBar } from '../src/ble/ScaleStatusBar';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';

export default function FormulaReviewScreen() {
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

      <View style={styles.hero}>
        <StatusPill label="Formula saved" tone="success" />
        <LabText variant="display" weight="bold">
          Formula ready for handoff
        </LabText>
        <LabText tone="secondary">
          The saved result keeps stylist, salon, client, product usage, and charge preview together
          for billing and inventory processing.
        </LabText>
      </View>

      <View style={styles.grid}>
        <LabCard tone="success" style={styles.card}>
          <LabText variant="title" weight="bold">
            Saved formula
          </LabText>
          <LabText tone="secondary">Ava Morgan | Balayage refresh</LabText>
          <LabText tone="secondary">Captured by {stylistSession.stylistName}</LabText>
          <StatusPill label="Formula ID placeholder" tone="success" />
        </LabCard>

        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Billing handoff
          </LabText>
          <LabText tone="secondary">
            GBP 42.50 colour charge prepared for checkout. Production should reconcile against the
            active appointment and POS/billing service.
          </LabText>
          <StatusPill label="Ready to send" tone="success" />
        </LabCard>

        <LabCard style={styles.card}>
          <LabText variant="title" weight="bold">
            Inventory update
          </LabText>
          <LabText tone="secondary">
            Product deductions are staged here so managers can audit scale/manual entries before
            final inventory sync rules are enabled.
          </LabText>
          <StatusPill label="Inventory placeholder" tone="warning" />
        </LabCard>
      </View>

      <View style={styles.actions}>
        <LabButton label="Start another formula" onPress={() => router.replace('/mix')} />
        <LabButton label="Return home" variant="secondary" onPress={() => router.replace('/')} />
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  hero: {
    maxWidth: 820,
    gap: 10,
  },
  grid: {
    flexDirection: 'row',
    gap: 16,
    flexWrap: 'wrap',
  },
  card: {
    width: 340,
    minHeight: 200,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
});
