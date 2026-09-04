import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { userHasAllPermissions, userHasPermission } from '@sheer/domain';
import type { ZacConsolidationResult } from '../analysis/zac-priority.types';
import { ZacPriorityService } from '../analysis/zac-priority.service';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacCostTelemetryService } from '../measurement/zac-cost-telemetry.service';
import type { ZacModelMemoryItem } from '../models/zac-model-provider.interface';
import { ZacIntelligenceSignalStore, type ZacSignalRepository } from '../persistence/zac-intelligence-signal.store';
import type { ZacMemoryScope } from '../responses/zac-response.types';
import { ZacToolRegistryService } from '../tools/zac-tool-registry.service';
import { ZacMetricObservationService } from './zac-metric-observation.service';
import { allMetricDefinitions, metricDefinition } from './zac-metric-registry';
import type {
  ZacMetricDefinition,
  ZacMetricObservation,
  ZacSignalScope,
  ZacSignalScopeType,
} from './zac-metric.types';
import { ZacSignalEvaluatorRegistry } from './zac-signal-evaluator.registry';
import { ZacSignalPriorityAdapter } from './zac-signal-priority.adapter';
import {
  ZacSignalReconciler,
  type ZacSignalAction,
  type ZacSignalReconciliation,
} from './zac-signal-reconciler';
import type {
  ZacPersistedSignal,
  ZacSignalEvaluation,
  ZacWithheldSignal,
} from './zac-signal.types';

/** How many locations one evaluation run will look at individually. */
const MAX_LOCATION_SCOPES = 10;

export interface ZacSignalEvaluationRun {
  evaluations: ZacSignalEvaluation[];
  observations: ZacMetricObservation[];
  reconciliation: ZacSignalReconciliation;
  /** Everything an evaluator declined to raise, with its reason. */
  withheld: ZacWithheldSignal[];
  /** Persistence problems that did not break the run. */
  persistenceErrors: string[];
}

/**
 * The Phase 2 Workstream 1 entry point: the pipeline, composed.
 *
 *   canonical metric definition -> metric observation -> signal evaluator
 *   -> signal candidate -> signal reconciler -> persisted intelligence signal
 *   -> existing Phase 1 priority engine
 *
 * Three responsibilities live here and nowhere else, because each of them needs
 * a request context and every layer beneath is deliberately pure:
 *
 *  1. SCOPE FAN-OUT — which metric is read for which scope, by dispatching the
 *     canonical Phase 1 tools through the existing registry (so every read is
 *     re-permissioned and re-scoped by the guarded QLOOQO service, exactly as a
 *     live turn would be).
 *  2. WRITE-TIME VISIBILITY — stamping the scope a signal was raised in.
 *  3. RETRIEVAL-TIME AUTHORISATION — and this is the important one: the stored
 *     visibility scope NARROWS what a reader may see; it never authorises it.
 *     Every read re-checks the actor's CURRENT roles and permissions, so a
 *     permission removed after a signal was written hides that signal
 *     immediately. Persisted visibility is a snapshot of intent, not a grant.
 *
 * Nothing here is scheduled. There is no cron, no background scan and no
 * proactive feed: evaluation happens when a caller asks for it, which keeps the
 * framework inside its Workstream 1 boundary and means a signal can never be
 * raised about a business nobody was looking at.
 */
@Injectable()
export class ZacIntelligenceSignalService {
  private readonly logger = new Logger(ZacIntelligenceSignalService.name);

  constructor(
    private readonly tools: ZacToolRegistryService,
    private readonly observations: ZacMetricObservationService,
    private readonly evaluators: ZacSignalEvaluatorRegistry,
    private readonly reconciler: ZacSignalReconciler,
    @Inject(ZacIntelligenceSignalStore) private readonly store: ZacSignalRepository,
    private readonly priorities: ZacPriorityService,
    private readonly adapter: ZacSignalPriorityAdapter,
    private readonly telemetry: ZacCostTelemetryService,
  ) {}

