/**
 * Live semantic-router evaluation and model benchmark.
 *
 * Runs the full hybrid router (deterministic Layer 1 → the REAL semantic
 * classifier → the fallback ladder) over the Phase 1 routing dataset and
 * prints accuracy, per-mode precision/recall, the confusion matrix,
 * analysis-intent accuracy, confidence calibration by bucket and — the number
 * that matters most — the live-data false-positive rate.
 *
 * This is the only harness that measures a real model. The jest suite
 * (`src/zac/routing/eval/routing-eval.spec.ts`) measures the deterministic
 * floor and the router plumbing, both without a network call.
 *
 * Legacy (Anthropic) pipeline:
 *   ANTHROPIC_API_KEY=sk-... pnpm --filter @sheer/api zac-routing-eval
 *
 * OpenAI semantic pipeline (the v2 migration):
 *   OPENAI_API_KEY=sk-... ZAC_ROUTING_MODE=semantic pnpm --filter @sheer/api zac-routing-eval
 *
 * Model benchmark (brief §31) — one full pass per model, cheapest passing
 * model wins:
 *   OPENAI_API_KEY=sk-... ZAC_ROUTING_MODE=semantic \
 *     ZAC_EVAL_MODELS=gpt-5-mini,gpt-5-nano pnpm --filter @sheer/api zac-routing-eval
 *
 * Optional:
 *   ZAC_SEMANTIC_MODEL      the OpenAI classification model (single run)
 *   ZAC_ROUTER_MODEL_ID     the Anthropic routing model (legacy runs)
 *   ZAC_EVAL_CONCURRENCY    parallel classifications (default 6)
 *   ZAC_EVAL_LIMIT          evaluate only the first N prompts (smoke runs)
 *
 * Nothing here writes to the database or touches business data: the router
 * receives the question, the role lens and the turn summaries, and returns a
 * mode. No tool is ever dispatched.
 */
/* eslint-disable no-console -- this script's entire output contract is stdout. */
import type { ConfigService } from '@nestjs/config';
import { AnthropicZacModelProvider } from '../src/zac/models/providers/anthropic-zac-provider';
import { OpenAiSemanticProvider } from '../src/zac/models/providers/openai-semantic-provider';
import { StubZacModelProvider } from '../src/zac/models/providers/stub-zac-provider';
import { ZacMemoryExtractionService } from '../src/zac/memory/zac-memory-extraction.service';
import { ZacRequestModeClassifierService } from '../src/zac/routing/zac-request-mode-classifier.service';
import { ZacSemanticRouterService } from '../src/zac/routing/zac-semantic-router.service';
import { ZacSemanticHealthService } from '../src/zac/models/zac-semantic-health.service';
import { confidenceScoreBucket } from '../src/zac/routing/zac-request-mode.types';
import type { ZacModelProvider } from '../src/zac/models/zac-model-provider.interface';
import {
  formatIntentReport,
  formatRoutingReport,
  isAcceptable,
  loadRoutingEvalDataset,
  scoreIntents,
  scoreRouting,
  type RoutingEvalOutcome,
} from '../src/zac/routing/eval/routing-eval';

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const env = { ...process.env, ...overrides };
  return {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

interface RunSummary {
  label: string;
  accuracy: number;
  strictAccuracy: number;
  liveDataFalsePositiveRate: number;
  liveDataFalseNegativeRate: number;
  intentAccuracy: number;
  businessPriorityRecall: number;
  p50: number;
  p95: number;
  costPerRoutedRequest: number;
  providerFailures: number;
}

async function evaluate(routerLabel: string, router: ZacSemanticRouterService): Promise<RunSummary> {
  const limit = Number(process.env.ZAC_EVAL_LIMIT ?? '0');
  const dataset = limit > 0 ? loadRoutingEvalDataset().slice(0, limit) : loadRoutingEvalDataset();
  const concurrency = Math.max(1, Number(process.env.ZAC_EVAL_CONCURRENCY ?? '6'));

  console.log(`\nEvaluating ${dataset.length} prompts — ${routerLabel} (concurrency ${concurrency})…`);

  const outcomes: RoutingEvalOutcome[] = new Array(dataset.length);
  const latencies: number[] = [];
  let modelCalls = 0;
  let shortCircuited = 0;
  let providerFailures = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReads = 0;
  let next = 0;
  // Calibration: correctness per confidence bucket (brief §21 — collect and
  // evaluate; thresholds are calibrated from this, never invented).
  const byBucket: Record<string, { n: number; correct: number }> = {};

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= dataset.length) return;
      const evalCase = dataset[index];
      const routed = await router.route({
        question: evalCase.prompt,
        roleContext: evalCase.role,
        recentTurnSummaries: evalCase.priorTurn ? [evalCase.priorTurn] : undefined,
      });

      if (routed.classifierInvoked) {
        modelCalls += 1;
        if (routed.classifierLatencyMs !== null) latencies.push(routed.classifierLatencyMs);
      } else {
        shortCircuited += 1;
      }
      const failure = routed.classification.classifierFailure;
      if (failure === 'provider_unavailable' || failure === 'classification_timeout') {
        providerFailures += 1;
      }
      if (routed.completion) {
        costUsd += routed.completion.estimatedCostUsd;
        inputTokens += routed.completion.inputTokens;
        outputTokens += routed.completion.outputTokens;
        cacheReads += routed.completion.cacheReadInputTokens;
      }

      const correct = isAcceptable(evalCase, routed.classification.mode);
      if (routed.classification.confidence !== null && routed.classifierInvoked) {
        const bucket = confidenceScoreBucket(routed.classification.confidence);
        byBucket[bucket] ??= { n: 0, correct: 0 };
        byBucket[bucket].n += 1;
        if (correct) byBucket[bucket].correct += 1;
      }

      outcomes[index] = {
        case: evalCase,
        actual: routed.classification.mode,
        correct,
        source: routed.classification.source,
        actualIntent: routed.classification.analysisIntent ?? 'none',
        confidenceBucket:
          routed.classification.confidence === null
            ? null
            : confidenceScoreBucket(routed.classification.confidence),
      };
      process.stdout.write('.');
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write('\n');

  const metrics = scoreRouting(outcomes);
  const intents = scoreIntents(outcomes);
  console.log(formatRoutingReport(routerLabel, metrics));
  console.log(formatIntentReport(routerLabel, intents));

  console.log('\nConfidence calibration (semantic verdicts only):');
  for (const bucket of ['high', 'medium', 'low']) {
    const stats = byBucket[bucket];
    console.log(
      `  ${bucket.padEnd(7)} n=${String(stats?.n ?? 0).padStart(4)}  correct ${(
        stats && stats.n > 0 ? (100 * stats.correct) / stats.n : 0
      ).toFixed(1)}%`,
    );
  }

  latencies.sort((a, b) => a - b);
  const at = (q: number) => (latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length * q)]);
  console.log('\nCost and latency:');
  console.log(`  Deterministic short-circuits: ${shortCircuited}/${dataset.length} (no model call)`);
  console.log(`  Semantic classifications:     ${modelCalls}`);
  console.log(`  Provider failures/timeouts:   ${providerFailures}`);
  console.log(`  Latency p50 / p95 / max:      ${at(0.5)}ms / ${at(0.95)}ms / ${latencies.at(-1) ?? 0}ms`);
  console.log(`  Tokens in / out:              ${inputTokens} / ${outputTokens}`);
  console.log(`  Cache-read input tokens:      ${cacheReads}`);
  console.log(`  Estimated cost:               $${costUsd.toFixed(4)} total`);
  console.log(
    `  Estimated cost per routed request: $${(modelCalls === 0 ? 0 : costUsd / modelCalls).toFixed(6)}`,
  );

  return {
    label: routerLabel,
    accuracy: metrics.accuracy,
    strictAccuracy: metrics.strictAccuracy,
    liveDataFalsePositiveRate: metrics.liveDataFalsePositiveRate,
    liveDataFalseNegativeRate: metrics.liveDataFalseNegativeRate,
    intentAccuracy: intents.accuracy,
    businessPriorityRecall: intents.businessPriorityRecall,
    p50: at(0.5),
    p95: at(0.95),
    costPerRoutedRequest: modelCalls === 0 ? 0 : costUsd / modelCalls,
    providerFailures,
  };
}

