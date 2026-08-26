import { Injectable } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacToolRegistryService } from '../tools/zac-tool-registry.service';
import type { ZacToolName } from '../tools/zac-tool.types';
import {
  MAX_MULTI_TOOL_CALLS,
  isZacAnalysisIntent,
  type ZacAnalysisIntent,
  type ZacDataDomain,
  type ZacLiveCapabilityState,
  type ZacPlannedTool,
  type ZacPlanningToolDescriptor,
  type ZacSynthesisStrategy,
  type ZacToolPlan,
  type ZacToolPurpose,
} from './zac-analysis.types';

/** Planning metadata per tool. Descriptive only — grants nothing. */
const TOOL_DESCRIPTORS: Partial<Record<ZacToolName, Omit<ZacPlanningToolDescriptor, 'name'>>> = {
  'report.business_health': {
    purpose: 'Overall trading snapshot: revenue, bookings, new vs repeat clients, rebooking activity.',
    domains: ['business_health'],
  },
  'report.kpi_summary': {
    purpose: 'Each stylist against their service, retail, rebooking and average-bill targets.',
    domains: ['kpi', 'team_performance'],
  },
  'report.rebooking_summary': {
    purpose: 'Rebooking rate and where rebookings come from, by location.',
    domains: ['rebooking'],
  },
  'report.utilisation_summary': {
    purpose: 'Booked time against rostered available hours, quiet days and diary gaps.',
    domains: ['utilisation'],
  },
  'report.stylist_performance': {
    purpose: 'Stylist ranking by completed bookings, revenue and rebooking rate.',
    domains: ['team_performance'],
  },
  'kpi.personal_coaching': {
    purpose: "The acting stylist's own targets, rebooking and retail habits.",
    domains: ['personal_performance'],
  },
  'schedule.my_appointments': {
    purpose: "The acting stylist's own diary for today and tomorrow.",
    domains: ['appointments'],
  },
};

/**
 * Sources that measure the ACTOR's own work rather than the business. Correct
 * evidence for a stylist's own question; wrong evidence for an owner's — a
 * manager who also works the floor holds a staffProfileId, and without this
 * split their own column would quietly become part of a business analysis.
 */
const PERSONAL_TOOLS: ReadonlySet<ZacToolName> = new Set([
  'kpi.personal_coaching',
  'schedule.my_appointments',
]);

/**
 * Deterministic plans per intent, in priority order. These are the FALLBACK and
 * the validation baseline — never a keyword shortcut for recognising intent,
 * which is the semantic layer's job.
 *
 * Order matters: the first entries are the evidence a priority answer leans on
 * hardest, so truncation at MAX_MULTI_TOOL_CALLS drops the least important
 * source rather than an arbitrary one.
 */
const INTENT_PLANS: Record<ZacAnalysisIntent, ZacPlannedTool[]> = {
  business_priorities: [
    { toolName: 'report.business_health', purpose: 'baseline' },
    { toolName: 'report.rebooking_summary', purpose: 'priority_signal' },
    { toolName: 'report.utilisation_summary', purpose: 'priority_signal' },
    { toolName: 'report.kpi_summary', purpose: 'priority_signal' },
    { toolName: 'report.stylist_performance', purpose: 'supporting_evidence' },
  ],
  team_priorities: [
    { toolName: 'report.kpi_summary', purpose: 'priority_signal' },
    { toolName: 'report.stylist_performance', purpose: 'priority_signal' },
  ],
  business_health: [
    { toolName: 'report.business_health', purpose: 'baseline' },
    { toolName: 'report.rebooking_summary', purpose: 'supporting_evidence' },
  ],
  // The metric the question named leads (see fallbackPlan's `primaryTool`);
  // these support it. Utilisation is deliberately absent: it is a diary
  // measure, and pulling it into every "why is revenue down" question would
  // both cost a dispatch and invite a causal claim the evidence cannot support.
  diagnostic: [
    { toolName: 'report.business_health', purpose: 'baseline' },
    { toolName: 'report.rebooking_summary', purpose: 'diagnostic' },
  ],
  comparison: [{ toolName: 'report.business_health', purpose: 'comparison' }],
  explanation: [{ toolName: 'report.business_health', purpose: 'supporting_evidence' }],
  specific_metric: [],
};

/** The stylist catalogue is self-scoped by construction, never business-wide. */
const STYLIST_INTENT_PLANS: Partial<Record<ZacAnalysisIntent, ZacPlannedTool[]>> = {
  business_priorities: [
    { toolName: 'kpi.personal_coaching', purpose: 'priority_signal' },
    { toolName: 'schedule.my_appointments', purpose: 'supporting_evidence' },
  ],
  team_priorities: [{ toolName: 'kpi.personal_coaching', purpose: 'priority_signal' }],
  business_health: [{ toolName: 'kpi.personal_coaching', purpose: 'baseline' }],
  diagnostic: [{ toolName: 'kpi.personal_coaching', purpose: 'diagnostic' }],
};

