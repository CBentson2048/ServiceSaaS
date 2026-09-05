import { Injectable } from '@nestjs/common';
import { metricDefinition } from './zac-metric-registry';
import { computeMateriality } from './zac-signal-scoring';
import { isPositiveEvidence, type ZacMetricObservationStatus } from './zac-metric.types';
import {
  buildCoverageKey,
  signalFamily,
  type ZacPersistedSignal,
  type ZacSignalCandidate,
  type ZacSignalEvaluation,
} from './zac-signal.types';

/**
 * SIGNAL RECONCILER — the lifecycle rules, as a pure function.
 *
 * No I/O, no clock, no model: it is handed the signals that exist, the
 * evaluations that just ran and the instant to reason about, and it returns a
 * PLAN. The store applies the plan. Keeping it pure is what makes every
 * acceptance fixture — including "the dashboard went down" and "permission was
 * revoked" — a table-driven unit test rather than an integration exercise.
 *
 * THE RULE THAT MATTERS MOST, stated once so it cannot be diluted:
 *
 *   A MISSING OR FAILED OBSERVATION NEVER RESOLVES A SIGNAL.
 *
 * Resolution requires positive evidence that the triggering condition is gone —
 * a real reading, over a real denominator, that no longer clears the bar for a
 * signal. Everything else (the tool errored, the rota was empty, the sample was
 * thin, the target vanished when the scope widened) leaves the signal exactly
 * where it was. The failure mode this prevents is the worst one available to a
 * system like this: an outage that reads as good news.
 *
 * Its mirror keeps the framework from lying in the other direction — an active
 * signal that goes unconfirmed long enough EXPIRES rather than standing forever.
 * `resolved` and `expired` are deliberately different states, because "it got
 * better" and "we stopped being able to tell" are different facts.
 */

/** What the store should do about one signal. */
export type ZacSignalActionKind = 'open' | 'refresh' | 'resolve' | 'expire' | 'retain';

/** Why a signal was left untouched. Observability only; never a write. */
export type ZacSignalRetentionReason =
  /** The metric/scope was not evaluated at all this run. */
  | 'not_evaluated'
  /** It was evaluated, but the reading carried no positive evidence. */
  | 'unconfirmed_observation'
  /** Under an active suppression window. */
  | 'suppressed';

export interface ZacSignalAction {
  kind: ZacSignalActionKind;
  signalKey: string;
  /** The row to act on. Absent for `open`. */
  existing: ZacPersistedSignal | null;
  /** The reading to write. Absent for `resolve` / `expire` / `retain`. */
  candidate: ZacSignalCandidate | null;
  /** For `refresh`: the row stays suppressed rather than returning to active. */
  keepSuppressed?: boolean;
  /** For `retain`: why nothing happened. */
  retentionReason?: ZacSignalRetentionReason;
  /** For `retain` / `resolve`: the observation status that produced the decision. */
  observationStatus?: ZacMetricObservationStatus;
  /** For `resolve`: whether a gap closed, or a progress run was superseded. */
  resolutionReason?: 'recovered' | 'superseded' | 'expired_unconfirmed';
  /** For `refresh` / `open`: when this signal stops being credible without re-confirmation. */
  expiresAt?: string;
}

export interface ZacSignalReconciliation {
  actions: ZacSignalAction[];
  opened: number;
  refreshed: number;
  resolved: number;
  expired: number;
  retained: number;
}

/**
 * Withholding reasons that constitute POSITIVE EVIDENCE ABOUT THE BUSINESS: the
 * evaluator looked at a real reading and declined to raise a problem because
 * there was no longer a problem to raise.
 *
 * `no_target` is pointedly absent. A target disappearing (a threshold cleared,
 * a scope widened past the single location QLOOQO resolves one for) says
 * nothing about whether the gap closed, and treating it as recovery would let a
 * settings change silently retire every utilisation signal in the business.
 */
const RECOVERY_REASONS = new Set(['below_materiality_floor', 'healthy_steady']);

