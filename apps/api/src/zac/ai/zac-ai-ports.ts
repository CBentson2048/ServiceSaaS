import type {
  ZacAnalysisPlanInput,
  ZacAnalysisPlanOutcome,
  ZacModelCompletion,
  ZacModelRequest,
  ZacPrioritySynthesisInput,
  ZacPrioritySynthesisOutcome,
} from '../models/zac-model-provider.interface';
import type { ZacAiCapability, ZacAiProviderId } from './zac-ai.types';

/**
 * THE THREE CAPABILITY PORTS.
 *
 * ZAC orchestration depends on these interfaces and nothing else. Each is
 * expressed entirely in ZAC-owned request/result types that already existed and
 * are already provider-neutral — `ZacModelRequest`, `ZacAnalysisPlanInput`,
 * `ZacPrioritySynthesisInput` and their outcomes carry no vendor type, no wire
 * format and no SDK class. That is why this refactor is a re-wiring rather than
 * a rewrite: the contracts were right, but all three capabilities were welded
 * to one implementation.
 *
 * `ZacSemanticProvider` is the fourth port and already exists
 * (`../models/zac-semantic-provider.interface`); it is reused unchanged, since
 * its contract, its safety properties and its health plumbing are shipped and
 * proven.
 */

/** Injection token for the resolved reasoning/planning provider. */
export const ZAC_REASONING_PROVIDER = 'ZAC_REASONING_PROVIDER';

/** Injection token for the resolved answer-synthesis provider. */
export const ZAC_SYNTHESIS_PROVIDER = 'ZAC_SYNTHESIS_PROVIDER';

/** Common identity every capability adapter reports for health and telemetry. */
export interface ZacAiProviderIdentity {
  /** The vendor. Recorded on telemetry and health; never a secret. */
  readonly providerId: ZacAiProviderId;
  /** The configured model for THIS capability. */
  readonly model: string;
  /** What this adapter declares it can do — validated at boot. */
  readonly capabilities: readonly ZacAiCapability[];
}

/**
 * STRUCTURED REASONING AND TOOL PLANNING.
 *
 * Two tasks, one port, because both are the same mechanism: send a ZAC-owned
 * schema, get back an object validated against it server-side. Neither method
 * may throw — a failure comes back as a typed outcome, so "the model could not
 * decide" can never be narrated as "your data is unavailable".
 *
 * Both outputs are UNTRUSTED. The planner's tool names are re-validated against
 * the permission-filtered catalogue and the synthesiser's ids against the real
 * candidate list, exactly as before: **the provider is never the security
 * boundary**, and swapping vendors cannot make it one.
 */
export interface ZacReasoningProvider extends ZacAiProviderIdentity {
  /**
   * Decide WHAT KIND of analysis a live-data question needs and which of the
   * supplied sources would answer it. The catalogue it receives has already
   * been filtered to tools this actor may use right now.
   */
  planAnalysis(input: ZacAnalysisPlanInput): Promise<ZacAnalysisPlanOutcome>;
  /**
   * Choose and explain priorities from a supplied candidate list, by id. The
   * server does the counting; the model cannot invent a candidate.
   */
  synthesisePriorities(input: ZacPrioritySynthesisInput): Promise<ZacPrioritySynthesisOutcome>;
}

/**
 * ANSWER SYNTHESIS — the narration/synthesis call that produces user-facing
 * prose from pre-computed, permission-checked figures.
 *
 * `narrates` stays part of the contract because the deterministic stub is a
 * first-class deployment: with no key, ZAC serves its deterministic answers and
 * the orchestrator skips the call entirely rather than emitting placeholder
 * text. Grounding requirements are unchanged and enforced downstream — a
 * provider swap cannot loosen them.
 */
export interface ZacSynthesisProvider extends ZacAiProviderIdentity {
  /** True when completions carry user-facing narration (false on the stub). */
  readonly narrates: boolean;
  generate(request: ZacModelRequest): Promise<ZacModelCompletion>;
}
