import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacCostEvent } from '../measurement/zac-cost-telemetry.service';
import type {
  ZacFeedbackRecord,
  ZacOutcomeInsert,
  ZacOutputInsert,
  ZacOutputRecord,
  ZacToolCallInsert,
} from './zac-measurement.types';

/**
 * Server-owned persistence for the ZAC measurement spine: outputs, tool-call
 * records, cost events, feedback and outcome events. Platform convention
 * (private service-role client, per-query `.schema('zac')`); forced RLS +
 * SELECT-only grants keep every client out of the write path, and this store
 * scopes every query by business so no call can cross a tenant.
 *
 * Data minimisation is upstream by construction: callers hand this store
 * pre-redacted summaries and safe metadata only — never prompts, transcripts
 * or raw tool payloads.
 */
@Injectable()
export class ZacMeasurementStore {
  private readonly logger = new Logger(ZacMeasurementStore.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Persist one output row; returns its id. */
  async insertOutput(output: ZacOutputInsert): Promise<string> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('outputs')
      .insert({
        business_id: output.businessId,
        location_id: output.locationId,
        actor_user_id: output.actorUserId,
        role_context: output.roleContext,
        visibility_scope: output.visibilityScope,
        response_type: output.responseType,
        request_mode: output.requestMode,
        title: output.title,
        body_redacted: output.bodyRedacted,
        evidence: output.evidence,
        limitations: output.limitations,
        confidence: output.confidence,
        status: 'created',
        source_conversation_id: output.conversationId,
        trace_id: output.traceId,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !data) {
      throw new Error(`zac output insert failed: ${error?.message ?? 'no row returned'}`);
    }
    return data.id;
  }

  /** Persist the turn's tool dispatch metadata (names/status/latency only). */
  async insertToolCalls(rows: ZacToolCallInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.admin
      .schema('zac')
      .from('tool_calls')
      .insert(
        rows.map((row) => ({
          business_id: row.businessId,
          location_id: row.locationId,
          conversation_id: row.conversationId,
          actor_user_id: row.actorUserId,
          role_context: row.roleContext,
          tool_name: row.toolName,
          args_meta: row.argsMeta,
          result_status: row.resultStatus,
          result_row_count: row.resultRowCount,
          latency_ms: row.latencyMs,
          trace_id: row.traceId,
        })),
      );

    if (error) {
      throw new Error(`zac tool_calls insert failed: ${error.message}`);
    }
  }

  /**
   * Persist the turn's model cost events. `estimatedCostUsd: null` means the
   * call is real but unpriced (ZAC_PRICE_* unset) — never silently $0.
   */
  async insertCostEvents(
    events: ZacCostEvent[],
    outputId: string | null,
  ): Promise<void> {
    if (events.length === 0) return;
    const { error } = await this.admin
      .schema('zac')
      .from('cost_events')
      .insert(
        events.map((event) => ({
          business_id: event.business_id,
          location_id: event.location_id,
          actor_user_id: event.actor_user_id,
          role_context: event.role_context,
          conversation_id: event.conversation_id,
          output_id: outputId,
          trace_id: event.trace_id,
          provider: event.provider,
          model: event.model,
          task_type: event.task_type,
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          reasoning_tokens: event.reasoning_tokens,
          // Real usage with a zero estimate = unpriced deployment: store NULL
          // (estimate unavailable) rather than a false $0.
          estimated_cost_usd:
            event.estimated_cost_usd === 0 &&
            event.input_tokens + event.output_tokens > 0
              ? null
              : event.estimated_cost_usd,
          latency_ms: event.latency_ms,
          tool_calls_used: event.tool_calls_used,
          cache_hit: event.cache_hit,
        })),
      );

    if (error) {
      throw new Error(`zac cost_events insert failed: ${error.message}`);
    }
  }

  /**
   * Load an output the acting user may interact with, fail-closed: the same
   * 404 covers "does not exist", "another business" and "not visible to you"
   * (a user_private output belongs to its actor alone — owner and manager
   * roles never widen into it).
   */
  async requireAccessibleOutput(
    context: Pick<
      ZacActingContext,
      'actorUserId' | 'businessId' | 'roleContext' | 'accessibleLocationIds'
    >,
    outputId: string,
  ): Promise<ZacOutputRecord> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('outputs')
      .select('id, business_id, actor_user_id, location_id, visibility_scope, response_type, request_mode')
      .eq('id', outputId)
      .eq('business_id', context.businessId)
      .maybeSingle<ZacOutputRecord>();

    if (error) {
      throw new Error(`zac output lookup failed: ${error.message}`);
    }
    if (!data) throw new NotFoundException();

    if (!this.canSeeOutput(context, data)) throw new NotFoundException();
    return data;
  }

