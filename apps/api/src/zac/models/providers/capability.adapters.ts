import type { ZacAiCapability, ZacAiProviderId } from '../../ai/zac-ai.types';
import type { ZacReasoningProvider, ZacSynthesisProvider } from '../../ai/zac-ai-ports';
import type { ZacSemanticProvider } from '../zac-semantic-provider.interface';
import type {
  ZacAnalysisPlanInput,
  ZacAnalysisPlanOutcome,
  ZacModelCompletion,
  ZacModelProvider,
  ZacModelRequest,
  ZacPrioritySynthesisInput,
  ZacPrioritySynthesisOutcome,
  ZacSemanticRouterInput,
  ZacSemanticRouterOutcome,
} from '../zac-model-provider.interface';

/**
 * CAPABILITY ADAPTERS over a whole-vendor provider.
 *
 * `AnthropicZacModelProvider` implements all four capabilities in one class, as
 * it always has — that is a fine shape for a vendor SDK wrapper and rewriting it
 * would risk shipped narration behaviour for no gain. What it could not do was
 * be taken apart: with one object bound to one token, ZAC could not put routing
 * on one vendor and synthesis on another, and `ZAC_AI_PROVIDER=openai` had
 * nowhere to plug in.
 *
 * These adapters are that seam. Each exposes exactly one ZAC capability port,
 * delegating to the underlying provider, so the resolver can compose a profile
 * from either vendor per capability without either vendor's class knowing.
 *
 * They are intentionally trivial. An adapter that did anything interesting
 * would be a second place where provider behaviour is decided, which is the
 * problem this refactor exists to remove.
 */

/** Semantic routing, from a whole-vendor provider's `classifyRequestMode`. */
export class ModelProviderSemanticAdapter implements ZacSemanticProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly provider: ZacModelProvider,
    /** The routing model, which is usually smaller than the narration model. */
    model?: string,
  ) {
    this.name = provider.name;
    this.model = model ?? provider.model;
  }

  async classify(input: ZacSemanticRouterInput): Promise<ZacSemanticRouterOutcome> {
    const classify = this.provider.classifyRequestMode;
    if (!classify) {
      // Contract, not defence: a provider bound to the semantic capability
      // without implementing it is a boot-time configuration error, caught by
      // the resolver. If one ever reached here it must still not throw — the
      // router's fallback ladder is the safe degradation, not an exception.
      return { raw: null, failure: 'provider_unavailable', completion: null };
    }
    return classify.call(this.provider, input);
  }
}

/** Tool planning + structured reasoning, from a whole-vendor provider. */
export class ModelProviderReasoningAdapter implements ZacReasoningProvider {
  readonly providerId: ZacAiProviderId;
  readonly model: string;
  readonly capabilities: readonly ZacAiCapability[] = ['tool_planning', 'structured_reasoning'];

  constructor(
    private readonly provider: ZacModelProvider,
    providerId: ZacAiProviderId,
  ) {
    this.providerId = providerId;
    this.model = provider.model;
  }

  async planAnalysis(input: ZacAnalysisPlanInput): Promise<ZacAnalysisPlanOutcome> {
    const plan = this.provider.planAnalysis;
    if (!plan) return { raw: null, failure: 'provider_unavailable', completion: null };
    return plan.call(this.provider, input);
  }

  async synthesisePriorities(
    input: ZacPrioritySynthesisInput,
  ): Promise<ZacPrioritySynthesisOutcome> {
    const synthesise = this.provider.synthesisePriorities;
    if (!synthesise) return { raw: null, failure: 'provider_unavailable', completion: null };
    return synthesise.call(this.provider, input);
  }
}

/** Answer synthesis, from a whole-vendor provider's `complete`. */
export class ModelProviderSynthesisAdapter implements ZacSynthesisProvider {
  readonly providerId: ZacAiProviderId;
  readonly model: string;
  readonly narrates: boolean;
  readonly capabilities: readonly ZacAiCapability[] = ['answer_synthesis'];

  constructor(
    private readonly provider: ZacModelProvider,
    providerId: ZacAiProviderId,
  ) {
    this.providerId = providerId;
    this.model = provider.model;
    this.narrates = provider.narrates;
  }

  /**
   * Errors propagate unchanged. `complete` throws `ZacModelRefusedError` and
   * `ZacModelIncompleteError` on a billed-but-unusable answer, and the
   * orchestrator already handles both by serving the deterministic answer while
   * still recording the cost. Catching them here would break that.
   */
  generate(request: ZacModelRequest): Promise<ZacModelCompletion> {
    return this.provider.complete(request);
  }
}
