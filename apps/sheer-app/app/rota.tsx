import { EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';

export default function RotaScreen() {
  return (
    <Screen>
      <SectionHeader title="Rota" subtitle="Shifts, breaks, availability, and leave." />
      <EmptyState
        title="Rota placeholder"
        body="This personal app view stays focused on the signed-in stylist's schedule."
      />
    </Screen>
  );
}