function makeSemanticRouter(model: string): ZacSemanticRouterService {
  const config = makeConfig({ ZAC_ROUTING_MODE: 'semantic', ZAC_SEMANTIC_MODEL: model });
  const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
  // The model provider is irrelevant in semantic mode (Layer 2 is the
  // dedicated provider); the stub keeps the harness key-free on that side.
  const modelProvider: ZacModelProvider = process.env.ANTHROPIC_API_KEY
    ? new AnthropicZacModelProvider(makeConfig())
    : new StubZacModelProvider();
  return new ZacSemanticRouterService(
    classifier,
    modelProvider,
    config,
    new ZacSemanticHealthService(),
    new OpenAiSemanticProvider(config),
  );
}

async function main(): Promise<void> {
  const semanticMode = (process.env.ZAC_ROUTING_MODE ?? '').trim().toLowerCase() === 'semantic';

  if (semanticMode) {
    if (!process.env.OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY is required for ZAC_ROUTING_MODE=semantic runs.');
      process.exitCode = 1;
      return;
    }
    const models = (process.env.ZAC_EVAL_MODELS ?? process.env.ZAC_SEMANTIC_MODEL ?? 'gpt-5-mini')
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model.length > 0);
    const summaries: RunSummary[] = [];
    for (const model of models) {
      summaries.push(await evaluate(`OPENAI SEMANTIC ROUTER (${model})`, makeSemanticRouter(model)));
    }
    if (summaries.length > 1) {
      console.log('\n=== MODEL BENCHMARK (brief §31 — cheapest model passing the gates wins) ===');
      console.log(
        `  ${'model'.padEnd(38)}${'acc'.padStart(7)}${'FP'.padStart(7)}${'FN'.padStart(7)}${'intent'.padStart(8)}${'BP rec'.padStart(8)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'$/req'.padStart(11)}`,
      );
      for (const s of summaries) {
        console.log(
          `  ${s.label.padEnd(38)}${(100 * s.accuracy).toFixed(1).padStart(6)}%${(
            100 * s.liveDataFalsePositiveRate
          )
            .toFixed(1)
            .padStart(6)}%${(100 * s.liveDataFalseNegativeRate).toFixed(1).padStart(6)}%${(
            100 * s.intentAccuracy
          )
            .toFixed(1)
            .padStart(7)}%${(100 * s.businessPriorityRecall).toFixed(1).padStart(7)}%${String(
            s.p50,
          ).padStart(8)}${String(s.p95).padStart(8)}$${s.costPerRoutedRequest
            .toFixed(6)
            .padStart(10)}`,
        );
      }
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is required — this harness measures the REAL semantic classifier.\n' +
        'Without it there is nothing to evaluate: run the jest suite for the deterministic floor,\n' +
        'or set ZAC_ROUTING_MODE=semantic with OPENAI_API_KEY to measure the OpenAI router.',
    );
    process.exitCode = 1;
    return;
  }

  const config = makeConfig();
  const provider = new AnthropicZacModelProvider(config);
  const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
  const router = new ZacSemanticRouterService(classifier, provider, config);
  await evaluate(`LIVE SEMANTIC ROUTER (${provider.routerModel})`, router);
}

void main();
