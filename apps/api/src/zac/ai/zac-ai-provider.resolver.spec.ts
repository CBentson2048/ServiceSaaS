import type { ConfigService } from '@nestjs/config';
import { ZacAiProviderResolver } from './zac-ai-provider.resolver';
import { ZacCompositeModelProvider } from './zac-composite-model.provider';
import {
  ZacAiConfigurationError,
  ignoredCapabilityOverrides,
  resolveZacAiProfile,
} from './zac-ai-profile.config';
import { toZacAiFailureKind, ZAC_AI_CAPABILITIES } from './zac-ai.types';

/**
 * PROVIDER-SWITCH TESTS.
 *
 * The whole point of the refactor is that one variable moves every AI call to a
 * different vendor without touching a line of business code. That claim is only
 * worth anything if it is asserted, so these tests read the resolved bindings
 * for each profile rather than trusting the wiring by inspection.
 *
 * No network: the adapters are constructed for real (which proves they CAN be)
 * but never called. A fake API key is enough to construct a vendor client;
 * nothing here bills.
 */

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
    getOrThrow: <T>(key: string): T => {
      const value = values[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value as T;
    },
  } as unknown as ConfigService;
}

const KEYS = { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' };

/** capability → provider, as the resolver actually bound it. */
function bound(resolver: ZacAiProviderResolver): Record<string, string | null> {
  return Object.fromEntries(resolver.bindings().map((b) => [b.capability, b.provider]));
}

describe('ZAC_AI_PROVIDER profile resolution', () => {
  it('defaults to the shipped hybrid design when nothing is configured', () => {
    // The default MUST be the current production shape, or this refactor would
    // silently re-provider every deployment that has not set the new variable.
    const resolution = resolveZacAiProfile(config({}));
    expect(resolution).toEqual({
      profile: 'hybrid',
      semantic: 'openai',
      reasoning: 'anthropic',
      synthesis: 'anthropic',
      explicit: false,
    });
  });

  it('puts every capability on OpenAI under ZAC_AI_PROVIDER=openai', () => {
    const resolver = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'openai' }));
    expect(resolver.profile).toBe('openai');
    expect(bound(resolver)).toEqual({
      semantic_routing: 'openai',
      tool_planning: 'openai',
      structured_reasoning: 'openai',
      answer_synthesis: 'openai',
    });
    expect(resolver.degradations).toEqual([]);
  });

  it('puts every capability on Anthropic under ZAC_AI_PROVIDER=anthropic', () => {
    const resolver = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'anthropic' }));
    expect(resolver.profile).toBe('anthropic');
    expect(bound(resolver)).toEqual({
      semantic_routing: 'anthropic',
      tool_planning: 'anthropic',
      structured_reasoning: 'anthropic',
      answer_synthesis: 'anthropic',
    });
    expect(resolver.degradations).toEqual([]);
  });

  it('honours per-capability configuration under hybrid', () => {
    const resolver = new ZacAiProviderResolver(
      config({
        ...KEYS,
        ZAC_AI_PROVIDER: 'hybrid',
        ZAC_SEMANTIC_PROVIDER: 'openai',
        ZAC_REASONING_PROVIDER: 'anthropic',
        ZAC_SYNTHESIS_PROVIDER: 'openai',
      }),
    );
    expect(bound(resolver)).toEqual({
      semantic_routing: 'openai',
      tool_planning: 'anthropic',
      structured_reasoning: 'anthropic',
      answer_synthesis: 'openai',
    });
  });

  it('keeps the shipped production shape as the DEFAULT hybrid assignment', () => {
    const resolver = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'hybrid' }));
    expect(bound(resolver)).toEqual({
      semantic_routing: 'openai',
      tool_planning: 'anthropic',
      structured_reasoning: 'anthropic',
      answer_synthesis: 'anthropic',
    });
  });

  it('fails fast on an unsupported profile instead of falling back', () => {
    // A silent fallback is the worst outcome available: a typo would quietly
    // benchmark the other vendor and report it under this one's name.
    expect(() => resolveZacAiProfile(config({ ZAC_AI_PROVIDER: 'gemini' }))).toThrow(
      ZacAiConfigurationError,
    );
    expect(() => resolveZacAiProfile(config({ ZAC_AI_PROVIDER: 'openal' }))).toThrow(
      /not a supported profile/,
    );
  });

  it('fails fast on an unsupported capability provider', () => {
    expect(() =>
      resolveZacAiProfile(config({ ZAC_AI_PROVIDER: 'hybrid', ZAC_REASONING_PROVIDER: 'llama' })),
    ).toThrow(/not a supported provider/);
  });

  it('fails at BOOT, not on the first request', () => {
    expect(() => new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'nope' }))).toThrow(
      ZacAiConfigurationError,
    );
  });

  it('ignores — and reports — per-capability overrides under a single-vendor profile', () => {
    const values = {
      ...KEYS,
      ZAC_AI_PROVIDER: 'openai',
      ZAC_REASONING_PROVIDER: 'anthropic',
    };
    const resolution = resolveZacAiProfile(config(values));
    expect(resolution.reasoning).toBe('openai');
    // Reported rather than silently obeyed: an operator whose benchmark is not
    // measuring what they think must be told.
    expect(ignoredCapabilityOverrides(config(values), resolution)).toEqual([
      'ZAC_REASONING_PROVIDER',
    ]);
  });

  it('covers every declared capability in its bindings', () => {
    const resolver = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'openai' }));
    expect(resolver.bindings().map((b) => b.capability).sort()).toEqual(
      [...ZAC_AI_CAPABILITIES].sort(),
    );
  });
});

