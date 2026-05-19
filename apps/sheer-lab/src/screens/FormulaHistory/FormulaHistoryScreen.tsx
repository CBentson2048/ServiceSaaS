import React from 'react';

import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

export function FormulaHistoryScreen(): React.JSX.Element {
  return (
    <LabScreen title="Formula history" eyebrow="Shared client model">
      <PlaceholderText>
        History, client context, and appointment linking will be loaded from the existing Sheer API
        and shared domain contracts.
      </PlaceholderText>
    </LabScreen>
  );
}
