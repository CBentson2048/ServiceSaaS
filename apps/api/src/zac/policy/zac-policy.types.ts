import type { ZacRequestMode } from '../routing/zac-request-mode.types';

/**
 * WHY a request cannot be fulfilled — the closed, server-selected taxonomy.
 *
 * This type exists because ZAC used to state whichever reason the matching
 * response branch happened to carry, which let a low-priority availability
 * message ("staff data isn't connected") stand in front of a high-priority
 * privacy invariant. A reason is now RESOLVED from evaluated state and ranked,
 * never implied by control flow, and never invented by a model.
 *
 * The distinctions are product-critical, not cosmetic:
 *  - a fixed boundary never disappears, whatever changes;
 *  - a permission denial could change if an admin grants access;
 *  - an unsupported capability could change when Phase 2 ships it;
 *  - unavailable data could change when the data arrives.
 * Saying the wrong one tells the user something untrue about their own product.
 */
export type ZacBlockingReason =
  | 'private_coaching_boundary'
  | 'cross_business_boundary'
  | 'cross_actor_private_boundary'
  | 'location_scope_boundary'
  | 'permission_denied'
  | 'phase1_read_only_boundary'
  | 'unsupported_capability'
  | 'data_unavailable'
  | 'tool_unavailable'
  | 'provider_unavailable'
  | 'classification_failure'
  | 'none';

export const ZAC_BLOCKING_REASONS: readonly ZacBlockingReason[] = [
  'private_coaching_boundary',
  'cross_business_boundary',
  'cross_actor_private_boundary',
  'location_scope_boundary',
  'permission_denied',
  'phase1_read_only_boundary',
  'unsupported_capability',
  'data_unavailable',
  'tool_unavailable',
  'provider_unavailable',
  'classification_failure',
  'none',
];

/**
 * Precedence bands. LOWER number = higher priority = closer to "this can never
 * change". The ordering is the whole point of this module: a reason may only be
 * replaced by one of STRICTLY higher priority, so no availability or technical
 * failure discovered later in a turn can ever mask a boundary established
 * earlier.
 *
 *  P0 fixed privacy / product invariants — never change for anyone
 *  P1 authentication / tenant / object ownership
 *  P2 current effective permission — could change if granted
 *  P3 Phase 1 capability / scope support — could change when shipped
 *  P4 data / tool availability — could change when data arrives
 *  P5 model/provider/technical failure — transient
 */
export const ZAC_BLOCKING_PRECEDENCE: Record<ZacBlockingReason, number> = {
  private_coaching_boundary: 0,
  cross_actor_private_boundary: 0,
  phase1_read_only_boundary: 0,
  cross_business_boundary: 1,
  location_scope_boundary: 1,
  permission_denied: 2,
  unsupported_capability: 3,
  data_unavailable: 4,
  tool_unavailable: 4,
  provider_unavailable: 5,
  classification_failure: 5,
  // Not a block at all — ranked last so it never wins a comparison.
  none: 99,
};

/** The P0 band: invariants that no role, permission, grant or instruction changes. */
export const ZAC_FIXED_BOUNDARY_REASONS: readonly ZacBlockingReason[] = [
  'private_coaching_boundary',
  'cross_actor_private_boundary',
  'phase1_read_only_boundary',
];

/** True for reasons that can NEVER be lifted within Phase 1 by any actor. */
export function isFixedBoundary(reason: ZacBlockingReason): boolean {
  return ZAC_FIXED_BOUNDARY_REASONS.includes(reason);
}

/**
 * Pick the reason the user is told, from every reason that applies this turn.
 *
 * This is the single rule that fixes the reported defect: given
 * `['data_unavailable', 'private_coaching_boundary']` it returns the privacy
 * boundary, because connection status is IRRELEVANT to a request that would be
 * refused even if every source were connected.
 *
 * Ties inside a band break on declaration order, NOT on the order the caller
 * happened to discover them: the reason a user is told must not depend on which
 * check ran first, or the same turn could be explained two different ways.
 */
export function selectPrimaryBlockingReason(
  candidates: readonly ZacBlockingReason[],
): ZacBlockingReason {
  let winner: ZacBlockingReason = 'none';
  for (const candidate of candidates) {
    const better = ZAC_BLOCKING_PRECEDENCE[candidate] - ZAC_BLOCKING_PRECEDENCE[winner];
    if (
      better < 0 ||
      (better === 0 &&
        ZAC_BLOCKING_REASONS.indexOf(candidate) < ZAC_BLOCKING_REASONS.indexOf(winner))
    ) {
      winner = candidate;
    }
  }
  return winner;
}

