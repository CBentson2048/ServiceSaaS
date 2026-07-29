import { Injectable } from '@nestjs/common';
import { estimateModelCostUsd, ZAC_STUB_PRICING } from '../zac-model-pricing.config';
import type {
  ZacModelCompletion,
  ZacModelProvider,
  ZacModelRequest,
} from '../zac-model-provider.interface';

/**
 * Deterministic Week 1 placeholder: no network, no API key, no real reasoning.
 * In foundation mode the user-facing answer is composed by
 * ZacResponseBuilderService, not by this provider — the stub exists to exercise
 * the provider/cost pipeline end-to-end so a live provider can slot in behind
 * the same interface later. Its text is trace plumbing, never shown to users.
 */
@Injectable()
export class StubZacModelProvider implements ZacModelProvider {
  readonly name = 'stub';
  readonly model = 'zac-stub-1';

  async complete(request: ZacModelRequest): Promise<ZacModelCompletion> {
    const text = `Foundation-mode acknowledgment (${request.roleContext} lens, ${request.availableToolNames.length} planned tools). The user-facing answer is composed by the response builder.`;

    const inputTokens = approximateTokens(request.systemPromptSeed) + approximateTokens(request.question);
    const outputTokens = approximateTokens(text);

    return {
      text,
      provider: this.name,
      model: this.model,
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      estimatedCostUsd: estimateModelCostUsd(ZAC_STUB_PRICING, inputTokens, outputTokens),
    };
  }
}

/** Rough 4-chars-per-token heuristic — deterministic and good enough for stub cost plumbing. */
function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
