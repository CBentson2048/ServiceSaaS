import type { ConfigService } from '@nestjs/config';
import {
  ZAC_AI_PROVIDER_IDS,
  ZAC_AI_PROVIDER_PROFILES,
  isZacAiProviderId,
  isZacAiProviderProfile,
  type ZacAiCapability,
  type ZacAiProviderId,
  type ZacAiProviderProfile,
} from './zac-ai.types';

/**
 * PROVIDER PROFILE RESOLUTION — one place, pure, and fail-fast.
 *
 * This function is the entire answer to "which vendor performs which
 * capability". Nothing else in ZAC may ask: scattering `if (provider ===
 * 'openai')` through orchestration is how a provider choice becomes a hundred
 * behavioural forks nobody can benchmark.
 *
 * It THROWS on an unsupported value rather than falling back. A silent fallback
 * is the worst possible outcome for a benchmark: `ZAC_AI_PROVIDER=openai` with
 * a typo would quietly measure Anthropic and report it as OpenAI, and every
 * conclusion drawn from that run would be wrong in a way nothing surfaces.
 */

/** What one capability resolves to, before keys and adapters are considered. */
export interface ZacAiCapabilityAssignment {
  capability: ZacAiCapability;
  provider: ZacAiProviderId;
}

export interface ZacAiProfileResolution {
  profile: ZacAiProviderProfile;
  semantic: ZacAiProviderId;
  reasoning: ZacAiProviderId;
  synthesis: ZacAiProviderId;
  /** True when the profile came from configuration rather than the default. */
  explicit: boolean;
}

/**
 * The default profile is `hybrid`, and the default hybrid assignment is exactly
 * what production runs today: a dedicated OpenAI router in front of Anthropic
 * reasoning and narration. Defaulting to anything else would make this refactor
 * a behaviour change for every deployment that does not set the new variable.
 */
export const ZAC_DEFAULT_PROFILE: ZacAiProviderProfile = 'hybrid';
export const ZAC_DEFAULT_HYBRID_SEMANTIC: ZacAiProviderId = 'openai';
export const ZAC_DEFAULT_HYBRID_REASONING: ZacAiProviderId = 'anthropic';
export const ZAC_DEFAULT_HYBRID_SYNTHESIS: ZacAiProviderId = 'anthropic';

export class ZacAiConfigurationError extends Error {
  constructor(message: string) {
    super(`ZAC AI configuration: ${message}`);
    this.name = 'ZacAiConfigurationError';
  }
}

function readProvider(
  config: ConfigService,
  key: string,
  fallback: ZacAiProviderId,
): ZacAiProviderId {
  const raw = config.get<string>(key)?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!isZacAiProviderId(raw)) {
    throw new ZacAiConfigurationError(
      `${key}='${raw}' is not a supported provider. Supported: ${ZAC_AI_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * Resolve the profile and its three capability assignments.
 *
 * Under `openai` or `anthropic` the per-capability variables are IGNORED rather
 * than merged: a single-vendor profile exists so a benchmark can attribute
 * every call to one vendor, and honouring a stray `ZAC_REASONING_PROVIDER`
 * would silently make `ZAC_AI_PROVIDER=openai` a hybrid run. A leftover setting
 * that would have changed the outcome is reported, not obeyed.
 */
export function resolveZacAiProfile(config: ConfigService): ZacAiProfileResolution {
  const rawProfile = config.get<string>('ZAC_AI_PROVIDER')?.trim().toLowerCase();

  let profile: ZacAiProviderProfile = ZAC_DEFAULT_PROFILE;
  if (rawProfile !== undefined && rawProfile !== '') {
    if (!isZacAiProviderProfile(rawProfile)) {
      throw new ZacAiConfigurationError(
        `ZAC_AI_PROVIDER='${rawProfile}' is not a supported profile. Supported: ${ZAC_AI_PROVIDER_PROFILES.join(', ')}.`,
      );
    }
    profile = rawProfile;
  }
  const explicit = rawProfile !== undefined && rawProfile !== '';

  if (profile === 'openai' || profile === 'anthropic') {
    return {
      profile,
      semantic: profile,
      reasoning: profile,
      synthesis: profile,
      explicit,
    };
  }

  return {
    profile: 'hybrid',
    // ZAC_SEMANTIC_PROVIDER predates this work and already means "which vendor
    // routes"; it keeps that meaning rather than being renamed out from under
    // deployed configuration.
    semantic: readProvider(config, 'ZAC_SEMANTIC_PROVIDER', ZAC_DEFAULT_HYBRID_SEMANTIC),
    reasoning: readProvider(config, 'ZAC_REASONING_PROVIDER', ZAC_DEFAULT_HYBRID_REASONING),
    synthesis: readProvider(config, 'ZAC_SYNTHESIS_PROVIDER', ZAC_DEFAULT_HYBRID_SYNTHESIS),
    explicit,
  };
}

/**
 * Per-capability settings a single-vendor profile deliberately ignores. Surfaced
 * so an operator whose benchmark is not measuring what they think gets told,
 * rather than discovering it in the numbers.
 */
export function ignoredCapabilityOverrides(
  config: ConfigService,
  resolution: ZacAiProfileResolution,
): string[] {
  if (resolution.profile === 'hybrid') return [];
  return ['ZAC_SEMANTIC_PROVIDER', 'ZAC_REASONING_PROVIDER', 'ZAC_SYNTHESIS_PROVIDER'].filter(
    (key) => {
      const raw = config.get<string>(key)?.trim().toLowerCase();
      return Boolean(raw) && raw !== resolution.profile;
    },
  );
}

/**
 * MODEL SELECTION, kept independent of provider selection.
 *
 * Every capability on every vendor has its own variable, so a benchmark can
 * pin a model without touching which vendor runs. Existing deployed variables
 * are the compatibility aliases and take precedence when the new name is unset,
 * because breaking a live deployment to tidy a naming scheme is not an upgrade:
 *
 *   ZAC_ANTHROPIC_SYNTHESIS_MODEL ← ZAC_MODEL_ID          (deployed today)
 *   ZAC_ANTHROPIC_SEMANTIC_MODEL  ← ZAC_ROUTER_MODEL_ID   (deployed today)
 *   ZAC_OPENAI_SEMANTIC_MODEL     ← ZAC_SEMANTIC_MODEL    (deployed today)
 *
 * The aliases are documented and kept; a deprecation would be a separate,
 * announced change with a release note, not a side effect of this refactor.
 */
export interface ZacAiModelAlias {
  /** The canonical, provider-and-capability-explicit variable. */
  canonical: string;
  /** The shipped variable it supersedes, still honoured. */
  alias?: string;
  fallback: string;
}

export function resolveModelId(config: ConfigService, spec: ZacAiModelAlias): string {
  const canonical = config.get<string>(spec.canonical)?.trim();
  if (canonical) return canonical;
  if (spec.alias) {
    const alias = config.get<string>(spec.alias)?.trim();
    if (alias) return alias;
  }
  return spec.fallback;
}
