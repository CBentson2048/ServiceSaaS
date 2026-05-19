import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import { AuthScreen } from '../../screens/Auth/AuthScreen';
import { DevicePairingScreen } from '../../screens/DevicePairing/DevicePairingScreen';
import { FormulaScreen } from '../../screens/Formula/FormulaScreen';
import { FormulaHistoryScreen } from '../../screens/FormulaHistory/FormulaHistoryScreen';
import { HomeScreen } from '../../screens/Home/HomeScreen';
import { SettingsScreen } from '../../screens/Settings/SettingsScreen';
import { labTheme } from '../../theme/labTheme';
import type { RootStackParamList } from './routes';

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
  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator
        initialRouteName="Auth"
        screenOptions={{
          headerStyle: { backgroundColor: labTheme.colors.background },
          headerTintColor: labTheme.colors.textPrimary,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: labTheme.colors.background },
        }}
      >
        <Stack.Screen name="Auth" component={AuthScreen} options={{ title: 'Sheer Lab' }} />
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Lab Home' }} />
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
