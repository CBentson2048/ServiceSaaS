import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { redactForStorage } from '../memory/zac-redaction';
import type { ZacEvidenceItem, ZacMemoryScope } from '../responses/zac-response.types';
import type {
  ZacMetricKey,
  ZacMetricObservationStatus,
  ZacMetricReference,
  ZacMetricTargetSource,
  ZacSignalScopeType,
} from '../intelligence/zac-metric.types';
import type {
  ZacPersistedSignal,
  ZacSignalDirection,
  ZacSignalResolutionReason,
  ZacSignalSeverity,
  ZacSignalStatus,
  ZacSignalType,
} from '../intelligence/zac-signal.types';
import {
  ZAC_SIGNAL_STATUSES,
  ZAC_SIGNAL_TYPES,
  isZacSignalStatus,
  isZacSignalType,
} from '../intelligence/zac-signal.types';

const COLUMNS =
  'id, business_id, location_id, subject_user_id, signal_key, evaluator_key, metric_key, issue_key, ' +
  'scope_type, scope_label, visibility_scope, signal_type, severity, materiality, confidence, direction, ' +
  'observation_status, observed_value, comparison_value, target_value, target_source, sample_size, ' +
  'period_label, metric_refs, evidence_refs, limitations, headline_redacted, status, resolution_reason, ' +
  'occurrence_count, first_evaluated_at, last_evaluated_at, last_confirmed_at, resolved_at, ' +
  'suppressed_until, expires_at';

/** The columns that carry a reading, shared by insert and refresh. */
export interface ZacSignalReadingWrite {
  signalType: ZacSignalType;
  severity: ZacSignalSeverity;
  materiality: number;
  confidence: number;
  direction: ZacSignalDirection;
  observationStatus: ZacMetricObservationStatus;
  observedValue: number | null;
  comparisonValue: number | null;
  targetValue: number | null;
  targetSource: ZacMetricTargetSource | null;
  sampleSize: number | null;
  period: string | null;
  headline: string;
  metricRefs: ZacMetricReference[];
  evidenceRefs: ZacEvidenceItem[];
  limitations: string[];
  expiresAt: string | null;
}

export interface ZacSignalInsert extends ZacSignalReadingWrite {
  businessId: string;
  locationId: string | null;
  subjectUserId: string | null;
  signalKey: string;
  evaluatorKey: string;
  metricKey: ZacMetricKey;
  issueKey: string;
  scopeType: ZacSignalScopeType;
  scopeLabel: string | null;
  visibilityScope: ZacMemoryScope;
  evaluatedAt: string;
}

export interface ZacSignalRefresh extends ZacSignalReadingWrite {
  id: string;
  businessId: string;
  evaluatedAt: string;
  occurrenceCount: number;
  /** True while a suppression window is open: the reading updates, the state does not. */
  keepSuppressed: boolean;
}

export interface ZacSignalRetire {
  id: string;
  businessId: string;
  status: Extract<ZacSignalStatus, 'resolved' | 'expired'>;
  reason: ZacSignalResolutionReason;
  at: string;
}

/**
 * Server-owned persistence for zac.intelligence_signals.
 *
 * Platform convention throughout: a private service-role client, per-query
 * `.schema('zac')`, and `.eq('business_id', …)` on EVERY read and write. That
 * last one is the tenant boundary in practice — the API bypasses RLS with the
 * service role, so the policies in 0112 are defence-in-depth for direct
 * PostgREST access and this class is what actually keeps businesses apart.
 *
 * Visibility is NOT decided here. This store guarantees no query crosses a
 * business; who may see a row is ZacIntelligenceSignalService's job, and it
 * re-checks live permissions rather than trusting the stored scope.
 */
