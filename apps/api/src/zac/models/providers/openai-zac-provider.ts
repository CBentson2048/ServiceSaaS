import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ZAC_ANALYSIS_PLANNER_FORMAT_NAME,
  ZAC_ANALYSIS_PLANNER_OPENAI_SCHEMA,
  ZAC_ANALYSIS_PLANNER_SYSTEM_PROMPT,
  buildAnalysisPlannerUserMessage,
} from '../../analysis/zac-analysis-planner.prompt';
import {
  ZAC_PRIORITY_SYNTHESIS_FORMAT_NAME,
  ZAC_PRIORITY_SYNTHESIS_OPENAI_SCHEMA,
  ZAC_PRIORITY_SYNTHESIS_SYSTEM_PROMPT,
  buildPrioritySynthesisUserMessage,
} from '../../analysis/zac-priority-synthesis.prompt';
import {
  confidenceBucketScore,
  isZacConfidenceBucket,
  type ZacClassifierFailure,
} from '../../routing/zac-request-mode.types';
import type { ZacAiCapability } from '../../ai/zac-ai.types';
import type { ZacReasoningProvider, ZacSynthesisProvider } from '../../ai/zac-ai-ports';
import { resolveModelId } from '../../ai/zac-ai-profile.config';
import {
  estimateLiveModelCostUsd,
  resolveZacModelPricing,
  resolveZacSemanticPricing,
  type ZacModelPricing,
} from '../zac-model-pricing.config';
import { classifySemanticFailure } from '../zac-semantic-health.service';
import { buildSystemPrompt, buildUserMessage } from '../zac-synthesis.prompt';
import {
  ZacModelIncompleteError,
  ZacModelRefusedError,
  type ZacAnalysisPlanInput,
  type ZacAnalysisPlanOutcome,
  type ZacAnalysisPlanRawOutput,
  type ZacModelCompletion,
  type ZacModelRequest,
  type ZacPrioritySynthesisInput,
  type ZacPrioritySynthesisOutcome,
  type ZacPrioritySynthesisRawOutput,
} from '../zac-model-provider.interface';

/**
 * Defaults, not commitments. Both are configuration and both should be settled
 * by the provider benchmark rather than by preference — which is the entire
 * reason this adapter exists.
 */
const DEFAULT_REASONING_MODEL = 'gpt-5.6-luna';
const DEFAULT_SYNTHESIS_MODEL = 'gpt-5.6-luna';

/**
 * Reasoning is a blocking pre-step like routing, so it carries routing's
 * timeout discipline. Synthesis is the answer itself and is allowed longer:
 * a truncated narration is a wasted billed call AND a degraded turn.
 */
const REASONING_TIMEOUT_MS = 20_000;
const SYNTHESIS_TIMEOUT_MS = 45_000;

/**
 * Reasoning-capable models bill their thinking inside `max_output_tokens`, so a
 * cap sized for the visible JSON alone truncates mid-object and reads as an
 * invalid structured output rather than as the budget problem it is.
 */
const REASONING_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS = 8192;

/** Mirrors the semantic adapter: only families that accept `reasoning`. */
function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model) && !/chat/i.test(model);
}

function defaultReasoningEffort(model: string): string {
  if (/^gpt-5(-|$)/i.test(model)) return 'minimal';
  if (/^o\d/i.test(model)) return 'low';
  return 'none';
}

/**
 * THE OPENAI REASONING AND SYNTHESIS ADAPTER.
 *
 * The counterpart to `AnthropicZacModelProvider` for the two capabilities that
 * previously had no OpenAI implementation, which is what made
 * `ZAC_AI_PROVIDER=openai` impossible and a like-for-like benchmark impossible
 * with it.
 *
 * It is deliberately thin. Every prompt, every schema and every rule comes from
 * ZAC-owned modules shared with the Anthropic adapter — `buildSystemPrompt`,
 * `buildUserMessage`, the planner and synthesis prompts and their strict
 * schemas. What lives here is only the translation into the Responses API:
 * `instructions` + `input` instead of `system` + `messages`, a JSON-schema
 * `text.format` instead of a forced tool call, and `status`/`output_text`
 * instead of `stop_reason`/content blocks.
 *
 * Safety properties are unchanged because they are not this class's to change:
 * planner output is re-validated against the permission-filtered catalogue,
 * synthesis ids against the real candidate list, and narration against the
 * grounding guard. A provider is never the security boundary.
 *
 * Privacy: the question and evidence exist only in the outbound request.
 * `store: false` keeps them out of the provider's stored-response surface, and
 * this class never logs or persists either.
 */
