import type { ZacResourceCategory } from '../policy/zac-policy.types';
import { ZAC_ANALYSIS_INTENTS, type ZacAnalysisIntent } from '../analysis/zac-analysis.types';

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
  | 'privacy_boundary'
  | 'conversational';

export const ZAC_REQUEST_MODES: readonly ZacRequestMode[] = [
  'qlooqo_data',
  'general_advice',
  'hypothetical',
  'memory',
  'permission_capability',
  'privacy_boundary',
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
  | 'privacy_boundary_probe'
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
  'privacy_boundary_probe',
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
 * Which routing pipeline is authoritative for MEANING this deployment.
 *
 * - `legacy`   — the pre-migration hybrid: deterministic layers plus the model
 *                provider's own classifier (Anthropic) where configured.
 * - `shadow`   — legacy still decides every turn; the dedicated semantic
 *                provider (OpenAI) classifies the same turn in parallel and
 *                the two verdicts are recorded for comparison. Observation
 *                only: the shadow verdict can never influence the turn.
 * - `semantic` — the dedicated semantic provider IS Layer 2. Deterministic
 *                explicit directives (Layer 1) and the safe fallback ladder
 *                (Layer 3) are unchanged in every mode.
 */
export type ZacRoutingMode = 'legacy' | 'shadow' | 'semantic';

export const ZAC_ROUTING_MODES: readonly ZacRoutingMode[] = ['legacy', 'shadow', 'semantic'];

/** Parse ZAC_ROUTING_MODE. Anything unrecognised is `legacy` — the safe floor. */
export function parseZacRoutingMode(raw: string | undefined | null): ZacRoutingMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (ZAC_ROUTING_MODES as readonly string[]).includes(value)
    ? (value as ZacRoutingMode)
    : 'legacy';
}

/**
 * The router's own coarse reading of WHAT KIND of analysis a live-data turn
 * wants. `'none'` is mandatory for every non-qlooqo_data mode (a server-side
 * invariant, enforced in validation — never trusted from the model). For
 * qlooqo_data turns it is a HINT to the analysis pipeline and a telemetry
 * fact; the tool planner remains the authority on which tools actually run.
 */
export type ZacRouterAnalysisIntent = ZacAnalysisIntent | 'none';

export const ZAC_ROUTER_ANALYSIS_INTENTS: readonly ZacRouterAnalysisIntent[] = [
  'none',
  ...ZAC_ANALYSIS_INTENTS,
];

export function isZacRouterAnalysisIntent(
  candidate: unknown,
): candidate is ZacRouterAnalysisIntent {
  return (
    typeof candidate === 'string' &&
    (ZAC_ROUTER_ANALYSIS_INTENTS as readonly string[]).includes(candidate)
  );
}

/**
 * Where the ANSWER's information should come from, as the router read the
 * request. Descriptive, never an access decision — `live_qlooqo` still goes
 * through policy and per-dispatch permission checks like every other turn.
 */
export type ZacInformationSource =
  | 'live_qlooqo'
  | 'general_knowledge'
  | 'user_hypothesis'
  | 'zac_memory'
  | 'capability_context'
  | 'none';

export const ZAC_INFORMATION_SOURCES: readonly ZacInformationSource[] = [
  'live_qlooqo',
  'general_knowledge',
  'user_hypothesis',
  'zac_memory',
  'capability_context',
  'none',
];

export function isZacInformationSource(candidate: unknown): candidate is ZacInformationSource {
  return (
    typeof candidate === 'string' &&
    (ZAC_INFORMATION_SOURCES as readonly string[]).includes(candidate)
  );
}

/**
 * The information source each mode is REQUIRED to carry. A verdict that
 * contradicts this is not discarded, but it loses self-consistency and with it
 * the right to be accepted on confidence alone.
 */
export const ZAC_MODE_INFORMATION_SOURCE: Readonly<Record<ZacRequestMode, ZacInformationSource>> = {
  qlooqo_data: 'live_qlooqo',
  general_advice: 'general_knowledge',
  hypothetical: 'user_hypothesis',
  memory: 'zac_memory',
  permission_capability: 'capability_context',
  // A privacy probe is answered from the boundary itself, not from any store.
  privacy_boundary: 'none',
  conversational: 'none',
};

/**
 * The closed confidence vocabulary the semantic provider reports. Buckets
 * rather than a raw number because a strict structured-output schema cannot
 * carry numeric bounds (the exact keyword class that made earlier semantic
 * calls 400 silently), and because bucketed confidence is what the evaluation
 * calibrates (brief §21).
 */
export type ZacConfidenceBucket = 'high' | 'medium' | 'low';

export const ZAC_CONFIDENCE_BUCKETS: readonly ZacConfidenceBucket[] = ['high', 'medium', 'low'];

export function isZacConfidenceBucket(candidate: unknown): candidate is ZacConfidenceBucket {
  return (
    typeof candidate === 'string' &&
    (ZAC_CONFIDENCE_BUCKETS as readonly string[]).includes(candidate)
  );
}

/**
 * Map a bucket onto the measured numeric confidence policy so ONE policy
 * governs both providers:
 *
 *   high   0.9 — above the override bar; may overturn a deterministic shape rule
 *   medium 0.6 — review band; needs corroboration to change the data decision
 *   low    0.3 — below the review floor; the fallback ladder decides
 *
 * These are projections onto the existing, evaluated thresholds — not new
 * thresholds. Recalibration happens against the dataset, per the brief.
 */
export function confidenceBucketScore(bucket: ZacConfidenceBucket): number {
  if (bucket === 'high') return 0.9;
  if (bucket === 'medium') return 0.6;
  return 0.3;
}

/** The reverse projection, for telemetry on numeric (legacy-provider) verdicts. */
export function confidenceScoreBucket(score: number): ZacConfidenceBucket {
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

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
  /**
   * The resource category the model proposed, or null when it proposed none or
   * proposed something outside the closed enum. Policy — not the model — then
   * decides what it means.
   */
  resourceCategory: ZacResourceCategory | null;
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
  /**
   * The router's coarse analysis-intent reading. ALWAYS 'none' for
   * non-qlooqo_data modes — normalised server-side, never trusted from the
   * model. 'none' on a legacy verdict that never carried the field.
   */
  analysisIntent: ZacRouterAnalysisIntent;
  /** Null on legacy verdicts that never carried the field. */
  informationSource: ZacInformationSource | null;
  /** Null on legacy numeric-confidence verdicts. */
  confidenceBucket: ZacConfidenceBucket | null;
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
  /**
   * What the request reaches for, from the deterministic category classifier or
   * the semantic layer. Feeds {@link ZacPolicyService}; never an access grant.
   */
  resourceCategory?: ZacResourceCategory | null;
  /**
   * The router's analysis-intent HINT for the live-data pipeline. 'none'
   * whenever the mode is not qlooqo_data (hard invariant). The tool planner
   * stays authoritative for which tools actually run; this widens the
   * analysis GATE and labels telemetry, nothing more.
   */
  analysisIntent?: ZacRouterAnalysisIntent;
  /** Where the router read the answer as coming from, when it said. */
  informationSource?: ZacInformationSource | null;
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
