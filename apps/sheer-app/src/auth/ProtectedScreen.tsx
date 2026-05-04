import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { palette, spacing } from '@sheer/design-tokens';
import type { UserRole } from '@sheer/domain';
import { useAuth } from './AuthProvider';

export function ProtectedScreen({
  allowedRoles,
  children,
}: {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}) {
  const auth = useAuth();

  if (auth.status === 'bootstrapping') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={palette.brand[300]} />
        <Text style={styles.loadingText}>Restoring your Sheer session...</Text>
      </View>
    );
  }

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  if (!allowedRoles.includes(auth.user.role)) {
    return <Redirect href="/login" />;
  }

  return <>{children}</>;
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