  /**
   * Read every registered metric for every scope in view, evaluate, reconcile
   * against what is stored, and apply the plan.
   *
   * `evaluatedAt` is a parameter rather than a clock read so a caller — and
   * every acceptance fixture — controls the instant the lifecycle reasons about.
   */
  async evaluate(
    actor: AuthUser,
    context: ZacActingContext,
    options: { traceId: string; evaluatedAt: string; memory?: ZacModelMemoryItem[] },
  ): Promise<ZacSignalEvaluationRun> {
    // The feature gate belongs on the write path as well as the read path: an
    // actor whose ZAC access was revoked must not be able to drive lifecycle
    // transitions on signals they can no longer be shown.
    if (!userHasPermission(actor, 'zac.access')) {
      return {
        evaluations: [],
        observations: [],
        reconciliation: { actions: [], opened: 0, refreshed: 0, resolved: 0, expired: 0, retained: 0 },
        withheld: [],
        persistenceErrors: [],
      };
    }

    const memory = options.memory ?? [];
    const scopes = this.resolveScopes(context);
    const truncatedLocations = Math.max(
      0,
      (context.locationId ? 1 : context.accessibleLocations.length) - scopes.length,
    );

    const observations: ZacMetricObservation[] = [];
    const evaluations: ZacSignalEvaluation[] = [];

    for (const definition of allMetricDefinitions()) {
      // The metric's own permission gate, checked before anything is dispatched.
      // The tool registry re-checks it too; doing it here as well means an
      // actor who cannot see a metric never even causes a query for it.
      if (!this.actorMayRead(actor, definition)) continue;

      for (const scope of scopes) {
        const observation = await this.observe(actor, context, definition, scope, memory);
        observations.push(observation);
        evaluations.push(
          ...this.evaluators.evaluate({
            businessId: context.businessId,
            observation,
            evaluatedAt: options.evaluatedAt,
          }),
        );
      }
    }

    const existing = await this.store.listLive(context.businessId);
    const reconciliation = this.reconciler.reconcile(existing, evaluations, options.evaluatedAt);
    const persistenceErrors = await this.apply(context, reconciliation, options.evaluatedAt);

    const withheld = evaluations.flatMap((evaluation) => evaluation.withheld);
    this.telemetry.recordSpineEvent('signal_evaluated', {
      trace_id: options.traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      scopes_evaluated: scopes.length,
      locations_not_evaluated: truncatedLocations,
      observations: observations.length,
      candidates: evaluations.reduce((total, item) => total + item.candidates.length, 0),
      withheld: withheld.length,
      opened: reconciliation.opened,
      refreshed: reconciliation.refreshed,
      resolved: reconciliation.resolved,
      expired: reconciliation.expired,
      retained: reconciliation.retained,
      persistence_errors: persistenceErrors.length,
    });

    return { evaluations, observations, reconciliation, withheld, persistenceErrors };
  }

  /**
   * The live signals this actor may see RIGHT NOW.
   *
   * Two independent gates, both re-evaluated on every call:
   *  - the visibility matrix, against the actor's current role and location
   *    scope (a stored scope narrows, it never grants);
   *  - the metric's required permissions, against the actor's current effective
   *    permission set. A signal written while someone held `report.dashboard.view`
   *    disappears from their view the moment that permission is removed.
   *
   * Business isolation is guaranteed a layer down: the store filters on
   * `business_id` for every query, so no signal from another tenant can reach
   * this filter to be judged by it.
   */
  async listVisible(actor: AuthUser, context: ZacActingContext): Promise<ZacPersistedSignal[]> {
    // `zac.access` is a feature gate, not a data grant — but without it there is
    // no ZAC surface to read signals through at all.
    if (!userHasPermission(actor, 'zac.access')) return [];

    const live = await this.store.listLive(context.businessId);
    return live.filter((signal) => {
      if (signal.status !== 'active') return false;
      if (!this.canSee(context, signal)) return false;
      // A row whose metric is no longer registered has no resolvable permission
      // requirement, so it cannot be authorised — hide it rather than throw.
      // Deny-by-default: an unreadable row must not take the whole retrieval
      // down with it, which would also make it impossible to suppress away.
      const definition = this.definitionFor(signal.metricKey);
      return definition !== null && this.actorMayRead(actor, definition);
    });
  }

