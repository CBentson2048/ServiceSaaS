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

/**
 * The three modes that reason WITHOUT reading operational business data.
 * `answerAdvisory` is the only handler for them and contains no dispatch path.
 */
export type ZacAdvisoryRequestMode = Extract<
  ZacRequestMode,
  'general_advice' | 'hypothetical' | 'conversational'
>;

/**
 * Which layer decided the mode. Closed on purpose: this value is persisted on
 * the telemetry spine and surfaced in `technical_details`, so it must stay
 * machine-readable and stable.
 *
 * - `deterministic`      — Layer 1 matched an explicit, unambiguous instruction.
 * - `semantic_model`     — Layer 2, the semantic intent classifier, decided it.
 * - `contextual_followup`— resolved from the prior turn (short follow-ups).
 * - `fallback`           — Layer 3 safe default (classifier absent/failed/unsure).
 * - `clarification`      — ZAC asked the user which way they meant it.
 */
export type ZacClassificationSource =
  | 'deterministic'
  | 'semantic_model'
  | 'contextual_followup'
  | 'fallback'
  | 'clarification';

/**
 * Closed reason codes. Persisted alongside the mode so routing decisions can be
 * audited without ever storing the model's free text or chain-of-thought.
 */
export type ZacRoutingReasonCode =
  | 'explicit_live_data_request'
  | 'explicit_ignore_live_data'
  | 'hypothetical_scenario'
  | 'general_business_advice'
  | 'user_memory_recall'
  | 'capability_question'
  | 'conversation_followup'
  | 'real_business_analysis'
  | 'ambiguous_business_request';

export const ZAC_ROUTING_REASON_CODES: readonly ZacRoutingReasonCode[] = [
  'explicit_live_data_request',
  'explicit_ignore_live_data',
  'hypothetical_scenario',
  'general_business_advice',
  'user_memory_recall',
  'capability_question',
  'conversation_followup',
  'real_business_analysis',
  'ambiguous_business_request',
];

/**
 * An explicit current-turn instruction about data use. Always wins over
 * keyword inference, over the semantic classifier, and over stale conversation
 * context. `ignore_data` is a hard veto: no code path may reach `qlooqo_data`
 * for that turn.
 */
export type ZacDataInstruction = 'ignore_data' | 'use_data' | null;

/**
 * Why the semantic classifier did not produce the answer. Distinct from
 * operational-data failures on purpose (see the failure taxonomy in
 * ZacAdvisoryFailureReason): "I could not work out what you meant" and
 * "your business data is unavailable" are different truths, and ZAC must
 * never report the second when the first happened.
 */
export type ZacClassifierFailure =
  | 'classification_timeout'
  | 'classification_refused'
  | 'classification_invalid'
  | 'classification_low_confidence'
  | 'provider_unavailable'
  | 'router_disabled';

/** Validated output of one semantic classification call. */
export interface ZacSemanticClassification {
  mode: ZacRequestMode;
  /** 0..1, clamped server-side. Drives the confidence policy, never shown to users. */
  confidence: number;
  requiresLiveBusinessData: boolean;
  reasonCode: ZacRoutingReasonCode;
  /**
   * False when the verdict contradicts itself — e.g. `general_advice` that
   * claims to need live business data. Such a verdict has its confidence capped
   * below the accept threshold rather than being trusted outright.
   */
  selfConsistent: boolean;
}

/** The routing decision for one turn. */
export interface ZacRequestClassification {
  mode: ZacRequestMode;
  source: ZacClassificationSource;
  /** Set when the user explicitly said to ignore/use their real data this turn. */
  dataInstruction: ZacDataInstruction;
  reasonCode: ZacRoutingReasonCode;
  /** Present only when the semantic layer decided (or was consulted). */
  confidence: number | null;
  /** Set when the semantic layer was consulted but did not decide. */
  classifierFailure: ZacClassifierFailure | null;
  /**
   * The semantic layer's own claim about whether live business data is needed,
   * when it made one. Recorded on the spine so routing decisions can be audited
   * against what the classifier actually asserted.
   */
  requiresLiveBusinessData: boolean | null;
  /** Set when `source === 'clarification'`: the one question to ask back. */
  clarificationPrompt?: string;
}

/**
 * A deterministic (Layer 1) verdict. `certain` marks the high-confidence
 * explicit rules that short-circuit before any model call; heuristic verdicts
 * are advisory only and are used by Layer 3 when the semantic layer cannot
 * answer.
 */
export interface ZacDeterministicVerdict {
  mode: ZacRequestMode;
  reasonCode: ZacRoutingReasonCode;
  dataInstruction: ZacDataInstruction;
  certain: boolean;
}

/** Runtime guard for the closed mode enum — the ONLY way model output becomes a mode. */
export function isZacRequestMode(candidate: unknown): candidate is ZacRequestMode {
  return typeof candidate === 'string' && (ZAC_REQUEST_MODES as readonly string[]).includes(candidate);
}

/** Runtime guard for the closed reason-code enum. */
export function isZacRoutingReasonCode(candidate: unknown): candidate is ZacRoutingReasonCode {
  return (
    typeof candidate === 'string' &&
    (ZAC_ROUTING_REASON_CODES as readonly string[]).includes(candidate)
  );
}
