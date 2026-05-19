export type RootStackParamList = {
  Auth: undefined;
  Home: undefined;
  DevicePairing: undefined;
  Formula: undefined;
  FormulaHistory: undefined;
  Settings: undefined;
};

export const routes = {
  auth: 'Auth',
  home: 'Home',
  devicePairing: 'DevicePairing',
  formula: 'Formula',
  formulaHistory: 'FormulaHistory',
  settings: 'Settings',
} as const satisfies Record<string, keyof RootStackParamList>;
