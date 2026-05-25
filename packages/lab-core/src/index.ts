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
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  targetGrams?: number;
  capturedGrams?: number;
  wasteGrams?: number;
  entryMode: 'ble_scale' | 'manual';
  capturedAt?: string;
  costPerGramCents?: number;
  costCents?: number;
  wasteCostCents?: number;
  notes?: string;
}

export interface FormulaClientContext {
  clientProfileId?: string;
  clientName?: string;
}

export interface FormulaVisitContext {
  appointmentId?: string;
  visitId?: string;
  serviceType?: string;
}

export interface FormulaDraft {
  id: string;
  labSessionId: string;
  appointmentId?: string;
  visitId?: string;
  businessId?: string;
  locationId?: string;
  clientProfileId?: string;
  client?: FormulaClientContext;
  visit?: FormulaVisitContext;
  sourceFormulaId?: string;
  status: FormulaStatus;
  items: FormulaItem[];
  chargePreviewCents?: number;
  totalCostCents?: number;
  totalWasteCostCents?: number;
  billableChargeCents?: number;
  billingStatus?: 'not_requested' | 'applied' | 'skipped' | 'failed';
  inventoryStatus?: 'not_requested' | 'applied' | 'partial' | 'failed';
  currencyCode: string;
  savedAt?: string;
  createdAt?: string;
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
  appointmentId?: string;
  visitId?: string;
  businessId?: string;
  locationId?: string;
  clientProfileId?: string;
  sourceFormulaId?: string;
  items: FormulaItem[];
  manualFallbacks?: ManualEntryFallback[];
  totalCostCents?: number;
  totalWasteCostCents?: number;
  billableChargeCents?: number;
  currencyCode?: string;
  billingHandoffRequested: boolean;
  inventoryDeductionRequested?: boolean;
  finalizeRequested?: boolean;
}

export interface FormulaHistoryRecord extends FormulaDraft {
  status: Extract<FormulaStatus, 'saved'>;
  savedAt: string;
}

export interface FormulaHistoryResponse {
  formulas: FormulaHistoryRecord[];
}

export interface FormulaDuplicatePayload {
  sourceFormulaId: string;
  labSessionId: string;
  appointmentId?: string;
  visitId?: string;
  clientProfileId?: string;
}

export type FormulaBillingMode = 'cost_only' | 'cost_plus_markup_percent' | 'fixed_uplift';

export interface FormulaBillingRule {
  mode: FormulaBillingMode;
  markupPercent?: number;
  fixedUpliftCents?: number;
  autoBillFormulaOnSave: boolean;
  rebillFormulaOnEdit: boolean;
  combineFormulasIntoSingleCharge: boolean;
}

export interface FormulaBillingBreakdown {
  formulaId: string;
  actualCostCents: number;
  billableChargeCents: number;
  currencyCode: string;
}

export interface FormulaSaveResult extends FormulaHistoryRecord {
  billingLineItem?: {
    visitId: string;
    amountCents: number;
    currencyCode: string;
    formulaBreakdown: FormulaBillingBreakdown[];
    updatedAt: string;
  };
  inventoryMovements: Array<{
    productId: string;
    quantityDeltaGrams: number;
    remainingQuantityGrams?: number;
    movementType: 'formula_usage' | 'formula_waste' | 'formula_reversal';
  }>;
  lowStockAlerts: Array<{
    productId: string;
    remainingQuantityGrams: number;
    thresholdQuantityGrams: number;
  }>;
}

export function calculateFormulaBillableChargeCents(
  actualCostCents: number,
  rule: FormulaBillingRule,
): number {
  if (rule.mode === 'cost_only') return Math.max(0, Math.round(actualCostCents));

  if (rule.mode === 'fixed_uplift') {
    return Math.max(0, Math.round(actualCostCents + (rule.fixedUpliftCents ?? 0)));
  }

  return Math.max(0, Math.round(actualCostCents * (1 + (rule.markupPercent ?? 0) / 100)));
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