@Injectable()
export class ZacIntelligenceSignalStore {
  private readonly logger = new Logger(ZacIntelligenceSignalStore.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * The LIVE signals of one business — active and suppressed. Resolved and
   * expired rows are history: the reconciler must not see them, or a closed
   * episode would be reopened in place instead of a new one being recorded.
   */
  async listLive(businessId: string, limit = 500): Promise<ZacPersistedSignal[]> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('intelligence_signals')
      .select(COLUMNS)
      .eq('business_id', businessId)
      .in('status', ['active', 'suppressed'])
      .order('materiality', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`zac intelligence signal list failed: ${error.message}`);
    }
    return this.toSignals(data ?? []);
  }

  /** Every signal for one business regardless of status — audit and history reads. */
  async listAll(businessId: string, limit = 500): Promise<ZacPersistedSignal[]> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('intelligence_signals')
      .select(COLUMNS)
      .eq('business_id', businessId)
      .order('last_evaluated_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`zac intelligence signal history read failed: ${error.message}`);
    }
    return this.toSignals(data ?? []);
  }

  /** Open a new signal episode. */
  async insert(signal: ZacSignalInsert): Promise<void> {
    const { error } = await this.admin
      .schema('zac')
      .from('intelligence_signals')
      .insert({
        business_id: signal.businessId,
        location_id: signal.locationId,
        subject_user_id: signal.subjectUserId,
        signal_key: signal.signalKey,
        evaluator_key: signal.evaluatorKey,
        metric_key: signal.metricKey,
        issue_key: signal.issueKey,
        scope_type: signal.scopeType,
        scope_label: signal.scopeLabel,
        visibility_scope: signal.visibilityScope,
        status: 'active',
        occurrence_count: 1,
        first_evaluated_at: signal.evaluatedAt,
        last_evaluated_at: signal.evaluatedAt,
        // A brand-new signal was, by definition, just confirmed by a reading.
        last_confirmed_at: signal.evaluatedAt,
        ...this.readingColumns(signal),
      });

    if (error) {
      throw new Error(`zac intelligence signal insert failed: ${error.message}`);
    }
  }

  /**
   * Refresh the live signal for a logical issue with a newer reading.
   *
   * `last_confirmed_at` advances here and only here, because a refresh always
   * comes from a candidate and a candidate always comes from a measured
   * observation. That is what lets expiry mean "unconfirmed" rather than
   * "unresolved".
   */
  async refresh(signal: ZacSignalRefresh): Promise<void> {
    const { error } = await this.admin
      .schema('zac')
      .from('intelligence_signals')
      .update({
        // A refresh never resurrects a signal out of an open suppression window:
        // the reading updates, the person's decision not to be told stands.
        // Returning to active clears the suppression window too: leaving a stale
        // `suppressed_until` behind would make an active signal read as one
        // somebody had silenced.
        ...(signal.keepSuppressed
          ? {}
          : { status: 'active', resolution_reason: null, resolved_at: null, suppressed_until: null }),
        occurrence_count: signal.occurrenceCount + 1,
        last_evaluated_at: signal.evaluatedAt,
        last_confirmed_at: signal.evaluatedAt,
        ...this.readingColumns(signal),
      })
      .eq('id', signal.id)
      .eq('business_id', signal.businessId);

    if (error) {
      throw new Error(`zac intelligence signal refresh failed: ${error.message}`);
    }
  }

  /** Move a signal out of the live set: recovered, or aged out unconfirmed. */
  async retire(signal: ZacSignalRetire): Promise<void> {
    const { error } = await this.admin
      .schema('zac')
      .from('intelligence_signals')
      .update({
        status: signal.status,
        resolution_reason: signal.reason,
        resolved_at: signal.at,
        last_evaluated_at: signal.at,
      })
      .eq('id', signal.id)
      .eq('business_id', signal.businessId);

    if (error) {
      throw new Error(`zac intelligence signal retire failed: ${error.message}`);
    }
  }

  /**
   * Suppress a live signal until an instant. An explicit human decision — the
   * framework never suppresses anything on its own — and the instant is required,
   * so no suppression can outlive the reading behind it. The service bounds it
   * before it reaches here.
   */
  async suppress(
    businessId: string,
    signalId: string,
    until: string,
    at: string,
  ): Promise<void> {
    const { error } = await this.admin
      .schema('zac')
      .from('intelligence_signals')
      .update({
        status: 'suppressed',
        resolution_reason: 'suppressed_by_actor',
        suppressed_until: until,
        last_evaluated_at: at,
      })
      .eq('id', signalId)
      .eq('business_id', businessId);

    if (error) {
      throw new Error(`zac intelligence signal suppress failed: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * The reading columns. `headline_redacted` goes through the same
   * data-minimisation gate as every other ZAC write, at the same 300-character
   * cap a memory summary uses — a headline is a sentence, and anything longer is
   * a payload leaking in.
   */
  private readingColumns(reading: ZacSignalReadingWrite): Record<string, unknown> {
    return {
      signal_type: reading.signalType,
      severity: reading.severity,
      materiality: reading.materiality,
      confidence: reading.confidence,
      direction: reading.direction,
      observation_status: reading.observationStatus,
      observed_value: reading.observedValue,
      comparison_value: reading.comparisonValue,
      target_value: reading.targetValue,
      target_source: reading.targetSource,
      sample_size: reading.sampleSize,
      period_label: reading.period,
      headline_redacted: redactForStorage(reading.headline, 300),
      metric_refs: reading.metricRefs,
      evidence_refs: reading.evidenceRefs,
      limitations: reading.limitations,
      expires_at: reading.expiresAt,
    };
  }

  private toSignals(rows: unknown[]): ZacPersistedSignal[] {
    return rows
      .map((row) => this.toSignal(row as Record<string, unknown>))
      .filter((signal): signal is ZacPersistedSignal => signal !== null);
  }

  /**
   * Rows are trusted-shape by construction (only this API writes them), but a
   * defensive parse keeps an unrecognised status or type out of the lifecycle —
   * an unreadable row is dropped, never guessed at, exactly as the memory store
   * does. Dropping is safe here in a way it would not be for a resolution: a row
   * we cannot read is a row we do not act on.
   */
  private toSignal(row: Record<string, unknown>): ZacPersistedSignal | null {
    const status = row['status'];
    const signalType = row['signal_type'];
    if (!isZacSignalStatus(status) || !isZacSignalType(signalType)) {
      this.logger.warn(
        `zac intelligence signal row ${String(row['id'])} has an unrecognised status/type (expected one of ${ZAC_SIGNAL_STATUSES.join('/')} and ${ZAC_SIGNAL_TYPES.join('/')})`,
      );
      return null;
    }

    return {
      id: String(row['id']),
      businessId: String(row['business_id']),
      locationId: (row['location_id'] as string | null) ?? null,
      subjectUserId: (row['subject_user_id'] as string | null) ?? null,
      signalKey: String(row['signal_key']),
      evaluatorKey: String(row['evaluator_key']),
      metricKey: row['metric_key'] as ZacMetricKey,
      issueKey: String(row['issue_key']),
      scopeType: row['scope_type'] as ZacSignalScopeType,
      scopeLabel: (row['scope_label'] as string | null) ?? null,
      visibilityScope: row['visibility_scope'] as ZacMemoryScope,
      signalType,
      severity: row['severity'] as ZacSignalSeverity,
      materiality: numberOr(row['materiality'], 0),
      confidence: numberOr(row['confidence'], 0),
      direction: (row['direction'] as ZacSignalDirection) ?? 'unknown',
      observationStatus: row['observation_status'] as ZacMetricObservationStatus,
      observedValue: nullableNumber(row['observed_value']),
      comparisonValue: nullableNumber(row['comparison_value']),
      targetValue: nullableNumber(row['target_value']),
      targetSource: (row['target_source'] as ZacMetricTargetSource | null) ?? null,
      sampleSize: nullableNumber(row['sample_size']),
      period: (row['period_label'] as string | null) ?? null,
      headline: String(row['headline_redacted'] ?? ''),
      metricRefs: jsonArray<ZacMetricReference>(row['metric_refs']),
      evidenceRefs: jsonArray<ZacEvidenceItem>(row['evidence_refs']),
      limitations: jsonArray<string>(row['limitations']),
      status,
      resolutionReason: (row['resolution_reason'] as ZacSignalResolutionReason | null) ?? null,
      occurrenceCount: numberOr(row['occurrence_count'], 1),
      firstEvaluatedAt: String(row['first_evaluated_at']),
      lastEvaluatedAt: String(row['last_evaluated_at']),
      lastConfirmedAt: (row['last_confirmed_at'] as string | null) ?? null,
      resolvedAt: (row['resolved_at'] as string | null) ?? null,
      suppressedUntil: (row['suppressed_until'] as string | null) ?? null,
      expiresAt: (row['expires_at'] as string | null) ?? null,
    };
  }
}

/** Postgres numerics arrive as strings through PostgREST; coerce once, here. */
function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