  /**
   * Persisted signals as Phase 1 priority candidates, through the EXISTING
   * consolidation. No second engine, no second ranking: `consolidate` dedupes,
   * groups by business issue, scores the issue once and ranks it exactly as it
   * does for a live turn.
   */
  async priorityCandidates(
    actor: AuthUser,
    context: ZacActingContext,
  ): Promise<ZacConsolidationResult> {
    const visible = await this.listVisible(actor, context);
    return this.priorities.consolidate(this.adapter.toEvidenceSignals(visible));
  }

  /**
   * An explicit human decision to stop being told about a signal FOR A WHILE.
   *
   * The window is mandatory and bounded, which is the whole safety property: an
   * open-ended suppression would silence a real business problem permanently,
   * and this workstream ships no unsuppress path to undo it (adding one would be
   * a new surface, which is out of scope). Bounding it means every suppression
   * ends by itself and the next evaluation says whether the problem is still
   * there.
   *
   * The ceiling is the metric's own credibility window: suppressing a signal for
   * longer than the reading behind it stays believable would silence a claim
   * nobody could still stand behind anyway.
   */
  async suppress(
    actor: AuthUser,
    context: ZacActingContext,
    signalId: string,
    until: string,
    at: string,
  ): Promise<boolean> {
    const visible = await this.listVisible(actor, context);
    // Existence-hiding, matching requireAccessibleOutput: a signal the actor may
    // not see cannot be suppressed, and the caller learns nothing about whether
    // it exists.
    const signal = visible.find((candidate) => candidate.id === signalId);
    if (!signal) return false;

    const atMs = Date.parse(at);
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs) || !Number.isFinite(atMs) || untilMs <= atMs) return false;

    const definition = this.definitionFor(signal.metricKey);
    if (!definition) return false;
    const ceilingMs = atMs + definition.staleAfterDays * 86_400_000;
    const boundedUntil = new Date(Math.min(untilMs, ceilingMs)).toISOString();

    await this.store.suppress(context.businessId, signalId, boundedUntil, at);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Scope fan-out
  // ---------------------------------------------------------------------------

  /**
   * The scopes one run looks at.
   *
   * The load-bearing rule: **only an OWNER's reading may be filed as the
   * business's.** `AuthService.resolveAllowedLocationIds` gives owners every
   * active location and everyone else the union of their own memberships — so a
   * manager restricted to one site asking about "the business" is reading one
   * site. Filing that under the business-scope signal key would silently
   * overwrite the owner's business-wide signal with one branch's number, and
   * later resolve it on that branch's recovery. Everyone else's readings are
   * location readings, always.
   *
   * Beyond that, the shape avoids saying the same thing twice:
   *  - a single-location owner gets ONE business scope, whether or not the turn
   *    carried a location filter, because both readings are the same fact and
   *    two keys for one fact is exactly the duplication this framework prevents;
   *  - a multi-location owner gets the business view PLUS each location, because
   *    QLOOQO resolves a utilisation threshold only for a single-location scope,
   *    so the aggregate legitimately has no target to be material against.
   */
  private resolveScopes(context: ZacActingContext): ZacSignalScope[] {
    const businessScope: ZacSignalScope = {
      type: 'business',
      locationId: null,
      label: context.businessName,
      subjectUserId: null,
    };
    const locationScope = (id: string, name: string | null): ZacSignalScope => ({
      type: 'location',
      locationId: id,
      label: name,
      subjectUserId: null,
    });
    const nameOf = (id: string): string | null =>
      context.accessibleLocations.find((entry) => entry.id === id)?.name ?? null;

    // Mirrors resolveAllowedLocationIds exactly: `roles`, not the display-only
    // `roleContext`, and `includes` rather than equality so a multi-role owner
    // is still an owner.
    const seesWholeBusiness = context.roles.includes('owner');

    if (!seesWholeBusiness) {
      const ids = context.locationId ? [context.locationId] : context.accessibleLocationIds;
      return ids.slice(0, MAX_LOCATION_SCOPES).map((id) => locationScope(id, nameOf(id)));
    }

    if (context.locationId) {
      return context.accessibleLocationIds.length <= 1
        ? [businessScope]
        : [locationScope(context.locationId, nameOf(context.locationId))];
    }

    if (context.accessibleLocations.length <= 1) return [businessScope];

    return [
      businessScope,
      ...context.accessibleLocations
        .slice(0, MAX_LOCATION_SCOPES)
        .map((location) => locationScope(location.id, location.name)),
    ];
  }

  /**
   * Read one metric for one scope through its canonical Phase 1 tool.
   *
   * The tool is dispatched with a context narrowed to the scope, so the guarded
   * QLOOQO service applies the actor's own permissions and location scope — ZAC
   * never opens its own business-data client, and a scope the actor cannot see
   * comes back as a denial that becomes a `missing` observation rather than a
   * signal.
   */
  private async observe(
    actor: AuthUser,
    context: ZacActingContext,
    definition: ZacMetricDefinition,
    scope: ZacSignalScope,
    memory: ZacModelMemoryItem[],
  ): Promise<ZacMetricObservation> {
    const scopedContext: ZacActingContext = { ...context, locationId: scope.locationId };
    const { result } = await this.tools.dispatch(
      actor,
      scopedContext,
      definition.sourceTool,
      scope.locationId ? { locationId: scope.locationId } : {},
    );
    return this.observations.observe(definition.key, result, scope, memory);
  }

  // ---------------------------------------------------------------------------
  // Applying the reconciliation plan
  // ---------------------------------------------------------------------------

  /**
   * Apply the plan, one action at a time and fail-soft per action.
   *
   * A write failure must not abort the rest of the plan: losing one refresh is a
   * gap in a record, while abandoning the plan half-applied could leave a
   * resolved condition still on an owner's list. Every failure is reported to
   * the caller AND emitted on the spine, so a silent degradation is impossible.
   */
  private async apply(
    context: ZacActingContext,
    reconciliation: ZacSignalReconciliation,
    evaluatedAt: string,
  ): Promise<string[]> {
    const errors: string[] = [];

    for (const action of reconciliation.actions) {
      try {
        await this.applyAction(context, action, evaluatedAt);
      } catch (error) {
        const message = `${action.kind} ${action.signalKey}: ${(error as Error).message}`;
        this.logger.error(`zac intelligence signal ${message}`);
        errors.push(message);
      }
    }

    return errors;
  }

  private async applyAction(
    context: ZacActingContext,
    action: ZacSignalAction,
    evaluatedAt: string,
  ): Promise<void> {
    switch (action.kind) {
      case 'open': {
        const candidate = action.candidate;
        if (!candidate) return;
        await this.store.insert({
          businessId: context.businessId,
          locationId: candidate.scope.locationId,
          subjectUserId: candidate.scope.subjectUserId,
          signalKey: candidate.signalKey,
          evaluatorKey: candidate.evaluatorKey,
          metricKey: candidate.metricKey,
          issueKey: candidate.issueKey,
          scopeType: candidate.scope.type,
          scopeLabel: candidate.scope.label,
          visibilityScope: resolveVisibilityScope(candidate.scope.type),
          evaluatedAt,
          expiresAt: action.expiresAt ?? null,
          ...readingOf(candidate),
        });
        return;
      }
      case 'refresh': {
        const candidate = action.candidate;
        const existing = action.existing;
        if (!candidate || !existing) return;
        await this.store.refresh({
          id: existing.id,
          businessId: context.businessId,
          evaluatedAt,
          occurrenceCount: existing.occurrenceCount,
          keepSuppressed: action.keepSuppressed === true,
          expiresAt: action.expiresAt ?? null,
          ...readingOf(candidate),
        });
        return;
      }
      case 'resolve': {
        if (!action.existing) return;
        await this.store.retire({
          id: action.existing.id,
          businessId: context.businessId,
          status: 'resolved',
          reason: action.resolutionReason ?? 'recovered',
          at: evaluatedAt,
        });
        return;
      }
      case 'expire': {
        if (!action.existing) return;
        await this.store.retire({
          id: action.existing.id,
          businessId: context.businessId,
          status: 'expired',
          reason: action.resolutionReason ?? 'expired_unconfirmed',
          at: evaluatedAt,
        });
        return;
      }
      default:
        // `retain` is deliberately a no-write. The signal keeps its expiry clock
        // exactly where it was, so a persistent outage eventually expires it
        // instead of being silently re-confirmed by the act of looking.
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  /**
   * The visibility matrix. Deny by default: an unrecognised scope is invisible.
   *
   * It mirrors {@link ZacMemoryService.canSee}, INCLUDING the manager location
   * check that `ZacMeasurementStore.requireAccessibleOutput` omits — a
   * manager_team_theme row from another site must not be readable by every
   * manager in the business. (That divergence is a Phase 1 defect, reported
   * separately; it is not replicated here.)
   */
  private canSee(context: ZacActingContext, signal: ZacPersistedSignal): boolean {
    if (signal.businessId !== context.businessId) return false;

    switch (signal.visibilityScope) {
      case 'user_private':
      case 'stylist_private':
        // A personal signal belongs to its subject alone. No role widens into
        // it — the Phase 1 private-coaching boundary, unchanged.
        return signal.subjectUserId === context.actorUserId;
      case 'business_owner':
        return context.roleContext === 'owner' || context.roleContext === 'manager';
      case 'manager_team_theme':
        if (context.roleContext === 'owner') return true;
        if (context.roleContext !== 'manager') return false;
        // Fail closed on an unresolvable location: a team-scoped signal with no
        // location would otherwise broadcast to every manager in the business.
        return (
          signal.locationId !== null && context.accessibleLocationIds.includes(signal.locationId)
        );
      // `system_safe_summary` is in the stored vocabulary for parity with
      // zac.memory_items, but nothing writes it and ZacMemoryService.canSee
      // denies it too. Mirroring that exactly keeps one matrix, not two: a
      // scope no writer produces must not be the one branch with no test.
      default:
        return false;
    }
  }

  /** The metric's own permission requirement, against CURRENT effective permissions. */
  private actorMayRead(actor: AuthUser, definition: ZacMetricDefinition): boolean {
    return userHasAllPermissions(actor, definition.requiredPermissions);
  }

  /** A registered metric, or null for a row written against one since removed. */
  private definitionFor(metricKey: ZacPersistedSignal['metricKey']): ZacMetricDefinition | null {
    try {
      return metricDefinition(metricKey);
    } catch {
      this.logger.warn(`zac intelligence signal references an unregistered metric: ${metricKey}`);
      return null;
    }
  }
}

/**
 * Write-time visibility, derived from the scope the signal is about — never
 * from who happened to trigger the evaluation.
 *
 * `location` and `team` share `manager_team_theme` because that is how this
 * platform expresses a team: there is no team entity, no team_id and no teams
 * table, so a team is the staff at a location and the scope is keyed on the
 * location. Inventing a new visibility vocabulary for Phase 2 would fork a
 * settled one for no gain.
 */
function resolveVisibilityScope(scopeType: ZacSignalScopeType): ZacMemoryScope {
  switch (scopeType) {
    case 'personal':
      return 'stylist_private';
    case 'location':
    case 'team':
      return 'manager_team_theme';
    default:
      return 'business_owner';
  }
}

/** The reading columns a candidate contributes to an insert or a refresh. */
function readingOf(candidate: NonNullable<ZacSignalAction['candidate']>) {
  return {
    signalType: candidate.signalType,
    severity: candidate.severity,
    materiality: candidate.materiality,
    confidence: candidate.confidence,
    direction: candidate.direction,
    observationStatus: candidate.observationStatus,
    observedValue: candidate.observedValue,
    comparisonValue: candidate.comparisonValue,
    targetValue: candidate.targetValue,
    targetSource: candidate.targetSource,
    sampleSize: candidate.sampleSize,
    period: candidate.period,
    headline: candidate.headline,
    metricRefs: candidate.metricRefs,
    evidenceRefs: candidate.evidenceRefs,
    limitations: candidate.limitations,
  };
}
