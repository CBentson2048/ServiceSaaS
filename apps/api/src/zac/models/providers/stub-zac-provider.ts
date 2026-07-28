import { Injectable } from '@nestjs/common';
import { estimateModelCostUsd, ZAC_STUB_PRICING } from '../zac-model-pricing.config';
import type {
  ZacModelCompletion,
  ZacModelProvider,
  ZacModelRequest,
} from '../zac-model-provider.interface';

/**
 * Deterministic Week 1 placeholder: no network, no API key, no real reasoning.
 * It produces the controlled test response so the /zac/ask contract can ship and
 * be exercised end-to-end before any live provider is wired in.
 */
@Injectable()
export class StubZacModelProvider implements ZacModelProvider {
  readonly name = 'stub';
  readonly model = 'zac-stub-1';

  async complete(request: ZacModelRequest): Promise<ZacModelCompletion> {
    const toolCount = request.availableToolNames.length;
    const text = [
      `Thanks for trying ZAC — I received your question and I am answering through the ${request.roleContext} lens.`,
      toolCount > 0
        ? `${toolCount} data tool${toolCount === 1 ? ' is' : 's are'} registered for your role, but none are connected to live salon data yet.`
        : 'No data tools are available to your role yet.',
      'This is a controlled foundation response: no live business figures were read and nothing was written.',
    ].join(' ');

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
