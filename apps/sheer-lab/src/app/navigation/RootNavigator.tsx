import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type React from 'react';

import { AuthScreen } from '../../screens/Auth/AuthScreen';
import { DeviceBlockedScreen } from '../../screens/DeviceBlocked/DeviceBlockedScreen';
import { DevicePairingScreen } from '../../screens/DevicePairing/DevicePairingScreen';
import { DeviceRegistrationScreen } from '../../screens/DeviceRegistration/DeviceRegistrationScreen';
import { DeviceResolvingScreen } from '../../screens/DeviceResolving/DeviceResolvingScreen';
import { FormulaScreen } from '../../screens/Formula/FormulaScreen';
import { FormulaHistoryScreen } from '../../screens/FormulaHistory/FormulaHistoryScreen';
import { HomeScreen } from '../../screens/Home/HomeScreen';
import { NewMixScreen } from '../../screens/NewMix/NewMixScreen';
import { SettingsScreen } from '../../screens/Settings/SettingsScreen';
import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { labTheme } from '../../theme/labTheme';
import type { DeviceStartupRouteName, RootStackParamList } from './routes';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: labTheme.colors.background,
    card: labTheme.colors.surface,
    primary: labTheme.colors.primary,
    text: labTheme.colors.textPrimary,
    border: labTheme.colors.border,
  },
};

export function RootNavigator(): React.JSX.Element {
  const { resolution } = useDeviceSession();
  const routeName = getStartupRouteName(resolution.status);

  return (
    <NavigationContainer key={routeName} theme={navigationTheme}>
      <Stack.Navigator
        initialRouteName={routeName}
        screenOptions={{
          headerStyle: { backgroundColor: labTheme.colors.background },
          headerTintColor: labTheme.colors.textPrimary,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: labTheme.colors.background },
        }}
      >
        <Stack.Screen
          name="DeviceResolving"
          component={DeviceResolvingScreen}
          options={{ title: 'Sheer Lab' }}
        />
        <Stack.Screen
          name="DeviceRegistration"
          component={DeviceRegistrationScreen}
          options={{ title: 'Register Device' }}
        />
        <Stack.Screen
          name="DeviceBlocked"
          component={DeviceBlockedScreen}
          options={{ title: 'Device Blocked' }}
        />
        <Stack.Screen name="Auth" component={AuthScreen} options={{ title: 'Sheer Lab', headerShown: false }} />
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Lab Home', headerShown: false }} />
        <Stack.Screen name="NewMix" component={NewMixScreen} options={{ title: 'New Mix', headerShown: false }} />
        <Stack.Screen
          name="DevicePairing"
          component={DevicePairingScreen}
          options={{ title: 'Device Pairing' }}
        />
        <Stack.Screen name="Formula" component={FormulaScreen} options={{ title: 'Formula' }} />
        <Stack.Screen
          name="FormulaHistory"
          component={FormulaHistoryScreen}
          options={{ title: 'Formula History' }}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function getStartupRouteName(status: ReturnType<typeof useDeviceSession>['resolution']['status']): DeviceStartupRouteName {
  if (status === 'ready') return 'Auth';
  if (status === 'unregistered') return 'DeviceRegistration';
  if (status === 'disabled' || status === 'registration_required') return 'DeviceBlocked';
  return 'DeviceResolving';
}