/**
 * WHAT the user is asking for. Deliberately the smallest closed set that lets
 * the server apply policy correctly — this is not an ontology of the product.
 *
 * The semantic classifier may propose one; the server validates it against this
 * enum and then applies policy itself. A category is never authorisation: it
 * only says what KIND of thing was requested.
 */
export type ZacResourceCategory =
  | 'live_business_metrics'
  | 'business_financials'
  | 'team_performance'
  | 'personal_performance'
  | 'personal_coaching'
  | 'private_other_stylist_coaching'
  | 'private_other_actor_conversation'
  | 'business_memory'
  | 'personal_memory'
  | 'operational_write_action'
  | 'general_knowledge'
  | 'hypothetical_reasoning'
  | 'capability_information';

export const ZAC_RESOURCE_CATEGORIES: readonly ZacResourceCategory[] = [
  'live_business_metrics',
  'business_financials',
  'team_performance',
  'personal_performance',
  'personal_coaching',
  'private_other_stylist_coaching',
  'private_other_actor_conversation',
  'business_memory',
  'personal_memory',
  'operational_write_action',
  'general_knowledge',
  'hypothetical_reasoning',
  'capability_information',
];

/**
 * Categories that are intrinsically inaccessible through ZAC in Phase 1,
 * whoever asks. Kept as data so the invariant is one list, testable directly.
 */
export const ZAC_FIXED_BOUNDARY_CATEGORIES: Record<string, ZacBlockingReason> = {
  private_other_stylist_coaching: 'private_coaching_boundary',
  private_other_actor_conversation: 'cross_actor_private_boundary',
  operational_write_action: 'phase1_read_only_boundary',
};

/**
 * The outcome of policy evaluation. `overridable` is ALWAYS false for a fixed
 * Phase 1 boundary and is set by server policy only — no model, prompt, user
 * claim or role name can produce `overridable: true`.
 */
export interface ZacPolicyDecision {
  allowed: boolean;
  blockingReason: ZacBlockingReason;
  overridable: boolean;
  /** The precedence band of `blockingReason`, denormalised for telemetry. */
  precedence: number;
  /** True when the actor tried to have the rule lifted; recorded, never honoured. */
  overrideAttempted: boolean;
}

/** How the turn will be answered once policy and authorisation have spoken. */
export type ZacResponseStrategy =
  | 'answer_with_qlooqo_evidence'
  | 'answer_general_advice'
  | 'answer_hypothetical'
  | 'answer_memory'
  | 'explain_permissions'
  | 'conversational_answer'
  | 'refuse_privacy_boundary'
  | 'refuse_permission'
  | 'refuse_read_only'
  | 'explain_unsupported'
  | 'explain_data_unavailable'
  | 'technical_fallback';

export const ZAC_RESPONSE_STRATEGIES: readonly ZacResponseStrategy[] = [
  'answer_with_qlooqo_evidence',
  'answer_general_advice',
  'answer_hypothetical',
  'answer_memory',
  'explain_permissions',
  'conversational_answer',
  'refuse_privacy_boundary',
  'refuse_permission',
  'refuse_read_only',
  'explain_unsupported',
  'explain_data_unavailable',
  'technical_fallback',
];

/**
 * The internal decision record for one turn: the five decisions kept separate
 * so none can silently overwrite another. Never returned to clients whole —
 * only safe scalars reach `technical_details` and telemetry.
 */
export interface ZacTurnDecision {
  requestMode: ZacRequestMode;
  requestedResourceCategory: ZacResourceCategory | null;
  policy: ZacPolicyDecision;
  responseStrategy: ZacResponseStrategy;
}

/** Runtime guard — the ONLY way an untrusted string becomes a resource category. */
export function isZacResourceCategory(candidate: unknown): candidate is ZacResourceCategory {
  return (
    typeof candidate === 'string' &&
    (ZAC_RESOURCE_CATEGORIES as readonly string[]).includes(candidate)
  );
}

/** Runtime guard for the closed blocking-reason enum. */
export function isZacBlockingReason(candidate: unknown): candidate is ZacBlockingReason {
  return (
    typeof candidate === 'string' && (ZAC_BLOCKING_REASONS as readonly string[]).includes(candidate)
  );
}