const STRATEGY_BY_INTENT: Record<ZacAnalysisIntent, ZacSynthesisStrategy> = {
  specific_metric: 'single_metric',
  business_health: 'business_health',
  business_priorities: 'rank_business_priorities',
  team_priorities: 'rank_team_priorities',
  diagnostic: 'diagnostic',
  comparison: 'comparison',
  explanation: 'explanation',
};

/**
 * Chooses WHICH permitted evidence sources a question needs.
 *
 * Three properties are load-bearing:
 *
 *  1. The catalogue it plans over contains only tools this actor may use RIGHT
 *     NOW — filtered by role, effective permission and enablement before any
 *     planning happens. A tool the actor cannot use is not "refused later"; it
 *     is never visible to be proposed.
 *  2. A model plan is a SUGGESTION. Every entry is re-validated against the
 *     registry, the permitted catalogue and the tool cap, and dispatch
 *     re-checks permissions again per tool.
 *  3. Planning failure is not a data fact. When nothing can be planned, the
 *     deterministic intent plan runs; if that is empty too, the caller reports
 *     capability state, never "no live data".
 */
@Injectable()
export class ZacToolPlannerService {
  constructor(private readonly registry: ZacToolRegistryService) {}

  /**
   * What this actor could actually run right now. Tracked separately from
   * planning so "the planner chose nothing" can never be reported as "you have
   * no live data".
   */
  liveCapability(actor: AuthUser): ZacLiveCapabilityState {
    const all = this.registry.allTools();
    const permitted = this.registry.buildFor(actor);
    return {
      registered: all.map((tool) => tool.name),
      enabled: all.filter((tool) => tool.enabled).map((tool) => tool.name),
      permitted: permitted.map((tool) => tool.name),
      executable: permitted.filter((tool) => tool.enabled).map((tool) => tool.name),
    };
  }

  /**
   * The safe planning catalogue: enabled, permitted, EVIDENCE-bearing and
   * role-appropriate.
   *
   * Context/meta tools are excluded because they describe scope rather than
   * measure the business — a plan made of them would run, return nothing to
   * rank, and be reported as "the reports had no data", which is false. The
   * personal/business split matters for the same reason in the other
   * direction: a manager who also works the floor must not have their own
   * column folded into a business-wide answer.
   */
  catalogueFor(actor: AuthUser, roleContext?: ZacActingContext['roleContext']): ZacPlanningToolDescriptor[] {
    const wantsPersonal = roleContext === 'stylist';
    return this.registry
      .buildFor(actor)
      .filter((tool) => tool.enabled)
      .filter((tool) => TOOL_DESCRIPTORS[tool.name] !== undefined)
      .filter((tool) => PERSONAL_TOOLS.has(tool.name) === wantsPersonal)
      .map((tool) => ({ name: tool.name, ...TOOL_DESCRIPTORS[tool.name]! }));
  }

  /**
   * Sources that could actually contribute EVIDENCE for this actor right now.
   * Distinct from {@link liveCapability}'s `executable`, which counts every
   * runnable tool including the context/meta ones: an actor who can only run
   * "which locations can I see" has no analysis capability, and reporting that
   * as available capability would turn a permission gap into a data outage.
   */
  analysisCapabilityCount(actor: AuthUser, roleContext?: ZacActingContext['roleContext']): number {
    return this.catalogueFor(actor, roleContext).length;
  }

  /**
   * The deterministic plan for an intent, filtered to what the actor may run.
   *
   * `primaryTool` leads the plan when one is known. That ordering is not
   * cosmetic: for a diagnostic ("why is it so quiet on Mondays?") the metric
   * the user actually named must be the first source consulted and the first
   * evidence cited, with the rest supporting it.
   */
  fallbackPlan(
    intent: ZacAnalysisIntent,
    context: ZacActingContext,
    catalogue: ZacPlanningToolDescriptor[],
    primaryTool: ZacToolName | null = null,
  ): ZacToolPlan {
    const available = new Set(catalogue.map((entry) => entry.name));
    const base =
      context.roleContext === 'stylist'
        ? (STYLIST_INTENT_PLANS[intent] ?? [])
        : INTENT_PLANS[intent];
    const lead: ZacPlannedTool[] =
      primaryTool && available.has(primaryTool)
        ? [
            {
              toolName: primaryTool,
              purpose: intent === 'diagnostic' ? 'baseline' : 'priority_signal',
            },
          ]
        : [];
    const seen = new Set(lead.map((entry) => entry.toolName));
    const source = [
      ...lead,
      ...base.filter((entry) => {
        if (seen.has(entry.toolName)) return false;
        seen.add(entry.toolName);
        return true;
      }),
    ];
    const tools = source
      .filter((entry) => available.has(entry.toolName))
      .slice(0, MAX_MULTI_TOOL_CALLS);

    return {
      analysisIntent: intent,
      tools,
      synthesisStrategy: STRATEGY_BY_INTENT[intent],
      source: 'fallback_plan',
      confidence: null,
      rejectedTools: [],
    };
  }

