import { EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';

export default function RotaScreen() {
  return (
    <ProtectedScreen allowedRoles={['stylist']}>
      <Screen>
        <SectionHeader title="Rota" subtitle="Shifts, breaks, availability, and leave." />
        <EmptyState
          title="Rota placeholder"
          body="This personal app view stays focused on the signed-in stylist's schedule."
        />
      </Screen>
    </ProtectedScreen>
  );
}
