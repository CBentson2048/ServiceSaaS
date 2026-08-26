import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../context/zac-context.types';
import {
  ZAC_MODEL_PROVIDER,
  type ZacModelMemoryItem,
  type ZacModelProvider,
  type ZacModelSynthesisPack,
} from '../models/zac-model-provider.interface';
import { ZacToolRegistryService } from '../tools/zac-tool-registry.service';
import type { ZacToolDispatchTrace, ZacToolName } from '../tools/zac-tool.types';
import { ZacAnalysisIntentService } from './zac-analysis-intent.service';
import { ZacEvidenceService } from './zac-evidence.service';
import { ZacPriorityService } from './zac-priority.service';
import type {
  ZacConsolidationResult,
  ZacPriorityCandidate,
  ZacResolvedPriority,
} from './zac-priority.types';
import { ZacToolPlannerService } from './zac-tool-planner.service';
import {
  DEFAULT_PRIORITY_COUNT,
  MAX_MULTI_TOOL_CALLS,
  isZacAnalysisIntentReason,
  requiresMultiTool,
  type ZacAnalysisIntent,
  type ZacAnalysisIntentReason,
  type ZacEvidenceSignal,
  type ZacOrchestrationResult,
  type ZacPlannerSource,
  type ZacToolExecution,
  type ZacToolPlan,
} from './zac-analysis.types';

/** Per-tool ceiling inside a multi-tool plan. */
const TOOL_TIMEOUT_MS = 8_000;

export interface ZacAnalysisDecision {
  intent: ZacAnalysisIntent;
  reasonCode: ZacAnalysisIntentReason;
  source: ZacPlannerSource;
  confidence: number | null;
  /** The model's proposed tools, still untrusted. Undefined = none proposed. */
  proposedTools?: unknown;
  plannerBilled: boolean;
}

/**
 * Multi-source analysis for `qlooqo_data` turns.
 *
 * The defect this exists to fix: every live-data question resolved to exactly
 * ONE keyword-matched tool, and a question spanning the whole business matched
 * no keyword — so it fell through to the capability summary, whose copy states
 * that ZAC has no live business data. Five executable tools sat unused behind
 * that sentence.
 *
 * The fix is not a wider keyword list. It is: understand what KIND of analysis
 * is wanted, gather the permitted evidence that answers it, and synthesise. And
 * critically — separate "I could not plan" from "you have no data", which is
 * why {@link ZacToolPlannerService.liveCapability} is threaded through every
 * outcome.
 */
@Injectable()
export class ZacOrchestratorService {
  constructor(
    private readonly intents: ZacAnalysisIntentService,
    private readonly planner: ZacToolPlannerService,
    private readonly evidence: ZacEvidenceService,
    private readonly priorities: ZacPriorityService,
    private readonly registry: ZacToolRegistryService,
    @Inject(ZAC_MODEL_PROVIDER) private readonly modelProvider: ZacModelProvider,
  ) {}

