import React, { createContext, useContext, useMemo } from 'react';

import { appConfig } from '../../config/appConfig';
import { sheerApiClient, type SheerApiClient } from './client';

interface ApiContextValue {
  client: SheerApiClient;
  baseUrl: string;
}

const ApiContext = createContext<ApiContextValue | undefined>(undefined);

interface ApiProviderProps {
  children: React.ReactNode;
}

export function ApiProvider({ children }: ApiProviderProps): React.JSX.Element {
  const value = useMemo<ApiContextValue>(
    () => ({
      client: sheerApiClient,
      baseUrl: appConfig.apiBaseUrl,
    }),
    [],
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiClient(): ApiContextValue {
  const value = useContext(ApiContext);

  if (!value) {
    throw new Error('useApiClient must be used inside ApiProvider');
  }

  return value;
}
