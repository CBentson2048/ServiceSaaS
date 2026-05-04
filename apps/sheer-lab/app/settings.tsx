import { Redirect, router } from 'expo-router';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';

export default function LabSettingsScreen() {
  const { boundSalon, stylistSession, signOutStylist, unbindSalon } = useSheerLabSession();

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/locked" />;
  }

  function handleLogout() {
    signOutStylist();
  }

  async function handleUnbind() {
    await unbindSalon();
    router.replace('/bind');
  }

  return (
    <LabScreen>
      <LabText variant="display" weight="bold">
        Settings and logout
      </LabText>
      <LabCard>
        <LabText variant="title" weight="bold">
          Active session
        </LabText>
        <LabText tone="secondary">
          {stylistSession.stylistName} is signed in as {stylistSession.role}.
        </LabText>
        <StatusPill label="Auto-locks after 10 minutes idle" tone="warning" />
      </LabCard>
      <LabButton label="Logout and lock tablet" onPress={handleLogout} />
      <LabButton
        label="Manager/admin unbind placeholder"
        variant="danger"
        onPress={() => void handleUnbind()}
      />
    </LabScreen>
  );
}
