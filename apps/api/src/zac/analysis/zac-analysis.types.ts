import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacConsolidationResult } from './zac-priority.types';
import type { ZacToolName } from '../tools/zac-tool.types';

/**
 * WHAT KIND of analysis the user wants, inside `qlooqo_data`.
 *
 * The request mode answers "should this turn read live business data at all?".
 * It cannot answer "how much of the business does this question span?", and
 * that gap is what made the reported defect possible: every live-data question
 * resolved to exactly ONE keyword-matched tool, so a question spanning the
 * whole business matched no keyword and fell through to the capability summary
 * — which says ZAC has no live data.
 */
export type ZacAnalysisIntent =
  | 'specific_metric'
  | 'business_health'
  | 'business_priorities'
  | 'team_priorities'
  | 'diagnostic'
  | 'comparison'
  | 'explanation';

export const ZAC_ANALYSIS_INTENTS: readonly ZacAnalysisIntent[] = [
  'specific_metric',
  'business_health',
  'business_priorities',
  'team_priorities',
  'diagnostic',
  'comparison',
  'explanation',
];

/**
 * Intents whose answer genuinely requires synthesising several sources.
 *
 * `business_health` is deliberately NOT here. "How is my business doing?"
 * already works, already reads live data, and already has an answer shaped for
 * it — turning it into a multi-source synthesis would spend latency and cost
 * changing something that is not broken, and would break the single narrated
 * snapshot the product already accepted. Breadth is earned by the question.
 */
export const ZAC_MULTI_TOOL_INTENTS: readonly ZacAnalysisIntent[] = [
  'business_priorities',
  'team_priorities',
  'diagnostic',
];

/** Closed reason codes — auditable without storing model free text. */
export type ZacAnalysisIntentReason =
  | 'direct_metric_request'
  | 'business_overview_request'
  | 'business_priority_request'
  | 'team_priority_request'
  | 'diagnostic_request'
  | 'comparison_request'
  | 'followup_explanation';

export const ZAC_ANALYSIS_INTENT_REASONS: readonly ZacAnalysisIntentReason[] = [
  'direct_metric_request',
  'business_overview_request',
  'business_priority_request',
  'team_priority_request',
  'diagnostic_request',
  'comparison_request',
  'followup_explanation',
];

/** Which layer decided the analysis intent and the plan. */
export type ZacPlannerSource = 'deterministic' | 'semantic_model' | 'fallback_plan';

/** Evidence domains — small on purpose; enough for planning and ranking. */
export type ZacDataDomain =
  | 'business_health'
  | 'kpi'
  | 'rebooking'
  | 'utilisation'
  | 'team_performance'
  | 'personal_performance'
  | 'appointments'
  // Workstream 1 — Expanded Intelligence.
  | 'services'
  | 'retail'
  | 'client_retention'
  // Workstream 3 — QLab & stock. `colour` is the money side (what colour work
  // costs and earns); `stock` is the shelf side (what is low, idle, or needed
  // for work already booked). Kept separate because an owner asks them as
  // different questions and they carry different permissions.
  | 'colour'
  | 'stock';

/**
 * Safe planning metadata for ONE tool the actor may currently use. Contains no
 * permissions, no identifiers and no data — only what a planner needs to know
 * that a source of evidence exists.
 */
export interface ZacPlanningToolDescriptor {
  name: ZacToolName;
  purpose: string;
  domains: ZacDataDomain[];
}

/** Why a tool is in the plan. Drives ordering and the synthesis framing. */
export type ZacToolPurpose =
  | 'baseline'
  | 'priority_signal'
  | 'diagnostic'
  | 'comparison'
  | 'supporting_evidence';

export type ZacSynthesisStrategy =
  | 'single_metric'
  | 'business_health'
  | 'rank_business_priorities'
  | 'rank_team_priorities'
  | 'diagnostic'
  | 'comparison'
  | 'explanation';

export interface ZacPlannedTool {
  toolName: ZacToolName;
  purpose: ZacToolPurpose;
}

export interface ZacToolPlan {
  analysisIntent: ZacAnalysisIntent;
  tools: ZacPlannedTool[];
  synthesisStrategy: ZacSynthesisStrategy;
  source: ZacPlannerSource;
  /** Model confidence when a model planned it; null otherwise. */
  confidence: number | null;
  /** Tools the model proposed that the server refused, for observability. */
  rejectedTools: string[];
}