describe('a missing key degrades, and never switches vendor', () => {
  it('does not move a capability to the other vendor when its key is absent', () => {
    // Silently re-providering on a missing key would make a benchmark measure
    // something other than what it claims.
    const resolver = new ZacAiProviderResolver(
      config({ ZAC_AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'sk-ant-test' }),
    );
    const bindings = bound(resolver);
    expect(bindings.semantic_routing).toBeNull();
    expect(bindings.structured_reasoning).toBeNull();
    expect(Object.values(bindings)).not.toContain('anthropic');
    expect(resolver.degradations.join(' ')).toContain('OPENAI_API_KEY is not set');
  });

  it('falls to the deterministic stub for synthesis with no key at all', () => {
    const resolver = new ZacAiProviderResolver(config({}));
    const synthesis = resolver.synthesis();
    expect(synthesis.narrates).toBe(false);
    expect(synthesis.model).toBe('zac-stub-1');
    expect(resolver.semantic()).toBeNull();
    expect(resolver.reasoning()).toBeNull();
  });
});

describe('the composite model provider follows the resolved profile', () => {
  it('reports the synthesis binding as its identity', () => {
    const resolver = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'openai' }));
    const composite = new ZacCompositeModelProvider(resolver);
    expect(composite.name).toBe('openai');
    expect(composite.narrates).toBe(true);
  });

  it('exposes reasoning methods only when a reasoning provider is bound', () => {
    const withKeys = new ZacCompositeModelProvider(
      new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'anthropic' })),
    );
    expect(typeof withKeys.planAnalysis).toBe('function');
    expect(typeof withKeys.synthesisePriorities).toBe('function');

    // Callers branch on the METHOD's existence to decide whether the
    // deterministic path applies. A method that exists and always fails would
    // report "reasoning attempted and failed" for "no reasoning configured".
    const withoutKeys = new ZacCompositeModelProvider(new ZacAiProviderResolver(config({})));
    expect(withoutKeys.planAnalysis).toBeUndefined();
    expect(withoutKeys.synthesisePriorities).toBeUndefined();
  });

  it('keeps the LEGACY classifier on the narration vendor, not the dedicated router', () => {
    // Shadow mode compares the dedicated router against the pre-migration
    // classifier. Pointing both at the same object would make it compare a
    // provider with itself and report perfect agreement forever.
    const hybrid = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'hybrid' }));
    expect(hybrid.semantic()?.name).toBe('openai');
    expect(hybrid.legacyClassifier()?.name).toBe('anthropic');

    // Under an all-OpenAI profile there is no separate legacy classifier, and
    // the router uses its safe fallback ladder rather than inventing one.
    const openai = new ZacAiProviderResolver(config({ ...KEYS, ZAC_AI_PROVIDER: 'openai' }));
    expect(openai.legacyClassifier()).toBeNull();
  });
});

describe('failure taxonomy normalisation', () => {
  it('maps every shipped semantic failure kind onto the ZAC-wide taxonomy', () => {
    expect(toZacAiFailureKind('auth')).toBe('authentication');
    expect(toZacAiFailureKind('credit')).toBe('quota');
    expect(toZacAiFailureKind('rate_limit')).toBe('rate_limit');
    expect(toZacAiFailureKind('timeout')).toBe('timeout');
    expect(toZacAiFailureKind('schema')).toBe('schema_failure');
    expect(toZacAiFailureKind('refusal')).toBe('content_policy');
    expect(toZacAiFailureKind('invalid_output')).toBe('invalid_structured_output');
    expect(toZacAiFailureKind('transport')).toBe('provider_unavailable');
  });

  it('never guesses: an unknown or absent kind is `unknown`', () => {
    expect(toZacAiFailureKind(null)).toBe('unknown');
    expect(toZacAiFailureKind(undefined)).toBe('unknown');
  });
});
