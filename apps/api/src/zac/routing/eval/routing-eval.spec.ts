import type { ConfigService } from '@nestjs/config';
import { ZacMemoryExtractionService } from '../../memory/zac-memory-extraction.service';
import { ZAC_REQUEST_MODES } from '../zac-request-mode.types';
import { StubZacModelProvider } from '../../models/providers/stub-zac-provider';
import type {
  ZacModelProvider,
  ZacSemanticRouterInput,
  ZacSemanticRouterOutcome,
} from '../../models/zac-model-provider.interface';
import { ZacRequestModeClassifierService } from '../zac-request-mode-classifier.service';
import {
  ZAC_ROUTING_CLARIFICATION,
  ZacSemanticRouterService,
} from '../zac-semantic-router.service';
import type { ZacRequestMode } from '../zac-request-mode.types';
import { ZAC_MODE_INFORMATION_SOURCE } from '../zac-request-mode.types';
import type { ZacSemanticProvider } from '../../models/zac-semantic-provider.interface';
import { ZacSemanticHealthService } from '../../models/zac-semantic-health.service';
import {
  formatIntentReport,
  formatRoutingReport,
  isAcceptable,
  loadRoutingEvalDataset,
  scoreIntents,
  scoreRouting,
  type RoutingEvalCase,
  type RoutingEvalOutcome,
} from './routing-eval';

/**
 * The Phase 1 semantic-router evaluation suite.
 *
 * Two configurations are measured here, both WITHOUT a network call:
 *
 *  1. DETERMINISTIC-ONLY — no provider key. This is the floor: what a
 *     deployment routes on when the semantic layer is unavailable, and what
 *     the hosted environment does today. Its thresholds are deliberately
 *     lower.
 *
 *  2. SEMANTIC (oracle provider) — a deterministic test provider that returns
 *     the dataset's own label. This does NOT measure a real model's accuracy;
 *     it proves the ROUTER PLUMBING (validation, confidence policy, the
 *     ignore-data veto, the fallback ladder) carries a correct semantic
 *     verdict all the way through without corrupting it. Real-model accuracy
 *     is measured by the live harness in routing-eval.live.ts.
 *
 * The metric that matters most for the client acceptance failure is the
 * live-data FALSE POSITIVE rate: a question needing no business data that
 * gets routed into the data pipeline anyway.
 */

const config = { get: () => undefined } as unknown as ConfigService;

function makeRouter(provider: ZacModelProvider): ZacSemanticRouterService {
  const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
  return new ZacSemanticRouterService(classifier, provider, config);
}

/**
 * A deterministic test provider with EXPLICITLY DEFINED classifications: it
 * answers from the dataset labels, never from a network call. Section 29 of
 * the brief requires exactly this — a test provider whose semantic verdicts
 * are stated, not implied.
 */
function makeOracleProvider(
  labels: Map<string, ZacRequestMode>,
  confidence = 0.9,
): ZacModelProvider {
  return {
    name: 'test-oracle',
    model: 'zac-test-oracle-1',
    narrates: true,
    semanticRouting: true,
    complete: async () => {
      throw new Error('not used by the routing evaluation');
    },
    async classifyRequestMode(input: ZacSemanticRouterInput): Promise<ZacSemanticRouterOutcome> {
      const mode = labels.get(input.question);
      if (!mode) return { raw: null, failure: 'classification_invalid', completion: null };
      return {
        raw: {
          mode,
          confidence,
          requires_live_business_data: mode === 'qlooqo_data',
          reason_code: mode === 'qlooqo_data' ? 'real_business_analysis' : 'general_business_advice',
        },
        failure: null,
        completion: null,
      };
    },
  };
}

