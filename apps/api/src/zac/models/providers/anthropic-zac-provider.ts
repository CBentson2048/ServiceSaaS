import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  estimateLiveModelCostUsd,
  resolveZacModelPricing,
  resolveZacRouterPricing,
  type ZacModelPricing,
} from '../zac-model-pricing.config';
import {
  ZAC_PRIORITY_SYNTHESIS_SCHEMA,
  ZAC_PRIORITY_SYNTHESIS_SYSTEM_PROMPT,
  ZAC_PRIORITY_SYNTHESIS_TOOL_NAME,
  buildPrioritySynthesisUserMessage,
} from '../../analysis/zac-priority-synthesis.prompt';
import {
  ZAC_ANALYSIS_PLANNER_SCHEMA,
  ZAC_ANALYSIS_PLANNER_SYSTEM_PROMPT,
  ZAC_ANALYSIS_PLANNER_TOOL_NAME,
  buildAnalysisPlannerUserMessage,
} from '../../analysis/zac-analysis-planner.prompt';
import {
  ZAC_SEMANTIC_ROUTER_SCHEMA,
  ZAC_SEMANTIC_ROUTER_SYSTEM_PROMPT,
  ZAC_SEMANTIC_ROUTER_TOOL_NAME,
  buildSemanticRouterUserMessage,
} from '../../routing/zac-semantic-router.prompt';
import type { ZacClassifierFailure } from '../../routing/zac-request-mode.types';
// ZAC-owned task semantics, shared with every other provider adapter.
import { buildSystemPrompt, buildUserMessage } from '../zac-synthesis.prompt';
import { classifySemanticFailure } from '../zac-semantic-health.service';
import {
  ZacModelIncompleteError,
  ZacModelRefusedError,
  type ZacModelCompletion,
  type ZacModelProvider,
  type ZacModelRequest,
  type ZacAnalysisPlanInput,
  type ZacAnalysisPlanOutcome,
  type ZacPrioritySynthesisInput,
  type ZacPrioritySynthesisOutcome,
  type ZacSemanticRouterInput,
  type ZacSemanticRouterOutcome,
} from '../zac-model-provider.interface';

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 8192;
/**
 * The routing model. Smaller and cheaper than the narration model, because
 * routing is a small, high-volume classification on the user's critical path.
 *
 * Sonnet rather than Haiku, for a specific reason: the routing prompt is ~2.3k
 * tokens (the worked examples are what make it understand meaning rather than
 * keywords) and it is byte-identical on every call, so it wants to be CACHED.
 * The minimum cacheable prefix is 4096 tokens on Haiku 4.5 but 1024 on Sonnet 5
 * — at this prompt size Haiku would silently never cache (no error, just
 * cache_creation_input_tokens: 0), which makes the nominally cheaper model the
 * more expensive one per routed request, and less accurate besides.
 *
 * Override with ZAC_ROUTER_MODEL_ID. If you point it at a model with a higher
 * cacheable minimum, check `cache_read_input_tokens` on the cost spine — a
 * silent drop to zero is the symptom.
 */
const DEFAULT_ROUTER_MODEL = 'claude-sonnet-5';
/** The router emits one small tool call; nothing needs a large budget. */
const ROUTER_MAX_TOKENS = 512;
/**
 * A blocking pre-step on the user's turn, so it cannot wait forever — but 8s
 * was too tight to be a safety valve and became a routine failure mode.
 *
 * Measured against the live router model: a single call runs p50 ~4.8s and
 * p95 ~12.7s, and even at a concurrency of two the 8s cap produced
 * `classification_timeout`. A timeout is expensive out of proportion to the
 * wait it saves: the fallback ladder treats it as genuine ambiguity and asks
 * the user a clarifying question, so a broad business question gets "did you
 * mean general advice or your figures?" instead of an analysis.
 *
 * 15s sits above the measured p95. With `maxRetries: 0` the worst case is also
 * shorter than the old 8s-plus-one-retry, so this is not a latency regression:
 * it converts a doubled wait that ends in a bad turn into a single wait that
 * ends in the right one.
 */
