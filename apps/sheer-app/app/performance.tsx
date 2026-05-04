import { EmptyState, Screen, SectionHeader, StatTile } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';

export default function PerformanceScreen() {
  return (
    <ProtectedScreen allowedRoles={['stylist']}>
      <Screen>
        <SectionHeader title="Performance" subtitle="Stats, goals, and commission progress." />
        <StatTile label="Retail attach rate" value="34%" />
        <StatTile label="Rebooking rate" value="71%" />
        <EmptyState
          title="Performance placeholder"
          body="Detailed KPIs and commission breakdowns will be wired after the API contracts settle."
        />
      </Screen>
    </ProtectedScreen>
  );
}