  /**
   * Decide what analysis this question needs. Deterministic first (cheap and
   * certain), then the model for everything that turns on meaning, then the
   * heuristic floor so a build with no provider still works.
   */
  async decideAnalysis(input: {
    question: string;
    context: ZacActingContext;
    actor: AuthUser;
    recentTurnSummaries: string[];
    memory: ZacModelMemoryItem[];
  }): Promise<{ decision: ZacAnalysisDecision; latencyMs: number; completion: unknown | null }> {
    const { question, context } = input;

    const certain = this.intents.classifyCertain(question, context.roleContext);
    if (certain) {
      return {
        decision: {
          intent: certain.intent,
          reasonCode: certain.reasonCode,
          source: 'deterministic',
          confidence: null,
          plannerBilled: false,
        },
        latencyMs: 0,
        completion: null,
      };
    }

    // The catalogue is built BEFORE the model is consulted, so the model can
    // only ever propose from what this actor may already run.
    const catalogue = this.planner.catalogueFor(input.actor, context.roleContext);
    if (this.modelProvider.planAnalysis && catalogue.length > 0) {
      const startedAt = Date.now();
      const outcome = await this.modelProvider
        .planAnalysis({
          question,
          roleContext: context.roleContext,
          catalogue: catalogue.map((entry) => ({
            name: entry.name,
            purpose: entry.purpose,
            domains: entry.domains,
          })),
          recentTurnSummaries: input.recentTurnSummaries,
          // KINDS only — the remembered text never leaves the server.
          memoryKinds: input.memory.map((item) => item.kind),
        })
        .catch(() => ({ raw: null, failure: 'provider_unavailable' as const, completion: null }));
      const latencyMs = Date.now() - startedAt;

      const intent = ZacToolPlannerService.readIntent(outcome.raw?.analysis_intent);
      if (intent) {
        const rawReason = outcome.raw?.reason_code;
        return {
          decision: {
            intent,
            reasonCode: isZacAnalysisIntentReason(rawReason)
              ? rawReason
              : this.intents.reasonFor(intent),
            source: 'semantic_model',
            confidence: readConfidence(outcome.raw?.confidence),
            proposedTools: outcome.raw?.tools,
            plannerBilled: outcome.completion !== null,
          },
          latencyMs,
          completion: outcome.completion,
        };
      }
      // The model could not plan. That says nothing about the data.
      const fallback = this.intents.classifyHeuristic(question, context.roleContext);
      return {
        decision: {
          intent: fallback.intent,
          reasonCode: fallback.reasonCode,
          source: 'fallback_plan',
          confidence: null,
          plannerBilled: outcome.completion !== null,
        },
        latencyMs,
        completion: outcome.completion,
      };
    }

    const fallback = this.intents.classifyHeuristic(question, context.roleContext);
    return {
      decision: {
        intent: fallback.intent,
        reasonCode: fallback.reasonCode,
        source: 'fallback_plan',
        confidence: null,
        plannerBilled: false,
      },
      latencyMs: 0,
      completion: null,
    };
  }

  /** Build the validated, capped plan for a decided intent. */
  buildPlan(input: {
    decision: ZacAnalysisDecision;
    actor: AuthUser;
    context: ZacActingContext;
    /** The tool the question named outright, when it named one. Leads the plan. */
    primaryTool?: ZacToolName | null;
  }): {
    plan: ZacToolPlan;
    capability: ReturnType<ZacToolPlannerService['liveCapability']>;
    /** Sources that could contribute evidence — not merely run. */
    analysisCapabilityCount: number;
  } {
    const catalogue = this.planner.catalogueFor(input.actor, input.context.roleContext);
    const capability = this.planner.liveCapability(input.actor);
    const plan = this.planner.planFrom({
      intent: input.decision.intent,
      context: input.context,
      catalogue,
      modelTools: input.decision.proposedTools,
      confidence: input.decision.confidence,
      primaryTool: input.primaryTool ?? null,
    });
    return { plan, capability, analysisCapabilityCount: catalogue.length };
  }

  /**
   * Run the plan. Independent read-only tools run concurrently — they share no
   * state and each re-checks permissions on dispatch — and one failing source
   * never destroys the analysis: partial evidence still answers the question,
   * with an honest note about what could not be assessed.
   */
  async execute(input: {
    plan: ZacToolPlan;
    actor: AuthUser;
    context: ZacActingContext;
    toolInput: (tool: ZacToolName) => Record<string, unknown>;
    memory: ZacModelMemoryItem[];
    capability: ReturnType<ZacToolPlannerService['liveCapability']>;
  }): Promise<{ result: ZacOrchestrationResult; traces: ZacToolDispatchTrace[] }> {
    const planned = input.plan.tools.slice(0, MAX_MULTI_TOOL_CALLS);

    const settled = await Promise.all(
      planned.map(async (entry) => {
        const startedAt = Date.now();
        try {
          const dispatch = await withTimeout(
            this.registry.dispatch(
              input.actor,
              input.context,
              entry.toolName,
              input.toolInput(entry.toolName),
            ),
            TOOL_TIMEOUT_MS,
          );
          return { entry, dispatch, startedAt, timedOut: false };
        } catch {
          return { entry, dispatch: null, startedAt, timedOut: true };
        }
      }),
    );

    const executions: ZacToolExecution[] = [];
    const traces: ZacToolDispatchTrace[] = [];
    const signals: ZacEvidenceSignal[] = [];

    for (const item of settled) {
      const latencyMs = Date.now() - item.startedAt;
      if (!item.dispatch) {
        executions.push({
          toolName: item.entry.toolName,
          purpose: item.entry.purpose,
          status: 'timeout',
          ok: false,
          latencyMs,
          limitation: `${describeTool(item.entry.toolName)} did not respond in time, so it is not part of this answer.`,
        });
        continue;
      }
      const { result, trace } = item.dispatch;
      traces.push(trace);
      const ok = result.status === 'ok';
      executions.push({
        toolName: item.entry.toolName,
        purpose: item.entry.purpose,
        status: result.status,
        ok,
        latencyMs: trace.latency_ms,
        limitation: ok
          ? null
          : `${describeTool(item.entry.toolName)} could not be assessed (${result.explanation}).`,
      });
      if (ok) {
        signals.push(...this.evidence.normalise(item.entry.toolName, result, input.memory));
      }
    }

    // Signals become BUSINESS ISSUES before anything is ranked for the user.
    // Ranking raw signals is what produced one problem in three slots, twice
    // word for word.
    const consolidation = this.priorities.consolidate(signals);

    return {
      result: {
        plan: input.plan,
        executions,
        signals: this.evidence.rank(signals),
        consolidation,
        capability: input.capability,
        hasLiveEvidence: signals.length > 0,
      },
      traces,
    };
  }

