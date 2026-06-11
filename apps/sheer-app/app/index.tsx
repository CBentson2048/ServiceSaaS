import { Redirect } from 'expo-router';
import { AppLoadingScreen } from '../src/components/AppLoadingScreen';
import { useAuth } from '../src/auth/AuthProvider';

export default function EntryRoute() {
  const auth = useAuth();

  if (auth.status === 'bootstrapping') {
    return <AppLoadingScreen />;
  }

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // Stylists have no separate dashboard — their home is the performance screen,
  // navigated through the bottom tab bar.
  return <Redirect href={auth.user.role === 'stylist' ? '/performance' : '/dashboard'} />;
}
