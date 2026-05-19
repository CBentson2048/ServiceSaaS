import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useApiClient } from '../../lib/api/ApiProvider';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

type AuthScreenProps = NativeStackScreenProps<RootStackParamList, 'Auth'>;

export function AuthScreen({ navigation }: AuthScreenProps): React.JSX.Element {
  const api = useApiClient();

  return (
    <LabScreen title="Unlock Sheer Lab" eyebrow="Staff workflow">
      <PlaceholderText>
        Auth is scaffolded for the shared Sheer backend. The next task can add device
        registration, PIN unlock, token storage, and session refresh using the shared API client.
      </PlaceholderText>
      <PlaceholderText>API base URL: {api.baseUrl}</PlaceholderText>
      <LabButton label="Continue to lab home" onPress={() => navigation.replace('Home')} />
    </LabScreen>
  );
}
