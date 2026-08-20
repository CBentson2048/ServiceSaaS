import type { ZacRoleContext } from '../context/zac-context.types';
import type {
  ZacClassificationSource,
  ZacRequestMode,
  ZacRoutingReasonCode,
} from '../routing/zac-request-mode.types';
import type { ZacToolDispatchTrace } from '../tools/zac-tool.types';

/** The seven ZAC response types (decision D19). */
export type ZacResponseType =
  | 'Insight'
  | 'Coaching Point'
  | 'Opportunity'
  | 'Risk'
  | 'Watch Point'
  | 'Explanation'
  | 'Refusal / Insufficient Data';

/** Derived from evidence coverage, never guessed. */
export type ZacConfidence = 'high' | 'medium' | 'low';

/** One evidence reference. Safe handles only (e.g. client_code) — never raw PII. */
export interface ZacEvidenceItem {
  source_type: string;
  source_ref: string;
  as_of: string | null;
  entities_used: string[];
}

/** Seed for later outcome attribution (Observed / Influenced / Directly Attributable). */
export interface ZacAttributionSeed {
  recommendation_ref: string | null;
  attribution_type: 'observed' | 'influenced' | 'directly_attributable';
  metric_to_measure: string | null;
  measurement_window_days: number | null;
}

export type ZacMemoryScope =
  | 'user_private'
  | 'business_owner'
  | 'manager_team_theme'
  | 'stylist_private'
  | 'system_safe_summary';

/** A memory the platform may persist later. Summary only — redaction-safe by construction. */
export interface ZacMemoryUpdate {
  scope: ZacMemoryScope;
  kind: string;
  summary: string;
}

export interface ZacCostMetadata {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number;
  cache_hit: boolean;
}

/**
 * Debug/diagnostic block, deliberately separated from the user-facing `answer`
 * so the primary text reads as product copy, not backend state. Safe metadata
 * only — never prompt or answer text.
 */
export interface ZacTechnicalDetails {
  foundation_mode: boolean;
  /** Always 'enabled' on a served response — a disabled flag never reaches the builder. */
  feature_flag_state: 'enabled';
  connected_tools: string[];
  disabled_tools: string[];
  provider: string;
  model: string;
  /** Set when an intent was recognised but its tool is not connected (e.g. 'staff.members'). */
  detected_intent?: string;
  /** How this turn was answered (closed enum; decided server-side). */
  request_mode?: ZacRequestMode;
  /** Which layer decided the mode: deterministic, semantic, follow-up, fallback or clarification. */
  classification_source?: ZacClassificationSource;
  /** Closed reason code for the routing decision. Never free text, never rationale. */
  reason_code?: ZacRoutingReasonCode;
  /** The semantic classifier's bounded confidence, when one ran. Diagnostics only. */
  semantic_confidence?: number;
  /**
   * False when this deployment is routing on deterministic rules alone (no
   * model provider). Surfaced so a reduced build can never be mistaken for
   * full Phase 1 during UAT.
   */
  semantic_routing_available?: boolean;
}

/**
 * The ZAC wire contract: every /zac/ask answer is exactly this shape (snake_case
 * on the wire, matching how web/mobile will consume it). `tool_calls` carries
 * dispatch metadata only — never tool arguments or result payloads.
 */
export interface ZacResponse {
  answer: string;
  role_context: ZacRoleContext;
  response_type: ZacResponseType;
  evidence: ZacEvidenceItem[];
  confidence: ZacConfidence;
  limitations: string[];
  suggested_next_step: string | null;
  measurement_hook: string | null;
  attribution_seed: ZacAttributionSeed | null;
  memory_updates: ZacMemoryUpdate[];
  tool_calls: ZacToolDispatchTrace[];
  cost_metadata: ZacCostMetadata;
  technical_details: ZacTechnicalDetails;
  trace_id: string;
  /**
   * The persisted conversation this turn belongs to. Clients send it back as
   * `conversationId` to continue the thread. Null only when conversation
   * storage was unavailable and the turn ran stateless (fail-soft).
   */
  conversation_id: string | null;
  /**
   * The persisted output this answer produced — the id feedback is submitted
   * against. Null when the turn produced no meaningful output (acknowledgement,
   * refusal, meta answer) or output storage was unavailable. Stamped by the
   * orchestrator after the measurement flush; opaque to clients.
   */
  output_id?: string | null;
}

/** Wire result of POST /zac/outputs/:outputId/feedback. */
export interface ZacFeedbackResponse {
  output_id: string;
  rating: 'useful' | 'not_useful';
  recorded: true;
}

/** Operational check response: reachable + which provider would answer. No model call. */
export interface ZacHealthResponse {
  enabled: boolean;
  provider: string;
  model: string;
  ok: boolean;
  /** True when a real model can narrate advisory answers (false on the stub). */
  narrates: boolean;
  /** True when Layer 2 semantic intent routing is available AND enabled. */
  semantic_routing: boolean;
  /** The model performing semantic routing, or null when unavailable. */
  router_model: string | null;
  /**
   * Readiness for client acceptance testing. False whenever ZAC would answer
   * without a real provider or without semantic routing — a deployment in that
   * state must not be handed over as Phase 1 complete.
   */
  uat_ready: boolean;
}
