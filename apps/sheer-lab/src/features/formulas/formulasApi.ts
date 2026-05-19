import type { FormulaSavePayload } from '@sheer/lab-core';

import { sheerApiClient } from '../../lib/api/client';

export async function startFormula(input: {
  labSessionId: string;
  appointmentId?: string;
  clientProfileId?: string;
}) {
  return sheerApiClient.labFormulas.start(input);
}

export async function saveFormula(payload: FormulaSavePayload) {
  return sheerApiClient.labFormulas.save(payload);
}
