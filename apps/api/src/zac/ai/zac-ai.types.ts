import type { ZacSemanticFailureKind } from '../models/zac-semantic-health.service';

/**
 * ZAC-OWNED AI VOCABULARY.
 *
 * Everything in this file is ZAC's own language for talking about model
 * providers. No OpenAI type, no Anthropic type, no SDK import — and none may
 * ever be added here, because this is precisely the layer that stops a vendor's
 * shape becoming ZAC's shape.
 *
 * The rule the whole refactor enforces: **ZAC business and orchestration code
 * depends on these contracts; provider adapters translate between them and
 * their vendor's API.** A provider is an implementation detail of intelligence,
 * never of authority — permissions, privacy, evidence, memory, signals and
 * priority logic are decided server-side and do not know which model answered.
 */

/** The providers ZAC officially supports today. */
export type ZacAiProviderId = 'openai' | 'anthropic';

export const ZAC_AI_PROVIDER_IDS: readonly ZacAiProviderId[] = ['openai', 'anthropic'];

/**
 * The top-level deployment profile.
 *
 * `openai` and `anthropic` put every capability on one vendor, which is what
 * makes a like-for-like benchmark possible. `hybrid` keeps the shipped
 * production design — a dedicated router on one vendor, reasoning and synthesis
 * on another — and is the default precisely so this refactor changes no
 * deployed behaviour on its own.
 */
export type ZacAiProviderProfile = 'openai' | 'anthropic' | 'hybrid';

export const ZAC_AI_PROVIDER_PROFILES: readonly ZacAiProviderProfile[] = [
  'openai',
  'anthropic',
  'hybrid',
];

/**
 * What a provider can be asked to DO.
 *
 * Deliberately four, and deliberately not "chat": ZAC's model calls are four
 * distinct jobs with different prompts, schemas, latency budgets and failure
 * consequences, and collapsing them is what made a single `ZacModelProvider`
 * unable to put routing on one vendor and narration on another.
 *
 * `tool_planning` and `structured_reasoning` are separate capabilities but one
 * PORT: both are "return a validated object against a ZAC-owned schema", they
 * share an adapter, and splitting the port would mean two implementations of
 * the same mechanism. Embeddings/RAG are deliberately absent — out of scope.
 */
export type ZacAiCapability =
  | 'semantic_routing'
  | 'tool_planning'
  | 'structured_reasoning'
  | 'answer_synthesis';

export const ZAC_AI_CAPABILITIES: readonly ZacAiCapability[] = [
  'semantic_routing',
  'tool_planning',
  'structured_reasoning',
  'answer_synthesis',
];

/**
 * PROVIDER-NEUTRAL FAILURE TAXONOMY.
 *
 * Every vendor exception is mapped into exactly one of these by its adapter, so
 * ZAC never branches on a provider's error class and a user never sees a
 * provider payload.
 *
 * The distinction that matters most is not in this list but around it: an AI
 * provider failure is NEVER reported as "your QLOOQO data is unavailable". A
 * model that could not be reached and a business figure that could not be read
 * are different facts, and the Phase 1 blocking-reason precedence already
 * depends on telling them apart.
 */
export type ZacAiFailureKind =
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'provider_unavailable'
  | 'invalid_request'
  | 'schema_failure'
  | 'invalid_structured_output'
  | 'content_policy'
  | 'unknown';

export const ZAC_AI_FAILURE_KINDS: readonly ZacAiFailureKind[] = [
  'authentication',
  'quota',
  'rate_limit',
  'timeout',
  'provider_unavailable',
  'invalid_request',
  'schema_failure',
  'invalid_structured_output',
  'content_policy',
  'unknown',
];

/**
 * The existing semantic-health vocabulary widened into the full taxonomy.
 *
 * `ZacSemanticFailureKind` is NOT replaced: it drives shipped health snapshots,
 * `/zac/health.semantic_last_failure_kind` and the routing tests, and renaming
 * a live observability field to tidy a type would be a behaviour change wearing
 * a refactor's clothes. This maps one onto the other so both can coexist —
 * narrow where the router already reasons, broad where a second provider and a
 * second capability now need to.
 */
export function toZacAiFailureKind(kind: ZacSemanticFailureKind | null | undefined): ZacAiFailureKind {
  switch (kind) {
    case 'auth':
      return 'authentication';
    case 'credit':
      return 'quota';
    case 'rate_limit':
      return 'rate_limit';
    case 'timeout':
      return 'timeout';
    case 'schema':
      return 'schema_failure';
    case 'refusal':
      return 'content_policy';
    case 'invalid_output':
      return 'invalid_structured_output';
    case 'transport':
      return 'provider_unavailable';
    default:
      return 'unknown';
  }
}

/**
 * NORMALISED USAGE. One shape for both vendors so cost and token comparisons
 * are arithmetic rather than interpretation.
 *
 * `cachedInputTokens` is optional because "this provider does not report cache
 * activity" and "nothing was cached" are different facts, and a default of 0
 * would quietly assert the second.
 */
export interface ZacAiUsage {
  provider: ZacAiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * NORMALISED FINISH REASON. Small on purpose: orchestration only ever needs to
 * know whether it got a usable answer, was cut short, was blocked, or failed.
 * Vendor stop reasons stay inside their adapters.
 */
export type ZacAiFinishReason =
  | 'completed'
  | 'tool_call'
  | 'max_tokens'
  | 'content_blocked'
  | 'error'
  | 'unknown';

export const ZAC_AI_FINISH_REASONS: readonly ZacAiFinishReason[] = [
  'completed',
  'tool_call',
  'max_tokens',
  'content_blocked',
  'error',
  'unknown',
];

/** What a provider declares it can do. Checked at boot against the profile. */
export interface ZacAiProviderCapabilities {
  readonly id: ZacAiProviderId;
  readonly supports: readonly ZacAiCapability[];
}

/** One resolved capability→provider→model binding, for health and telemetry. */
export interface ZacAiCapabilityBinding {
  capability: ZacAiCapability;
  provider: ZacAiProviderId | null;
  model: string | null;
}

export function isZacAiProviderId(value: unknown): value is ZacAiProviderId {
  return typeof value === 'string' && (ZAC_AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isZacAiProviderProfile(value: unknown): value is ZacAiProviderProfile {
  return (
    typeof value === 'string' && (ZAC_AI_PROVIDER_PROFILES as readonly string[]).includes(value)
  );
}