  /** The synthesis pack — consolidated candidates, never raw payloads. */
  buildSynthesisPack(
    result: ZacOrchestrationResult,
    requestedCount = DEFAULT_PRIORITY_COUNT,
  ): ZacModelSynthesisPack {
    const failed = result.executions.filter((execution) => !execution.ok);
    const candidates = this.selectCandidates(result.consolidation, requestedCount);
    return {
      strategy: result.plan.synthesisStrategy,
      signals: (candidates.length > 0
        ? candidates.map((candidate) => candidate.primarySignal)
        : result.signals
      ).map((signal) => ({
        sourceTool: signal.sourceTool,
        headline: signal.headline,
        severity: signal.severity,
        targetSource: signal.targetSource,
      })),
      limitations: [
        ...failed.map((execution) => execution.limitation ?? ''),
        ...new Set(result.signals.flatMap((signal) => signal.limitations)),
      ].filter((line) => line.length > 0),
      requestedCount,
      unassessedDomains: [...new Set(failed.map((execution) => describeTool(execution.toolName)))],
    };
  }

  /**
   * The deterministic answer — ranked CANDIDATES, never raw signals.
   *
   * This is the path that shipped the defect, so it is also the path that has
   * to be right without a model: it renders one entry per business issue, in
   * ranked order, capped at what the user asked for, with supporting evidence
   * folded into its own issue rather than taking a slot.
   */
  composeDeterministicAnswer(
    result: ZacOrchestrationResult,
    requestedCount = DEFAULT_PRIORITY_COUNT,
  ): { answer: string; priorities: ZacResolvedPriority[] } {
    const chosen = this.priorities.selectTop(
      result.consolidation?.candidates ?? [],
      requestedCount,
    );

    const lines: string[] = [];
    if (chosen.length === 0) {
      lines.push(
        'I looked across the areas I can currently read for you, and nothing stood out as needing attention in this period.',
      );
    } else {
      lines.push(
        chosen.length === 1
          ? 'Looking across the areas I can currently read for you, this is the one thing I would focus on:'
          : `Looking across the areas I can currently read for you, here are the ${numberWord(chosen.length)} things I would focus on:`,
      );
      chosen.forEach((candidate, index) => {
        const support = candidate.supportingSignals
          .map((signal) => signal.headline)
          .slice(0, 2)
          .join(' ');
        lines.push(
          `${index + 1}. ${candidate.title} — ${candidate.primarySignal.headline}${support ? ` ${support}` : ''}`,
        );
      });
      // Said plainly rather than padded: asking for three and getting two is
      // only confusing if nobody explains why.
      if (chosen.length < requestedCount) {
        lines.push(
          `That is ${chosen.length === 1 ? 'the only area' : `all ${numberWord(chosen.length)} areas`} the current evidence supports raising — I would rather give you fewer real priorities than pad the list.`,
        );
      }
    }

    const failed = result.executions.filter((execution) => !execution.ok);
    if (failed.length > 0) {
      lines.push(
        `I could not assess ${joinList(failed.map((execution) => describeTool(execution.toolName)))} this time, so this is based on the rest.`,
      );
    }
    return {
      answer: lines.join('\n\n'),
      priorities: chosen.map((candidate) => ({ candidate, explanation: null, action: null })),
    };
  }

