import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { LabText } from '../src/ui/LabText';
import { labTheme } from '../src/ui/labTheme';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';

export default function EntryRoute() {
  const { isHydrating, boundSalon, stylistSession } = useSheerLabSession();

  if (isHydrating) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={labTheme.colors.primary} />
        <LabText tone="secondary">Preparing Sheer Lab tablet...</LabText>
      </View>
    );
  }

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/locked" />;
  }

  if (stylistSession.role === 'manager') {
    return <Redirect href="/manager" />;
  }

  return <Redirect href="/appointments" />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: labTheme.colors.bg,
  },
});
