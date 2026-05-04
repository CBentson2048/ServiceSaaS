import { EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';

export default function BookingsScreen() {
  return (
    <Screen>
      <SectionHeader title="Bookings" subtitle="Upcoming appointments and client notes." />
      <EmptyState
        title="Bookings placeholder"
        body="This screen will show the stylist's own active and upcoming appointments."
      />
    </Screen>
  );
}
