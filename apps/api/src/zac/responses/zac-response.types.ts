import type { ZacRoleContext } from '../context/zac-context.types';
import type {
  ZacBlockingReason,
  ZacResourceCategory,
  ZacResponseStrategy,
} from '../policy/zac-policy.types';
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
  /** Which routing pipeline is authoritative in this deployment. */
  routing_mode?: 'legacy' | 'shadow' | 'semantic';
  /** The router contract version that decided this turn (e.g. 'semantic-v2'). */
  router_version?: string;
  /**
   * The ROUTER's coarse analysis-intent reading for a qlooqo_data turn —
   * distinct from `analysis_intent`, which is the planner's decision. Present
   * only when the router made one; comparing the two is how planner/router
   * disagreement is audited.
   */
  router_analysis_intent?: string;
  /** Where the router read the answer as coming from (closed enum). */
  information_source?: string;
  /**
   * False when this deployment is routing on deterministic rules alone (no
   * model provider). Surfaced so a reduced build can never be mistaken for
   * full Phase 1 during UAT.
   */
  semantic_routing_available?: boolean;
  /**
   * The TRUE reason this turn could not be fulfilled, selected server-side by
   * precedence — never by whichever response branch matched first. 'none' on a
   * fulfilled answer. This is the field UAT reads to confirm that a privacy
   * boundary was reported as a boundary and not as a connection problem.
   */
  blocking_reason?: ZacBlockingReason;
  /** WHAT the request reached for. Describes the request, never an access grant. */
  resource_category?: ZacResourceCategory | null;
  /** Which closed strategy produced this answer. */
  response_strategy?: ZacResponseStrategy;
  /** True when a FIXED Phase 1 boundary decided the turn before any dispatch. */
  policy_boundary_triggered?: boolean;
  /**
   * True when the actor asked for the rule to be lifted (authority claim,
   * consent claim or an explicit override request). Recorded for audit; it has
   * no effect whatsoever on the decision.
   */
  override_attempted?: boolean;
  /** What kind of analysis this live-data turn needed. */
  analysis_intent?: string;
  /** Which layer decided the analysis and the plan. */
  planner_source?: string;
  planner_confidence?: number;
  /** True when more than one evidence source was gathered for one answer. */
  multi_tool?: boolean;
  tools_considered?: number;
  tools_selected?: string[];
  tools_executed?: number;
  tool_failures?: number;
  /** True when the deterministic plan ran because model planning did not. */
  fallback_plan_used?: boolean;
  evidence_signal_count?: number;
  priority_count?: number;
  /**
   * What this actor could ACTUALLY run this turn. Present on analysis turns so
   * a "no live data" claim can be checked against reality rather than trusted.
   */
  executable_tool_count?: number;
  /** How many priorities the user asked for. The answer never exceeds it. */
  requested_priority_count?: number;
  raw_signal_count?: number;
  consolidated_candidate_count?: number;
  candidate_domains?: string[];
  duplicate_signals_removed?: number;
  signals_merged?: number;
  final_priority_count?: number;
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
  /** Which routing pipeline is authoritative: legacy, shadow or semantic. */
  routing_mode: 'legacy' | 'shadow' | 'semantic';
  /** The dedicated semantic provider's name (e.g. 'openai'), null when none. */
  semantic_provider: string | null;
  /** The dedicated semantic provider's model, null when none is configured. */
  semantic_model: string | null;
  /** The router contract version in force (e.g. 'semantic-v2'). */
  router_version: string;
  /** The versioned v2 prompt in force; null while legacy routing is authoritative. */
  prompt_version: string | null;
  /**
   * Kept for compatibility: semantic routing is CONFIGURED (flag on, provider
   * implements it). It is not evidence that anything works — see
   * `semantic_operational`.
   */
  semantic_routing: boolean;
  /** The model performing semantic routing, or null when unavailable. */
  router_model: string | null;

  // --- The distinctions that stop a config flag masquerading as readiness ---
  /** The provider implements semantic classification at all. */
  semantic_routing_configured: boolean;
  /** ZAC_SEMANTIC_ROUTER_ENABLED (default on). */
  semantic_routing_enabled: boolean;
  /** Every strict tool schema uses only keywords the API accepts. Boot check. */
  semantic_schema_valid: boolean;
  /** ISO timestamp of the last SUCCESSFUL semantic classification, or null. */
  semantic_last_success_at: string | null;
  /** ISO timestamp of the last failure, or null. */
  semantic_last_failure_at: string | null;
  /** Actionable cause: auth, credit, schema, rate_limit, timeout, transport… */
  semantic_last_failure_kind: string | null;
  /** A semantic call has demonstrably worked and nothing hard has failed since. */
  semantic_operational: boolean;
  /**
   * Why the semantic layer is not fully operational, or null when it is.
   * 'never_attempted' on a fresh boot — one real request settles it.
   */
  degraded_reason: string | null;
  /**
   * Readiness for client acceptance testing.
   *
   * Requires EVIDENCE, not configuration: a real narrating provider, semantic
   * routing configured and enabled, valid tool schemas, and a semantic call
   * that has actually succeeded with nothing hard-failing since. This field
   * previously read `true` while every semantic request returned HTTP 400.
   */
  uat_ready: boolean;
}
