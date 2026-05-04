import type { FormulaStatus } from '@sheer/domain';

export type BleConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export type LabActivityEvent =
  | 'pin_unlock'
  | 'screen_tap'
  | 'formula_editing'
  | 'ble_capture'
  | 'save_action'
  | 'manual_logout';

export interface BleScaleState {
  state: BleConnectionState;
  deviceIdentifier?: string;
  deviceName?: string;
  lastWeightGrams?: number;
  lastChangedAt?: string;
}

export interface FormulaItem {
  id: string;
  productId?: string;
  productName: string;
  targetGrams?: number;
  capturedGrams?: number;
  entryMode: 'ble_scale' | 'manual';
  capturedAt?: string;
  notes?: string;
}

export interface FormulaDraft {
  id: string;
  labSessionId: string;
  appointmentId?: string;
  clientProfileId?: string;
  status: FormulaStatus;
  items: FormulaItem[];
  chargePreviewCents?: number;
  currencyCode: string;
  updatedAt: string;
}

export interface ManualEntryFallback {
  reason: 'scale_unavailable' | 'scale_mismatch' | 'correction' | 'other';
  grams: number;
  note?: string;
}

export interface FormulaSavePayload {
  formulaId: string;
  labSessionId: string;
  items: FormulaItem[];
  manualFallbacks?: ManualEntryFallback[];
  billingHandoffRequested: boolean;
}

export interface LocalFormulaBufferState {
  formulaId: string;
  hasPendingWrites: boolean;
  lastSyncedAt?: string;
  queuedOperations: Array<'add_item' | 'capture_weight' | 'manual_entry' | 'save_formula'>;
}

export interface LabEmbeddingContext {
  surface: 'standalone_lab_app' | 'embedded_sheer_app';
  businessId: string;
  locationId: string;
  userProfileId?: string;
}

export interface BleScaleAdapter {
  getState: () => BleScaleState;
  connect: (deviceIdentifier: string) => Promise<BleScaleState>;
  disconnect: () => Promise<BleScaleState>;
  readWeight: () => Promise<number | null>;
}

export function createFormulaDraft(input: {
  id: string;
  labSessionId: string;
  appointmentId?: string;
  clientProfileId?: string;
  currencyCode?: string;
}): FormulaDraft {
  return {
    id: input.id,
    labSessionId: input.labSessionId,
    appointmentId: input.appointmentId,
    clientProfileId: input.clientProfileId,
    status: 'draft',
    items: [],
    currencyCode: input.currencyCode ?? 'GBP',
    updatedAt: new Date().toISOString(),
  };
}

export function shouldSuspendInactivityLock(event: LabActivityEvent): boolean {
  return event === 'formula_editing' || event === 'ble_capture';
}