  /**
   * Validate an untrusted plan. Anything the server cannot vouch for is
   * dropped, never repaired: an invented tool name, a disabled tool, a tool
   * outside this actor's catalogue and anything beyond the cap all disappear
   * here, and the rejections are reported for observability.
   */
  validatePlan(
    rawTools: unknown,
    intent: ZacAnalysisIntent,
    catalogue: ZacPlanningToolDescriptor[],
  ): { tools: ZacPlannedTool[]; rejected: string[] } {
    const available = new Map(catalogue.map((entry) => [entry.name, entry]));
    const tools: ZacPlannedTool[] = [];
    const rejected: string[] = [];
    const seen = new Set<ZacToolName>();

    for (const entry of Array.isArray(rawTools) ? rawTools : []) {
      // Untrusted output can be anything at all — a null, a number, a bare
      // string. None of that may take the validator down, because the fallback
      // that keeps the turn alive lives on the other side of this loop.
      if (entry === null || typeof entry !== 'object') {
        rejected.push('(malformed)');
        continue;
      }
      const candidate = entry as { tool_name?: unknown; purpose?: unknown };
      const name = candidate.tool_name;
      if (typeof name !== 'string' || !available.has(name as ZacToolName)) {
        rejected.push(typeof name === 'string' ? name : '(malformed)');
        continue;
      }
      const toolName = name as ZacToolName;
      // A duplicate is not an error, but running the same tool twice costs a
      // dispatch and adds nothing.
      if (seen.has(toolName)) continue;
      if (tools.length >= MAX_MULTI_TOOL_CALLS) {
        rejected.push(`${toolName} (over cap)`);
        continue;
      }
      seen.add(toolName);
      tools.push({ toolName, purpose: readPurpose(candidate.purpose) });
    }

    void intent;
    return { tools, rejected };
  }

  /** Combine a validated model plan with the deterministic baseline. */
  planFrom(input: {
    intent: ZacAnalysisIntent;
    context: ZacActingContext;
    catalogue: ZacPlanningToolDescriptor[];
    modelTools?: unknown;
    confidence?: number | null;
    primaryTool?: ZacToolName | null;
  }): ZacToolPlan {
    const { intent, context, catalogue } = input;
    const fallback = this.fallbackPlan(intent, context, catalogue, input.primaryTool ?? null);

    if (input.modelTools === undefined) return fallback;

    const { tools, rejected } = this.validatePlan(input.modelTools, intent, catalogue);
    // A model plan that survives validation with nothing in it is not a plan.
    // The deterministic one runs instead — the turn still gets live evidence.
    if (tools.length === 0) {
      return { ...fallback, rejectedTools: rejected };
    }
    return {
      analysisIntent: intent,
      tools,
      synthesisStrategy: STRATEGY_BY_INTENT[intent],
      source: 'semantic_model',
      confidence: input.confidence ?? null,
      rejectedTools: rejected,
    };
  }

  /** The single tool a specific-metric question should run, or null. */
  singleToolFor(toolName: ZacToolName | null, catalogue: ZacPlanningToolDescriptor[]): ZacToolName | null {
    if (!toolName) return null;
    return catalogue.some((entry) => entry.name === toolName) ? toolName : null;
  }

  /** Domains represented in a catalogue — used to explain coverage honestly. */
  domainsIn(catalogue: ZacPlanningToolDescriptor[]): ZacDataDomain[] {
    return [...new Set(catalogue.flatMap((entry) => entry.domains))];
  }

  /** Guard for an untrusted analysis intent from a model. */
  static readIntent(candidate: unknown): ZacAnalysisIntent | null {
    return isZacAnalysisIntent(candidate) ? candidate : null;
  }
}

const PURPOSES: readonly ZacToolPurpose[] = [
  'baseline',
  'priority_signal',
  'diagnostic',
  'comparison',
  'supporting_evidence',
];

function readPurpose(candidate: unknown): ZacToolPurpose {
  return typeof candidate === 'string' && (PURPOSES as readonly string[]).includes(candidate)
    ? (candidate as ZacToolPurpose)
    : 'supporting_evidence';
}
