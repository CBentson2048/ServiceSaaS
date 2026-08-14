import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from './context/zac-context.types';
import type {
  ZacModelCompletion,
  ZacModelRequest,
} from './models/zac-model-provider.interface';
import type { ZacRoleProfile } from './roles/zac-role-profile.types';
import type { ZacReadOnlyTool, ZacToolName, ZacToolResult } from './tools/zac-tool.types';
import { ZacContextService } from './context/zac-context.service';
import { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import {
  ZAC_MODEL_PROVIDER,
  ZacModelIncompleteError,
  ZacModelRefusedError,
} from './models/zac-model-provider.interface';
import type { ZacModelEvidencePack } from './models/zac-model-provider.interface';
import type { ZacModelProvider } from './models/zac-model-provider.interface';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import type { ZacHealthResponse, ZacResponse } from './responses/zac-response.types';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacRolloutService } from './zac-rollout.service';
import type { ZacAskRequestDto } from './dto/zac-ask-request.dto';

/** What one narration attempt produced. `liveCompletion` is set ONLY when a real model call succeeded. */
interface ZacNarration {
  completion: ZacModelCompletion;
  liveCompletion: ZacModelCompletion | null;
  narratedAnswer: string | null;
}

@Injectable()
export class ZacService {
  constructor(
    private readonly rollout: ZacRolloutService,
    private readonly contextService: ZacContextService,
    private readonly roleProfiles: ZacRoleProfileService,
    private readonly toolRegistry: ZacToolRegistryService,
    private readonly responseBuilder: ZacResponseBuilderService,
    private readonly telemetry: ZacCostTelemetryService,
    @Inject(ZAC_MODEL_PROVIDER) private readonly modelProvider: ZacModelProvider,
  ) {}

  /**
   * Week 3 orchestration: rollout → acting context → role profile → visible tool
   * set → deterministic intent routing → ONE permission-re-checked tool dispatch
   * → live narration of the tool's verified figures (when a narrating provider
   * is bound) → answer-first response. Routing stays keyword-based on purpose —
   * the model narrates evidence AFTER dispatch, it never decides routing or
   * computes numbers. Telemetry carries safe metadata only (never the question
   * or answer text); cost events fire once per real model call, and any
   * provider failure degrades to the deterministic tool-backed answer.
   */
  async ask(actor: AuthUser, request: ZacAskRequestDto): Promise<ZacResponse> {
    const startedAt = Date.now();
    this.rollout.assertRolloutFor(actor);

    const context = this.contextService.resolve(actor, request);
    const profile = this.roleProfiles.selectFor(context.roleContext);
    const visibleTools = this.toolRegistry.buildFor(actor);
    const traceId = randomUUID();

    this.telemetry.recordSpineEvent('question_asked', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      request_source: context.requestSource,
      question_length: request.question.length,
    });

    const modelRequest: ZacModelRequest = {
      question: request.question,
      roleContext: context.roleContext,
      systemPromptSeed: profile.systemPromptSeed,
      availableToolNames: visibleTools.map((tool) => tool.name),
    };

    let response: ZacResponse;
    let liveCompletion: ZacModelCompletion | null = null;

    const resolvedIntent =
      context.roleContext === 'stylist' ? null : this.resolveIntent(request.question);

