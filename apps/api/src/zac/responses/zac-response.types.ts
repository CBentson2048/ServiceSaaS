import type { ZacRoleContext } from '../context/zac-context.types';
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
  trace_id: string;
}

/** Operational check response: reachable + which provider would answer. No model call. */
export interface ZacHealthResponse {
  enabled: boolean;
  provider: string;
  model: string;
  ok: boolean;
}
