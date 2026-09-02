import type {
  ZacSemanticRouterInput,
  ZacSemanticRouterOutcome,
} from './zac-model-provider.interface';

/**
 * Injection token for the DEDICATED semantic-routing provider — the routing
 * migration's seam. Distinct from {@link ZAC_MODEL_PROVIDER} on purpose:
 * reasoning/narration stays on the existing model provider (Claude), while
 * request-mode classification can run on a different vendor and model
 * entirely. Bound to null when the deployment has no dedicated router
 * (legacy routing mode, or no key).
 */
export const ZAC_SEMANTIC_PROVIDER = 'ZAC_SEMANTIC_PROVIDER';

/**
 * A provider that does exactly one thing: read a user message (plus the role
 * lens and a few structural turn summaries) and name what KIND of request it
 * is, through a strict structured output validated server-side.
 *
 * The contract is deliberately the same wire shape the hybrid router already
 * validates ({@link ZacSemanticRouterOutcome}), so every existing safety
 * property — closed-enum validation, the ignore-data veto, the confidence
 * policy, the fallback ladder, evidence-based health — applies unchanged to
 * any implementation.
 *
 * Implementations MUST:
 * - never throw (failures return a typed `failure` + `failureKind`);
 * - never log or persist the question text or the API key;
 * - never receive or return identity, permissions, tool names or scope;
 * - keep `input.question` byte-identical in the outbound prompt (the offline
 *   oracle keys on it, and redaction belongs to the caller).
 *
 * An AnthropicSemanticProvider can implement this later without touching the
 * orchestration; today the legacy path reaches Anthropic through the model
 * provider's own classifyRequestMode.
 */
export interface ZacSemanticProvider {
  /** e.g. 'openai' — recorded on telemetry and /zac/health, never a secret. */
  readonly name: string;
  /** The configured classification model, e.g. 'gpt-5-mini'. */
  readonly model: string;
  classify(input: ZacSemanticRouterInput): Promise<ZacSemanticRouterOutcome>;
}
