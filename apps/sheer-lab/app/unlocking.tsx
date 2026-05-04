import { Redirect, router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { labTheme } from '../src/ui/labTheme';

export default function UnlockingScreen() {
  const { boundSalon, stylistSession } = useSheerLabSession();

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (stylistSession?.role === 'manager') {
        router.replace('/manager');
        return;
      }

      router.replace('/appointments');
    }, 700);

    return () => clearTimeout(timeout);
  }, [stylistSession?.role]);

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/locked" />;
  }

  return (
    <LabScreen scroll={false} contentStyle={styles.content}>
      <View style={styles.panel}>
        <ActivityIndicator color={labTheme.colors.primary} size="large" />
        <LabText variant="heading" weight="bold" align="center">
          Unlocking Lab session
        </LabText>
        <LabText tone="secondary" align="center">
          Loading {stylistSession.role === 'manager' ? 'location operations' : 'your appointments'}
          for {` ${boundSalon.name}`}.
        </LabText>
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    maxWidth: 520,
    alignItems: 'center',
    gap: 14,
  },
});
