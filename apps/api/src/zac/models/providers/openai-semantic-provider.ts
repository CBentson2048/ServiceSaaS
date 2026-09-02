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
 * The cheapest model that passed every routing gate in the live benchmark
 * (2026-09-02, 350-case dataset, scripts/zac-routing-eval.ts, four tiers):
 * 99.1% mode accuracy with alternatives / 94.3% strict, ONE live-data false
 * positive in 188, zero hypothetical→data, 87.1% analysis-intent accuracy,
 * 10/10 business-priority recall, 99.0% of `high` verdicts correct, at
 * $0.000185 per routed request — a third of gpt-4.1-mini's cost for equal
 * mode accuracy. gpt-5-mini failed the hypothetical→data invariant;
 * gpt-5-nano routed 16% of live-data questions away. Configuration, not a
 * commitment: override with ZAC_SEMANTIC_MODEL and re-run the benchmark.
 */
const DEFAULT_SEMANTIC_MODEL = 'gpt-5.6-luna';

/**
 * A blocking pre-step on the user's turn, so it cannot wait forever — but a
 * cap that routinely fires is worse than a slightly longer single wait: the
 * fallback ladder treats a timeout as genuine ambiguity and asks a clarifying
 * question, so every timeout is a bad turn.
 *
 * Measured basis (live benchmark, 2026-09-02, gpt-5.6-luna, serial calls):
 * p50 2.1s, p95 3.9s, max 8.5s. 15s sits comfortably above the observed
 * maximum while still bounding a genuine stall. The same benchmark showed
 * that six concurrent connections on a slow-TLS path pushed p50 to 12–14s and
 * produced timeouts — concurrency and connection reuse, not the model, so
 * the production client keeps its default keep-alive pool.
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
 * understood.
 */
function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model) && !/chat/i.test(model);
}

/**
 * The lowest reasoning effort each family accepts — routing is a judgement
 * call on the user's critical path, not a reasoning task. The gpt-5 base
 * family (gpt-5, gpt-5-mini, gpt-5-nano) has no 'none' and takes 'minimal';
 * gpt-5.1 onward accepts 'none' and REJECTS 'minimal' (measured: gpt-5.6-luna
 * 400s on it); the o-series bottoms out at 'low'. Overridable with
 * ZAC_SEMANTIC_REASONING_EFFORT, and self-correcting on a rejection — see
 * adoptSupportedReasoningEffort().
 */
function defaultReasoningEffort(model: string): string {
  if (/^gpt-5(-|$)/i.test(model)) return 'minimal';
  if (/^o\d/i.test(model)) return 'low';
  return 'none';
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
  /** Mutable on purpose: see adoptSupportedReasoningEffort(). */
  private reasoningEffort: string;

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
    this.reasoningEffort =
      config.get<string>('ZAC_SEMANTIC_REASONING_EFFORT')?.trim() || defaultReasoningEffort(this.model);
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
      this.adoptSupportedReasoningEffort(error);
      return { raw: null, failure, completion: null, failureKind: classifySemanticFailure(error) };
    }
  }

  /**
   * A 400 that names an unsupported `reasoning.effort` value is a CONFIG
   * defect, not an outage — and left alone it fails EVERY call until someone
   * reads the logs, which is the exact silent-degradation class this
   * migration's health work exists to stop (measured: gpt-5.6-luna rejects
   * 'minimal' and lists none|low|medium|… instead). When the API states the
   * values it accepts, adopt the cheapest one it names for subsequent calls
   * and say so loudly. The current call still fails safely; nothing is
   * retried on the user's turn.
   */
  private adoptSupportedReasoningEffort(error: unknown): void {
    const message = String((error as { message?: string } | null)?.message ?? '');
    const match = /Unsupported value: '([^']+)' is not supported with the '[^']+' model\. Supported values are: (.+)/i.exec(
      message,
    );
    if (!match || match[1] !== this.reasoningEffort) return;
    const supported = (match[2].match(/'([^']+)'/g) ?? []).map((value) => value.replace(/'/g, ''));
    const preferred = ['none', 'minimal', 'low'].find((value) => supported.includes(value));
    if (!preferred || preferred === this.reasoningEffort) return;
    this.logger.warn(
      `ZAC_SEMANTIC_REASONING_EFFORT='${this.reasoningEffort}' is not supported by ${this.model}; using '${preferred}' from now on — set ZAC_SEMANTIC_REASONING_EFFORT explicitly to silence this.`,
    );
    this.reasoningEffort = preferred;
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