  /**
   * Validate an untrusted synthesis against the candidates it was given.
   *
   * Everything the model could get wrong is caught here rather than read by the
   * user: an invented id, a repeated id, more priorities than were asked for.
   * Returns null when nothing usable survives, and the deterministic answer
   * runs instead.
   */
  resolvePriorities(
    raw: unknown,
    candidates: ZacPriorityCandidate[],
    requestedCount: number,
  ): { priorities: ZacResolvedPriority[]; rejected: string[] } | null {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const entries = (raw as { priorities?: unknown })?.priorities;
    if (!Array.isArray(entries)) return null;

    const priorities: ZacResolvedPriority[] = [];
    const rejected: string[] = [];
    const used = new Set<string>();

    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') {
        rejected.push('(malformed)');
        continue;
      }
      const item = entry as { candidate_id?: unknown; explanation?: unknown; action?: unknown };
      const id = typeof item.candidate_id === 'string' ? item.candidate_id : null;
      const candidate = id ? byId.get(id) : undefined;
      if (!candidate) {
        rejected.push(id ?? '(no id)');
        continue;
      }
      if (used.has(candidate.id)) {
        rejected.push(`${candidate.id} (repeated)`);
        continue;
      }
      if (priorities.length >= requestedCount) {
        rejected.push(`${candidate.id} (over requested count)`);
        continue;
      }
      used.add(candidate.id);
      priorities.push({
        candidate,
        explanation: typeof item.explanation === 'string' ? item.explanation.trim() : null,
        action: typeof item.action === 'string' ? item.action.trim() : null,
      });
    }

    if (priorities.length === 0) return null;
    return { priorities, rejected };
  }

  /** Render validated priorities into the user-facing answer. */
  composeSynthesisedAnswer(
    priorities: ZacResolvedPriority[],
    preamble: string | null,
    result: ZacOrchestrationResult,
  ): string {
    const lines: string[] = [];
    lines.push(
      preamble?.trim()
        ? preamble.trim()
        : priorities.length === 1
          ? 'Looking across what I can currently read for you, this is the one thing I would focus on:'
          : `Looking across what I can currently read for you, here are the ${numberWord(priorities.length)} things I would focus on:`,
    );
    priorities.forEach((priority, index) => {
      const body = [priority.explanation, priority.action].filter(Boolean).join(' ');
      lines.push(
        `${index + 1}. ${priority.candidate.title} — ${body || priority.candidate.primarySignal.headline}`,
      );
    });

    const failed = result.executions.filter((execution) => !execution.ok);
    if (failed.length > 0) {
      lines.push(
        `I could not assess ${joinList(failed.map((execution) => describeTool(execution.toolName)))} this time, so this is based on the rest.`,
      );
    }
    return lines.join('\n\n');
  }

  /** How many priorities the user asked for, bounded server-side. */
  requestedPriorityCount(question: string): number {
    return this.priorities.requestedCount(question, DEFAULT_PRIORITY_COUNT);
  }

  /** The candidates that would be shown, for the synthesis prompt and metadata. */
  selectCandidates(
    consolidation: ZacConsolidationResult | undefined,
    requestedCount: number,
  ): ZacPriorityCandidate[] {
    return this.priorities.selectTop(consolidation?.candidates ?? [], requestedCount);
  }

  /** True when this intent should gather several sources. */
  isMultiTool(intent: ZacAnalysisIntent): boolean {
    return requiresMultiTool(intent);
  }

  /** True when the question is about the business at all — see the classifier. */
  hasAnalysisSignal(question: string): boolean {
    return this.intents.hasAnalysisSignal(question);
  }
}

/** Friendly area names — never internal tool identifiers in user-facing copy. */
const TOOL_AREA: Partial<Record<ZacToolName, string>> = {
  'report.business_health': 'business health',
  'report.kpi_summary': 'team KPIs',
  'report.rebooking_summary': 'rebooking',
  'report.utilisation_summary': 'utilisation',
  'report.stylist_performance': 'stylist performance',
  'kpi.personal_coaching': 'your own KPIs',
  'schedule.my_appointments': 'your diary',
};

function describeTool(tool: ZacToolName): string {
  return TOOL_AREA[tool] ?? 'one area';
}

/** "two", "three" — the count reads better as a word in product copy. */
function numberWord(count: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five'][count] ?? String(count);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function readConfidence(candidate: unknown): number | null {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return null;
  return Math.min(1, Math.max(0, candidate));
}

/** A slow source must not hold the whole analysis open. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tool timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