/**
 * "Use everything" is bounded. Five is the largest set the Phase 1 catalogue
 * can usefully produce for one question, and the planner is instructed to
 * prefer the smallest sufficient set: more sources cost latency and dilute the
 * answer without adding a priority the owner would act on.
 */
export const MAX_MULTI_TOOL_CALLS = 5;

/** Default number of priorities a broad analysis returns. */
export const DEFAULT_PRIORITY_COUNT = 3;

/**
 * What live capability ACTUALLY exists for this actor, tracked separately from
 * planning so the two can never be confused.
 *
 * The reported defect said "I don't yet have access to your live business data"
 * when five tools were executable. Planning produced nothing; the answer
 * reported that as a connectivity fact. These are different things and are now
 * different values.
 */
export interface ZacLiveCapabilityState {
  registered: ZacToolName[];
  enabled: ZacToolName[];
  permitted: ZacToolName[];
  /** Enabled AND permitted — the set that could actually run right now. */
  executable: ZacToolName[];
}

/** A comparable, source-attributed reading distilled from one tool result. */
export interface ZacEvidenceSignal {
  sourceTool: ZacToolName;
  /**
   * The business ISSUE this reading speaks to, set by the adapter that knows
   * what it measured. "6 of 6 stylists are below the rebooking target" is a KPI
   * reading whose issue is `rebooking` — without this the team's view of a
   * problem and the business's view of the same problem become two priorities.
   */
  issueKey: string;
  /** What the reading covers — 'business', 'team', 'self'. Part of identity. */
  scope: string;
  /** The period the reading covers, when the tool reported one. Part of identity. */
  period: string | null;
  domain: ZacDataDomain | 'revenue' | 'bookings' | 'other';
  metric: string;
  /** Live value, exactly as the tool reported it. Never derived, never guessed. */
  currentValue: number | string | null;
  comparisonValue: number | string | null;
  /** A threshold or target from configuration, or an attributed user goal. */
  targetValue: number | string | null;
  /** Where the target came from — provenance is never lost. */
  targetSource: 'tool_threshold' | 'user_memory_goal' | null;
  direction: 'improving' | 'stable' | 'declining' | 'unknown';
  severity: 'positive' | 'watch' | 'attention';
  confidence: number;
  evidenceRefs: ZacEvidenceItem[];
  limitations: string[];
  /** Deterministic rank aid; higher = more worth the owner's attention. */
  priorityScore: number;
  /** One safe sentence the synthesis may quote verbatim. */
  headline: string;
}

/** One tool's execution outcome inside a multi-tool plan. */
export interface ZacToolExecution {
  toolName: ZacToolName;
  purpose: ZacToolPurpose;
  status: string;
  ok: boolean;
  latencyMs: number;
  /** Honest note when this source could not contribute. */
  limitation: string | null;
}

/** Everything the orchestrator produced for one broad analysis turn. */
export interface ZacOrchestrationResult {
  plan: ZacToolPlan;
  executions: ZacToolExecution[];
  signals: ZacEvidenceSignal[];
  /** Signals grouped into business issues — what the user is actually shown. */
  consolidation?: ZacConsolidationResult;
  capability: ZacLiveCapabilityState;
  /** True when at least one live tool returned usable evidence. */
  hasLiveEvidence: boolean;
}

export function isZacAnalysisIntent(candidate: unknown): candidate is ZacAnalysisIntent {
  return (
    typeof candidate === 'string' && (ZAC_ANALYSIS_INTENTS as readonly string[]).includes(candidate)
  );
}

export function isZacAnalysisIntentReason(
  candidate: unknown,
): candidate is ZacAnalysisIntentReason {
  return (
    typeof candidate === 'string' &&
    (ZAC_ANALYSIS_INTENT_REASONS as readonly string[]).includes(candidate)
  );
}

/** True when this intent's answer needs more than one evidence source. */
export function requiresMultiTool(intent: ZacAnalysisIntent): boolean {
  return ZAC_MULTI_TOOL_INTENTS.includes(intent);
}