describe('ZAC semantic router — evaluation suite', () => {
  const dataset = loadRoutingEvalDataset();

  it('the dataset is large and covers every mode with real diversity', () => {
    expect(dataset.length).toBeGreaterThanOrEqual(150);
    const byMode = new Map<string, number>();
    for (const item of dataset) byMode.set(item.expected, (byMode.get(item.expected) ?? 0) + 1);
    // EVERY closed mode has a floor — derived from the enum so a newly added
    // mode (privacy_boundary was invisible here once) cannot silently shrink
    // to zero coverage.
    for (const mode of ZAC_REQUEST_MODES) {
      expect({ mode, count: byMode.get(mode) ?? 0 }).toEqual({
        mode,
        count: expect.any(Number),
      });
      expect(byMode.get(mode) ?? 0).toBeGreaterThanOrEqual(20);
    }
    // The v2 dataset floor (brief §26) and full intent labelling: every
    // qlooqo_data case carries its analysis-intent label.
    expect(dataset.length).toBeGreaterThanOrEqual(300);
    const unlabelled = dataset.filter((d) => d.expected === 'qlooqo_data' && !d.expectedIntent);
    expect(unlabelled.map((d) => d.prompt)).toEqual([]);
    const misLabelled = dataset.filter((d) => d.expected !== 'qlooqo_data' && d.expectedIntent);
    expect(misLabelled.map((d) => d.prompt)).toEqual([]);
    // Follow-ups, ambiguity and adversarial input are all represented.
    expect(dataset.filter((d) => d.priorTurn).length).toBeGreaterThanOrEqual(20);
    expect(dataset.filter((d) => d.acceptable?.length).length).toBeGreaterThanOrEqual(15);
    expect(dataset.filter((d) => d.injection).length).toBeGreaterThanOrEqual(5);
    // No duplicates.
    const keys = dataset.map((d) => d.prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    expect(new Set(keys).size).toBe(dataset.length);
  });

  describe('configuration 1 — deterministic only (no semantic provider)', () => {
    const router = makeRouter(new StubZacModelProvider());

    const run = async (): Promise<RoutingEvalOutcome[]> =>
      Promise.all(
        dataset.map(async (evalCase) => {
          const { classification } = await router.route({
            question: evalCase.prompt,
            roleContext: evalCase.role,
            recentTurnSummaries: evalCase.priorTurn ? [evalCase.priorTurn] : undefined,
          });
          return {
            case: evalCase,
            actual: classification.mode,
            correct: isAcceptable(evalCase, classification.mode),
          };
        }),
      );

    it('meets the documented deterministic-only thresholds', async () => {
      const metrics = scoreRouting(await run());
      // eslint-disable-next-line no-console
      console.log(formatRoutingReport('DETERMINISTIC ONLY (no model provider)', metrics));

      // These thresholds are a REGRESSION GUARD on a knowingly degraded
      // configuration, not a quality target. Deterministic rules alone score
      // ~63% on unseen paraphrases and misroute nearly half of all no-data
      // questions into the data pipeline — which is precisely why a build in
      // this state reports `uat_ready: false` and must not be handed to the
      // client. The semantic layer is what fixes it (configuration 2).
      expect(metrics.accuracy).toBeGreaterThanOrEqual(0.62);
      // Reported alongside, so the alternatives-credit is never mistaken for
      // exact-label accuracy.
      expect(metrics.strictAccuracy).toBeGreaterThanOrEqual(0.6);
      expect(metrics.liveDataFalsePositiveRate).toBeLessThanOrEqual(0.5);
      // Live-data questions must still work on the degraded path.
      expect(metrics.liveDataFalseNegativeRate).toBeLessThanOrEqual(0.08);
    });

    it('an explicit exclusion of the user\'s own data can never reach the data pipeline', async () => {
      const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
      const outcomes = await run();

      // The invariant is about DETECTED exclusions, not about the presence of
      // a word: "ignore what I just said" and "without being pushy" exclude
      // something other than the user's data and are correctly unaffected.
      const excluded = outcomes.filter(
        (o) => classifier.detectDataInstruction(o.case.prompt) === 'ignore_data',
      );
      expect(excluded.length).toBeGreaterThanOrEqual(15);
      expect(excluded.filter((o) => o.actual === 'qlooqo_data').map((o) => o.case.prompt)).toEqual(
        [],
      );
    });

    it('every mandated set-aside phrasing is recognised as an exclusion', async () => {
      const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
      const setAsides = [
        'Forget the QLOOQO data for this question. If a stylist has a rebooking target of 50% and is currently achieving 40%, what would you recommend they do to improve?',
        'Put my salon to one side for a minute. What would you recommend to someone at 40% against a 50% target?',
        "Don't look anything up. How would you coach a stylist who was ten points behind their rebooking target?",
        'Leave my figures out of this answer. What normally improves rebooking?',
        "Don't use anything you know about my salon.",
        'dont use my data for this',
        'forget qlooqo on this one',
        'just answer as a salon expert not from my figures',
        'Ignore my figures. What do benchmarks generally suggest?',
        'Put QLOOQO aside for a second — what would you tell another owner in this situation?',
        "Don't use QLOOQO here.",
        'dont pull my actuals, im after the theory',
        'Set my numbers aside. In a two-stylist salon doing £15k a month, what should wage cost be running at?',
      ];
      const missed = setAsides.filter((p) => classifier.detectDataInstruction(p) !== 'ignore_data');
      expect(missed).toEqual([]);
    });

    it('a retraction of a NON-data topic is not an exclusion of their data', async () => {
      const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
      for (const prompt of [
        'Ignore what I just said, that came out wrong.',
        'sorry ignore that last bit i meant the other thing',
        'Any advice on getting the team selling retail without being pushy about it?',
        'Ignore industry averages and use my actual figures.',
        'Forget that — show me my actual numbers.',
      ]) {
        expect({ prompt, instruction: classifier.detectDataInstruction(prompt) }).not.toMatchObject({
          instruction: 'ignore_data',
        });
      }
    });

    it('every prompt-injection attempt still yields a valid closed mode', async () => {
      const outcomes = await run();
      const injections = outcomes.filter((o) => o.case.injection);
      expect(injections.length).toBeGreaterThanOrEqual(5);
      for (const outcome of injections) {
        // Routing must not crash, must not invent a mode, and must not be
        // steered by the instruction. Whether the mode is qlooqo_data is not
        // the safety property — authorisation is, and the orchestration suite
        // asserts that the actor, scope and permissions are unchanged.
        // Derived from the closed enum on purpose: a hardcoded list silently
        // goes stale when a mode is added, and an injection attempt landing on
        // the new privacy_boundary mode is correct behaviour, not a failure.
        expect(ZAC_REQUEST_MODES as readonly (string | null)[]).toContain(outcome.actual);
      }
    });

    it('routes every floor-pinnable client-mandated acceptance prompt correctly', async () => {
      const outcomes = await run();
      // floorExempt cases are mandated for the SEMANTIC pipeline (configuration
      // 3 asserts them at 100%); the deterministic floor is known-unable to pin
      // them, which is precisely why the migration exists.
      const mandated = outcomes.filter(
        (o) => o.case.mandated && !o.case.metricsExempt && !o.case.floorExempt,
      );
      expect(mandated.length).toBeGreaterThanOrEqual(29);
      const failures = mandated.filter((o) => !o.correct);
      expect(
        failures.map((f) => `${f.case.prompt} → ${f.actual} (want ${f.case.expected})`),
      ).toEqual([]);
    });
  });

  describe('configuration 2 — semantic layer (oracle provider)', () => {
    it('carries a correct semantic verdict through validation and policy intact', async () => {
      const labels = new Map(dataset.map((d) => [d.prompt, d.expected]));
      const router = makeRouter(makeOracleProvider(labels));

      const outcomes: RoutingEvalOutcome[] = await Promise.all(
        dataset.map(async (evalCase) => {
          const { classification } = await router.route({
            question: evalCase.prompt,
            roleContext: evalCase.role,
            recentTurnSummaries: evalCase.priorTurn ? [evalCase.priorTurn] : undefined,
          });
          return {
            case: evalCase,
            actual: classification.mode,
            correct: isAcceptable(evalCase, classification.mode),
          };
        }),
      );

      const metrics = scoreRouting(outcomes);
      // eslint-disable-next-line no-console
      console.log(formatRoutingReport('SEMANTIC LAYER (oracle provider)', metrics));

      // With a correct semantic verdict available, the router must deliver it
      // (or an equally-safe deterministic override) essentially every time.
      expect(metrics.accuracy).toBeGreaterThanOrEqual(0.98);
      expect(metrics.strictAccuracy).toBeGreaterThanOrEqual(0.96);
      expect(metrics.liveDataFalsePositiveRate).toBeLessThanOrEqual(0.01);
      expect(metrics.liveDataFalsePositiveDenominator).toBeGreaterThanOrEqual(150);
      expect(metrics.liveDataFalseNegativeRate).toBe(0);
    });

    it('a low-confidence verdict that would newly enable live data is not trusted', async () => {
      const labels = new Map<string, ZacRequestMode>([
        ['What normally lifts retail attach in a busy salon?', 'qlooqo_data'],
      ]);
      const router = makeRouter(makeOracleProvider(labels, 0.5));

      const { classification } = await router.route({
        question: 'What normally lifts retail attach in a busy salon?',
        roleContext: 'owner',
      });

      // Untrusted, so it must not silently become a live-data route…
      expect(classification.mode).not.toBe('qlooqo_data');
      // …and the decision is recorded as a fallback/clarification, never as a
      // semantic verdict ZAC stood behind.
      expect(['fallback', 'clarification']).toContain(classification.source);
      expect(classification.classifierFailure).toBe('classification_low_confidence');
    });

    it('records a follow-up resolved from prior-turn context as contextual_followup', async () => {
      const prompt = 'and what about the other thing';
      const provider: ZacModelProvider = {
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        classifyRequestMode: async () => ({
          raw: {
            mode: 'conversational',
            confidence: 0.9,
            requires_live_business_data: false,
            reason_code: 'conversation_followup',
          },
          failure: null,
          completion: null,
        }),
      };
      const { classification } = await makeRouter(provider).route({
        question: prompt,
        roleContext: 'owner',
        recentTurnSummaries: ['Asked about business health (week)'],
      });

      expect(classification.mode).toBe('conversational');
      // A different decision basis from "the sentence said so", and recorded
      // as such on the telemetry spine.
      expect(classification.source).toBe('contextual_followup');
      expect(classification.reasonCode).toBe('conversation_followup');
    });

    it('asks ONE clarifying question when no layer can tell whether live data is needed', async () => {
      const prompt = 'hmm not sure where to start with the thing we discussed';
      const provider: ZacModelProvider = {
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        // Untrusted (low confidence) AND pointing at live data, with no
        // explicit instruction, no scenario and no shape rule to fall back on.
        classifyRequestMode: async () => ({
          raw: {
            mode: 'qlooqo_data',
            confidence: 0.4,
            requires_live_business_data: true,
            reason_code: 'ambiguous_business_request',
          },
          failure: null,
          completion: null,
        }),
      };
      const { classification } = await makeRouter(provider).route({
        question: prompt,
        roleContext: 'owner',
      });

      expect(classification.source).toBe('clarification');
      expect(classification.mode).not.toBe('qlooqo_data');
      expect(classification.clarificationPrompt).toBe(ZAC_ROUTING_CLARIFICATION);
    });

    it('the feature flag forces the pre-semantic deterministic path', async () => {
      const disabled = { get: (key: string) => (key === 'ZAC_SEMANTIC_ROUTER_ENABLED' ? 'false' : undefined) } as unknown as ConfigService;
      const classifyRequestMode = jest.fn();
      const provider: ZacModelProvider = {
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        classifyRequestMode,
      };
      const router = new ZacSemanticRouterService(
        new ZacRequestModeClassifierService(new ZacMemoryExtractionService()),
        provider,
        disabled,
      );

      expect(router.semanticRoutingAvailable).toBe(false);
      const { classification, classifierInvoked } = await router.route({
        question: 'What normally lifts retail attach in a busy salon?',
        roleContext: 'owner',
      });

      expect(classifierInvoked).toBe(false);
      expect(classifyRequestMode).not.toHaveBeenCalled();
      expect(classification.classifierFailure).toBe('router_disabled');
      // Explicit instructions still work on the degraded path.
      const excluded = await router.route({
        question: 'Forget my figures. What would you generally recommend?',
        roleContext: 'owner',
      });
      expect(excluded.classification.mode).not.toBe('qlooqo_data');
    });

    it.each(['classification_timeout', 'classification_refused', 'classification_invalid'])(
      'a %s never falls open into the live-data pipeline',
      async (failure) => {
        // Classifier failure is partly user-inducible (a request phrased to
        // draw a refusal, or to time out). Defaulting to the data pipeline on
        // it would hand users a lever to force a live-data read.
        const provider: ZacModelProvider = {
          name: 'test-oracle',
          model: 'zac-test-oracle-1',
          narrates: true,
          semanticRouting: true,
          complete: async () => {
            throw new Error('not used');
          },
          classifyRequestMode: async () => ({
            raw: null,
            failure: failure as never,
            completion: null,
          }),
        };

        const { classification } = await makeRouter(provider).route({
          question: 'hmm not sure where to start with the thing we discussed',
          roleContext: 'owner',
        });

        expect(classification.mode).not.toBe('qlooqo_data');
        expect(classification.source).toBe('clarification');
        expect(classification.classifierFailure).toBe(failure);
      },
    );

    it('a self-contradictory verdict is not accepted at face value', async () => {
      // "This is general advice, and it needs live business data" is not a
      // reliable verdict; its confidence is capped below the accept threshold.
      const prompt = 'What normally lifts retail attach in a busy salon?';
      const provider: ZacModelProvider = {
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        classifyRequestMode: async () => ({
          raw: {
            mode: 'qlooqo_data',
            confidence: 0.99,
            requires_live_business_data: false,
            reason_code: 'real_business_analysis',
          },
          failure: null,
          completion: null,
        }),
      };

      const { classification } = await makeRouter(provider).route({
        question: prompt,
        roleContext: 'owner',
      });

      expect(classification.source).not.toBe('semantic_model');
      expect(classification.mode).not.toBe('qlooqo_data');
    });

    it('contextual_followup requires an actual prior turn', async () => {
      const provider: ZacModelProvider = {
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        classifyRequestMode: async () => ({
          raw: {
            mode: 'conversational',
            confidence: 0.9,
            requires_live_business_data: false,
            reason_code: 'conversation_followup',
          },
          failure: null,
          completion: null,
        }),
      };

      // No summaries supplied: there was nothing to follow up on, whatever the
      // model called it.
      const withoutContext = await makeRouter(provider).route({
        question: 'and the other thing',
        roleContext: 'owner',
      });
      expect(withoutContext.classification.source).toBe('semantic_model');

      const withContext = await makeRouter(provider).route({
        question: 'and the other thing',
        roleContext: 'owner',
        recentTurnSummaries: ['Asked about business health (week)'],
      });
      expect(withContext.classification.source).toBe('contextual_followup');
    });

    it('client-accepted data questions never depend on the model being right', async () => {
      // These are pinned product behaviours — the owner acceptance questions,
      // the staff-not-connected honest refusal, the stylist restricted router.
      // A confidently WRONG advisory verdict must not reach them at all: they
      // are decided at Layer 1, before any model call.
      const confidentlyWrong: ZacModelProvider = {
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        classifyRequestMode: async () => ({
          raw: {
            mode: 'general_advice',
            confidence: 0.99,
            requires_live_business_data: false,
            reason_code: 'general_business_advice',
          },
          failure: null,
          completion: null,
        }),
      };
      const router = makeRouter(confidentlyWrong);

      for (const question of [
        'How is my business doing?',
        "How's my rebooking rate?",
        'What is my utilisation this week?',
        'Which of my team needs attention?',
        'Show staff performance.',
        'Show me my team',
        'What is my revenue this month?',
        "What's my current rebooking rate?",
      ]) {
        const { classification, classifierInvoked } = await router.route({
          question,
          roleContext: 'owner',
        });
        expect({ question, mode: classification.mode, source: classification.source }).toEqual({
          question,
          mode: 'qlooqo_data',
          source: 'deterministic',
        });
        expect(classifierInvoked).toBe(false);
      }
    });

    it('but a question with a genuine second reading still defers to the model', async () => {
      // The Layer 1 certainty above is only safe because it yields whenever
      // another reading is plausible: memory, permission, meta, or benchmark
      // framing. Those must NOT be decided deterministically.
      const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
      for (const question of [
        "What's a healthy rebooking rate for a salon our size?",
        'What do you actually know about me and my column?',
        'How should I structure a weekly team meeting so we can talk about KPIs?',
        "I've got a new starter joining my team. What's the best way to build a column from scratch?",
      ]) {
        const verdict = classifier.classifyExplicit(question, 'owner');
        expect({ question, mode: verdict?.mode ?? null }).not.toMatchObject({
          mode: 'qlooqo_data',
        });
      }
    });

    it('a merely-confident verdict cannot route around a pinned product behaviour', async () => {
      // A question with a genuine second reading ("for a salon our size" is
      // benchmark framing) defers to the semantic layer — but a merely-
      // confident verdict still must not overturn the shape rules on the data
      // question. Only a high-confidence one may.
      const prompt = "What's a healthy rebooking rate for a salon our size?";
      const at = (confidence: number): ZacModelProvider => ({
        name: 'test-oracle',
        model: 'zac-test-oracle-1',
        narrates: true,
        semanticRouting: true,
        complete: async () => {
          throw new Error('not used');
        },
        classifyRequestMode: async () => ({
          raw: {
            mode: 'general_advice',
            confidence,
            requires_live_business_data: false,
            reason_code: 'general_business_advice',
          },
          failure: null,
          completion: null,
        }),
      });

      // The shape rules say "their data"; the untrusted verdict says "no data
      // needed". Neither side wins on principle, so ZAC asks rather than
      // guessing on the one decision that matters.
      const merelyConfident = await makeRouter(at(0.7)).route({
        question: prompt,
        roleContext: 'owner',
      });
      expect(merelyConfident.classification.mode).not.toBe('qlooqo_data');
      expect(merelyConfident.classification.source).toBe('clarification');

      // Above the override bar the semantic reading does win — that is the
      // whole point of having a semantic layer.
      const veryConfident = await makeRouter(at(0.95)).route({
        question: prompt,
        roleContext: 'owner',
      });
      expect(veryConfident.classification.mode).toBe('general_advice');
      expect(veryConfident.classification.source).toBe('semantic_model');
    });

    it('an ignore-data instruction vetoes a confident qlooqo_data verdict', async () => {
      const prompt = 'Forget my figures — what would you tell a salon owner in this position?';
      const router = makeRouter(makeOracleProvider(new Map([[prompt, 'qlooqo_data']]), 0.99));

      const { classification } = await router.route({ question: prompt, roleContext: 'owner' });

      expect(classification.mode).not.toBe('qlooqo_data');
      expect(classification.dataInstruction).toBe('ignore_data');
    });
  });

  describe('configuration 3 — v2 structured semantic route (oracle through semantic mode)', () => {
    // The same plumbing proof as configuration 2, through the MIGRATED
    // pipeline: ZAC_ROUTING_MODE=semantic, a dedicated ZacSemanticProvider
    // returning the v2 contract (bucketed confidence, analysis intent,
    // information source). Real-model accuracy is measured by the live
    // harness (scripts/zac-routing-eval.ts); this proves the v2 verdict
    // survives validation, the confidence policy, the veto and the ladder.
    function makeV2OracleProvider(cases: RoutingEvalCase[]): ZacSemanticProvider {
      const byPrompt = new Map(cases.map((c) => [c.prompt, c] as const));
      return {
        name: 'test-oracle-v2',
        model: 'zac-test-oracle-v2',
        classify: async (input) => {
          const found = byPrompt.get(input.question);
          if (!found) return { raw: null, failure: 'classification_invalid', completion: null };
          const mode = found.expected;
          const reasonByMode: Record<string, string> = {
            qlooqo_data: 'real_business_analysis',
            hypothetical: 'hypothetical_scenario',
            memory: 'user_memory_recall',
            permission_capability: 'capability_question',
            privacy_boundary: 'privacy_boundary_probe',
          };
          return {
            raw: {
              mode,
              analysis_intent:
                mode === 'qlooqo_data' ? (found.expectedIntent ?? 'business_health') : 'none',
              information_source: ZAC_MODE_INFORMATION_SOURCE[mode],
              confidence: 'high',
              requires_live_business_data: mode === 'qlooqo_data',
              reason_code: reasonByMode[mode] ?? 'general_business_advice',
            },
            failure: null,
            completion: null,
          };
        },
      };
    }

    function makeSemanticModeRouter(cases: RoutingEvalCase[]): ZacSemanticRouterService {
      const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
      return new ZacSemanticRouterService(
        classifier,
        new StubZacModelProvider(),
        { get: (key: string) => (key === 'ZAC_ROUTING_MODE' ? 'semantic' : undefined) } as unknown as ConfigService,
        new ZacSemanticHealthService(),
        makeV2OracleProvider(cases),
      );
    }

    const runV2 = async (): Promise<RoutingEvalOutcome[]> => {
      const router = makeSemanticModeRouter(dataset);
      return Promise.all(
        dataset.map(async (evalCase) => {
          const { classification } = await router.route({
            question: evalCase.prompt,
            roleContext: evalCase.role,
            recentTurnSummaries: evalCase.priorTurn ? [evalCase.priorTurn] : undefined,
          });
          return {
            case: evalCase,
            actual: classification.mode,
            correct: isAcceptable(evalCase, classification.mode),
            source: classification.source,
            actualIntent: classification.analysisIntent ?? 'none',
          };
        }),
      );
    };

    it('carries a correct v2 verdict through validation and policy intact', async () => {
      const metrics = scoreRouting(await runV2());
      // eslint-disable-next-line no-console
      console.log(formatRoutingReport('V2 SEMANTIC ROUTE (oracle, semantic mode)', metrics));

      expect(metrics.accuracy).toBeGreaterThanOrEqual(0.98);
      expect(metrics.strictAccuracy).toBeGreaterThanOrEqual(0.96);
      expect(metrics.liveDataFalsePositiveRate).toBeLessThanOrEqual(0.01);
      expect(metrics.liveDataFalseNegativeRate).toBe(0);
    });

    it('the analysis-intent hint survives the pipe, and ONLY on live-data turns', async () => {
      const outcomes = await runV2();

      // Hard invariant: no non-data turn ever carries an intent.
      for (const outcome of outcomes) {
        if (outcome.actual !== 'qlooqo_data') {
          expect({ prompt: outcome.case.prompt, intent: outcome.actualIntent }).toEqual({
            prompt: outcome.case.prompt,
            intent: 'none',
          });
        }
      }

      // And a correct intent label passes through unchanged: plumbing, not
      // model accuracy (that is the live harness's job).
      const intents = scoreIntents(outcomes);
      // eslint-disable-next-line no-console
      console.log(formatIntentReport('V2 SEMANTIC ROUTE (oracle, semantic mode)', intents));
      expect(intents.scored).toBeGreaterThanOrEqual(60);
      expect(intents.accuracy).toBe(1);
      expect(intents.businessPriorityRecall).toBe(1);
    });

    it('routes every client-mandated acceptance prompt correctly under the v2 contract', async () => {
      const outcomes = await runV2();
      const mandated = outcomes.filter((o) => o.case.mandated && !o.case.metricsExempt);
      expect(mandated.length).toBeGreaterThanOrEqual(29);
      expect(
        mandated
          .filter((o) => !o.correct)
          .map((f) => `${f.case.prompt} → ${f.actual} (want ${f.case.expected})`),
      ).toEqual([]);
    });

    it('an explicit exclusion still never reaches the data pipeline under the v2 contract', async () => {
      const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
      const outcomes = await runV2();
      const excluded = outcomes.filter(
        (o) => classifier.detectDataInstruction(o.case.prompt) === 'ignore_data',
      );
      expect(excluded.length).toBeGreaterThanOrEqual(15);
      expect(excluded.filter((o) => o.actual === 'qlooqo_data')).toEqual([]);
    });
  });
});
