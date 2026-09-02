import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA,
  ZAC_SEMANTIC_ROUTER_SYSTEM_PROMPT_V2,
  ZAC_SEMANTIC_ROUTER_V2_FORMAT_NAME,
  ZAC_SEMANTIC_PROMPT_VERSION,
  buildSemanticRouterUserMessage,
} from '../../routing/zac-semantic-router.prompt';
import type {
  ZacModelCompletion,
  ZacSemanticRouterInput,
  ZacSemanticRouterOutcome,
  ZacSemanticRouterRawOutput,
} from '../zac-model-provider.interface';
import type { ZacSemanticProvider } from '../zac-semantic-provider.interface';
import type { ZacClassifierFailure } from '../../routing/zac-request-mode.types';
import {
  classifySemanticFailure,
} from '../zac-semantic-health.service';
import {
  estimateLiveModelCostUsd,
  resolveZacSemanticPricing,
  type ZacModelPricing,
} from '../zac-model-pricing.config';

/**
 * Cheapest current tier that clears the routing quality bar in offline spot
 * checks. PROVISIONAL until the live benchmark (scripts/zac-routing-eval.ts
 * with ZAC_EVAL_MODELS) has been run against the account's real models —
 * configuration, not a commitment: override with ZAC_SEMANTIC_MODEL.
 */
const DEFAULT_SEMANTIC_MODEL = 'gpt-5-mini';

/**
 * Same bounded wait as the Anthropic router call, for the same reason: the
 * classification is a blocking pre-step on the user's turn, and the fallback
 * ladder treats a timeout as genuine ambiguity (a clarifying question), so a
 * cap that routinely fires is worse than a slightly longer single wait. 15s
 * was chosen from measured Anthropic p95 (~12.7s); OpenAI latencies are
 * RECORDED per call (classifierLatencyMs on the route result and the live
 * harness percentiles), so this number gets re-derived from evidence once the
 * benchmark has run rather than guessed now.
 */
const SEMANTIC_TIMEOUT_MS = 15_000;

/**
 * The route is a ~60-token JSON object, but reasoning-capable models bill
 * their thinking inside max_output_tokens — a tight cap would truncate the
 * JSON mid-object and read as classification_invalid. 1024 leaves room for
 * `minimal` reasoning without inviting an essay.
 */
const SEMANTIC_MAX_OUTPUT_TOKENS = 1024;

/**
 * Models that accept the `reasoning` parameter. gpt-5-chat-* variants and the
 * gpt-4 families reject it outright (400), so it is sent only where it is
 * understood. Effort defaults to `minimal`: routing is a judgement call, not a
 * reasoning task, and it sits on the user's critical path.
 */
function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model) && !/chat/i.test(model);
}

/**
 * The dedicated semantic-routing provider: OpenAI Responses API with strict
 * Structured Outputs. It classifies REQUEST MEANING and nothing else — it is
 * never handed identity, permissions, tool names or business data, its output
 * is untrusted until the router validates every field against the closed
 * server-side enums, and it can never throw: failures come back as typed
 * codes so "I could not work out what you meant" is never reported as "your
 * business data is unavailable".
 *
 * Privacy: the question exists only in the outbound request. `store: false`
 * keeps it out of the provider's stored-response surface, and this class never
 * logs or persists the question or the API key.
 */
@Injectable()
export class OpenAiSemanticProvider implements ZacSemanticProvider {
  private readonly logger = new Logger(OpenAiSemanticProvider.name);
  private readonly client: OpenAI;
  private readonly pricing: ZacModelPricing;
  private readonly reasoningEffort: string;

  readonly name = 'openai';
  readonly model: string;

  constructor(config: ConfigService) {
    // The module factory only constructs this class when the key is present.
    this.client = new OpenAI({
      apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: SEMANTIC_TIMEOUT_MS,
      // No retry: a slow classification is slow, not broken, and retrying
      // doubles the user's wait for the same likely outcome (measured basis in
      // the Anthropic router; re-evaluated by the live harness for OpenAI).
      maxRetries: 0,
    });
    this.model = config.get<string>('ZAC_SEMANTIC_MODEL')?.trim() || DEFAULT_SEMANTIC_MODEL;
    this.reasoningEffort = config.get<string>('ZAC_SEMANTIC_REASONING_EFFORT')?.trim() || 'minimal';
    const resolved = resolveZacSemanticPricing(config);
    this.pricing = resolved.pricing;
    if (!resolved.configured) {
      this.logger.warn(
        `ZAC_SEMANTIC_PRICE_* not set — semantic-routing cost events for ${this.model} will estimate $0 (D33: prices are deploy-time configuration).`,
      );
    }
  }