    if (context.roleContext === 'stylist') {
      ({ response, liveCompletion } = await this.answerAsStylist(
        actor,
        context,
        profile,
        visibleTools,
        modelRequest,
        request.question,
        traceId,
      ));
    } else if (resolvedIntent === null && this.isStaffMembersQuestion(request.question)) {
      // Staff/team/member questions with no matching performance intent (staff
      // LISTS — "who works here", "team members"): no read-only staff-list tool
      // is connected, so answer honestly from the service layer — nothing is
      // dispatched and no model is called. Performance-shaped staff questions
      // ("top performer", "below target") resolve to live tools above instead.
      response = this.responseBuilder.buildStaffMembersUnavailableResponse({
        context,
        profile,
        visibleTools,
        completion: this.noModelCompletion(),
        traceId,
      });
    } else {
      const intentTool = resolvedIntent ?? 'context.capabilities';
      const { result, trace } = await this.toolRegistry.dispatch(
        actor,
        context,
        intentTool,
        intentTool === 'report.kpi_summary'
          ? { period: this.parsePeriod(request.question) }
          : {},
      );

      this.telemetry.recordSpineEvent('source_used', {
        trace_id: traceId,
        business_id: context.businessId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        tool: intentTool,
        status: result.status,
        latency_ms: trace.latency_ms,
      });

      if (intentTool === 'context.capabilities' && result.status !== 'ok') {
        // The capability tool is the universal fallback; if even that is denied
        // (unexpected role/permission shape), serve the contract-complete
        // foundation answer rather than a refusal.
        response = this.responseBuilder.buildControlledTestResponse({
          context,
          profile,
          visibleTools,
          completion: this.noModelCompletion(),
          toolCalls: [trace],
          traceId,
        });
      } else {
        const narration = await this.narrate(modelRequest, result, intentTool, context, traceId);
        liveCompletion = narration.liveCompletion;
        response = narration.narratedAnswer
          ? this.responseBuilder.buildNarratedResponse({
              context,
              profile,
              visibleTools,
              completion: narration.completion,
              result,
              trace,
              traceId,
              narratedAnswer: narration.narratedAnswer,
            })
          : this.responseBuilder.buildToolBackedResponse({
              context,
              profile,
              visibleTools,
              completion: narration.completion,
              result,
              trace,
              traceId,
            });
      }
    }

    // One cost event per REAL model call (the ZacCostEvent contract) — none
    // when routing answered deterministically or the provider call failed.
    if (liveCompletion) {
      this.telemetry.recordCostEvent({
        trace_id: traceId,
        conversation_id: null,
        business_id: context.businessId,
        location_id: context.locationId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        provider: liveCompletion.provider,
        model: liveCompletion.model,
        task_type: 'qa',
        input_tokens: liveCompletion.inputTokens,
        output_tokens: liveCompletion.outputTokens,
        reasoning_tokens: liveCompletion.reasoningTokens,
        estimated_cost_usd: liveCompletion.estimatedCostUsd,
        latency_ms: Date.now() - startedAt,
        tool_calls_used: response.tool_calls.length,
        cache_hit: liveCompletion.cacheReadInputTokens > 0,
      });
    }

