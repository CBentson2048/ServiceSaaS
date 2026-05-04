import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { SALON_OPTIONS } from '../src/domain/mockDirectory';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';
import { labTheme } from '../src/ui/labTheme';

export default function DeviceBindingScreen() {
  const { bindSalon, boundSalon, unbindSalon } = useSheerLabSession();

  async function handleBind(salonId: string) {
    const salon = SALON_OPTIONS.find((option) => option.id === salonId);

    if (!salon) {
      return;
    }

    await bindSalon(salon);
    router.replace('/pin');
  }

  async function handleManagerReset() {
    await unbindSalon();
  }

  return (
    <LabScreen>
      <View style={styles.hero}>
        <StatusPill label="First-run setup" tone="warning" />
        <LabText variant="display" weight="bold">
          Bind this tablet to a salon
        </LabText>
        <LabText variant="body" tone="secondary">
          Sheer Lab is a shared basin device. Binding scopes stylist PINs, formulas, inventory
          usage, billing handoff, and future BLE scale pairing to one salon/location.
        </LabText>
      </View>

      <View style={styles.grid}>
        {SALON_OPTIONS.map((salon) => (
          <Pressable key={salon.id} onPress={() => void handleBind(salon.id)} style={styles.option}>
            <LabText variant="title" weight="bold">
              {salon.name}
            </LabText>
            <LabText tone="secondary">{salon.locationName}</LabText>
            <LabText variant="caption" tone="muted">
              Suggested device: {salon.deviceLabel}
            </LabText>
          </Pressable>
        ))}
      </View>

      <LabCard tone={boundSalon ? 'warning' : 'default'}>
        <View style={styles.managerRow}>
          <View style={styles.managerCopy}>
            <LabText variant="title" weight="bold">
              Manager/admin reset
            </LabText>
            <LabText tone="secondary">
              In production this action should require manager approval before unbinding a shared
              tablet.
            </LabText>
          </View>
          <LabButton
            label={boundSalon ? 'Unbind device' : 'Reset unavailable'}
            variant="danger"
            disabled={!boundSalon}
            onPress={() => void handleManagerReset()}
          />
        </View>
      </LabCard>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  hero: {
    maxWidth: 760,
    gap: 10,
  },
  grid: {
    flexDirection: 'row',
    gap: 16,
    flexWrap: 'wrap',
  },
  option: {
    width: 320,
    minHeight: 180,
    justifyContent: 'space-between',
    backgroundColor: labTheme.colors.surface,
    borderColor: labTheme.colors.borderStrong,
    borderWidth: 1,
    borderRadius: 28,
    padding: 22,
  },
  managerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
  },
  managerCopy: {
    flex: 1,
    gap: 4,
  },
});