const ROUTER_TIMEOUT_MS = 15_000;
/** Thinking bills inside max_tokens — a tighter cap guarantees truncation. */
const MIN_MAX_TOKENS = 1024;

/**
 * The live provider (Week 3). One non-streaming Messages call per narration:
 * the stable constitution + role seed go in `system` (with a prompt-cache
 * breakpoint), the question + verified evidence go in the user turn. The model
 * NARRATES pre-computed figures — it is told, structurally and in the prompt,
 * that every number must come from the evidence block. Failures throw; the
 * orchestrator's deterministic tool-backed answer is the degradation mode, so
 * a provider outage can never break an answer.
 *
 * Privacy: the question and evidence exist only in the request — this class
 * never logs, persists or telemeters either (interface contract).
 */
@Injectable()
export class AnthropicZacModelProvider implements ZacModelProvider {
  private readonly logger = new Logger(AnthropicZacModelProvider.name);
  private readonly client: Anthropic;
  private readonly pricing: ZacModelPricing;
  /** Routing runs on a different, cheaper model — and must be priced as such. */
  private readonly routerPricing: ZacModelPricing;
  private readonly maxTokens: number;

  readonly name = 'anthropic';
  readonly model: string;
  readonly narrates = true;
  readonly semanticRouting = true;
  /** The model that performs semantic routing; may differ from the narration model. */
  readonly routerModel: string;

  constructor(config: ConfigService) {
    // The module factory only constructs this class when the key is present.
    this.client = new Anthropic({
      apiKey: config.getOrThrow<string>('ANTHROPIC_API_KEY'),
      timeout: 30_000,
      maxRetries: 2,
    });
    this.model = config.get<string>('ZAC_MODEL_ID')?.trim() || DEFAULT_MODEL;
    this.routerModel = config.get<string>('ZAC_ROUTER_MODEL_ID')?.trim() || DEFAULT_ROUTER_MODEL;
    this.maxTokens = parsePositiveInt(config.get<string>('ZAC_MODEL_MAX_TOKENS'), DEFAULT_MAX_TOKENS);
    this.pricing = resolveZacModelPricing(config);
    const router = resolveZacRouterPricing(config, this.pricing);
    this.routerPricing = router.pricing;
    if (!router.configured && this.routerModel !== this.model) {
      this.logger.warn(
        `ZAC_ROUTER_PRICE_* not set — semantic-routing cost events are priced at the ${this.model} rates while the calls run on ${this.routerModel}, so routing spend will be overstated.`,
      );
    }
    if (
      this.pricing.usdPerMillionInputTokens === 0 ||
      this.pricing.usdPerMillionOutputTokens === 0
    ) {
      // Either price missing makes estimates absent or WRONG — surface both.
      this.logger.warn(
        'ZAC_PRICE_* env vars are missing or incomplete — zac.cost_events estimates will be null or understated (D33: prices are deploy-time configuration).',
      );
    }
  }

