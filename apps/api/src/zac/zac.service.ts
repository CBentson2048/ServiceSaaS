import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
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
   * Week 1 orchestration: rollout → acting context → role profile → visible tool
   * set → stub completion → contract-shaped controlled response. No live tool
   * runs, no salon records are read or written; telemetry carries safe metadata
   * only (never the question or answer text).
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

    const response = this.responseBuilder.buildControlledTestResponse({
      context,
      profile,
      visibleTools,
      completion,
      toolCalls: [],
      traceId,
    });

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
      tool_calls_used: 0,
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
