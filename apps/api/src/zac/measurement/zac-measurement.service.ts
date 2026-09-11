import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacConversationState } from '../conversation/zac-conversation.service';
import { redactForStorage } from '../memory/zac-redaction';
import { ZacMeasurementStore } from '../persistence/zac-measurement.store';
import type { ZacAttributionType } from '../persistence/zac-measurement.types';
import { ZAC_ATTRIBUTION_TYPES } from '../persistence/zac-measurement.types';
import type { ZacRequestMode } from '../routing/zac-request-mode.types';
import type { ZacResponse } from '../responses/zac-response.types';
import type { ZacCostEvent } from './zac-cost-telemetry.service';
import { ZacCostTelemetryService } from './zac-cost-telemetry.service';

/** What one turn's measurement flush persisted (ids for linkage/response). */
export interface ZacTurnMeasurement {
  outputId: string | null;
}

export interface ZacOutcomeRequest {
  outputId: string;
  outcomeType: string;
  summary: string;
  observedValue?: number | null;
  estimatedFinancialValueCents?: number | null;
  confidence?: string | null;
  attributionType?: ZacAttributionType | null;
  evidence?: Record<string, unknown>[];
}

/**
 * The Phase 1 measurement spine, made persistent. One flush per turn writes
 * the output record (when the answer is MEANINGFUL — see isMeaningfulOutput),
 * the tool-call metadata and the buffered model cost events, all correlated by
 * trace_id and conversation_id. Fail-SOFT for the turn flush: the user's
 * answer never breaks because telemetry storage is down — failures log loudly
 * and emit `persistence_failed`. Fail-HARD for feedback and outcomes: those
 * are explicit writes the caller must know succeeded.
 */
@Injectable()
export class ZacMeasurementService {
  private readonly logger = new Logger(ZacMeasurementService.name);

  constructor(
    private readonly store: ZacMeasurementStore,
    private readonly telemetry: ZacCostTelemetryService,
  ) {}

  /**
   * Persist everything one completed turn produced. Output first (its id links
   * the rest), then tool calls, then cost events — each stage fail-soft and
   * individually observable, so a partial failure never silently drops the
   * whole spine.
   */
  async persistTurn(
    context: ZacActingContext,
    conversation: ZacConversationState,
    traceId: string,
    response: ZacResponse,
    costEvents: ZacCostEvent[],
  ): Promise<ZacTurnMeasurement> {
    let outputId: string | null = null;

    if (this.isMeaningfulOutput(response)) {
      try {
        outputId = await this.store.insertOutput({
          businessId: context.businessId,
          locationId: context.locationId,
          actorUserId: context.actorUserId,
          roleContext: context.roleContext,
          // Stylist answers are personal by construction (self-scoped tools,
          // personal coaching) — never business-readable.
          visibilityScope: context.roleContext === 'stylist' ? 'user_private' : 'business_owner',
          responseType: response.response_type,
          requestMode: (response.technical_details.request_mode ?? 'qlooqo_data') as ZacRequestMode,
          title: null,
          // The storage form when a tool disclosed identities, the answer
          // otherwise. redactForStorage has patterns for emails, tokens and
          // digit runs but NONE for names, so a named answer stored here would
          // keep the names verbatim in a table whose read path re-checks no
          // client permission.
          bodyRedacted: redactForStorage(response.answer_storage_form ?? response.answer, 4000),
          evidence: response.evidence,
          limitations: response.limitations,
          confidence: response.confidence,
          conversationId: conversation.conversationId,
          traceId,
        });
        this.telemetry.recordSpineEvent('output_persisted', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          output_id: outputId,
          response_type: response.response_type,
          request_mode: response.technical_details.request_mode ?? null,
        });
      } catch (error) {
        this.persistenceFailed(context, traceId, 'output', error);
      }
    }

    if (response.tool_calls.length > 0) {
      try {
        await this.store.insertToolCalls(
          response.tool_calls.map((trace) => ({
            businessId: context.businessId,
            locationId: context.locationId,
            conversationId: conversation.conversationId,
            actorUserId: context.actorUserId,
            roleContext: context.roleContext,
            toolName: trace.tool,
            argsMeta: {},
            resultStatus: trace.status,
            resultRowCount: trace.row_count,
            latencyMs: trace.latency_ms,
            traceId,
          })),
        );
      } catch (error) {
        this.persistenceFailed(context, traceId, 'tool_calls', error);
      }
    }

    if (costEvents.length > 0) {
      try {
        await this.store.insertCostEvents(costEvents, outputId);
        // Unpriced deployments are visible, not silent: real usage that will
        // persist with a NULL estimate gets an explicit warning event.
        if (
          costEvents.some(
            (event) =>
              event.estimated_cost_usd === 0 && event.input_tokens + event.output_tokens > 0,
          )
        ) {
          this.telemetry.recordSpineEvent('cost_estimate_unavailable', {
            trace_id: traceId,
            business_id: context.businessId,
            actor_user_id: context.actorUserId,
            role_context: context.roleContext,
            reason: 'pricing_not_configured',
          });
        }
      } catch (error) {
        this.persistenceFailed(context, traceId, 'cost_events', error);
      }
    }

