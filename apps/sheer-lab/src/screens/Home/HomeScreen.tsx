import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DevicePairingStatus } from '@sheer/domain';
import type React from 'react';

import type { RootStackParamList } from '../../app/navigation/routes';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

type HomeScreenProps = NativeStackScreenProps<RootStackParamList, 'Home'>;

const initialPairingStatus: DevicePairingStatus = 'unpaired';

export function HomeScreen({ navigation }: HomeScreenProps): React.JSX.Element {
  return (
    <LabScreen title="Today in the lab" eyebrow="BLE-ready shell">
      <PlaceholderText>
        This is the staff-facing launch point for scale connection, appointments, and formula
        capture. Current device pairing status: {initialPairingStatus}.
      </PlaceholderText>
      <LabButton
        label="Pair BLE scale"
        onPress={() => navigation.navigate('DevicePairing')}
      />
      <LabButton label="Start formula" onPress={() => navigation.navigate('Formula')} />
      <LabButton
        label="Formula history"
        variant="secondary"
        onPress={() => navigation.navigate('FormulaHistory')}
      />
      <LabButton
        label="Settings"
        variant="secondary"
        onPress={() => navigation.navigate('Settings')}
      />
    </LabScreen>
  );
}