  async complete(request: ZacModelRequest): Promise<ZacModelCompletion> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // Thinking is deliberately not configured: on current Claude models an
      // omitted `thinking` runs adaptive thinking, the recommended mode.
      output_config: { effort: 'medium' },
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(request),
          // Stable prefix (constitution + role seed + tool names) — cached so
          // repeat questions per role bill cache-read rates.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: buildUserMessage(request) }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    const usage = response.usage;
    const usageTokens = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    };

    const completion: ZacModelCompletion = {
      text,
      provider: this.name,
      model: response.model,
      inputTokens: usageTokens.inputTokens,
      outputTokens: usageTokens.outputTokens,
      // The API bills thinking inside output_tokens and never reports a
      // separate figure — 0 here is honest, not missing data.
      reasoningTokens: 0,
      cacheReadInputTokens: usageTokens.cacheReadInputTokens,
      cacheCreationInputTokens: usageTokens.cacheCreationInputTokens,
      estimatedCostUsd: estimateLiveModelCostUsd(this.pricing, usageTokens),
    };

    if (response.stop_reason === 'refusal') {
      // Safety classifiers declined; content may be empty. Callers fall back
      // to the deterministic answer — never surface this to the user raw.
      // The call BILLED: the completion (text cleared) rides on the error.
      throw new ZacModelRefusedError('Model declined to answer', { ...completion, text: '' });
    }

    if (response.stop_reason !== 'end_turn') {
      // Anything else ('max_tokens' truncation mid-sentence; 'tool_use' /
      // 'pause_turn' can't legitimately occur — we send no tools) is an
      // unusable narration. The call still billed, so the completion rides
      // on the error for honest cost telemetry.
      throw new ZacModelIncompleteError(
        `Narration incomplete (stop_reason ${response.stop_reason})`,
        completion,
      );
    }

    return completion;
  }

  /**
   * Layer 2 semantic intent classification. Runs only for requests the
   * deterministic layer could not resolve with certainty.
   *
   * Shape matters here:
   * - the decision comes back through a FORCED tool call, so the model cannot
   *   answer the user's question, emit prose, or invent a field;
   * - the system block is a module-level constant, so it is byte-identical
   *   every call and is cached (routing prompts are large because of the
   *   worked examples — caching is what makes that affordable);
   * - the user block carries the question, the role LENS and at most three
   *   structural turn summaries. No identity, no scope, no permissions, no
   *   tool names, no business records.
   *
   * Output is UNTRUSTED and returned raw; ZacSemanticRouterService validates
   * every field against the closed enums. This method never throws: failures
   * come back as a typed `failure` code so the caller can tell "I could not
   * work out what you meant" apart from "your data is unavailable".
   */
  /**
   * Plan the analysis for a live-data question: what kind it is, and which of
   * the supplied sources answer it. Same contract as the router — never
   * throws, returns untrusted `raw` for the server to validate, and receives
   * no identity, permissions or business data.
   */
  /**
   * Choose and explain priorities from server-built candidates. Structured, so
   * an over-long, repeated or invented list is a validation failure rather than
   * something the user reads. Uses the full model — this is the answer itself,
   * not a routing decision.
   */
  async synthesisePriorities(
    input: ZacPrioritySynthesisInput,
  ): Promise<ZacPrioritySynthesisOutcome> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        output_config: { effort: 'medium' },
        system: [
          {
            type: 'text',
            text: ZAC_PRIORITY_SYNTHESIS_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: ZAC_PRIORITY_SYNTHESIS_TOOL_NAME,
            description: 'Record the chosen priorities for this request.',
            input_schema: ZAC_PRIORITY_SYNTHESIS_SCHEMA as unknown as Anthropic.Tool.InputSchema,
            strict: true,
          },
        ],
        tool_choice: { type: 'tool', name: ZAC_PRIORITY_SYNTHESIS_TOOL_NAME },
        messages: [{ role: 'user', content: buildPrioritySynthesisUserMessage(input) }],
      });

      const usage = response.usage;
      const usageTokens = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      };
      const completion: ZacModelCompletion = {
        text: '',
        provider: this.name,
        model: response.model,
        inputTokens: usageTokens.inputTokens,
        outputTokens: usageTokens.outputTokens,
        reasoningTokens: 0,
        cacheReadInputTokens: usageTokens.cacheReadInputTokens,
        cacheCreationInputTokens: usageTokens.cacheCreationInputTokens,
        estimatedCostUsd: estimateLiveModelCostUsd(this.pricing, usageTokens),
      };

      if (response.stop_reason === 'refusal') {
        return { raw: null, failure: 'classification_refused', completion };
      }
      if (response.stop_reason !== 'tool_use') {
        return { raw: null, failure: 'classification_invalid', completion };
      }
      const block = response.content.find(
        (candidate): candidate is Anthropic.ToolUseBlock =>
          candidate.type === 'tool_use' && candidate.name === ZAC_PRIORITY_SYNTHESIS_TOOL_NAME,
      );
      if (!block) return { raw: null, failure: 'classification_invalid', completion };
      return { raw: block.input as Record<string, unknown>, failure: null, completion };
    } catch (error) {
      // The deterministic candidate rendering answers instead — the user still
      // gets their priorities, just in the server's words.
      this.logger.warn(`zac priority synthesis failed: ${describeProviderFailure(error)}`);
      return {
        raw: null,
        failure: 'provider_unavailable',
        completion: null,
        failureKind: classifySemanticFailure(error),
      };
    }
  }

  async planAnalysis(input: ZacAnalysisPlanInput): Promise<ZacAnalysisPlanOutcome> {
    try {
      const response = await this.client.messages.create(
        {
          model: this.routerModel,
          max_tokens: ROUTER_MAX_TOKENS,
          output_config: { effort: 'low' },
          system: [
            {
              type: 'text',
              text: ZAC_ANALYSIS_PLANNER_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: [
            {
              name: ZAC_ANALYSIS_PLANNER_TOOL_NAME,
              description: 'Record the analysis plan for this request.',
              input_schema: ZAC_ANALYSIS_PLANNER_SCHEMA as unknown as Anthropic.Tool.InputSchema,
              strict: true,
            },
          ],
          tool_choice: { type: 'tool', name: ZAC_ANALYSIS_PLANNER_TOOL_NAME },
          messages: [{ role: 'user', content: buildAnalysisPlannerUserMessage(input) }],
        },
        // No retry: a slow call is slow, not broken, and retrying it doubles
        // the user's wait for the same likely outcome.
        { timeout: ROUTER_TIMEOUT_MS, maxRetries: 0 },
      );

      const usage = response.usage;
      const usageTokens = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      };
      const completion: ZacModelCompletion = {
        text: '',
        provider: this.name,
        model: response.model,
        inputTokens: usageTokens.inputTokens,
        outputTokens: usageTokens.outputTokens,
        reasoningTokens: 0,
        cacheReadInputTokens: usageTokens.cacheReadInputTokens,
        cacheCreationInputTokens: usageTokens.cacheCreationInputTokens,
        estimatedCostUsd: estimateLiveModelCostUsd(this.routerPricing, usageTokens),
      };

      if (response.stop_reason === 'refusal') {
        return { raw: null, failure: 'classification_refused', completion };
      }
      if (response.stop_reason !== 'tool_use') {
        return { raw: null, failure: 'classification_invalid', completion };
      }
      const block = response.content.find(
        (candidate): candidate is Anthropic.ToolUseBlock =>
          candidate.type === 'tool_use' && candidate.name === ZAC_ANALYSIS_PLANNER_TOOL_NAME,
      );
      if (!block) {
        return { raw: null, failure: 'classification_invalid', completion };
      }
      return { raw: block.input as Record<string, unknown>, failure: null, completion };
    } catch (error) {
      // A planning failure must never break the turn: the caller falls back to
      // the deterministic plan and STILL reads live data.
      this.logger.warn(`zac analysis planning failed: ${describeProviderFailure(error)}`);
      return {
        raw: null,
        failure: 'provider_unavailable',
        completion: null,
        failureKind: classifySemanticFailure(error),
      };
    }
  }

  async classifyRequestMode(input: ZacSemanticRouterInput): Promise<ZacSemanticRouterOutcome> {
    try {
      const response = await this.client.messages.create(
        {
          model: this.routerModel,
          max_tokens: ROUTER_MAX_TOKENS,
          // Routing is a judgement call, not a reasoning task; low effort keeps
          // it off the user's critical path.
          output_config: { effort: 'low' },
          system: [
            {
              type: 'text',
              text: ZAC_SEMANTIC_ROUTER_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: [
            {
              name: ZAC_SEMANTIC_ROUTER_TOOL_NAME,
              description: 'Record the request mode for this user message.',
              input_schema: ZAC_SEMANTIC_ROUTER_SCHEMA as unknown as Anthropic.Tool.InputSchema,
              // Guarantees the emitted input matches the schema exactly.
              strict: true,
            },
          ],
          // Forced: the only legal output is one call to the routing tool.
          tool_choice: { type: 'tool', name: ZAC_SEMANTIC_ROUTER_TOOL_NAME },
          messages: [{ role: 'user', content: buildSemanticRouterUserMessage(input) }],
        },
        // No retry: a slow call is slow, not broken, and retrying it doubles
        // the user's wait for the same likely outcome.
        { timeout: ROUTER_TIMEOUT_MS, maxRetries: 0 },
      );

      const usage = response.usage;
      const usageTokens = {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      };
      const completion: ZacModelCompletion = {
        text: '',
        provider: this.name,
        model: response.model,
        inputTokens: usageTokens.inputTokens,
        outputTokens: usageTokens.outputTokens,
        reasoningTokens: 0,
        cacheReadInputTokens: usageTokens.cacheReadInputTokens,
        cacheCreationInputTokens: usageTokens.cacheCreationInputTokens,
        estimatedCostUsd: estimateLiveModelCostUsd(this.routerPricing, usageTokens),
      };

      if (response.stop_reason === 'refusal') {
        return { raw: null, failure: 'classification_refused', completion };
      }
      if (response.stop_reason !== 'tool_use') {
        // Truncated, or the model answered in prose despite tool_choice.
        return { raw: null, failure: 'classification_invalid', completion };
      }

      const block = response.content.find(
        (candidate): candidate is Anthropic.ToolUseBlock =>
          candidate.type === 'tool_use' && candidate.name === ZAC_SEMANTIC_ROUTER_TOOL_NAME,
      );
      if (!block || typeof block.input !== 'object' || block.input === null) {
        return { raw: null, failure: 'classification_invalid', completion };
      }

      return { raw: block.input as ZacSemanticRouterOutcome['raw'], failure: null, completion };
    } catch (error) {
      const failure: ZacClassifierFailure = isTimeout(error)
        ? 'classification_timeout'
        : 'provider_unavailable';
      // The question itself is never logged — only the failure shape, plus the
      // API's own words when it rejected the request as malformed, because
      // that is our bug and used to read as an indistinguishable outage.
      this.logger.warn(
        `zac semantic routing failed (${failure}): ${describeProviderFailure(error)}; safe fallback applies`,
      );
      return { raw: null, failure, completion: null, failureKind: classifySemanticFailure(error) };
    }
  }
}

/**
 * Distinguish a routing timeout from any other transport failure, so the
 * caller can report the honest reason. Reads the error shape rather than
 * using `instanceof`: the SDK's error classes are not guaranteed to be
 * present (they are absent under a module mock), and a routing helper must
 * never itself throw.
 */
function isTimeout(error: unknown): boolean {
  const candidate = error as { name?: string; message?: string; status?: number } | null;
  if (candidate?.status === 408) return true;
  return /timeout|timed out|aborted/i.test(`${candidate?.name ?? ''} ${candidate?.message ?? ''}`);
}

/**
 * A failure line that names OUR bug when it is ours.
 *
 * The fail-soft contract is right — a provider fault must never break a turn —
 * but logging only `error.name` reduced every failure to "Error", and a 400
 * caused by our own tool schema looked exactly like a network blip. A 4xx is
 * never the user's data and never transient: it is a request WE built wrongly,
 * so it is worth saying so out loud.
 */
function describeProviderFailure(error: unknown): string {
  const err = error as { name?: string; status?: number; message?: string };
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    const message = String(err.message ?? '').slice(0, 300);
    return `${err.name ?? 'Error'} ${err.status} (request rejected — this is a bug in the request we sent): ${message}`;
  }
  return err.name ?? 'Error';
}


function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= MIN_MAX_TOKENS ? value : fallback;
}
