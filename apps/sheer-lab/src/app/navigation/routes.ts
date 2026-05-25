import type { StaffBookingPatchTestSummary } from '@sheer/domain';

export interface FormulaEntryContext {
  labSessionId: string;
  appointmentId: string;
  clientProfileId: string;
  clientName: string;
  serviceType: string;
  startsAt: string;
  patchTest?: StaffBookingPatchTestSummary;
}

export type RootStackParamList = {
  DeviceResolving: undefined;
  DeviceRegistration: undefined;
  DeviceBlocked: undefined;
  Auth: undefined;
  Home: undefined;
  DevicePairing: undefined;
  Formula: { entryContext?: FormulaEntryContext } | undefined;
  FormulaHistory: undefined;
  Settings: undefined;
};

export type DeviceStartupRouteName = 'DeviceResolving' | 'DeviceRegistration' | 'DeviceBlocked' | 'Auth';

export const routes = {
  deviceResolving: 'DeviceResolving',
  deviceRegistration: 'DeviceRegistration',
  deviceBlocked: 'DeviceBlocked',
  auth: 'Auth',
  home: 'Home',
  devicePairing: 'DevicePairing',
  formula: 'Formula',
  formulaHistory: 'FormulaHistory',
  settings: 'Settings',
} as const satisfies Record<string, keyof RootStackParamList>;
