/**
 * Production-path evaluation.
 *
 * Every other harness in this repo measures the DETERMINISTIC FLOOR: the rules
 * that run when no model is available. This one runs the path a hosted request
 * actually takes — Layer 1 rules, then the REAL semantic router, then the REAL
 * analysis planner, then the real validation, consolidation and count logic.
 *
 * It exists because the floor and the production path had silently diverged:
 * every semantic call was being rejected with a 400 for an unsupported schema
 * keyword, the provider's fail-soft contract turned that into
 * `provider_unavailable`, and ZAC ran on its floor while reporting itself
 * ready. A floor-only evaluation cannot see that, by construction.
 *
 *   ANTHROPIC_API_KEY=sk-... pnpm --filter @sheer/api zac-production-eval
 *
 * Optional:
 *   ZAC_EVAL_CONCURRENCY  parallel calls (default 6)
 *   ZAC_EVAL_LIMIT        evaluate only the first N cases per dataset
 *
 * Read-only: no database, no tools dispatched, no writes. The model sees a
 * question, a role lens and a permitted source catalogue — never data.
 */
/* eslint-disable no-console -- this script's entire output contract is stdout. */
import 'dotenv/config';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@sheer/domain';
import { ZacAnalysisIntentService } from '../src/zac/analysis/zac-analysis-intent.service';
import { ZacEvidenceService } from '../src/zac/analysis/zac-evidence.service';
import { ZacOrchestratorService } from '../src/zac/analysis/zac-orchestrator.service';
import { ZacPriorityService } from '../src/zac/analysis/zac-priority.service';
import { ZacToolPlannerService } from '../src/zac/analysis/zac-tool-planner.service';
import { requiresMultiTool } from '../src/zac/analysis/zac-analysis.types';
import type { ZacActingContext } from '../src/zac/context/zac-context.types';
import { AnthropicZacModelProvider } from '../src/zac/models/providers/anthropic-zac-provider';
import { ZacMemoryExtractionService } from '../src/zac/memory/zac-memory-extraction.service';
import { ZacPolicyService } from '../src/zac/policy/zac-policy.service';
import { ZacResourceCategoryService } from '../src/zac/policy/zac-resource-category.service';
import { ZacRequestModeClassifierService } from '../src/zac/routing/zac-request-mode-classifier.service';
import { ZacSemanticRouterService } from '../src/zac/routing/zac-semantic-router.service';
import { loadOrchestrationEvalDataset } from '../src/zac/routing/eval/orchestration-eval';
import { loadReasonEvalDataset } from '../src/zac/routing/eval/routing-eval';
import { loadRoutingEvalDataset } from '../src/zac/routing/eval/routing-eval';

const OWNER_TOOLS = [
  'report.business_health',
  'report.kpi_summary',
  'report.rebooking_summary',
  'report.utilisation_summary',
  'report.stylist_performance',
];

function contextFor(roleContext: ZacActingContext['roleContext']): ZacActingContext {
  return {
    actorUserId: 'user-1',
    actorFirstName: null,
    businessId: 'biz-1',
    businessName: 'Main Salon',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
    accessibleLocations: [{ id: 'loc-1', name: 'Main' }],
    roleContext,
    roles: [roleContext],
    permissions: ['zac.access'],
    staffProfileId: roleContext === 'stylist' ? 'staff-1' : null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
  } as ZacActingContext;
}

/** A registry stub exposing exactly the Core MVP owner catalogue. */
function registryFor(roleContext: ZacActingContext['roleContext']): never {
  const business = OWNER_TOOLS.map((name) => ({ name, enabled: true }));
  const personal = [
    { name: 'kpi.personal_coaching', enabled: true },
    { name: 'schedule.my_appointments', enabled: true },
  ];
  const tools = [
    ...(roleContext === 'stylist' ? personal : business),
    { name: 'context.capabilities', enabled: true },
  ];
  return { buildFor: () => tools, allTools: () => tools } as never;
}