@Injectable()
export class OpenAiZacProvider implements ZacReasoningProvider, ZacSynthesisProvider {
  private readonly logger = new Logger(OpenAiZacProvider.name);
  private readonly reasoningClient: OpenAI;
  private readonly synthesisClient: OpenAI;
  private readonly reasoningPricing: ZacModelPricing;
  private readonly synthesisPricing: ZacModelPricing;
  private readonly reasoningEffort: string;
  private readonly synthesisMaxTokens: number;

  readonly providerId = 'openai' as const;
  readonly capabilities: readonly ZacAiCapability[] = [
    'tool_planning',
    'structured_reasoning',
    'answer_synthesis',
  ];
  readonly narrates = true;
  /** The synthesis model — the identity `/zac/health.model` reports. */
  readonly model: string;
  /** The reasoning model, which may legitimately differ from synthesis. */
  readonly reasoningModel: string;

  constructor(config: ConfigService) {
    const apiKey = config.getOrThrow<string>('OPENAI_API_KEY');

    this.model = resolveModelId(config, {
      canonical: 'ZAC_OPENAI_SYNTHESIS_MODEL',
      fallback: DEFAULT_SYNTHESIS_MODEL,
    });
    this.reasoningModel = resolveModelId(config, {
      canonical: 'ZAC_OPENAI_REASONING_MODEL',
      fallback: DEFAULT_REASONING_MODEL,
    });

    // Separate clients so the two capabilities keep their own timeout budgets;
    // one shared client would force the answer's budget onto the pre-step.
    this.reasoningClient = new OpenAI({ apiKey, timeout: REASONING_TIMEOUT_MS, maxRetries: 0 });
    this.synthesisClient = new OpenAI({ apiKey, timeout: SYNTHESIS_TIMEOUT_MS, maxRetries: 1 });

    this.reasoningEffort =
      config.get<string>('ZAC_OPENAI_REASONING_EFFORT')?.trim() ||
      defaultReasoningEffort(this.reasoningModel);

    this.synthesisMaxTokens = parsePositiveInt(
      config.get<string>('ZAC_OPENAI_SYNTHESIS_MAX_TOKENS'),
      DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
    );

    // Reasoning is priced like the router (small, high-volume, cheap model);
    // synthesis like the narration model. Reusing both existing resolvers keeps
    // one pricing convention rather than inventing a third.
    this.reasoningPricing = resolveZacSemanticPricing(config).pricing;
    this.synthesisPricing = resolveZacModelPricing(config);
    if (
      this.synthesisPricing.usdPerMillionInputTokens === 0 &&
      this.synthesisPricing.usdPerMillionOutputTokens === 0
    ) {
      this.logger.warn(
        `ZAC_PRICE_* not set — OpenAI synthesis cost events for ${this.model} will estimate $0 (D33: prices are deploy-time configuration).`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // ZacSynthesisProvider
  // ---------------------------------------------------------------------------

  /**
   * One non-streaming Responses call per answer. The stable constitution and
   * role seed go in `instructions` (the cacheable prefix, matching how the
   * Anthropic adapter uses `system` + a cache breakpoint); the question and
   * verified evidence go in the user input.
   *
   * Throws on an unusable answer, exactly like the Anthropic adapter, because
   * the orchestrator's deterministic tool-backed answer is the degradation mode
   * and a provider outage must never break a turn. A refusal or a truncation
   * still BILLED, so the completion rides on the error for honest cost
   * telemetry.
   */
  async generate(request: ZacModelRequest): Promise<ZacModelCompletion> {
    const response = await this.synthesisClient.responses.create({
      model: this.model,
      instructions: buildSystemPrompt(request),
      input: [{ role: 'user', content: buildUserMessage(request) }],
      max_output_tokens: this.synthesisMaxTokens,
      store: false,
      ...(supportsReasoningEffort(this.model)
        ? { reasoning: { effort: this.reasoningEffort as 'minimal' } }
        : {}),
    });

    const completion = this.toCompletion(response, this.model, this.synthesisPricing);

    const refused = response.output?.some(
      (item) =>
        item.type === 'message' &&
        Array.isArray(item.content) &&
        item.content.some((block) => block.type === 'refusal'),
    );
    if (refused) {
      throw new ZacModelRefusedError('Model declined to answer', { ...completion, text: '' });
    }

    if (response.status !== 'completed') {
      // 'incomplete' = truncated at the output cap mid-sentence. Unusable as
      // narration, and the deterministic answer serves instead.
      throw new ZacModelIncompleteError(
        `Narration incomplete (status ${response.status ?? 'unknown'})`,
        completion,
      );
    }

    if (completion.text.length === 0) {
      throw new ZacModelIncompleteError('Narration empty', completion);
    }

    return completion;
  }

  // ---------------------------------------------------------------------------
  // ZacReasoningProvider
  // ---------------------------------------------------------------------------

  async planAnalysis(input: ZacAnalysisPlanInput): Promise<ZacAnalysisPlanOutcome> {
    const outcome = await this.structured(
      ZAC_ANALYSIS_PLANNER_SYSTEM_PROMPT,
      buildAnalysisPlannerUserMessage(input),
      ZAC_ANALYSIS_PLANNER_FORMAT_NAME,
      ZAC_ANALYSIS_PLANNER_OPENAI_SCHEMA as unknown as Record<string, unknown>,
      'analysis planning',
    );
    if (!outcome.parsed) {
      return { raw: null, failure: outcome.failure, completion: outcome.completion, failureKind: outcome.failureKind };
    }

    // Strict mode cannot express a number, so confidence arrives as a bucket.
    // Mapping it back here — rather than widening the server's contract — keeps
    // the planner's confidence policy identical across providers.
    const raw = { ...outcome.parsed } as Record<string, unknown> & ZacAnalysisPlanRawOutput;
    if (isZacConfidenceBucket(raw.confidence)) {
      raw.confidence = confidenceBucketScore(raw.confidence);
    }
    return { raw, failure: null, completion: outcome.completion };
  }

  async synthesisePriorities(
    input: ZacPrioritySynthesisInput,
  ): Promise<ZacPrioritySynthesisOutcome> {
    const outcome = await this.structured(
      ZAC_PRIORITY_SYNTHESIS_SYSTEM_PROMPT,
      buildPrioritySynthesisUserMessage(input),
      ZAC_PRIORITY_SYNTHESIS_FORMAT_NAME,
      ZAC_PRIORITY_SYNTHESIS_OPENAI_SCHEMA as unknown as Record<string, unknown>,
      'priority synthesis',
    );
    if (!outcome.parsed) {
      return { raw: null, failure: outcome.failure, completion: outcome.completion, failureKind: outcome.failureKind };
    }
    return {
      raw: outcome.parsed as ZacPrioritySynthesisRawOutput,
      failure: null,
      completion: outcome.completion,
    };
  }

  // ---------------------------------------------------------------------------

  /**
   * One structured-output call, shared by both reasoning tasks.
   *
   * Never throws: a reasoning failure is a typed outcome so the orchestrator's
   * deterministic plan and deterministic answer take over. That is the rule
   * that keeps "the model could not decide" from ever being narrated as "your
   * business data is unavailable".
   */
  private async structured(
    instructions: string,
    userMessage: string,
    formatName: string,
    schema: Record<string, unknown>,
    label: string,
  ): Promise<{
    parsed: Record<string, unknown> | null;
    failure: ZacClassifierFailure | null;
    completion: ZacModelCompletion | null;
    failureKind?: ReturnType<typeof classifySemanticFailure>;
  }> {
    try {
      const response = await this.reasoningClient.responses.create({
        model: this.reasoningModel,
        instructions,
        input: [{ role: 'user', content: userMessage }],
        text: {
          format: {
            type: 'json_schema',
            name: formatName,
            schema,
            // The API guarantees the shape; the server re-validates anyway. A
            // provider guarantee is not a substitute for validating untrusted
            // input, and never becomes one.
            strict: true,
          },
        },
        max_output_tokens: REASONING_MAX_OUTPUT_TOKENS,
        store: false,
        ...(supportsReasoningEffort(this.reasoningModel)
          ? { reasoning: { effort: this.reasoningEffort as 'minimal' } }
          : {}),
      });

      const completion = this.toCompletion(response, this.reasoningModel, this.reasoningPricing);

      const refused = response.output?.some(
        (item) =>
          item.type === 'message' &&
          Array.isArray(item.content) &&
          item.content.some((block) => block.type === 'refusal'),
      );
      if (refused) {
        return { parsed: null, failure: 'classification_refused', completion };
      }
      if (response.status !== 'completed') {
        return { parsed: null, failure: 'classification_invalid', completion };
      }

      const text = (response.output_text ?? '').trim();
      if (text.length === 0) {
        return { parsed: null, failure: 'classification_invalid', completion };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          parsed: null,
          failure: 'classification_invalid',
          completion,
          failureKind: 'invalid_output',
        };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          parsed: null,
          failure: 'classification_invalid',
          completion,
          failureKind: 'invalid_output',
        };
      }

      return { parsed: parsed as Record<string, unknown>, failure: null, completion };
    } catch (error) {
      const failure: ZacClassifierFailure = isTimeout(error)
        ? 'classification_timeout'
        : 'provider_unavailable';
      // Never the prompt, never the question — only the failure shape, plus the
      // API's own words when it rejected the request as malformed, because that
      // is our bug and must not read as an indistinguishable outage.
      this.logger.warn(
        `zac ${label} (openai) failed (${failure}): ${describeFailure(error)}; deterministic path applies`,
      );
      return {
        parsed: null,
        failure,
        completion: null,
        failureKind: classifySemanticFailure(error),
      };
    }
  }

  /** Responses usage → the ZAC completion contract. */
  private toCompletion(
    response: {
      model?: string;
      output_text?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      } | null;
    },
    fallbackModel: string,
    pricing: ZacModelPricing,
  ): ZacModelCompletion {
    const usage = response.usage;
    const cachedInput = usage?.input_tokens_details?.cached_tokens ?? 0;
    // `input_tokens` is the TOTAL including cached reads; the ZAC contract
    // reports them separately so cost is not double-counted at the full rate.
    const totalInput = usage?.input_tokens ?? 0;
    const usageTokens = {
      inputTokens: Math.max(0, totalInput - cachedInput),
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadInputTokens: cachedInput,
      // The Responses API reports cache reads but never a separate write
      // figure — 0 is honest, not missing data.
      cacheCreationInputTokens: 0,
    };

    return {
      text: (response.output_text ?? '').trim(),
      provider: this.providerId,
      model: response.model ?? fallbackModel,
      inputTokens: usageTokens.inputTokens,
      outputTokens: usageTokens.outputTokens,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
      cacheReadInputTokens: usageTokens.cacheReadInputTokens,
      cacheCreationInputTokens: usageTokens.cacheCreationInputTokens,
      estimatedCostUsd: estimateLiveModelCostUsd(pricing, usageTokens),
    };
  }
}

/**
 * Duck-typed rather than `instanceof`: the SDK's error classes are not
 * guaranteed stable across versions, and a misclassified timeout would send the
 * fallback ladder down the wrong branch.
 */
function isTimeout(error: unknown): boolean {
  const err = error as { name?: string; status?: number; code?: string };
  return (
    err?.name === 'APIConnectionTimeoutError' ||
    err?.name === 'AbortError' ||
    err?.code === 'ETIMEDOUT' ||
    err?.status === 408
  );
}

function describeFailure(error: unknown): string {
  const err = error as { name?: string; status?: number; message?: string };
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    const message = String(err.message ?? '').slice(0, 300);
    return `${err.name ?? 'Error'} ${err.status} (request rejected — this is a bug in the request we sent): ${message}`;
  }
  return err?.name ?? 'Error';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1024 ? value : fallback;
}
