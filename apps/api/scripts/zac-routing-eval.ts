/**
 * Live semantic-router evaluation.
 *
 * Runs the full hybrid router (deterministic Layer 1 → the REAL semantic
 * classifier → the fallback ladder) over the Phase 1 routing dataset and
 * prints accuracy, per-mode precision/recall, the confusion matrix and — the
 * number that matters most — the live-data false-positive rate.
 *
 * This is the only harness that measures a real model. The jest suite
 * (`src/zac/routing/eval/routing-eval.spec.ts`) measures the deterministic
 * floor and the router plumbing, both without a network call.
 *
 *   ANTHROPIC_API_KEY=sk-... pnpm --filter @sheer/api zac-routing-eval
 *
 * Optional:
 *   ZAC_ROUTER_MODEL_ID   the routing model (default: the fast tier)
 *   ZAC_EVAL_CONCURRENCY  parallel classifications (default 6)
 *   ZAC_EVAL_LIMIT        evaluate only the first N prompts (smoke runs)
 *
 * Nothing here writes to the database or touches business data: the router
 * receives the question, the role lens and the turn summaries, and returns a
 * mode. No tool is ever dispatched.
 */
/* eslint-disable no-console -- this script's entire output contract is stdout. */
import type { ConfigService } from '@nestjs/config';
import { AnthropicZacModelProvider } from '../src/zac/models/providers/anthropic-zac-provider';
import { ZacMemoryExtractionService } from '../src/zac/memory/zac-memory-extraction.service';
import { ZacRequestModeClassifierService } from '../src/zac/routing/zac-request-mode-classifier.service';
import { ZacSemanticRouterService } from '../src/zac/routing/zac-semantic-router.service';
import {
  formatRoutingReport,
  isAcceptable,
  loadRoutingEvalDataset,
  scoreRouting,
  type RoutingEvalOutcome,
} from '../src/zac/routing/eval/routing-eval';

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is required — this harness measures the REAL semantic classifier.\n' +
        'Without it there is nothing to evaluate: run the jest suite for the deterministic floor.',
    );
    process.exitCode = 1;
    return;
  }

  const config = {
    get: (key: string) => process.env[key],
    getOrThrow: (key: string) => {
      const value = process.env[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
  } as unknown as ConfigService;

  const provider = new AnthropicZacModelProvider(config);
  const classifier = new ZacRequestModeClassifierService(new ZacMemoryExtractionService());
  const router = new ZacSemanticRouterService(classifier, provider, config);

  const limit = Number(process.env.ZAC_EVAL_LIMIT ?? '0');
  const dataset = limit > 0 ? loadRoutingEvalDataset().slice(0, limit) : loadRoutingEvalDataset();
  const concurrency = Math.max(1, Number(process.env.ZAC_EVAL_CONCURRENCY ?? '6'));

  console.log(
    `Evaluating ${dataset.length} prompts against ${provider.routerModel} ` +
      `(concurrency ${concurrency})…`,
  );

  const outcomes: RoutingEvalOutcome[] = new Array(dataset.length);
  const latencies: number[] = [];
  let modelCalls = 0;
  let shortCircuited = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReads = 0;
  let next = 0;

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
      if (routed.completion) {
        costUsd += routed.completion.estimatedCostUsd;
        inputTokens += routed.completion.inputTokens;
        outputTokens += routed.completion.outputTokens;
        cacheReads += routed.completion.cacheReadInputTokens;
      }

      outcomes[index] = {
        case: evalCase,
        actual: routed.classification.mode,
        correct: isAcceptable(evalCase, routed.classification.mode),
      };
      process.stdout.write('.');
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stdout.write('\n');

  console.log(formatRoutingReport(`LIVE SEMANTIC ROUTER (${provider.routerModel})`, scoreRouting(outcomes)));

  latencies.sort((a, b) => a - b);
  const at = (q: number) => (latencies.length === 0 ? 0 : latencies[Math.floor(latencies.length * q)]);
  console.log('\nCost and latency:');
  console.log(`  Deterministic short-circuits: ${shortCircuited}/${dataset.length} (no model call)`);
  console.log(`  Semantic classifications:     ${modelCalls}`);
  console.log(`  Latency p50 / p90 / max:      ${at(0.5)}ms / ${at(0.9)}ms / ${latencies.at(-1) ?? 0}ms`);
  console.log(`  Tokens in / out:              ${inputTokens} / ${outputTokens}`);
  console.log(`  Cache-read input tokens:      ${cacheReads}`);
  console.log(`  Estimated cost:               $${costUsd.toFixed(4)} total`);
  console.log(
    `  Estimated cost per routed request: $${(modelCalls === 0 ? 0 : costUsd / modelCalls).toFixed(6)}`,
  );
}

void main();
