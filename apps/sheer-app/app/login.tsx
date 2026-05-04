import { router } from 'expo-router';
import { AppButton, Card, Screen, SectionHeader } from '@sheer/ui-mobile';

export default function LoginScreen() {
  return (
    <Screen>
      <SectionHeader
        title="Sheer App"
        subtitle="Personal stylist login placeholder. BLE scale workflows are intentionally not part of this app."
      />
      <Card>
        <SectionHeader
          title="Sign in"
          subtitle="Production auth will use normal personal credentials. Biometric login can be added in V2."
        />
        <AppButton label="Continue to dashboard" onPress={() => router.replace('/dashboard')} />
      </Card>
    </Screen>
  );
}
