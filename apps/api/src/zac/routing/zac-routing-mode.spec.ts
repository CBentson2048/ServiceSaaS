/**
 * The routing-mode seam (ZAC_ROUTING_MODE): legacy keeps today's pipeline
 * byte-for-byte, shadow observes the dedicated semantic provider without ever
 * letting it steer, and semantic makes it Layer 2 while Layer 1 (explicit
 * directives) and Layer 3 (safe fallback) stay deterministic. Plus the v2
 * verdict validation: bucketed confidence, the §11 intent/source coherence
 * rules, and the hard non-data-turns-carry-no-intent invariant.
 */

import type { ConfigService } from '@nestjs/config';
import { ZacMemoryExtractionService } from '../memory/zac-memory-extraction.service';
import { ZacRequestModeClassifierService } from './zac-request-mode-classifier.service';
import { ZacSemanticRouterService } from './zac-semantic-router.service';
import { ZacSemanticHealthService } from '../models/zac-semantic-health.service';
import type {
  ZacModelProvider,
  ZacSemanticRouterOutcome,
} from '../models/zac-model-provider.interface';
import type { ZacSemanticProvider } from '../models/zac-semantic-provider.interface';

/**
 * A question chosen NOT to trip a Layer 1 explicit rule (asserted as a test
 * precondition below) so every test reliably exercises Layer 2.
 */
const QUESTION = 'Everyone keeps talking about growth, what would you look at first for me?';

const V2_ROUTE = {
  mode: 'qlooqo_data',
  analysis_intent: 'business_priorities',
  information_source: 'live_qlooqo',
  confidence: 'high',
  requires_live_business_data: true,
  reason_code: 'real_business_analysis',
  resource_category: 'live_business_metrics',
};

const COMPLETION = {
  text: '',
  provider: 'openai',
  model: 'gpt-5-mini-2025-08-07',
  inputTokens: 500,
  outputTokens: 60,
  reasoningTokens: 0,
  cacheReadInputTokens: 2500,
  cacheCreationInputTokens: 0,
  estimatedCostUsd: 0.0002,
};

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function makeLegacyProvider(
  outcome?: ZacSemanticRouterOutcome,
): ZacModelProvider & { classifyRequestMode: jest.Mock } {
  return {
    name: 'anthropic',
    model: 'claude-opus-5',
    narrates: true,
    semanticRouting: true,
    complete: jest.fn(),
    classifyRequestMode: jest.fn().mockResolvedValue(
      outcome ?? {
        raw: {
          mode: 'qlooqo_data',
          confidence: 0.9,
          requires_live_business_data: true,
          reason_code: 'real_business_analysis',
        },
        failure: null,
        completion: { ...COMPLETION, provider: 'anthropic', model: 'claude-sonnet-5' },
      },
    ),
  } as unknown as ZacModelProvider & { classifyRequestMode: jest.Mock };
}

function makeSemanticProvider(
  outcome?: Partial<ZacSemanticRouterOutcome> & { raw?: unknown },
): ZacSemanticProvider & { classify: jest.Mock } {
  return {
    name: 'openai',
    model: 'gpt-5-mini',
    classify: jest.fn().mockResolvedValue({
      raw: V2_ROUTE,
      failure: null,
      completion: COMPLETION,
      ...outcome,
    }),
  };
}

function makeRouter(options: {
  mode?: string;
  legacy?: ZacModelProvider;
  semantic?: ZacSemanticProvider | null;
  health?: ZacSemanticHealthService;
}) {
  const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
  return new ZacSemanticRouterService(
    classifier,
    options.legacy ?? makeLegacyProvider(),
    makeConfig({ ZAC_ROUTING_MODE: options.mode }),
    options.health ?? new ZacSemanticHealthService(),
    options.semantic === undefined ? null : options.semantic,
  );
}

