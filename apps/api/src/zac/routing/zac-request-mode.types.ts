/**
 * The closed set of ZAC request modes. The mode decides HOW a question is
 * answered — which pipeline runs and whether any QLOOQO tool may execute.
 * It never decides WHAT the actor is authorised to access: tool-level
 * role/permission checks re-run on every dispatch regardless of mode.
 */
export type ZacRequestMode =
  | 'qlooqo_data'
  | 'general_advice'
  | 'hypothetical'
  | 'memory'
  | 'permission_capability'
  | 'conversational';

export const ZAC_REQUEST_MODES: readonly ZacRequestMode[] = [
  'qlooqo_data',
  'general_advice',
  'hypothetical',
  'memory',
  'permission_capability',
  'conversational',
];

/** Who decided the mode — deterministic rules, the model, or the safe default. */
export type ZacClassificationSource = 'deterministic' | 'model' | 'fallback';

/**
 * An explicit current-turn instruction about data use. Always wins over
 * keyword inference and over stale conversation context.
 */
export type ZacDataInstruction = 'ignore_data' | 'use_data' | null;

export interface ZacRequestClassification {
  mode: ZacRequestMode;
  source: ZacClassificationSource;
  /** Set when the user explicitly said to ignore/use their real data this turn. */
  dataInstruction: ZacDataInstruction;
}
