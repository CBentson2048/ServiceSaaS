import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import type { ZacToolName } from './tools/zac-tool.types';
import { ZacContextService } from './context/zac-context.service';
import { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { ZAC_MODEL_PROVIDER } from './models/zac-model-provider.interface';
import type { ZacModelProvider } from './models/zac-model-provider.interface';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import type { ZacHealthResponse, ZacResponse } from './responses/zac-response.types';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacRolloutService } from './zac-rollout.service';
import type { ZacAskRequestDto } from './dto/zac-ask-request.dto';

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
   * Week 2 orchestration: rollout → acting context → role profile → visible tool
   * set → deterministic intent routing → ONE permission-re-checked tool dispatch
   * → answer-first response. Routing is keyword-based on purpose — no LLM/network
   * call decides anything; telemetry carries safe metadata only (never the
   * question or answer text).
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

    const completion = await this.modelProvider.complete({
      question: request.question,
      roleContext: context.roleContext,
      systemPromptSeed: profile.systemPromptSeed,
      availableToolNames: visibleTools.map((tool) => tool.name),
    });

    let response: ZacResponse;
    if (this.isStaffMembersQuestion(request.question)) {
      // Recognised staff/team/member intent, but no read-only staff tool is
      // connected yet: answer honestly from the service layer without touching
      // any staff service — nothing is dispatched at all.
      response = this.responseBuilder.buildStaffMembersUnavailableResponse({
        context,
        profile,
        visibleTools,
        completion,
        traceId,
      });
    } else {
      const intentTool = this.resolveIntent(request.question) ?? 'context.capabilities';
      const { result, trace } = await this.toolRegistry.dispatch(actor, context, intentTool, {});

      this.telemetry.recordSpineEvent('source_used', {
        trace_id: traceId,
        business_id: context.businessId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        tool: intentTool,
        status: result.status,
        latency_ms: trace.latency_ms,
      });

      // The capability tool is the universal fallback; if even that is denied
      // (unexpected role/permission shape), serve the contract-complete
      // foundation answer rather than a refusal.
      response =
        intentTool === 'context.capabilities' && result.status !== 'ok'
          ? this.responseBuilder.buildControlledTestResponse({
              context,
              profile,
              visibleTools,
              completion,
              toolCalls: [trace],
              traceId,
            })
          : this.responseBuilder.buildToolBackedResponse({
              context,
              profile,
              visibleTools,
              completion,
              result,
              trace,
              traceId,
            });
    }

    this.telemetry.recordCostEvent({
      trace_id: traceId,
      conversation_id: null,
      business_id: context.businessId,
      location_id: context.locationId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      provider: completion.provider,
      model: completion.model,
      task_type: 'qa',
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
      reasoning_tokens: completion.reasoningTokens,
      estimated_cost_usd: completion.estimatedCostUsd,
      latency_ms: Date.now() - startedAt,
      tool_calls_used: response.tool_calls.length,
      cache_hit: false,
    });

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
   * transparent (no LLM). Unmatched questions fall back to the capability
   * summary, which honestly says what ZAC can and cannot answer today.
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
    if (
      /how('s| is| are)?\s+(my|the|our)\s+(business|salon)|business health|\bdoing\b|performing|revenue|\bbookings?\b|rebooking/.test(
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
