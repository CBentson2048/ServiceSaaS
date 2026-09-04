import { redactForStorage } from '../../memory/zac-redaction';
import type {
  ZacSignalInsert,
  ZacSignalRefresh,
  ZacSignalRepository,
  ZacSignalRetire,
} from '../../persistence/zac-intelligence-signal.store';
import type { ZacPersistedSignal } from '../zac-signal.types';

/**
 * An in-memory {@link ZacSignalRepository} for the Phase 2 signal evaluation
 * harness.
 *
 * It mirrors the Supabase store's semantics EXACTLY — including the one that
 * matters most for dedupe: the partial unique index
 * `(business_id, signal_key) where status in ('active','suppressed')`. A
 * reconciler bug that tried to open a second live row for one issue must fail
 * here the same way Postgres would fail it, or the harness would certify a
 * dedupe the database rejects.
 *
 * It also records every write, so a case can assert what the service DID, not
 * only what it returned.
 */
export class InMemorySignalRepository implements ZacSignalRepository {
  private readonly rows: ZacPersistedSignal[] = [];
  private sequence = 0;
  /** Every mutation, in order, for assertions and for the duplicate-attempt count. */
  readonly log: Array<{ op: 'insert' | 'refresh' | 'retire' | 'suppress'; signalKey: string; businessId: string }> = [];
  /** Inserts the partial unique index would have rejected. Must be 0. */
  duplicateLiveAttempts = 0;

  async listLive(businessId: string, limit = 500): Promise<ZacPersistedSignal[]> {
    return this.rows
      .filter((row) => row.businessId === businessId && (row.status === 'active' || row.status === 'suppressed'))
      .sort((a, b) => b.materiality - a.materiality)
      .slice(0, limit)
      .map(clone);
  }

  async listAll(businessId: string, limit = 500): Promise<ZacPersistedSignal[]> {
    return this.rows
      .filter((row) => row.businessId === businessId)
      .sort((a, b) => b.lastEvaluatedAt.localeCompare(a.lastEvaluatedAt))
      .slice(0, limit)
      .map(clone);
  }

  async insert(signal: ZacSignalInsert): Promise<void> {
    const collides = this.rows.some(
      (row) =>
        row.businessId === signal.businessId &&
        row.signalKey === signal.signalKey &&
        (row.status === 'active' || row.status === 'suppressed'),
    );
    if (collides) {
      this.duplicateLiveAttempts += 1;
      throw new Error(
        `duplicate key value violates unique constraint "idx_zac_intelligence_signals_live_key" (${signal.signalKey})`,
      );
    }
    this.sequence += 1;
    this.rows.push({
      id: `sig-${String(this.sequence).padStart(4, '0')}`,
      businessId: signal.businessId,
      locationId: signal.locationId,
      subjectUserId: signal.subjectUserId,
      signalKey: signal.signalKey,
      evaluatorKey: signal.evaluatorKey,
      metricKey: signal.metricKey,
      issueKey: signal.issueKey,
      scopeType: signal.scopeType,
      scopeLabel: signal.scopeLabel,
      visibilityScope: signal.visibilityScope,
      ...reading(signal),
      status: 'active',
      resolutionReason: null,
      occurrenceCount: 1,
      firstEvaluatedAt: signal.evaluatedAt,
      lastEvaluatedAt: signal.evaluatedAt,
      lastConfirmedAt: signal.evaluatedAt,
      resolvedAt: null,
      suppressedUntil: null,
      expiresAt: signal.expiresAt,
    });
    this.log.push({ op: 'insert', signalKey: signal.signalKey, businessId: signal.businessId });
  }

  async refresh(signal: ZacSignalRefresh): Promise<void> {
    const row = this.find(signal.id, signal.businessId);
    if (!row) return; // An UPDATE that matches no row is a no-op in Postgres too.
    if (!signal.keepSuppressed) {
      row.status = 'active';
      row.resolutionReason = null;
      row.resolvedAt = null;
      row.suppressedUntil = null;
    }
    row.occurrenceCount = signal.occurrenceCount + 1;
    row.lastEvaluatedAt = signal.evaluatedAt;
    row.lastConfirmedAt = signal.evaluatedAt;
    Object.assign(row, reading(signal));
    row.expiresAt = signal.expiresAt;
    this.log.push({ op: 'refresh', signalKey: row.signalKey, businessId: row.businessId });
  }

  async retire(signal: ZacSignalRetire): Promise<void> {
    const row = this.find(signal.id, signal.businessId);
    if (!row) return;
    row.status = signal.status;
    row.resolutionReason = signal.reason;
    row.resolvedAt = signal.at;
    row.lastEvaluatedAt = signal.at;
    this.log.push({ op: 'retire', signalKey: row.signalKey, businessId: row.businessId });
  }

  async suppress(businessId: string, signalId: string, until: string, at: string): Promise<void> {
    const row = this.find(signalId, businessId);
    if (!row) return;
    row.status = 'suppressed';
    row.resolutionReason = 'suppressed_by_actor';
    row.suppressedUntil = until;
    row.lastEvaluatedAt = at;
    this.log.push({ op: 'suppress', signalKey: row.signalKey, businessId: row.businessId });
  }

  /** Every row across every business — for isolation assertions only. */
  snapshot(): ZacPersistedSignal[] {
    return this.rows.map(clone);
  }

  private find(id: string, businessId: string): ZacPersistedSignal | undefined {
    // Both predicates, exactly as the store's `.eq('id').eq('business_id')`:
    // a row id from another tenant must be unreachable even by accident.
    return this.rows.find((row) => row.id === id && row.businessId === businessId);
  }
}

function reading(signal: ZacSignalInsert | ZacSignalRefresh) {
  return {
    signalType: signal.signalType,
    severity: signal.severity,
    materiality: signal.materiality,
    confidence: signal.confidence,
    direction: signal.direction,
    observationStatus: signal.observationStatus,
    observedValue: signal.observedValue,
    comparisonValue: signal.comparisonValue,
    targetValue: signal.targetValue,
    targetSource: signal.targetSource,
    sampleSize: signal.sampleSize,
    period: signal.period,
    headline: redactForStorage(signal.headline, 300),
    metricRefs: signal.metricRefs,
    evidenceRefs: signal.evidenceRefs,
    limitations: signal.limitations,
  };
}

function clone(row: ZacPersistedSignal): ZacPersistedSignal {
  return JSON.parse(JSON.stringify(row)) as ZacPersistedSignal;
}
