import type { StaffBookingPatchTestSummary } from '@sheer/domain';

export interface FormulaEntryContext {
  labSessionId: string;
  // Optional so a walk-in session (no booking / no client profile yet) can
  // start a formula. Appointment-backed mixes still pass these.
  appointmentId?: string;
  clientProfileId?: string;
  clientName: string;
  serviceType: string;
  startsAt?: string;
  patchTest?: StaffBookingPatchTestSummary;
}

export type RootStackParamList = {
  DeviceResolving: undefined;
  DeviceRegistration: undefined;
  DeviceBlocked: undefined;
  Auth: undefined;
  Home: undefined;
  NewMix: undefined;
  DevicePairing: undefined;
  BuildFormula: { entryContext: FormulaEntryContext };
  UpdateFormula: { entryContext: FormulaEntryContext; sourceFormulaId: string };
  Formula: { entryContext?: FormulaEntryContext } | undefined;
  MixFinalized: undefined;
  FormulaHistory: undefined;
  Inventory: undefined;
  BillingRules: undefined;
  Settings: undefined;
};

export type DeviceStartupRouteName = 'DeviceResolving' | 'DeviceRegistration' | 'DeviceBlocked' | 'Auth';

export const routes = {
  deviceResolving: 'DeviceResolving',
  deviceRegistration: 'DeviceRegistration',
  deviceBlocked: 'DeviceBlocked',
  auth: 'Auth',
  home: 'Home',
  newMix: 'NewMix',
  devicePairing: 'DevicePairing',
  buildFormula: 'BuildFormula',
  updateFormula: 'UpdateFormula',
  formula: 'Formula',
  mixFinalized: 'MixFinalized',
  formulaHistory: 'FormulaHistory',
  inventory: 'Inventory',
  billingRules: 'BillingRules',
  settings: 'Settings',
} as const satisfies Record<string, keyof RootStackParamList>;