  /**
   * The visibility matrix for a stored output. Deny by default.
   *
   * This previously admitted any MANAGER to any business-scoped output on base
   * role alone — no permission, no location predicate — which
   * `ZacIntelligenceSignalService.canSee` documents as a Phase 1 defect and
   * deliberately declines to replicate. It was harmless only because the SELECT
   * above omits `body_redacted`; it stops being harmless the moment anything
   * reads an output body back.
   *
   * Ported from that corrected matrix so there is ONE definition, not two.
   */
  private canSeeOutput(
    context: Pick<
      ZacActingContext,
      'actorUserId' | 'businessId' | 'roleContext' | 'accessibleLocationIds'
    >,
    output: ZacOutputRecord,
  ): boolean {
    if (output.business_id !== context.businessId) return false;
    // Your own output is always yours, whatever its scope.
    if (output.actor_user_id === context.actorUserId) return true;

    switch (output.visibility_scope) {
      case 'user_private':
      case 'stylist_private':
        // Personal outputs belong to their subject alone; no role widens in.
        return false;
      case 'business_owner':
        // Business-wide readings are owner-only: the underlying tools are
        // location-scoped for everyone but an owner, so an output derived from
        // them must not widen what a manager can see.
        return context.roleContext === 'owner';
      case 'manager_team_theme': {
        if (context.roleContext === 'owner') return true;
        if (context.roleContext !== 'manager') return false;
        // Fail closed on an unresolvable location, or this broadcasts to every
        // manager in the business.
        return (
          output.location_id !== null &&
          (context.accessibleLocationIds ?? []).includes(output.location_id)
        );
      }
      default:
        return false;
    }
  }

  /** Upsert the actor's single active vote on an output (idempotent). */
  async upsertFeedback(feedback: ZacFeedbackRecord): Promise<void> {
    const existing = await this.admin
      .schema('zac')
      .from('feedback')
      .select('id')
      .eq('business_id', feedback.businessId)
      .eq('output_id', feedback.outputId)
      .eq('actor_user_id', feedback.actorUserId)
      .maybeSingle<{ id: string }>();

    if (existing.error) {
      throw new Error(`zac feedback lookup failed: ${existing.error.message}`);
    }

    if (existing.data) {
      const { error } = await this.admin
        .schema('zac')
        .from('feedback')
        .update({ rating: feedback.rating, comment_redacted: feedback.commentRedacted })
        .eq('id', existing.data.id)
        .eq('business_id', feedback.businessId);
      if (error) throw new Error(`zac feedback update failed: ${error.message}`);
      return;
    }

    const { error } = await this.admin.schema('zac').from('feedback').insert({
      business_id: feedback.businessId,
      actor_user_id: feedback.actorUserId,
      role_context: feedback.roleContext,
      output_id: feedback.outputId,
      rating: feedback.rating,
      comment_redacted: feedback.commentRedacted,
    });
    if (error) {
      // Concurrent first votes: the loser of the unique-index race converts to
      // an update — the vote persists either way, never a 500.
      if ((error as { code?: string }).code === '23505') {
        const { error: retryError } = await this.admin
          .schema('zac')
          .from('feedback')
          .update({ rating: feedback.rating, comment_redacted: feedback.commentRedacted })
          .eq('business_id', feedback.businessId)
          .eq('output_id', feedback.outputId)
          .eq('actor_user_id', feedback.actorUserId);
        if (!retryError) return;
        throw new Error(`zac feedback race-retry failed: ${retryError.message}`);
      }
      throw new Error(`zac feedback insert failed: ${error.message}`);
    }
  }

  /** Persist one explicit outcome event against an output. */
  async insertOutcomeEvent(outcome: ZacOutcomeInsert): Promise<string> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('outcome_events')
      .insert({
        business_id: outcome.businessId,
        location_id: outcome.locationId,
        actor_user_id: outcome.actorUserId,
        role_context: outcome.roleContext,
        output_id: outcome.outputId,
        visibility_scope: outcome.visibilityScope,
        outcome_type: outcome.outcomeType,
        summary_redacted: outcome.summaryRedacted,
        observed_value: outcome.observedValue,
        estimated_financial_value_cents: outcome.estimatedFinancialValueCents,
        confidence: outcome.confidence,
        attribution_type: outcome.attributionType,
        evidence: outcome.evidence,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !data) {
      throw new Error(`zac outcome insert failed: ${error?.message ?? 'no row returned'}`);
    }
    return data.id;
  }

  /**
   * Aggregation-friendly reads for later cost analysis — deliberately raw row
   * lists scoped by business; no dashboarding here. AUTHORISATION CONTRACT:
   * these are server-internal, and `businessId` must always come from a
   * guard-verified acting context (never a request parameter) — any future
   * endpoint over them owes its own role/permission gate before calling.
   */
  async listCostEventsForConversation(
    businessId: string,
    conversationId: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('cost_events')
      .select(
        'id, provider, model, task_type, input_tokens, output_tokens, estimated_cost_usd, latency_ms, output_id, created_at',
      )
      .eq('business_id', businessId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`zac cost aggregation read failed: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  }

  async listCostEventsForBusiness(
    businessId: string,
    sinceIso: string,
  ): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('cost_events')
      .select(
        'id, provider, model, task_type, input_tokens, output_tokens, estimated_cost_usd, latency_ms, output_id, conversation_id, created_at',
      )
      .eq('business_id', businessId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`zac cost aggregation read failed: ${error.message}`);
    return (data ?? []) as Record<string, unknown>[];
  }
}