describe('ZAC routing modes', () => {
  it('precondition: the probe question reaches Layer 2 (no explicit rule fires)', () => {
    const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
    expect(classifier.classifyExplicit(QUESTION, 'owner')).toBeNull();
  });

  it('defaults to legacy and parses unknown modes as legacy', () => {
    expect(makeRouter({}).routingMode).toBe('legacy');
    expect(makeRouter({ mode: 'SEMANTIC' }).routingMode).toBe('semantic');
    expect(makeRouter({ mode: 'full-openai' }).routingMode).toBe('legacy');
  });

  describe('legacy mode', () => {
    it('routes through the model provider and never touches the semantic provider', async () => {
      const legacy = makeLegacyProvider();
      const semantic = makeSemanticProvider();
      const router = makeRouter({ mode: 'legacy', legacy, semantic });

      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });

      expect(legacy.classifyRequestMode).toHaveBeenCalledTimes(1);
      expect(semantic.classify).not.toHaveBeenCalled();
      expect(routed.shadow).toBeNull();
      expect(routed.classification.mode).toBe('qlooqo_data');
      expect(routed.classification.source).toBe('semantic_model');
      expect(router.routerVersion).toBe('semantic-v1');
      expect(router.promptVersion).toBeNull();
    });
  });

  describe('semantic mode', () => {
    it('makes the dedicated provider Layer 2 and records the v2 verdict', async () => {
      const legacy = makeLegacyProvider();
      const semantic = makeSemanticProvider();
      const router = makeRouter({ mode: 'semantic', legacy, semantic });

      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });

      expect(semantic.classify).toHaveBeenCalledTimes(1);
      expect(legacy.classifyRequestMode).not.toHaveBeenCalled();
      expect(routed.shadow).toBeNull();
      expect(routed.classifierInvoked).toBe(true);
      expect(routed.completion?.provider).toBe('openai');
      expect(routed.classification.mode).toBe('qlooqo_data');
      // high bucket → 0.9, above the accept threshold.
      expect(routed.classification.confidence).toBe(0.9);
      expect(routed.classification.analysisIntent).toBe('business_priorities');
      expect(routed.classification.informationSource).toBe('live_qlooqo');
      expect(router.routerVersion).toBe('semantic-v2');
      expect(router.promptVersion).not.toBeNull();
      expect(router.routerModel).toBe('gpt-5-mini');
    });

    it('records router health under the AUTHORITATIVE capability', async () => {
      const health = new ZacSemanticHealthService();
      const router = makeRouter({ mode: 'semantic', semantic: makeSemanticProvider(), health });
      await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(health.operational('router')).toBe(true);
      expect(health.snapshot('shadow_router').successes).toBe(0);
    });

    it('without a provider, degrades like a keyless build: fallback, never a crash', async () => {
      const legacy = makeLegacyProvider();
      const router = makeRouter({ mode: 'semantic', legacy, semantic: null });

      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });

      // The legacy classifier is NOT consulted — semantic mode does not
      // silently fall back to the old model pipeline.
      expect(legacy.classifyRequestMode).not.toHaveBeenCalled();
      expect(routed.classifierInvoked).toBe(false);
      expect(routed.classification.classifierFailure).toBe('provider_unavailable');
      expect(routed.classification.source).toBe('fallback');
      expect(router.semanticRoutingAvailable).toBe(false);
    });

    it('a supplied scenario still falls back to hypothetical when the provider times out', async () => {
      const semantic = makeSemanticProvider({
        raw: null,
        failure: 'classification_timeout',
        completion: null,
        failureKind: 'timeout',
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({
        question: 'If a stylist has a 50% target and is achieving 40%, what would you recommend?',
        roleContext: 'owner',
      });
      expect(routed.classification.mode).toBe('hypothetical');
      expect(routed.classification.classifierFailure).toBe('classification_timeout');
    });

    it('resolves a follow-up as contextual when prior turns exist', async () => {
      const semantic = makeSemanticProvider({
        raw: { ...V2_ROUTE, reason_code: 'conversation_followup', analysis_intent: 'diagnostic' },
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({
        question: 'ok but why though',
        roleContext: 'owner',
        recentTurnSummaries: ['Answered about rebooking this month (data read).'],
      });
      expect(routed.classification.source).toBe('contextual_followup');
      expect(routed.classification.analysisIntent).toBe('diagnostic');
    });
  });

  describe('shadow mode', () => {
    it('legacy decides; the shadow verdict is observed and can never steer', async () => {
      const legacy = makeLegacyProvider({
        raw: {
          mode: 'general_advice',
          confidence: 0.9,
          requires_live_business_data: false,
          reason_code: 'general_business_advice',
        },
        failure: null,
        completion: { ...COMPLETION, provider: 'anthropic', model: 'claude-sonnet-5' },
      });
      const semantic = makeSemanticProvider(); // says qlooqo_data — disagrees
      const health = new ZacSemanticHealthService();
      const router = makeRouter({ mode: 'shadow', legacy, semantic, health });

      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });

      // The turn follows LEGACY even though the shadow disagreed.
      expect(routed.classification.mode).toBe('general_advice');
      expect(routed.completion?.provider).toBe('anthropic');
      expect(semantic.classify).toHaveBeenCalledTimes(1);

      const observation = await routed.shadow!;
      expect(observation.provider).toBe('openai');
      expect(observation.semantic?.mode).toBe('qlooqo_data');
      expect(observation.semantic?.confidenceBucket).toBe('high');
      expect(observation.failure).toBeNull();
      // Health is tracked apart from the authoritative pipeline.
      expect(health.snapshot('shadow_router').successes).toBe(1);
      expect(health.snapshot('router').successes).toBe(1); // the legacy call
    });

    it('observes Layer 1 short-circuited turns too', async () => {
      const semantic = makeSemanticProvider({
        raw: {
          ...V2_ROUTE,
          mode: 'memory',
          analysis_intent: 'none',
          information_source: 'zac_memory',
          requires_live_business_data: false,
          reason_code: 'user_memory_recall',
        },
      });
      const router = makeRouter({ mode: 'shadow', semantic });
      const routed = await router.route({
        question: 'What did I tell you my rebooking goal was?',
        roleContext: 'owner',
      });
      expect(routed.classification.source).toBe('deterministic');
      const observation = await routed.shadow!;
      expect(observation.semantic?.mode).toBe('memory');
    });

    it('a shadow failure surfaces as a typed observation and leaves the turn untouched', async () => {
      const semantic = makeSemanticProvider();
      semantic.classify.mockRejectedValue(new Error('boom'));
      const health = new ZacSemanticHealthService();
      const router = makeRouter({ mode: 'shadow', semantic, health });

      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(routed.classification.mode).toBe('qlooqo_data'); // legacy verdict

      const observation = await routed.shadow!;
      expect(observation.semantic).toBeNull();
      expect(observation.failure).toBe('provider_unavailable');
      expect(health.operational('shadow_router')).toBe(false);
      expect(health.operational('router')).toBe(true);
    });
  });

  describe('v2 verdict validation (§11)', () => {
    it('low confidence hands the turn to the fallback ladder', async () => {
      const semantic = makeSemanticProvider({ raw: { ...V2_ROUTE, confidence: 'low' } });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(routed.classification.source).not.toBe('semantic_model');
      expect(routed.classification.classifierFailure).toBe('classification_low_confidence');
    });

    it('a data verdict claiming intent none loses self-consistency and cannot be accepted alone', async () => {
      const semantic = makeSemanticProvider({
        raw: { ...V2_ROUTE, analysis_intent: 'none' },
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      // Confidence capped below accept; an uncorroborated live-data verdict is
      // exactly what must not route on its own say-so.
      expect(routed.classification.source).not.toBe('semantic_model');
    });

    it('a non-data verdict carrying an intent has it STRIPPED, whatever the model said', async () => {
      const semantic = makeSemanticProvider({
        raw: {
          mode: 'general_advice',
          analysis_intent: 'business_priorities', // incoherent claim
          information_source: 'general_knowledge',
          confidence: 'high',
          requires_live_business_data: false,
          reason_code: 'general_business_advice',
          resource_category: 'general_knowledge',
        },
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(routed.classification.analysisIntent).toBe('none');
    });

    it('an information source that contradicts the mode voids self-consistency', async () => {
      const semantic = makeSemanticProvider({
        raw: { ...V2_ROUTE, information_source: 'general_knowledge' },
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(routed.classification.source).not.toBe('semantic_model');
    });

    it('a v2 verdict with an out-of-enum intent is discarded whole', async () => {
      const semantic = makeSemanticProvider({
        raw: { ...V2_ROUTE, analysis_intent: 'world_domination' },
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(routed.classification.classifierFailure).not.toBeNull();
      expect(routed.classification.source).not.toBe('semantic_model');
    });

    it('a legacy numeric verdict still validates exactly as before (back-compat)', async () => {
      const semantic = makeSemanticProvider({
        raw: {
          mode: 'general_advice',
          confidence: 0.92,
          requires_live_business_data: false,
          reason_code: 'general_business_advice',
        },
      });
      const router = makeRouter({ mode: 'semantic', semantic });
      const routed = await router.route({ question: QUESTION, roleContext: 'owner' });
      expect(routed.classification.mode).toBe('general_advice');
      expect(routed.classification.source).toBe('semantic_model');
      expect(routed.classification.confidence).toBe(0.92);
      expect(routed.classification.analysisIntent).toBe('none');
    });
  });
});