@Injectable()
export class ZacSignalReconciler {
  /**
   * @param existing every signal already stored for this business in the scopes
   *   about to be evaluated — active AND suppressed. Resolved and expired rows
   *   are history and are not passed in: a recurrence opens a new episode so the
   *   old one stays separately auditable.
   * @param evaluations what the evaluators just produced.
   * @param evaluatedAt the instant to reason about, supplied by the caller so
   *   this stays deterministic.
   */
  reconcile(
    existing: readonly ZacPersistedSignal[],
    evaluations: readonly ZacSignalEvaluation[],
    evaluatedAt: string,
  ): ZacSignalReconciliation {
    const evaluatedAtMs = Date.parse(evaluatedAt);
    // Every input belongs to one tenant by construction — the store filters on
    // business_id and the evaluator stamps it into each signal key. Taking it
    // from the data rather than a parameter keeps that true without a caller
    // having to restate it.
    const businessId = existing[0]?.businessId ?? tenantOf(evaluations);
    const byKey = new Map<string, ZacPersistedSignal>();
    for (const signal of existing) byKey.set(signal.signalKey, signal);

    /** metric+scope -> what the reading was, and whether it can retire anything. */
    const coverage = new Map<
      string,
      {
        status: ZacMetricObservationStatus;
        recoveryEvidence: boolean;
        /** The reading behind the verdict, for the recovered-vs-superseded decision. */
        value: number | null;
        target: number | null;
      }
    >();
    for (const evaluation of evaluations) {
      const key = buildCoverageKey({
        businessId,
        metricKey: evaluation.metricKey,
        scope: evaluation.scope,
      });
      const positive = isPositiveEvidence(evaluation.observationStatus);
      // A reading recovers a signal only when the evaluator ALSO declined for a
      // business reason. A valid reading withheld for `no_target` is covered but
      // carries no verdict.
      const withheldReasons = evaluation.withheld.map((entry) => entry.reason);
      const recoveryEvidence =
        positive &&
        (evaluation.candidates.length > 0 ||
          withheldReasons.some((reason) => RECOVERY_REASONS.has(reason)));
      const previous = coverage.get(key);
      coverage.set(key, {
        status: evaluation.observationStatus,
        recoveryEvidence: (previous?.recoveryEvidence ?? false) || recoveryEvidence,
        value: evaluation.observedValue ?? previous?.value ?? null,
        target: evaluation.target ?? previous?.target ?? null,
      });
    }

    const actions: ZacSignalAction[] = [];
    const handled = new Set<string>();

    // ---- Candidates: open a new episode, or refresh the one that exists. ----
    for (const evaluation of evaluations) {
      for (const candidate of evaluation.candidates) {
        handled.add(candidate.signalKey);
        const current = byKey.get(candidate.signalKey);
        const expiresAt = this.expiryOf(candidate, evaluatedAtMs);

        if (!current) {
          actions.push({
            kind: 'open',
            signalKey: candidate.signalKey,
            existing: null,
            candidate,
            expiresAt,
            observationStatus: candidate.observationStatus,
          });
          continue;
        }

        // Repeated evaluation of the same logical issue REFRESHES. This is the
        // whole reason the signal key excludes the period and the value: without
        // that, a rolling window would mint a new row every run and an owner
        // would watch one problem multiply down their list.
        const keepSuppressed = this.isSuppressed(current, evaluatedAtMs);
        actions.push({
          kind: 'refresh',
          signalKey: candidate.signalKey,
          existing: current,
          candidate,
          keepSuppressed,
          expiresAt,
          observationStatus: candidate.observationStatus,
        });
      }
    }

    // ---- Signals with no candidate this run. ----
    for (const signal of existing) {
      if (handled.has(signal.signalKey)) continue;

      if (this.isSuppressed(signal, evaluatedAtMs)) {
        actions.push({
          kind: 'retain',
          signalKey: signal.signalKey,
          existing: signal,
          candidate: null,
          retentionReason: 'suppressed',
        });
        continue;
      }

      const covered = coverage.get(
        buildCoverageKey({
          businessId,
          metricKey: signal.metricKey,
          scope: {
            type: signal.scopeType,
            locationId: signal.locationId,
            subjectUserId: signal.subjectUserId,
          },
        }),
      );

      // Not looked at → nothing learned → nothing to resolve. It can still
      // EXPIRE, though: a metric that stops being evaluated at all (a permission
      // removed, a location dropped, a metric deregistered) would otherwise leave
      // its signals asserting themselves forever, which is the same lie as
      // resolving them — just in the opposite direction.
      if (!covered) {
        actions.push(
          this.hasExpired(signal, evaluatedAtMs)
            ? { kind: 'expire', signalKey: signal.signalKey, existing: signal, candidate: null, resolutionReason: 'expired_unconfirmed' }
            : {
                kind: 'retain',
                signalKey: signal.signalKey,
                existing: signal,
                candidate: null,
                retentionReason: 'not_evaluated',
              },
        );
        continue;
      }

      // THE INVARIANT. Looked at, but the reading carried no positive evidence:
      // the signal stands, unresolved, and its expiry clock is NOT extended —
      // a persistent outage eventually expires it, which is honest, rather than
      // resolving it, which would not be.
      if (!covered.recoveryEvidence) {
        const expired = this.hasExpired(signal, evaluatedAtMs);
        actions.push(
          expired
            ? {
                kind: 'expire',
                resolutionReason: 'expired_unconfirmed',
                signalKey: signal.signalKey,
                existing: signal,
                candidate: null,
                observationStatus: covered.status,
              }
            : {
                kind: 'retain',
                signalKey: signal.signalKey,
                existing: signal,
                candidate: null,
                retentionReason: 'unconfirmed_observation',
                observationStatus: covered.status,
              },
        );
        continue;
      }

      // Positive evidence, and no candidate under this key: the condition that
      // raised it no longer holds.
      actions.push({
        kind: 'resolve',
        signalKey: signal.signalKey,
        existing: signal,
        candidate: null,
        observationStatus: covered.status,
        resolutionReason: this.resolutionReasonFor(signal, covered.value),
      });
    }

    return {
      actions,
      opened: actions.filter((action) => action.kind === 'open').length,
      refreshed: actions.filter((action) => action.kind === 'refresh').length,
      resolved: actions.filter((action) => action.kind === 'resolve').length,
      expired: actions.filter((action) => action.kind === 'expire').length,
      retained: actions.filter((action) => action.kind === 'retain').length,
    };
  }

