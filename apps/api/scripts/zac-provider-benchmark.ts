/**
 * ZAC PROVIDER BENCHMARK — the same workload, against every provider profile.
 *
 * Runs ZAC's real evaluation datasets through the real pipeline once per
 * profile and prints a capability-by-capability scorecard, so a release
 * decision rests on measurement rather than preference.
 *
 *   OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm --filter @sheer/api zac-provider-benchmark
 *
 * Options (all optional):
 *   ZAC_BENCHMARK_PROFILES   openai,anthropic,hybrid   (default: all three)
 *   ZAC_BENCHMARK_CAPABILITIES routing,planning,synthesis (default: all)
 *   ZAC_EVAL_LIMIT           evaluate only the first N cases (smoke runs)
 *   ZAC_EVAL_CONCURRENCY     parallel calls per profile (default 4)
 *
 * WHAT MAKES THE COMPARISON FAIR — and it is the whole point:
 *  - the profile is set per run through an isolated config object, never by
 *    mutating process.env, so one run cannot leak configuration into the next;
 *  - every profile sees the same dataset, the same roles, the same frozen
 *    QLOOQO fixtures, the same permission-filtered catalogue and the same
 *    prompts (task semantics are ZAC-owned and shared);
 *  - a profile whose keys are absent is SKIPPED and reported as skipped. It is
 *    never scored as zero, because "we did not measure this" and "this scored
 *    nothing" are different facts and only one of them is honest.
 *
 * Nothing here writes to a database or reads business data. The routing pass
 * dispatches no tool at all; the planning pass validates plans against a
 * fixture catalogue; the synthesis pass narrates a frozen evidence pack.
 */
/* eslint-disable no-console -- this script's entire output contract is stdout. */
import { execSync } from 'node:child_process';
import type { ConfigService } from '@nestjs/config';
import { ZacAiProviderResolver } from '../src/zac/ai/zac-ai-provider.resolver';
import { ZAC_AI_PROVIDER_PROFILES, type ZacAiProviderProfile } from '../src/zac/ai/zac-ai.types';
import { ZacMemoryExtractionService } from '../src/zac/memory/zac-memory-extraction.service';
import { ZacSemanticHealthService } from '../src/zac/models/zac-semantic-health.service';
import { ZacRequestModeClassifierService } from '../src/zac/routing/zac-request-mode-classifier.service';
import { ZacSemanticRouterService } from '../src/zac/routing/zac-semantic-router.service';
import { ZacCompositeModelProvider } from '../src/zac/ai/zac-composite-model.provider';
import {
  ZAC_ROUTER_VERSION,
  ZAC_SEMANTIC_PROMPT_VERSION,
} from '../src/zac/routing/zac-semantic-router.prompt';
import { confidenceScoreBucket } from '../src/zac/routing/zac-request-mode.types';
import {
  isAcceptable,
  loadRoutingEvalDataset,
  scoreIntents,
  scoreRouting,
  type RoutingEvalOutcome,
} from '../src/zac/routing/eval/routing-eval';
import { loadOrchestrationEvalDataset } from '../src/zac/routing/eval/orchestration-eval';
import type { ZacModelRequest } from '../src/zac/models/zac-model-provider.interface';

// ---------------------------------------------------------------------------
// Configuration, isolated per run
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, string | undefined>): ConfigService {
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

const CONCURRENCY = Math.max(1, Number(process.env.ZAC_EVAL_CONCURRENCY ?? '4'));
const LIMIT = Number(process.env.ZAC_EVAL_LIMIT ?? '0');

function limited<T>(items: T[]): T[] {
  return LIMIT > 0 ? items.slice(0, LIMIT) : items;
}

async function pooled<T>(items: T[], run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await run(items[index], index);
        process.stdout.write('.');
      }
    }),
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