    this.telemetry.recordSpineEvent('answer_delivered', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      response_type: response.response_type,
      latency_ms: Date.now() - startedAt,
    });

    return response;
  }

  /**
   * One live model call, made AFTER the tool dispatch so the model narrates
   * verified figures instead of imagining them. Skipped entirely when the tool
   * produced no presentation, the bound provider does not narrate (the stub),
   * or the tool is a context.* catalog whose deterministic copy reads well
   * as-is (narrating the fallback would price every unmatched question).
   * Deterministic fallback on ANY provider failure — refusal, timeout, rate
   * limit, truncation, ungrounded figures — so ZAC degrades to exactly the
   * answer it gave before a live provider existed. Cost events fire for every
   * call that returned usage (truncated calls billed too, and ride their
   * completion on the error); a transport failure reports no usage, so none.
   */
  private async narrate(
    modelRequest: ZacModelRequest,
    result: ZacToolResult,
    toolName: ZacToolName,
    context: ZacActingContext,
    traceId: string,
  ): Promise<ZacNarration> {
    const presentation = result.status === 'ok' ? result.presentation : undefined;
    if (!presentation || !this.modelProvider.narrates || !this.shouldNarrate(toolName)) {
      return { completion: this.noModelCompletion(), liveCompletion: null, narratedAnswer: null };
    }

    const evidencePack: ZacModelEvidencePack = {
      toolName,
      toolAnswer: presentation.answer,
      evidence: presentation.evidence,
      limitations: presentation.limitations,
    };

    try {
      const completion = await this.modelProvider.complete({ ...modelRequest, evidencePack });
      const trimmed = completion.text.trim();

      if (trimmed.length === 0) {
        return { completion, liveCompletion: completion, narratedAnswer: null };
      }
      // Invariant 1 is structural, not prompt-trusted: every number in the
      // narration must exist in the evidence pack. A hallucinated, recomputed
      // or injection-steered figure falls back to the deterministic answer.
      if (!this.isGroundedNarration(trimmed, evidencePack)) {
        this.recordModelFallback(context, traceId, toolName, 'ungrounded');
        return { completion, liveCompletion: completion, narratedAnswer: null };
      }
      return { completion, liveCompletion: completion, narratedAnswer: trimmed };
    } catch (error) {
      if (error instanceof ZacModelIncompleteError) {
        // Truncated narration: unusable text, but the call billed — keep the
        // real usage on the response and in the cost event.
        this.recordModelFallback(context, traceId, toolName, 'truncated');
        return { completion: error.completion, liveCompletion: error.completion, narratedAnswer: null };
      }
      this.recordModelFallback(
        context,
        traceId,
        toolName,
        error instanceof ZacModelRefusedError ? 'refusal' : 'unavailable',
      );
      return { completion: this.noModelCompletion(), liveCompletion: null, narratedAnswer: null };
    }
  }

  private recordModelFallback(
    context: ZacActingContext,
    traceId: string,
    toolName: ZacToolName,
    reason: 'refusal' | 'unavailable' | 'truncated' | 'ungrounded',
  ): void {
    this.telemetry.recordSpineEvent('model_fallback', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      tool: toolName,
      reason,
    });
  }

  /** context.* catalogs (capabilities, scope summaries) stay deterministic. */
  private shouldNarrate(tool: ZacToolName): boolean {
    return !tool.startsWith('context.');
  }

  /**
   * Every numeric token in the narration must appear (value-equal after
   * normalisation, so £1,250 matches £1250.00) somewhere in the evidence pack.
   * Conservative by design: a legitimate number the model invents ("3 areas to
   * watch") costs only a fallback to the deterministic answer, while a
   * fabricated figure served under the evidence banner would be a lie.
   */
  private isGroundedNarration(narration: string, pack: ZacModelEvidencePack): boolean {
    const allowedSources = [
      pack.toolAnswer,
      ...pack.limitations,
      ...pack.evidence.map((item) => `${item.source_ref} ${item.as_of ?? ''}`),
    ].join(' ');
    const allowed = new Set(this.extractNumericValues(allowedSources));
    return this.extractNumericValues(narration).every((value) => allowed.has(value));
  }

  /** Normalised numeric values in a text: '£1,250.00' → '1250', '39%' → '39'. */
  private extractNumericValues(text: string): string[] {
    return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((token) =>
      String(Number(token.replace(/,/g, ''))),
    );
  }

  /**
   * Completion metadata for turns where no model ran. Carries the CONFIGURED
   * provider identity (so technical_details truthfully reports what is wired)
   * with zero tokens and zero cost — and never triggers a cost event.
   */
  private noModelCompletion(): ZacModelCompletion {
    return {
      text: '',
      provider: this.modelProvider.name,
      model: this.modelProvider.model,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  /**
   * Stylist turns never enter the owner/manager router. Three outcomes only:
   * a stylist-personal intent (own schedule/coaching/performance — honest
   * "not connected yet"), a restricted intent (business/pay/team/client asks —
   * plain access-boundary refusal), or the stylist-tailored capability summary.
   * Restricted and personal intents dispatch NOTHING; the capability path
   * dispatches only `context.capabilities`, which the registry re-checks. Even
   * a routing bug here cannot reach business data: every business tool's
   * `allowedRoles` excludes stylists, and dispatch re-checks that.
   */
  private async answerAsStylist(
    actor: AuthUser,
    context: ZacActingContext,
    profile: ZacRoleProfile,
    visibleTools: ZacReadOnlyTool[],
    modelRequest: ZacModelRequest,
    question: string,
    traceId: string,
  ): Promise<{ response: ZacResponse; liveCompletion: ZacModelCompletion | null }> {
    const q = question.toLowerCase();

    // Own-work intents first: self markers beat topic keywords, so "how can I
    // improve MY rebooking" reads as personal, not restricted.
    const isPersonal =
      /\bmy (day|week|appointments?|schedule|diary|rebooking|retail|performance|kpis?|numbers?|goals?|targets?)\b|what should i focus|how (can|do|should) i improve|how am i (doing|performing)|\bam i on track\b|\bappointments? (do|have) i\b|\b(do|have) i (have|got)\b.*(appointment|booking|client)|scheduled appointment/.test(
        q,
      );
    // Owner/manager territory: business-wide, money, team, other stylists, clients.
    const isRestricted =
      /\b(payroll|salar(y|ies)|wages?|commissions?|\bpay\b)\b|\b(team|staff|colleagues?|members?|employees?)\b|other stylists?|which stylist|\bstylists\b|\bclients?\b|business (revenue|health|reports?|performance)|\b(revenue|profit|turnover|takings|sales)\b|\b(owner|manager) (report|dashboard)s?\b|whole business|how('s| is) the (business|salon)|\bstock\b|\binventory\b|\bqlab\b/.test(
        q,
      );

    if (isPersonal && !this.isCapabilityQuestion(q)) {
      // Schedule-shaped vs coaching-shaped: appointments/diary go to the
      // self-scoped schedule tool; focus/improve/performance go to coaching.
      const isSchedule =
        /\b(appointments?|schedule|diary|booked|bookings?)\b|\bmy (day|week)\b/.test(q) &&
        !/focus|improve|performing|coach|rebook/.test(q);
      const toolName: ZacToolName = isSchedule ? 'schedule.my_appointments' : 'kpi.personal_coaching';
      const input: Record<string, unknown> = isSchedule
        ? { horizon: /tomorrow/.test(q) ? 'today_tomorrow' : 'today' }
        : { period: /month/.test(q) ? 'month' : /today\b/.test(q) && !/week/.test(q) ? 'today' : 'week' };

      const { result, trace } = await this.toolRegistry.dispatch(actor, context, toolName, input);
      this.telemetry.recordSpineEvent('source_used', {
        trace_id: traceId,
        business_id: context.businessId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        tool: toolName,
        status: result.status,
        latency_ms: trace.latency_ms,
      });

      if (result.status === 'ok') {
        const narration = await this.narrate(modelRequest, result, toolName, context, traceId);
        const response = narration.narratedAnswer
          ? this.responseBuilder.buildNarratedResponse({
              context,
              profile,
              visibleTools,
              completion: narration.completion,
              result,
              trace,
              traceId,
              narratedAnswer: narration.narratedAnswer,
            })
          : this.responseBuilder.buildToolBackedResponse({
              context,
              profile,
              visibleTools,
              completion: narration.completion,
              result,
              trace,
              traceId,
            });
        return { response, liveCompletion: narration.liveCompletion };
      }
      // Degrade honestly: denied/unavailable/failed personal tools fall back to
      // the "not connected" personal answer, never an error.
      return {
        response: this.responseBuilder.buildStylistPersonalUnavailableResponse({
          context,
          profile,
          visibleTools,
          completion: this.noModelCompletion(),
          traceId,
        }),
        liveCompletion: null,
      };
    }

    if (isRestricted && !this.isCapabilityQuestion(q)) {
      this.telemetry.recordSpineEvent('source_used', {
        trace_id: traceId,
        business_id: context.businessId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        tool: 'stylist.restricted',
        status: 'permission_denied',
        latency_ms: 0,
      });
      return {
        response: this.responseBuilder.buildStylistRestrictedResponse({
          context,
          profile,
          visibleTools,
          completion: this.noModelCompletion(),
          traceId,
        }),
        liveCompletion: null,
      };
    }

    // Capability question, or anything unmatched: the stylist-tailored
    // capability summary is the honest default.
    const { result, trace } = await this.toolRegistry.dispatch(
      actor,
      context,
      'context.capabilities',
      {},
    );
    this.telemetry.recordSpineEvent('source_used', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      tool: 'context.capabilities',
      status: result.status,
      latency_ms: trace.latency_ms,
    });
    // context.capabilities is never narrated (shouldNarrate) — no model call.
    return {
      response:
        result.status === 'ok'
          ? this.responseBuilder.buildToolBackedResponse({
              context,
              profile,
              visibleTools,
              completion: this.noModelCompletion(),
              result,
              trace,
              traceId,
            })
          : this.responseBuilder.buildControlledTestResponse({
              context,
              profile,
              visibleTools,
              completion: this.noModelCompletion(),
              toolCalls: [trace],
              traceId,
            }),
      liveCompletion: null,
    };
  }

  private isCapabilityQuestion(q: string): boolean {
    return /what can (you|zac|i ask)|help me with|what do you do|what can you do|capabilit|what information can you access/.test(
      q,
    );
  }

  /**
   * Staff/team/member questions are recognised BEFORE tool routing so they get
   * an honest "not connected yet" answer instead of the generic capability
   * fallback. No staff tool exists to dispatch — the stylist/KPI skeletons stay
   * disabled — so this intent never reaches any staff, performance or payroll
   * service.
   */
  private isStaffMembersQuestion(question: string): boolean {
    const q = question.toLowerCase();
    return /\b(staff|team|employees?|stylists?|colleagues?)\b|\bmembers?\b|who works|\busers? (in|at|of)\b/.test(
      q,
    );
  }

  /**
   * Deterministic keyword intent routing — deliberately conservative and
   * transparent (no LLM). Order matters: staff-performance and rebooking
   * intents are matched BEFORE business health, whose broad pattern would
   * otherwise swallow them; staff LIST questions match nothing here and fall
   * through to the honest staff-not-connected refusal. Unmatched questions
   * fall back to the capability summary.
   */
  private resolveIntent(question: string): ZacToolName | null {
    const q = question.toLowerCase();
    if (
      /what can (you|zac|i ask)|help me with|what do you do|what can you do|capabilit/.test(q)
    ) {
      return 'context.capabilities';
    }
    if (/(which|what) business|business context|my (scope|role|access)|what (can|do) i see/.test(q)) {
      return 'context.business_summary';
    }
    // Staff PERFORMANCE (ranking/rating) — requires a staff noun AND a
    // performance word, so "how is my business performing" stays business
    // health and "staff list" stays the honest refusal.
    if (
      /\b(stylists?|team|staff|members?|colleagues?|performers?)\b/.test(q) &&
      /\b(top|best|highest|leading|rated|ranking|ranked|star)\b|perform/.test(q)
    ) {
      return 'report.stylist_performance';
    }
    // Staff KPI/target standing — below/behind/missing a target or threshold,
    // or explicit KPI asks about the team.
    if (
      /\b(stylists?|team|staff|members?|colleagues?|who)\b/.test(q) &&
      /\bkpis?\b|(below|behind|under|missing|miss(es)?|not (meeting|hitting))\b.*\b(target|threshold|goal)s?\b|\btargets? (missed|not met)\b/.test(
        q,
      )
    ) {
      return 'report.kpi_summary';
    }
    if (/rebook/.test(q)) {
      return 'report.rebooking_summary';
    }
    if (
      /how('s| is| are)?\s+(my|the|our)\s+(business|salon)|business health|\bdoing\b|performing|revenue|\bbookings?\b/.test(
        q,
      )
    ) {
      return 'report.business_health';
    }
    if (/\blocations?\b/.test(q)) {
      return 'context.location_summary';
    }
    return null;
  }

  /** Period words in the question → KPI engine period; the week is the default. */
  private parsePeriod(question: string): 'today' | 'week' | 'month' {
    const q = question.toLowerCase();
    if (/\bmonth\b/.test(q)) return 'month';
    if (/\btoday\b/.test(q) && !/\bweek\b/.test(q)) return 'today';
    return 'week';
  }

  /** Operational check: reachable + which provider would answer. Makes no model call. */
  health(actor: AuthUser): ZacHealthResponse {
    this.rollout.assertRolloutFor(actor);
    return {
      enabled: true,
      provider: this.modelProvider.name,
      model: this.modelProvider.model,
      ok: true,
    };
  }
}
