import { createFormulaDraft } from '@sheer/lab-core';
import React from 'react';

import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

const draft = createFormulaDraft({
  id: 'local-placeholder',
  labSessionId: 'pending-session',
});

export function FormulaScreen(): React.JSX.Element {
  return (
    <LabScreen title="Capture formula" eyebrow="Manual fallback ready">
      <PlaceholderText>
        The formula workflow will combine BLE weight capture with manual entry fallback. This
        scaffold uses shared lab-core contracts instead of duplicating formula types in the app.
      </PlaceholderText>
      <PlaceholderText>
        Draft status: {draft.status} · Items: {draft.items.length}
      </PlaceholderText>
    </LabScreen>
  );
}
