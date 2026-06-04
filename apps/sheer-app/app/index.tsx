import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { palette, spacing } from '@sheer/design-tokens';
import { useAuth } from '../src/auth/AuthProvider';

export default function EntryRoute() {
  const auth = useAuth();

  if (auth.status === 'bootstrapping') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={palette.brand[300]} />
        <Text style={styles.loadingText}>Restoring your stylist session...</Text>
      </View>
    );
  }

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // Stylists have no separate dashboard — their home is the performance screen,
  // navigated through the bottom tab bar.
  return <Redirect href={auth.user.role === 'stylist' ? '/performance' : '/dashboard'} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: palette.ink[950],
  },
  loadingText: {
    color: 'rgba(255,255,255,0.72)',
  },
});