  async classify(input: ZacSemanticRouterInput): Promise<ZacSemanticRouterOutcome> {
    try {
      const response = await this.client.responses.create({
        model: this.model,
        // The stable v2 prompt — byte-identical every call, which is what
        // makes provider-side prompt caching effective.
        instructions: ZAC_SEMANTIC_ROUTER_SYSTEM_PROMPT_V2,
        // The user block is built by the SAME builder as the legacy router:
        // question byte-identical, role lens, at most three redacted turn
        // summaries. No identity, no scope, no permissions, no tool names.
        input: [{ role: 'user', content: buildSemanticRouterUserMessage(input) }],
        text: {
          format: {
            type: 'json_schema',
            name: ZAC_SEMANTIC_ROUTER_V2_FORMAT_NAME,
            schema: ZAC_SEMANTIC_ROUTER_OPENAI_SCHEMA as unknown as Record<string, unknown>,
            // The API guarantees the output validates against the schema.
            // The router still re-validates: a provider guarantee is not a
            // substitute for validating untrusted input.
            strict: true,
          },
        },
        max_output_tokens: SEMANTIC_MAX_OUTPUT_TOKENS,
        // The question must not persist in the provider's stored responses.
        store: false,
        // Stable cache bucket per prompt version, so a version bump never
        // reads a stale cached prefix.
        prompt_cache_key: `zac-semantic-router-${ZAC_SEMANTIC_PROMPT_VERSION}`,
        ...(supportsReasoningEffort(this.model)
          ? { reasoning: { effort: this.reasoningEffort as 'minimal' } }
          : {}),
      });

      const completion = this.toCompletion(response);

      const refused = response.output?.some(
        (item) =>
          item.type === 'message' &&
          Array.isArray(item.content) &&
          item.content.some((block) => block.type === 'refusal'),
      );
      if (refused) {
        return { raw: null, failure: 'classification_refused', completion };
      }

      if (response.status !== 'completed') {
        // 'incomplete' = truncated at the output cap (the JSON is unusable);
        // anything else unexpected is equally not a verdict. Billed either
        // way, so the completion rides along for honest cost telemetry.
        return { raw: null, failure: 'classification_invalid', completion };
      }

      const text = (response.output_text ?? '').trim();
      if (text.length === 0) {
        return { raw: null, failure: 'classification_invalid', completion };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          raw: null,
          failure: 'classification_invalid',
          completion,
          failureKind: 'invalid_output',
        };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          raw: null,
          failure: 'classification_invalid',
          completion,
          failureKind: 'invalid_output',
        };
      }

      return { raw: parsed as ZacSemanticRouterRawOutput, failure: null, completion };
    } catch (error) {
      const failure: ZacClassifierFailure = isTimeout(error)
        ? 'classification_timeout'
        : 'provider_unavailable';
      // The question itself is never logged — only the failure shape, plus the
      // API's own words when it rejected the request as malformed, because
      // that is our bug and must never read as an indistinguishable outage.
      this.logger.warn(
        `zac semantic routing (openai) failed (${failure}): ${describeFailure(error)}; safe fallback applies`,
      );
      return { raw: null, failure, completion: null, failureKind: classifySemanticFailure(error) };
    }
  }

  private toCompletion(response: OpenAI.Responses.Response): ZacModelCompletion {
    const usage = response.usage;
    const cachedInputTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
    // OpenAI's input_tokens INCLUDES the cached portion; the cost spine (and
    // the Anthropic provider) treat inputTokens and cacheReadInputTokens as
    // disjoint, so the cached share is subtracted rather than double-billed.
    const uncachedInputTokens = Math.max(0, (usage?.input_tokens ?? 0) - cachedInputTokens);
    const usageTokens = {
      inputTokens: uncachedInputTokens,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadInputTokens: cachedInputTokens,
      // OpenAI prompt caching has no billed write phase; the SDK field exists
      // but is 0 on current models. Recorded verbatim for honesty.
      cacheCreationInputTokens:
        (usage?.input_tokens_details as { cache_write_tokens?: number } | undefined)
          ?.cache_write_tokens ?? 0,
    };
    return {
      text: '',
      provider: this.name,
      model: response.model ?? this.model,
      inputTokens: usageTokens.inputTokens,
      outputTokens: usageTokens.outputTokens,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
      cacheReadInputTokens: usageTokens.cacheReadInputTokens,
      cacheCreationInputTokens: usageTokens.cacheCreationInputTokens,
      estimatedCostUsd: estimateLiveModelCostUsd(this.pricing, usageTokens),
    };
  }
}

/** Reads the error SHAPE, not instanceof — SDK classes are absent under mocks. */
function isTimeout(error: unknown): boolean {
  const candidate = error as { name?: string; message?: string; status?: number } | null;
  if (candidate?.status === 408) return true;
  return /timeout|timed out|aborted/i.test(`${candidate?.name ?? ''} ${candidate?.message ?? ''}`);
}

/** A loggable one-liner: status + message shape, never the request content. */
function describeFailure(error: unknown): string {
  const candidate = error as { status?: number; message?: string; name?: string } | null;
  const status = typeof candidate?.status === 'number' ? `HTTP ${candidate.status} ` : '';
  return `${status}${candidate?.name ?? 'Error'}: ${candidate?.message ?? 'unknown failure'}`;
}