    return { outputId };
  }

  /**
   * What counts as a persisted "meaningful output" (the closed rule):
   * - a LIVE business answer — an operational tool (report. / kpi. / schedule.
   *   namespaces) dispatched OK and its answer/narration was served;
   * - a successful ADVISORY answer (general advice or hypothetical reasoning).
   * Everything else is interaction, not output: acknowledgements and
   * conversational follow-ups, refusals/unavailable fallbacks, capability and
   * permission meta-answers, and memory operations (those live in
   * zac.memory_items already).
   */
  private isMeaningfulOutput(response: ZacResponse): boolean {
    if (response.response_type === 'Refusal / Insufficient Data') return false;
    const mode = response.technical_details.request_mode;

    if (mode === 'qlooqo_data') {
      const trace = response.tool_calls[0];
      if (!trace || trace.status !== 'ok') return false;
      // `qlab.` and `inventory.` added for Workstream 3.
      //
      // Without them every colour and stock answer would persist no
      // `zac.outputs` row, return `output_id: null`, and therefore support no
      // feedback and no outcome attribution — making the newest and most
      // demonstrable answers the only unmeasured ones in the system.
      //
      // The alternative considered and rejected was renaming the tools into the
      // `report.*` namespace to slip past this regex. That would break the
      // meaning of the domain segment in `ZacToolName` for the sake of a
      // pattern match, which is worse than widening the pattern.
      //
      // This does not widen what is persisted in kind: the same rule still
      // applies — a successful data answer from a real tool, never a refusal,
      // capability answer or permission explanation.
      return /^(report|kpi|schedule|qlab|inventory)\./.test(trace.tool);
    }
    if (mode === 'general_advice' || mode === 'hypothetical') {
      // Only real advisory answers count — the honest "can't reason right
      // now" fallback is a refusal and is filtered above.
      return response.evidence[0]?.source_ref === `advisory:${mode}`;
    }
    return false;
  }

  /**
   * Record the actor's useful/not-useful vote. Fail-HARD: a rejected write
   * surfaces to the caller — the UI must never claim feedback was saved when
   * it was not. Access is fail-closed 404 (existence-hiding) via the output
   * visibility rules; one active vote per (output, actor), updated in place.
   */
  async submitFeedback(
    context: ZacActingContext,
    outputId: string,
    rating: 'useful' | 'not_useful',
    comment: string | undefined,
    traceId: string,
  ): Promise<{ outputId: string; rating: 'useful' | 'not_useful' }> {
    const output = await this.store.requireAccessibleOutput(context, outputId);

    await this.store.upsertFeedback({
      businessId: context.businessId,
      actorUserId: context.actorUserId,
      roleContext: context.roleContext,
      outputId: output.id,
      rating: rating === 'useful' ? 'up' : 'down',
      commentRedacted: comment ? redactForStorage(comment, 500) : null,
    });

    this.telemetry.recordSpineEvent('feedback_recorded', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      output_id: output.id,
      rating,
    });
    return { outputId: output.id, rating };
  }

  /**
   * Record one EXPLICIT outcome event against an accessible output. Phase 1
   * discipline: attribution is whatever the caller can honestly support —
   * validated against the closed vocabulary, defaulting to null
   * (unattributed). Nothing here infers outcomes, and no code path upgrades
   * attribution; feedback is not an outcome.
   */
  async recordOutcome(
    context: ZacActingContext,
    request: ZacOutcomeRequest,
    traceId: string,
  ): Promise<string> {
    const output = await this.store.requireAccessibleOutput(context, request.outputId);

    const attribution = request.attributionType ?? null;
    if (attribution !== null && !ZAC_ATTRIBUTION_TYPES.includes(attribution)) {
      // A malformed request, not a missing resource.
      throw new BadRequestException('attributionType outside the closed vocabulary');
    }

    const outcomeId = await this.store.insertOutcomeEvent({
      businessId: context.businessId,
      locationId: context.locationId,
      actorUserId: context.actorUserId,
      roleContext: context.roleContext,
      outputId: output.id,
      // The outcome inherits the output's privacy — a stylist-private answer's
      // outcome never becomes owner-readable through the outcome row.
      visibilityScope: output.visibility_scope,
      outcomeType: redactForStorage(request.outcomeType, 60),
      summaryRedacted: redactForStorage(request.summary, 500),
      observedValue: request.observedValue ?? null,
      estimatedFinancialValueCents: request.estimatedFinancialValueCents ?? null,
      confidence: request.confidence ?? null,
      attributionType: attribution,
      evidence: request.evidence ?? [],
    });

    this.telemetry.recordSpineEvent('outcome_recorded', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      output_id: output.id,
      outcome_id: outcomeId,
      attribution_type: attribution,
    });
    return outcomeId;
  }

  private persistenceFailed(
    context: ZacActingContext,
    traceId: string,
    operation: string,
    error: unknown,
  ): void {
    this.logger.error(
      `zac measurement persistence failed (${operation}): ${(error as Error).message}`,
    );
    this.telemetry.recordSpineEvent('persistence_failed', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      operation: `measurement_${operation}`,
    });
  }
}
