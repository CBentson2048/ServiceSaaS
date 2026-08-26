import { Injectable } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacRequestMode } from '../routing/zac-request-mode.types';
import type { ZacToolResultStatus } from '../tools/zac-tool.types';
import {
  ZAC_BLOCKING_PRECEDENCE,
  ZAC_FIXED_BOUNDARY_CATEGORIES,
  isFixedBoundary,
  selectPrimaryBlockingReason,
  type ZacBlockingReason,
  type ZacPolicyDecision,
  type ZacResourceCategory,
  type ZacResponseStrategy,
} from './zac-policy.types';

export interface ZacPolicyInput {
  context: ZacActingContext;
  /** What the request is reaching for; null when neither layer could tell. */
  requestedResourceCategory: ZacResourceCategory | null;
  requestMode: ZacRequestMode;
  /** Recorded for telemetry. NEVER an input to the decision. */
  overrideAttempted: boolean;
}

/**
 * The fixed-policy resolver: is this category of request intrinsically
 * inaccessible, before anything is dispatched and before availability is
 * considered at all?
 *
 * Three properties matter and are pinned by tests:
 *
 *  1. It runs BEFORE tool selection, so a boundary can never be reported as a
 *     connection problem. Ordering is the fix for the defect where "staff data
 *     isn't connected" stood in front of a privacy invariant.
 *  2. It reads only the acting context and the request category — never a role
 *     NAME as authority, never a claim in the user's text, never model output
 *     about what is allowed. `overrideAttempted` is recorded and ignored.
 *  3. `overridable` is false for every Phase 1 fixed boundary, set here by
 *     server policy. No model, prompt or permission can produce true.
 *
 * It is a POLICY layer, not the enforcement layer: memory scope resolution, the
 * fail-closed conversation store and per-tool permission checks continue to
 * enforce independently, so a wrong answer here cannot disclose anything.
 */
@Injectable()
export class ZacPolicyService {
  /**
   * Evaluate the fixed boundaries for one turn. Any `allowed: false` result is
   * final: the orchestrator answers from it and never dispatches.
   */
  resolveBoundary(input: ZacPolicyInput): ZacPolicyDecision {
    const { context, requestedResourceCategory, overrideAttempted } = input;

    // P0 — fixed product invariants. Category alone decides: no role, no
    // permission, no authority claim and no override request changes it.
    if (requestedResourceCategory) {
      const fixed = ZAC_FIXED_BOUNDARY_CATEGORIES[requestedResourceCategory];
      if (fixed) return deny(fixed, overrideAttempted);
    }

    // P1 — tenant/object scope. The context service already rejects an
    // out-of-scope location before ZAC runs; this is defence in depth so a
    // future caller cannot bypass it silently.
    if (context.locationId && !context.accessibleLocationIds.includes(context.locationId)) {
      return deny('location_scope_boundary', overrideAttempted);
    }

    return {
      allowed: true,
      blockingReason: 'none',
      overridable: false,
      precedence: ZAC_BLOCKING_PRECEDENCE.none,
      overrideAttempted,
    };
  }

  /**
   * Translate a tool dispatch outcome into the honest reason.
   *
   * The distinctions the product needs:
   *  - `permission_denied`      the actor may not use a capability that exists
   *  - `unsupported_capability` ZAC does not have this capability in Phase 1
   *  - `data_unavailable`       the capability ran but the source data is not there
   *  - `tool_unavailable`       the capability exists but could not be reached
   *
   * Collapsing these (as the single "I can't answer that with your data right
   * now" fallback did) tells users to wait for data when the real answer is
   * "ask an admin", or to ask an admin when the real answer is "not built yet".
   */
  reasonForToolStatus(status: ZacToolResultStatus, toolEnabled: boolean): ZacBlockingReason {
    switch (status) {
      case 'ok':
        return 'none';
      case 'permission_denied':
        return 'permission_denied';
      case 'not_connected':
        return 'unsupported_capability';
      case 'unavailable':
        // A registered, enabled tool reporting `unavailable` means its SOURCE
        // data was missing; a disabled one means the capability itself is not
        // in Phase 1.
        return toolEnabled ? 'data_unavailable' : 'unsupported_capability';
      case 'error':
      default:
        return 'tool_unavailable';
    }
  }

  /**
   * Combine everything that blocked this turn and return the one truthful
   * reason, highest precedence first.
   *
   * This is the guarantee in §19: once a fixed boundary is established, a later
   * model timeout, tool failure or missing dataset cannot replace it, because
   * a lower band can never win this comparison.
   */
  primaryReason(...candidates: ZacBlockingReason[]): ZacBlockingReason {
    return selectPrimaryBlockingReason(candidates);
  }

  /**
   * Map the resolved state to the closed response strategy. Refusals are
   * selected by REASON, never by which branch happened to match, which is what
   * stops a generic fallback swallowing a boundary.
   */
  strategyFor(input: {
    blockingReason: ZacBlockingReason;
    requestMode: ZacRequestMode;
  }): ZacResponseStrategy {
    const { blockingReason, requestMode } = input;

    if (blockingReason !== 'none') {
      if (isFixedBoundary(blockingReason)) {
        return blockingReason === 'phase1_read_only_boundary'
          ? 'refuse_read_only'
          : 'refuse_privacy_boundary';
      }
      switch (blockingReason) {
        case 'cross_business_boundary':
        case 'location_scope_boundary':
        case 'permission_denied':
          return 'refuse_permission';
        case 'unsupported_capability':
          return 'explain_unsupported';
        case 'data_unavailable':
        case 'tool_unavailable':
          return 'explain_data_unavailable';
        case 'provider_unavailable':
        case 'classification_failure':
        default:
          return 'technical_fallback';
      }
    }

    switch (requestMode) {
      case 'general_advice':
        return 'answer_general_advice';
      case 'hypothetical':
        return 'answer_hypothetical';
      case 'memory':
        return 'answer_memory';
      case 'permission_capability':
        return 'explain_permissions';
      case 'conversational':
        return 'conversational_answer';
      case 'privacy_boundary':
        return 'refuse_privacy_boundary';
      case 'qlooqo_data':
      default:
        return 'answer_with_qlooqo_evidence';
    }
  }
}

function deny(reason: ZacBlockingReason, overrideAttempted: boolean): ZacPolicyDecision {
  return {
    allowed: false,
    blockingReason: reason,
    // Server policy, not a model or a permission: Phase 1 fixed boundaries are
    // never overridable, and nothing in a request can change this value.
    overridable: false,
    precedence: ZAC_BLOCKING_PRECEDENCE[reason],
    overrideAttempted,
  };
}
