import React from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiProvider } from '../../lib/api/ApiProvider';
import { labTheme } from '../../theme/labTheme';

interface AppProvidersProps {
  children: React.ReactNode;
}

export function AppProviders({ children }: AppProvidersProps): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ApiProvider>
        <StatusBar
          barStyle="light-content"
          backgroundColor={labTheme.colors.background}
        />
        {children}
      </ApiProvider>
    </SafeAreaProvider>
  );
}