interface Operational {
  calls: number;
  failures: number;
  p50: number;
  p95: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const EMPTY_OPERATIONAL: Operational = {
  calls: 0,
  failures: 0,
  p50: 0,
  p95: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

interface RoutingScore {
  cases: number;
  accuracy: number;
  strictAccuracy: number;
  intentAccuracy: number;
  qlooqoPrecision: number;
  qlooqoRecall: number;
  liveDataFalsePositives: number;
  hypotheticalToLiveData: number;
  businessPriorityRecall: number;
  operational: Operational;
}

interface PlanningScore {
  cases: number;
  validPlanRate: number;
  unavailableToolProposals: number;
  requiredToolRecall: number;
  unnecessaryToolRate: number;
  schemaFailures: number;
  operational: Operational;
}

interface SynthesisScore {
  cases: number;
  groundedRate: number;
  unsupportedClaims: number;
  requestedCountCompliance: number;
  refusals: number;
  operational: Operational;
}

interface ProfileResult {
  profile: ZacAiProviderProfile;
  skipped: string | null;
  bindings: string;
  routing: RoutingScore | null;
  planning: PlanningScore | null;
  synthesis: SynthesisScore | null;
}

// ---------------------------------------------------------------------------
// A. SEMANTIC ROUTING
// ---------------------------------------------------------------------------

async function benchmarkRouting(
  resolver: ZacAiProviderResolver,
  config: ConfigService,
): Promise<RoutingScore> {
  const health = new ZacSemanticHealthService();
  const composite = new ZacCompositeModelProvider(resolver);
  const router = new ZacSemanticRouterService(
    new ZacRequestModeClassifierService(new ZacMemoryExtractionService()),
    composite,
    config,
    health,
    resolver.semantic(),
  );

  const dataset = limited(loadRoutingEvalDataset());
  const outcomes: RoutingEvalOutcome[] = new Array(dataset.length);
  const latencies: number[] = [];
  const op = { ...EMPTY_OPERATIONAL };

  await pooled(dataset, async (evalCase, index) => {
    const routed = await router.route({
      question: evalCase.prompt,
      roleContext: evalCase.role,
      recentTurnSummaries: evalCase.priorTurn ? [evalCase.priorTurn] : undefined,
    });
    if (routed.classifierInvoked) {
      op.calls += 1;
      if (routed.classifierLatencyMs !== null) latencies.push(routed.classifierLatencyMs);
    }
    const failure = routed.classification.classifierFailure;
    if (failure === 'provider_unavailable' || failure === 'classification_timeout') {
      op.failures += 1;
    }
    if (routed.completion) {
      op.costUsd += routed.completion.estimatedCostUsd;
      op.inputTokens += routed.completion.inputTokens;
      op.outputTokens += routed.completion.outputTokens;
    }
    outcomes[index] = {
      case: evalCase,
      actual: routed.classification.mode,
      correct: isAcceptable(evalCase, routed.classification.mode),
      source: routed.classification.source,
      actualIntent: routed.classification.analysisIntent ?? 'none',
      confidenceBucket:
        routed.classification.confidence === null
          ? null
          : confidenceScoreBucket(routed.classification.confidence),
    };
  });

  const metrics = scoreRouting(outcomes);
  // Intents are scored separately by design: a case misrouted AWAY from live
  // data is a MODE failure, and blending the two would hide which layer moved.
  const intents = scoreIntents(outcomes);
  op.p50 = percentile(latencies, 50);
  op.p95 = percentile(latencies, 95);

  // The two HARD safety counts, read straight off the outcomes rather than
  // derived from a rate — a gate must be countable, not rounded.
  const hypotheticalToLiveData = outcomes.filter(
    (o) => o.case.expected === 'hypothetical' && o.actual === 'qlooqo_data',
  ).length;
  // Reuse the scorer's own definition rather than re-deriving it: a gate that
  // counts differently from the report it sits under is worse than no gate.
  const liveDataFalsePositives = metrics.liveDataFalsePositives.length;

  return {
    cases: dataset.length,
    accuracy: metrics.accuracy,
    strictAccuracy: metrics.strictAccuracy,
    intentAccuracy: intents.accuracy,
    qlooqoPrecision: metrics.perMode?.qlooqo_data?.precision ?? 0,
    qlooqoRecall: metrics.perMode?.qlooqo_data?.recall ?? 0,
    liveDataFalsePositives,
    hypotheticalToLiveData,
    businessPriorityRecall: intents.businessPriorityRecall,
    operational: op,
  };
}

// ---------------------------------------------------------------------------
// B. TOOL PLANNING
// ---------------------------------------------------------------------------

/** The frozen catalogue every profile plans against. Identical by construction. */
const CATALOGUE = [
  { name: 'report.business_health', purpose: 'Overall trading for the period', domains: ['business_health'] },
  { name: 'report.rebooking_summary', purpose: 'Rebooking rate and sources', domains: ['rebooking'] },
  { name: 'report.utilisation_summary', purpose: 'Chair utilisation and diary gaps', domains: ['utilisation'] },
  { name: 'report.kpi_summary', purpose: 'Per-stylist KPI standing', domains: ['team_performance'] },
  { name: 'report.stylist_performance', purpose: 'Per-stylist revenue and rebooking', domains: ['team_performance'] },
];
const CATALOGUE_NAMES = new Set(CATALOGUE.map((tool) => tool.name));
const BROAD_INTENTS = new Set(['business_priorities', 'team_priorities']);

async function benchmarkPlanning(resolver: ZacAiProviderResolver): Promise<PlanningScore | null> {
  const reasoning = resolver.reasoning();
  if (!reasoning) return null;

  const dataset = limited(
    loadOrchestrationEvalDataset().filter((item) => item.expectedIntent !== 'not_live_data'),
  );
  const latencies: number[] = [];
  const op = { ...EMPTY_OPERATIONAL };
  let valid = 0;
  let unavailable = 0;
  let requiredHit = 0;
  let requiredTotal = 0;
  let unnecessary = 0;
  let schemaFailures = 0;

  await pooled(dataset, async (evalCase) => {
    const startedAt = Date.now();
    const outcome = await reasoning.planAnalysis({
      question: evalCase.prompt,
      roleContext: evalCase.role,
      catalogue: CATALOGUE,
    });
    latencies.push(Date.now() - startedAt);
    op.calls += 1;
    if (outcome.completion) {
      op.costUsd += outcome.completion.estimatedCostUsd;
      op.inputTokens += outcome.completion.inputTokens;
      op.outputTokens += outcome.completion.outputTokens;
    }
    if (outcome.failure) {
      op.failures += 1;
      if (outcome.failureKind === 'schema' || outcome.failureKind === 'invalid_output') {
        schemaFailures += 1;
      }
      return;
    }

    const raw = outcome.raw ?? {};
    const tools = Array.isArray(raw.tools) ? (raw.tools as Array<{ tool_name?: unknown }>) : [];
    const names = tools
      .map((tool) => tool.tool_name)
      .filter((name): name is string => typeof name === 'string');

    // A plan is VALID when it names an intent we recognise and proposes at
    // least one tool. The server re-validates everything anyway; this measures
    // whether the provider can produce a usable plan at all.
    if (typeof raw.analysis_intent === 'string' && names.length > 0) valid += 1;

    // Proposing a tool that was not on the supplied list is the planning
    // failure that matters most: the server drops it, so the user silently
    // loses a source the model thought it had.
    unavailable += names.filter((name) => !CATALOGUE_NAMES.has(name)).length;

    // A broad question should reach more than one source; a narrow one should
    // not sprawl. Both are felt by the user — as a thin answer, or as latency.
    if (BROAD_INTENTS.has(String(evalCase.expectedIntent))) {
      requiredTotal += 1;
      if (names.length >= 2) requiredHit += 1;
    } else if (evalCase.expectedIntent === 'specific_metric' && names.length > 2) {
      unnecessary += 1;
    }
  });

  op.p50 = percentile(latencies, 50);
  op.p95 = percentile(latencies, 95);

  return {
    cases: dataset.length,
    validPlanRate: dataset.length === 0 ? 0 : valid / dataset.length,
    unavailableToolProposals: unavailable,
    requiredToolRecall: requiredTotal === 0 ? 0 : requiredHit / requiredTotal,
    unnecessaryToolRate: dataset.length === 0 ? 0 : unnecessary / dataset.length,
    schemaFailures,
    operational: op,
  };
}

// ---------------------------------------------------------------------------
// C. ANSWER SYNTHESIS
// ---------------------------------------------------------------------------

/**
 * Frozen evidence. Every profile narrates the SAME verified figures, so a
 * grounding difference is the provider's, not the data's.
 */
const SYNTHESIS_CASES: Array<{ label: string; request: ZacModelRequest; allowed: string[] }> = [
  {
    label: 'single metric',
    allowed: ['34', '7', '110', '33'],
    request: {
      question: 'How is my rebooking doing?',
      roleContext: 'owner',
      systemPromptSeed: 'You are speaking to the salon owner.',
      availableToolNames: ['report.rebooking_summary'],
      evidencePack: {
        toolName: 'report.rebooking_summary',
        toolAnswer:
          'Your rebooking rate over the last 7 days was 34% — 33 rebooked visits out of 110 completed.',
        evidence: [
          {
            source_type: 'report.dashboard',
            source_ref: 'DashboardService.kpis',
            as_of: null,
            entities_used: [],
          },
        ],
        limitations: ['Rebooking is a lower bound — rebookings made outside QLOOQO are not captured.'],
      },
    },
  },
  {
    label: 'requested count',
    allowed: ['34', '44', '60', '2'],
    request: {
      question: 'What are the 2 biggest things I should focus on?',
      roleContext: 'owner',
      systemPromptSeed: 'You are speaking to the salon owner.',
      availableToolNames: ['report.business_health', 'report.utilisation_summary'],
      requestedCount: 2,
      synthesisPack: {
        strategy: 'rank_business_priorities',
        signals: [
          {
            sourceTool: 'report.rebooking_summary',
            headline: 'Rebooking is 34% for the period.',
            severity: 'attention',
            targetSource: 'tool_threshold',
          },
          {
            sourceTool: 'report.utilisation_summary',
            headline: 'Utilisation is 44%, below the 60% warning threshold.',
            severity: 'attention',
            targetSource: 'tool_threshold',
          },
        ],
        limitations: [],
        requestedCount: 2,
        unassessedDomains: ['stock'],
      },
    },
  },
  {
    label: 'insufficient data',
    allowed: [],
    request: {
      question: 'How is my colour waste this month?',
      roleContext: 'owner',
      systemPromptSeed: 'You are speaking to the salon owner.',
      availableToolNames: [],
      mode: 'qlooqo_data',
    },
  },
];

/** Numbers a narration may state: only those already in the evidence. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((token) =>
    String(Number(token.replace(/,/g, ''))),
  );
}

async function benchmarkSynthesis(resolver: ZacAiProviderResolver): Promise<SynthesisScore | null> {
  const synthesis = resolver.synthesis();
  if (!synthesis.narrates) return null;

  const latencies: number[] = [];
  const op = { ...EMPTY_OPERATIONAL };
  let grounded = 0;
  let unsupported = 0;
  let countCompliant = 0;
  let countCases = 0;
  let refusals = 0;

  for (const testCase of SYNTHESIS_CASES) {
    const startedAt = Date.now();
    op.calls += 1;
    try {
      const completion = await synthesis.generate(testCase.request);
      latencies.push(Date.now() - startedAt);
      op.costUsd += completion.estimatedCostUsd;
      op.inputTokens += completion.inputTokens;
      op.outputTokens += completion.outputTokens;

      // GROUNDING: every number in the answer must appear in the evidence. The
      // same rule the live grounding guard applies — measured, not assumed.
      const allowed = new Set(testCase.allowed);
      const stated = numbersIn(completion.text);
      const invented = stated.filter((value) => !allowed.has(value));
      if (invented.length === 0) grounded += 1;
      else unsupported += invented.length;

      if (testCase.request.requestedCount !== undefined) {
        countCases += 1;
        // A numbered list longer than what was asked for is the one instruction
        // the user definitely gave being ignored.
        const items = completion.text.match(/^\s*\d+[.)]/gm)?.length ?? 0;
        if (items <= testCase.request.requestedCount) countCompliant += 1;
      }
    } catch (error) {
      latencies.push(Date.now() - startedAt);
      const name = (error as { name?: string }).name ?? '';
      if (name.includes('Refused')) refusals += 1;
      else op.failures += 1;
    }
    process.stdout.write('.');
  }

  op.p50 = percentile(latencies, 50);
  op.p95 = percentile(latencies, 95);

  return {
    cases: SYNTHESIS_CASES.length,
    groundedRate: grounded / SYNTHESIS_CASES.length,
    unsupportedClaims: unsupported,
    requestedCountCompliance: countCases === 0 ? 1 : countCompliant / countCases,
    refusals,
    operational: op,
  };
}

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------

interface Gate {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * HARD SAFETY GATES. A profile that fails any of these is not releasable,
 * whatever its quality numbers say. They are counted, never rated: "almost no
 * hypothetical questions read live data" is not a passing grade.
 */
function certify(result: ProfileResult): Gate[] {
  const gates: Gate[] = [];
  if (result.routing) {
    gates.push({
      name: 'hypothetical never reads live data',
      passed: result.routing.hypotheticalToLiveData === 0,
      detail: `${result.routing.hypotheticalToLiveData} case(s)`,
    });
    gates.push({
      name: 'no live-data false positives on advice',
      passed: result.routing.liveDataFalsePositives === 0,
      detail: `${result.routing.liveDataFalsePositives} case(s)`,
    });
  }
  if (result.planning) {
    gates.push({
      name: 'never proposes an unavailable tool',
      passed: result.planning.unavailableToolProposals === 0,
      detail: `${result.planning.unavailableToolProposals} proposal(s)`,
    });
  }
  if (result.synthesis) {
    gates.push({
      name: 'no unsupported numeric claims',
      passed: result.synthesis.unsupportedClaims === 0,
      detail: `${result.synthesis.unsupportedClaims} claim(s)`,
    });
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const money = (value: number): string => `$${value.toFixed(6)}`;

function row(label: string, values: (string | undefined)[]): string {
  return `${label.padEnd(34)}${values.map((v) => (v ?? '—').padStart(14)).join('')}`;
}

function commitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const requested = (process.env.ZAC_BENCHMARK_PROFILES ?? 'openai,anthropic,hybrid')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  for (const profile of requested) {
    if (!(ZAC_AI_PROVIDER_PROFILES as readonly string[]).includes(profile)) {
      console.error(`Unknown profile '${profile}'. Supported: ${ZAC_AI_PROVIDER_PROFILES.join(', ')}.`);
      process.exit(1);
    }
  }

  const capabilities = new Set(
    (process.env.ZAC_BENCHMARK_CAPABILITIES ?? 'routing,planning,synthesis')
      .split(',')
      .map((value) => value.trim()),
  );

  const results: ProfileResult[] = [];

  for (const profile of requested as ZacAiProviderProfile[]) {
    // Semantic routing must be the authoritative pipeline for the routing
    // pass, or the benchmark would measure the deterministic floor and
    // attribute the result to a provider that never ran.
    const config = makeConfig({ ZAC_AI_PROVIDER: profile, ZAC_ROUTING_MODE: 'semantic' });
    const resolver = new ZacAiProviderResolver(config);

    const bindings = resolver
      .bindings()
      .map((b) => `${b.capability}=${b.provider ?? 'none'}/${b.model ?? '-'}`)
      .join(' ');

    if (resolver.degradations.length > 0) {
      // Skipped, not scored zero: an unmeasured profile must never look like a
      // failing one.
      results.push({
        profile,
        skipped: resolver.degradations.join('; '),
        bindings,
        routing: null,
        planning: null,
        synthesis: null,
      });
      console.log(`\n=== ${profile}: SKIPPED — ${resolver.degradations.join('; ')}`);
      continue;
    }

    console.log(`\n=== ${profile}\n${bindings}`);
    const result: ProfileResult = { profile, skipped: null, bindings, routing: null, planning: null, synthesis: null };

    if (capabilities.has('routing')) {
      console.log('\n[A] semantic routing');
      result.routing = await benchmarkRouting(resolver, config);
    }
    if (capabilities.has('planning')) {
      console.log('\n[B] tool planning');
      result.planning = await benchmarkPlanning(resolver);
    }
    if (capabilities.has('synthesis')) {
      console.log('\n[C] answer synthesis');
      result.synthesis = await benchmarkSynthesis(resolver);
    }
    results.push(result);
  }

  // -------------------------------------------------------------------------
  // Run metadata — without it a result is not reproducible and not comparable.
  // -------------------------------------------------------------------------
  console.log('\n\n════ RUN METADATA ════');
  console.log(`commit             ${commitSha()}`);
  console.log(`timestamp          ${new Date().toISOString()}`);
  console.log(`router version     ${ZAC_ROUTER_VERSION}`);
  console.log(`semantic prompt    ${ZAC_SEMANTIC_PROMPT_VERSION}`);
  console.log(`routing dataset    ${loadRoutingEvalDataset().length} cases`);
  console.log(`planning dataset   ${loadOrchestrationEvalDataset().length} cases`);
  console.log(`synthesis dataset  ${SYNTHESIS_CASES.length} cases`);
  console.log(`concurrency        ${CONCURRENCY}${LIMIT > 0 ? ` (limited to ${LIMIT})` : ''}`);
  for (const result of results) console.log(`profile ${result.profile.padEnd(10)} ${result.bindings}`);

  // -------------------------------------------------------------------------
  // Comparison. Trade-offs are reported; no winner is declared.
  // -------------------------------------------------------------------------
  const scored = results.filter((result) => result.skipped === null);
  console.log('\n\n════ COMPARISON ════');
  const header = row('Metric', results.map((r) => r.profile));
  console.log(header);
  console.log('-'.repeat(header.length));

  const cell = <T>(pick: (r: ProfileResult) => T | undefined, format: (value: T) => string) =>
    results.map((r) => (r.skipped ? 'skipped' : pick(r) === undefined ? undefined : format(pick(r) as T)));

  console.log(row('Routing accuracy', cell((r) => r.routing?.accuracy, pct)));
  console.log(row('Routing accuracy (strict)', cell((r) => r.routing?.strictAccuracy, pct)));
  console.log(row('Analysis-intent accuracy', cell((r) => r.routing?.intentAccuracy, pct)));
  console.log(row('QLOOQO precision', cell((r) => r.routing?.qlooqoPrecision, pct)));
  console.log(row('QLOOQO recall', cell((r) => r.routing?.qlooqoRecall, pct)));
  console.log(row('Business-priority recall', cell((r) => r.routing?.businessPriorityRecall, pct)));
  console.log(row('Valid tool plans', cell((r) => r.planning?.validPlanRate, pct)));
  console.log(row('Required-tool recall', cell((r) => r.planning?.requiredToolRecall, pct)));
  console.log(row('Unavailable-tool proposals', cell((r) => r.planning?.unavailableToolProposals, String)));
  console.log(row('Grounded answers', cell((r) => r.synthesis?.groundedRate, pct)));
  console.log(row('Unsupported claims', cell((r) => r.synthesis?.unsupportedClaims, String)));
  console.log(row('Requested-count compliance', cell((r) => r.synthesis?.requestedCountCompliance, pct)));
  console.log(row('Routing p50 (ms)', cell((r) => r.routing?.operational.p50, String)));
  console.log(row('Routing p95 (ms)', cell((r) => r.routing?.operational.p95, String)));
  console.log(
    row(
      'Cost / routed request',
      cell(
        (r) =>
          r.routing && r.routing.operational.calls > 0
            ? r.routing.operational.costUsd / r.routing.operational.calls
            : undefined,
        money,
      ),
    ),
  );
  console.log(
    row(
      'Provider failures',
      cell(
        (r) =>
          r.routing || r.planning || r.synthesis
            ? (r.routing?.operational.failures ?? 0) +
              (r.planning?.operational.failures ?? 0) +
              (r.synthesis?.operational.failures ?? 0)
            : undefined,
        String,
      ),
    ),
  );

  // -------------------------------------------------------------------------
  // Certification
  // -------------------------------------------------------------------------
  console.log('\n\n════ CERTIFICATION (hard safety gates) ════');
  let anyFailed = false;
  for (const result of scored) {
    const gates = certify(result);
    const failed = gates.filter((gate) => !gate.passed);
    anyFailed ||= failed.length > 0;
    console.log(`\n${result.profile}: ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
    for (const gate of gates) {
      console.log(`  ${gate.passed ? '✓' : '✗'} ${gate.name.padEnd(40)} ${gate.detail}`);
    }
  }

  if (scored.length === 0) {
    console.log('\nNo profile was measured — every requested profile was skipped for missing keys.');
    console.log('No provider comparison is claimed.');
  } else if (scored.length < results.length) {
    console.log(
      `\nOnly ${scored.length} of ${results.length} profiles were measured. The skipped ones are NOT comparable and are not scored.`,
    );
  }
  console.log('\nQuality numbers are reported as trade-offs. No winner is declared here.');

  process.exit(anyFailed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