  /**
   * Why a signal is being resolved — and the distinction is load-bearing.
   *
   * A progress episode does not "recover"; it is SUPERSEDED by whatever the
   * metric did next. A shortfall is RECOVERED only when the reading closed the
   * gap against the target the signal was raised for (to zero or inside the
   * metric's noise floor, exactly as the evaluator judges recovery). If the
   * number did not move but the TARGET did — a remembered goal appearing, a
   * threshold lowered — the old signal no longer applies, but nothing recovered:
   * that is superseded too. Without this rule a goal typed into memory would
   * be recorded as a business improvement.
   */
  private resolutionReasonFor(
    signal: ZacPersistedSignal,
    value: number | null,
  ): 'recovered' | 'superseded' {
    if (signalFamily(signal.signalType) === 'progress') return 'superseded';
    if (value === null || signal.targetValue === null) return 'recovered';
    const definition = metricDefinition(signal.metricKey);
    const gapAgainstOwnTarget = computeMateriality(definition, value, signal.targetValue);
    return gapAgainstOwnTarget < definition.materialityBands.watch ? 'recovered' : 'superseded';
  }

  /** When a freshly confirmed signal stops being credible, from its metric's window. */
  private expiryOf(candidate: ZacSignalCandidate, evaluatedAtMs: number): string {
    const days = metricDefinition(candidate.metricKey).staleAfterDays;
    return new Date(evaluatedAtMs + days * 86_400_000).toISOString();
  }

  private hasExpired(signal: ZacPersistedSignal, evaluatedAtMs: number): boolean {
    if (!signal.expiresAt) return false;
    const expiry = Date.parse(signal.expiresAt);
    return Number.isFinite(expiry) && expiry <= evaluatedAtMs;
  }

  private isSuppressed(signal: ZacPersistedSignal, evaluatedAtMs: number): boolean {
    if (signal.status !== 'suppressed') return false;
    if (!signal.suppressedUntil) return true;
    const until = Date.parse(signal.suppressedUntil);
    return !Number.isFinite(until) || until > evaluatedAtMs;
  }
}

/**
 * The tenant an evaluation batch belongs to, read out of the signal key its
 * evaluator built. Only needed when nothing is stored yet, and only to key
 * coverage — a mismatch could not cross tenants, because the store never hands
 * this function two businesses' rows.
 */
function tenantOf(evaluations: readonly ZacSignalEvaluation[]): string {
  for (const evaluation of evaluations) {
    const key = evaluation.candidates[0]?.signalKey ?? evaluation.withheld[0]?.signalKey;
    if (key) return key.split('|')[0];
  }
  return '-';
}
