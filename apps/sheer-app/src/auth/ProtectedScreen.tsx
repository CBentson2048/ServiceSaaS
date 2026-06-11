import { Redirect } from 'expo-router';
import type { UserRole } from '@sheer/domain';
import { AppLoadingScreen } from '../components/AppLoadingScreen';
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
    return <AppLoadingScreen />;
  }

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  if (!allowedRoles.includes(auth.user.role)) {
    return <Redirect href="/login" />;
  }

  return <>{children}</>;
}
