import { Redirect, router } from 'expo-router';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';
import { ScaleStatusBar } from '../src/ble/ScaleStatusBar';

export default function DeviceStatusScreen() {
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
      <LabText variant="display" weight="bold">
        Device and scale status
      </LabText>
      <LabCard>
        <LabText variant="title" weight="bold">
          Shared device
        </LabText>
        <LabText tone="secondary">
          {boundSalon.deviceLabel} is bound to {boundSalon.name} / {boundSalon.locationName}.
        </LabText>
        <StatusPill label="Shared device API scaffolded" tone="success" />
      </LabCard>
      <LabCard>
        <LabText variant="title" weight="bold">
          BLE scale
        </LabText>
        <LabText tone="secondary">
          Production BLE adapter will implement connect, reconnect, read weight, pair, and unpair.
        </LabText>
        <StatusPill label="Reconnect placeholder" tone="warning" />
      </LabCard>
      <LabButton label="Back" variant="secondary" onPress={() => router.back()} />
    </LabScreen>
  );
}
