import React from 'react';

import { appConfig } from '../../config/appConfig';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function SettingsScreen(): React.JSX.Element {
  return (
    <LabScreen title="Settings" eyebrow="Native app config">
      <PlaceholderText>
        Environment: {appConfig.environment}. Bundle identifiers and backend URL are centralized
        so they can be changed without touching screen code.
      </PlaceholderText>
    </LabScreen>
  );
}