async function pooled<T, R>(items: T[], size: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

const pct = (numerator: number, denominator: number): string =>
  denominator === 0 ? 'n/a' : `${((numerator / denominator) * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required — this harness measures the REAL production path.');
    process.exitCode = 1;
    return;
  }
  const config = {
    get: (key: string) => process.env[key],
    getOrThrow: (key: string) => process.env[key],
  } as unknown as ConfigService;

  const provider = new AnthropicZacModelProvider(config);
  const memoryExtraction = new ZacMemoryExtractionService();
  const categories = new ZacResourceCategoryService();
  const modes = new ZacRequestModeClassifierService(memoryExtraction, categories);
  const router = new ZacSemanticRouterService(modes, provider, config);
  const intents = new ZacAnalysisIntentService();
  const policy = new ZacPolicyService();
  const priorities = new ZacPriorityService();

  const concurrency = Math.max(1, Number(process.env.ZAC_EVAL_CONCURRENCY ?? '6'));
  const limit = Number(process.env.ZAC_EVAL_LIMIT ?? '0');
  const cut = <T,>(items: T[]): T[] => (limit > 0 ? items.slice(0, limit) : items);
  /** Run one dataset at a time when re-measuring a single metric. */
  const only = process.env.ZAC_EVAL_ONLY;

  let modelCalls = 0;
  let modelCostUsd = 0;
  const latencies: number[] = [];
  const failures = new Map<string, number>();
  const noteFailure = (failure: string | null | undefined): void => {
    if (!failure) return;
    failures.set(failure, (failures.get(failure) ?? 0) + 1);
  };

  // ---------------------------------------------------------------- modes ---
  const modeCases = only && only !== 'mode' ? [] : cut(loadRoutingEvalDataset());
  console.log(`\nRouting ${modeCases.length} mode cases through the real semantic router…`);
  const modeOutcomes = await pooled(modeCases, concurrency, async (item) => {
    const startedAt = Date.now();
    const { classification, completion } = await router.route({
      question: item.prompt,
      roleContext: item.role,
      recentTurnSummaries: item.priorTurn ? [item.priorTurn] : undefined,
    });
    latencies.push(Date.now() - startedAt);
    noteFailure(classification.classifierFailure);
    if (completion) {
      modelCalls += 1;
      modelCostUsd += completion.estimatedCostUsd;
    }
    return { item, mode: classification.mode, failure: classification.classifierFailure };
  });

  const scoredModes = modeOutcomes.filter((o) => !o.item.metricsExempt && !o.item.injection);
  const modeCorrect = scoredModes.filter(
    (o) => o.mode === o.item.expected || (o.item.acceptable ?? []).includes(o.mode),
  ).length;
  const adviceCases = scoredModes.filter((o) => o.item.expected === 'general_advice');
  const hypoCases = scoredModes.filter((o) => o.item.expected === 'hypothetical');
  const adviceToData = adviceCases.filter((o) => o.mode === 'qlooqo_data').length;
  const hypoToData = hypoCases.filter((o) => o.mode === 'qlooqo_data').length;

  // -------------------------------------------------------- orchestration ---
  const orchCases = only && only !== 'orchestration' ? [] : cut(loadOrchestrationEvalDataset());
  console.log(`Planning ${orchCases.length} analysis cases through the real planner…`);
  const orchOutcomes = await pooled(orchCases, concurrency, async (item) => {
    const context = contextFor(item.role);
    const planner = new ZacToolPlannerService(registryFor(item.role));
    const orchestrator = new ZacOrchestratorService(
      intents,
      planner,
      new ZacEvidenceService(),
      priorities,
      registryFor(item.role),
      provider,
    );

    const startedAt = Date.now();
    const { classification } = await router.route({ question: item.prompt, roleContext: item.role });
    noteFailure(classification.classifierFailure);
    if (classification.mode !== 'qlooqo_data') {
      latencies.push(Date.now() - startedAt);
      return { item, intent: null as string | null, tools: 0, requested: priorities.requestedCount(item.prompt) };
    }
    const decision = await orchestrator.decideAnalysis({
      question: item.prompt,
      context,
      actor: {} as AuthUser,
      recentTurnSummaries: [],
      memory: [],
    });
    latencies.push(Date.now() - startedAt);
    noteFailure(decision.decision.source === 'fallback_plan' ? 'planner_fallback' : null);
    if (decision.completion) {
      modelCalls += 1;
      modelCostUsd += (decision.completion as { estimatedCostUsd: number }).estimatedCostUsd;
    }
    const { plan } = orchestrator.buildPlan({ decision: decision.decision, actor: {} as AuthUser, context });
    return {
      item,
      intent: decision.decision.intent as string,
      tools: requiresMultiTool(decision.decision.intent) ? plan.tools.length : 1,
      requested: priorities.requestedCount(item.prompt),
    };
  });

  const intentCorrect = orchOutcomes.filter(
    (o) => (o.intent ?? 'not_live_data') === o.item.expectedIntent,
  ).length;
  const broad = orchOutcomes.filter((o) => o.item.expectedIntent === 'business_priorities');
  const broadHit = broad.filter((o) => o.intent === 'business_priorities').length;
  const predictedBroad = orchOutcomes.filter((o) => o.intent === 'business_priorities');
  const predictedBroadCorrect = predictedBroad.filter(
    (o) => o.item.expectedIntent === 'business_priorities',
  ).length;
  // "Narrow" means a question ONE source should answer. `diagnostic` is a
  // multi-source intent by design (the named metric plus its context), so
  // counting it here would report correct behaviour as waste.
  const MULTI_BY_DESIGN = new Set(['business_priorities', 'team_priorities', 'diagnostic']);
  const narrow = orchOutcomes.filter((o) => !MULTI_BY_DESIGN.has(o.item.expectedIntent));
  const narrowMulti = narrow.filter((o) => o.tools > 1).length;
  const broadish = orchOutcomes.filter(
    (o) => o.item.expectedIntent === 'business_priorities' || o.item.expectedIntent === 'team_priorities',
  );
  const broadSingle = broadish.filter((o) => o.tools <= 1).length;
  const notLive = orchOutcomes.filter((o) => o.item.expectedIntent === 'not_live_data');
  const notLiveToData = notLive.filter((o) => o.intent !== null).length;

  // A false "no live data" claim requires: a live-data turn, executable tools,
  // and an empty plan with no analysis signal. Computed structurally.
  const falseNoData = orchOutcomes.filter(
    (o) => o.intent !== null && o.tools === 0 && intents.hasAnalysisSignal(o.item.prompt),
  ).length;

  // --------------------------------------------------------- refusal path ---
  const reasonCases = only && only !== 'reason' ? [] : cut(loadReasonEvalDataset());
  console.log(`Routing ${reasonCases.length} privacy cases through the real path…`);
  const reasonOutcomes = await pooled(reasonCases, concurrency, async (item) => {
    const startedAt = Date.now();
    const { classification, completion } = await router.route({
      question: item.prompt,
      roleContext: item.role,
    });
    latencies.push(Date.now() - startedAt);
    noteFailure(classification.classifierFailure);
    if (completion) {
      modelCalls += 1;
      modelCostUsd += completion.estimatedCostUsd;
    }
    const deterministic = categories.classify(item.prompt, item.role);
    const acquitted =
      deterministic?.category === 'general_knowledge' ||
      deterministic?.category === 'hypothetical_reasoning';
    const category = deterministic?.certain
      ? deterministic.category
      : acquitted
        ? deterministic.category
        : (classification.resourceCategory ?? deterministic?.category ?? null);
    const decision = policy.resolveBoundary({
      context: contextFor(item.role),
      requestedResourceCategory: category,
      requestMode: classification.mode,
      overrideAttempted: categories.detectOverrideAttempt(item.prompt),
    });
    return { item, reason: decision.blockingReason };
  });
  const reasonCorrect = reasonOutcomes.filter(
    (o) => o.reason === (o.item.expectedReason ?? 'none'),
  ).length;
  const downgrades = reasonOutcomes.filter((o) => {
    const fixed = ['private_coaching_boundary', 'cross_actor_private_boundary', 'phase1_read_only_boundary'];
    return fixed.includes(o.item.expectedReason ?? 'none') && !fixed.includes(o.reason);
  }).length;

  // ------------------------------------------------ counts + consolidation ---
  const countCases = orchCases.filter(
    (item) => item.expectedIntent === 'business_priorities' || item.expectedIntent === 'team_priorities',
  );
  let countViolations = 0;
  let duplicateFinals = 0;
  let sameRootDuplicates = 0;
  let finalTotal = 0;
  const evidence = new ZacEvidenceService();
  const RANGE = { range_start: '2026-07-27', range_end: '2026-08-26' };
  const goal = [{ kind: 'business_goal', summary: 'Increase rebooking to 60%.' }];
  const ok = (data: Record<string, unknown>) => ({
    status: 'ok' as const,
    data,
    explanation: '',
    rowCount: 1,
    presentation: {
      answer: 'x',
      evidence: [{ source_type: 'qlooqo.dashboard', source_ref: 'kpis', as_of: null, entities_used: [] }],
      confidence: 'medium' as const,
      limitations: [],
      suggestedNextStep: null,
      responseType: 'Insight' as const,
    },
  });
  const fixtureSignals = [
    ...evidence.normalise('report.business_health', ok({ ...RANGE, total_revenue_cents: 480000, currency_code: 'GBP', total_bookings: 120, completed_bookings: 110, cancelled_bookings: 22, new_clients: 40, repeat_clients: 70, rebooking_rate_percent: 0 }), goal),
    ...evidence.normalise('report.rebooking_summary', ok({ ...RANGE, rebooking_rate_percent: 0, completed_bookings: 110 }), goal),
    ...evidence.normalise('report.kpi_summary', ok({ period_start: RANGE.range_start, period_end: RANGE.range_end, stylists: Array.from({ length: 6 }, (_, i) => ({ stylist_name: `S${i}`, rebooking_met: false, all_kpis_met: false, rebooking_threshold_percent: 50 })) }), goal),
    ...evidence.normalise('report.utilisation_summary', ok({ overall: { utilisationPercent: 48 }, previousPeriod: { utilisationPercent: 55 }, warningThresholdPercent: 60, quietestWeekday: 'Tuesday', dataQuality: [] }), goal),
  ];
  for (const item of countCases) {
    const requested = priorities.requestedCount(item.prompt);
    const consolidated = priorities.consolidate(fixtureSignals);
    const top = priorities.selectTop(consolidated.candidates, requested);
    if (top.length > requested) countViolations += 1;
    const ids = top.map((c) => c.id);
    duplicateFinals += ids.length - new Set(ids).size;
    const domains = top.map((c) => c.domain);
    sameRootDuplicates += domains.length - new Set(domains).size;
    finalTotal += top.length;
  }

  latencies.sort((a, b) => a - b);
  const p = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;

  console.log('\n=== ZAC PRODUCTION-PATH EVALUATION (real semantic router + real planner) ===\n');
  console.log(` 1. request-mode accuracy                    ${pct(modeCorrect, scoredModes.length)}  (${modeCorrect}/${scoredModes.length})`);
  console.log(` 2. analysis-intent accuracy                 ${pct(intentCorrect, orchOutcomes.length)}  (${intentCorrect}/${orchOutcomes.length})`);
  console.log(` 3. business-priority recall                 ${pct(broadHit, broad.length)}  (${broadHit}/${broad.length})`);
  console.log(` 4. business-priority precision              ${pct(predictedBroadCorrect, predictedBroad.length)}  (${predictedBroadCorrect}/${predictedBroad.length})`);
  console.log(` 5. general-advice -> operational tools      ${pct(adviceToData, adviceCases.length)}  (${adviceToData}/${adviceCases.length})`);
  console.log(` 6. hypothetical  -> operational tools      ${pct(hypoToData, hypoCases.length)}  (${hypoToData}/${hypoCases.length})`);
  console.log(` 7. narrow -> unnecessary multi-tool         ${pct(narrowMulti, narrow.length)}  (${narrowMulti}/${narrow.length})`);
  console.log(` 8. broad  -> missed multi-tool              ${pct(broadSingle, broadish.length)}  (${broadSingle}/${broadish.length})`);
  console.log(` 9. false "live data unavailable"            ${pct(falseNoData, orchOutcomes.length)}  (${falseNoData}/${orchOutcomes.length})`);
  console.log(`10. requested-count violations               ${countViolations}  (over ${countCases.length} broad cases)`);
  console.log(`11. duplicate final priorities               ${duplicateFinals}  (of ${finalTotal} returned)`);
  console.log(`12. same-root-issue duplicates               ${sameRootDuplicates}  (of ${finalTotal} returned)`);
  console.log(`13. refusal-reason accuracy                  ${pct(reasonCorrect, reasonOutcomes.length)}  (${reasonCorrect}/${reasonOutcomes.length}); fixed-boundary downgrades ${downgrades}`);
  // ---------------------------------------------------------- error buckets ---
  // Aggregates say a number is wrong; only the individual cases say WHY. Every
  // failure is printed so it can be triaged one at a time rather than guessed at.
  const bucket = (title: string, rows: string[]): void => {
    console.log(`\n  ${title} (${rows.length})`);
    if (rows.length === 0) {
      console.log('    none');
      return;
    }
    for (const row of rows) console.log(`    ${row}`);
  };

  bucket(
    'REQUEST-MODE ERRORS',
    scoredModes
      .filter((o) => o.mode !== o.item.expected && !(o.item.acceptable ?? []).includes(o.mode))
      .map(
        (o) =>
          `want=${o.item.expected} got=${o.mode} role=${o.item.role}` +
          `${o.failure ? ` [classifier ${o.failure} — fell back, not a misread]` : ''} | ${o.item.prompt}`,
      ),
  );
  bucket(
    'ANALYSIS-INTENT ERRORS',
    orchOutcomes
      .filter((o) => (o.intent ?? 'not_live_data') !== o.item.expectedIntent)
      .map(
        (o) =>
          `want=${o.item.expectedIntent} got=${o.intent ?? 'not_live_data'} tools=${o.tools} role=${o.item.role} | ${o.item.prompt}`,
      ),
  );
  bucket(
    'BROAD -> MISSED MULTI-TOOL',
    broadish
      .filter((o) => o.tools <= 1)
      .map(
        (o) =>
          `want=${o.item.expectedIntent} got=${o.intent ?? 'not_live_data'} tools=${o.tools} | ${o.item.prompt}`,
      ),
  );
  bucket(
    'ADVICE/HYPOTHETICAL -> LIVE TOOLS',
    [
      ...adviceCases.filter((o) => o.mode === 'qlooqo_data').map((o) => `[mode-set general_advice] ${o.item.prompt}`),
      ...hypoCases.filter((o) => o.mode === 'qlooqo_data').map((o) => `[mode-set hypothetical] ${o.item.prompt}`),
      ...notLive.filter((o) => o.intent !== null).map((o) => `[orch-set not_live_data -> ${o.intent}] ${o.item.prompt}`),
    ],
  );
  bucket(
    'NARROW -> UNNECESSARY MULTI-TOOL',
    narrow
      .filter((o) => o.tools > 1)
      .map(
        (o) =>
          `want=${o.item.expectedIntent} got=${o.intent ?? 'not_live_data'} tools=${o.tools} | ${o.item.prompt}`,
      ),
  );
  bucket(
    'REFUSAL-REASON ERRORS',
    reasonOutcomes
      .filter((o) => o.reason !== (o.item.expectedReason ?? 'none'))
      .map((o) => `want=${o.item.expectedReason ?? 'none'} got=${o.reason} | ${o.item.prompt}`),
  );

  console.log(`\n    advice cases reaching the live pipeline (orchestration set): ${pct(notLiveToData, notLive.length)} (${notLiveToData}/${notLive.length})`);
  console.log(
    `\n    classifier failures: ${[...failures.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
  );
  console.log(`    model calls ${modelCalls}   estimated cost $${modelCostUsd.toFixed(2)} (router priced at opus rates — overstated)`);
  console.log(`    per-turn classification latency  p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${latencies[latencies.length - 1]}ms\n`);
}

void main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
