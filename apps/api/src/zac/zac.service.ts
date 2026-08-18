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
import { ZacConversationService } from './conversation/zac-conversation.service';
import type { ZacConversationState } from './conversation/zac-conversation.service';
import { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import type { ZacCostEvent } from './measurement/zac-cost-telemetry.service';
import { ZacMeasurementService } from './measurement/zac-measurement.service';
import { ZacMemoryExtractionService } from './memory/zac-memory-extraction.service';
import { ZacMemoryService } from './memory/zac-memory.service';
import { containsForbiddenMemoryContent } from './memory/zac-redaction';
import { ZacRequestModeClassifierService } from './routing/zac-request-mode-classifier.service';
import type {
  ZacRequestClassification,
  ZacRequestMode,
} from './routing/zac-request-mode.types';
import {
  ZAC_MODEL_PROVIDER,
  ZacModelIncompleteError,
  ZacModelRefusedError,
} from './models/zac-model-provider.interface';
import type { ZacModelEvidencePack } from './models/zac-model-provider.interface';
import type { ZacModelProvider } from './models/zac-model-provider.interface';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import type {
  ZacFeedbackResponse,
  ZacHealthResponse,
  ZacResponse,
} from './responses/zac-response.types';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacRolloutService } from './zac-rollout.service';
import type { ZacAskRequestDto } from './dto/zac-ask-request.dto';
import type { ZacFeedbackRequestDto } from './dto/zac-feedback-request.dto';

/**
 * What one narration attempt produced. `liveCompletion` is set whenever the
 * call BILLED (success, truncation, refusal-with-usage); `latencyMs` measures
 * the model call itself, not the turn.
 */
interface ZacNarration {
  completion: ZacModelCompletion;
  liveCompletion: ZacModelCompletion | null;
  narratedAnswer: string | null;
  latencyMs: number;
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
    private readonly conversations: ZacConversationService,
    private readonly memoryExtraction: ZacMemoryExtractionService,
    private readonly memory: ZacMemoryService,
    private readonly requestModes: ZacRequestModeClassifierService,
    private readonly measurement: ZacMeasurementService,
    @Inject(ZAC_MODEL_PROVIDER) private readonly modelProvider: ZacModelProvider,
  ) {}

  /**
   * Orchestration: rollout → acting context → resolve/create conversation
   * (fail-closed on foreign ids, fail-soft on storage faults) → role profile →
   * visible tool set → memory command/recall paths OR deterministic intent
   * routing → ONE permission-re-checked tool dispatch → live narration of the
   * tool's verified figures with relevant memory as clearly-labelled
   * user-stated context → answer-first response → safe turn persistence
   * (structural summaries only, never free text). Routing stays keyword-based
   * on purpose — the model narrates evidence AFTER dispatch, it never decides
   * routing or computes numbers. Telemetry carries safe metadata only (never
   * the question, answer or memory text); cost events fire once per real model
   * call, and any provider failure degrades to the deterministic tool-backed
   * answer.
   */
  async ask(actor: AuthUser, request: ZacAskRequestDto): Promise<ZacResponse> {
    const startedAt = Date.now();
    this.rollout.assertRolloutFor(actor);

    const baseContext = this.contextService.resolve(actor, request);
    const traceId = randomUUID();
    // Fail-closed 404 for a conversation the actor may not use; fail-soft
    // (stateless turn, conversation_id null) when storage is down.
    const conversation = await this.conversations.begin(
      baseContext,
      request.conversationId,
      traceId,
    );
    const context: ZacActingContext = {
      ...baseContext,
      firstAssistantTurn: conversation.firstAssistantTurn,
    };
    const profile = this.roleProfiles.selectFor(context.roleContext);
    const visibleTools = this.toolRegistry.buildFor(actor);

    this.telemetry.recordSpineEvent('question_asked', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      request_source: context.requestSource,
      question_length: request.question.length,
      conversation_id: conversation.conversationId,
    });

    // Every real model call this turn (narration, classification, truncated
    // calls that still billed) collects here and flushes to zac.cost_events
    // at the end of the turn, linked to the persisted output.
    const costEvents: ZacCostEvent[] = [];

    const response = await this.answer(
      actor,
      context,
      profile,
      visibleTools,
      conversation,
      request,
      traceId,
      startedAt,
      costEvents,
    );

    // Structural summaries only (D32): intents and response types, never the
    // user's words and never the assistant's prose.
    await this.conversations.persistTurn(context, {
      conversationId: conversation.conversationId,
      traceId,
      userSummary: this.describeUserTurn(request.question, response),
      assistantSummary: this.describeAssistantTurn(response),
      responseType: response.response_type,
      model: response.cost_metadata.output_tokens > 0 ? response.cost_metadata.model : null,
      outputTokens:
        response.cost_metadata.output_tokens > 0 ? response.cost_metadata.output_tokens : null,
    });

    // Measurement spine (fail-soft): output record, tool-call metadata and
    // cost events, all correlated by trace_id/conversation_id.
    const measurement = await this.measurement.persistTurn(
      context,
      conversation,
      traceId,
      response,
      costEvents,
    );

    this.telemetry.recordSpineEvent('answer_delivered', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      response_type: response.response_type,
      latency_ms: Date.now() - startedAt,
      conversation_id: conversation.conversationId,
    });

    return { ...response, output_id: measurement.outputId };
  }

  /** Route one question to the memory paths or the tool/narration pipeline. */
  private async answer(
    actor: AuthUser,
    context: ZacActingContext,
    profile: ZacRoleProfile,
    visibleTools: ZacReadOnlyTool[],
    conversation: ZacConversationState,
    request: ZacAskRequestDto,
    traceId: string,
    startedAt: number,
    costEvents: ZacCostEvent[],
  ): Promise<ZacResponse> {
    const question = request.question;
    const memoryBase = {
      context,
      profile,
      visibleTools,
      completion: this.noModelCompletion(),
      traceId,
      conversationId: conversation.conversationId,
    };

    // 1. Explicit remember-commands: capture (or refuse) BEFORE any routing, so
    //    a stylist's "remember I struggle with client rebooking" is a private
    //    coaching capture — not a restricted-topic refusal.
    const command = this.memoryExtraction.detectCommand(question, context.roleContext);
    if (command) {
      const memoryMode: ZacRequestClassification = {
        mode: 'memory',
        source: 'deterministic',
        dataInstruction: null,
      };
      if (containsForbiddenMemoryContent(question)) {
        this.telemetry.recordSpineEvent('memory_declined', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          reason: 'sensitive_content',
        });
        return this.withMode(this.responseBuilder.buildMemoryDeclinedResponse(memoryBase), memoryMode);
      }
      try {
        const captured = await this.memory.capture(
          context,
          command,
          conversation.conversationId,
          traceId,
        );
        return this.withMode(
          this.responseBuilder.buildMemoryStoredResponse({
            ...memoryBase,
            item: captured.item,
            supersededCount: captured.supersededCount,
          }),
          memoryMode,
        );
      } catch {
        // Never claim a memory was stored when it was not.
        this.telemetry.recordSpineEvent('memory_declined', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          reason: 'store_unavailable',
        });
        return this.withMode(this.responseBuilder.buildMemoryUnavailableResponse(memoryBase), memoryMode);
      }
    }

    // 2. Request-mode classification: deterministic layers first (memory
    //    recall, explicit data instructions, permission questions, hypothetical
    //    and general framing, conversational follow-ups, own-data anchors); the
    //    model may break ties for genuinely ambiguous questions, validated
    //    against the closed enum; the fail-safe default is the full data
    //    pipeline, which is exactly the pre-mode behaviour. The mode decides
    //    HOW the question is answered — it can never grant data access, because
    //    every tool dispatch re-checks role + permissions regardless.
    const classification = await this.classifyRequest(
      question,
      context,
      conversation,
      traceId,
      costEvents,
    );

    if (classification.mode === 'memory') {
      const recallSubject = this.memoryExtraction.detectRecallSubject(question) ?? 'about_me';
      let response: ZacResponse;
      try {
        const items = await this.memory.recall(context, recallSubject, traceId);
        response = this.responseBuilder.buildMemoryRecallResponse({
          ...memoryBase,
          subject: recallSubject,
          items,
        });
      } catch {
        // "Can't check" is not "nothing saved" — a read failure must never be
        // presented as an empty memory.
        this.telemetry.recordSpineEvent('persistence_failed', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          operation: 'memory_recall',
        });
        response = this.responseBuilder.buildMemoryRecallResponse({
          ...memoryBase,
          subject: recallSubject,
          items: [],
          storageUnavailable: true,
        });
      }
      return this.withMode(response, classification);
    }

    if (classification.mode === 'permission_capability') {
      // Descriptive only, computed from THIS request's effective permissions —
      // never from the role name, and never granting anything.
      return this.withMode(
        this.responseBuilder.buildPermissionExplanationResponse({
          ...memoryBase,
          gapTools: this.toolRegistry.permissionGapsFor(actor),
        }),
        classification,
      );
    }

    if (
      classification.mode === 'general_advice' ||
      classification.mode === 'hypothetical' ||
      classification.mode === 'conversational'
    ) {
      return this.withMode(
        await this.answerAdvisory(
          context,
          profile,
          visibleTools,
          conversation,
          question,
          classification.mode,
          traceId,
          costEvents,
        ),
        classification,
      );
    }

    // 3. qlooqo_data: the full permission-aware pipeline. Relevant memory
    //    (fail-soft) rides into narration as user-stated context; conversation
    //    state suppresses reintroduction.
    const relevantMemory = await this.memory.retrieveRelevant(context, question, traceId);
    const modelRequest: ZacModelRequest = {
      question,
      roleContext: context.roleContext,
      systemPromptSeed: profile.systemPromptSeed,
      availableToolNames: visibleTools.map((tool) => tool.name),
      memoryContext: relevantMemory.map((item) => ({ kind: item.kind, summary: item.content })),
      conversationState: {
        firstAssistantTurn: conversation.firstAssistantTurn,
        recentTurnSummaries: conversation.recentSummaries,
      },
    };

    let response: ZacResponse;
    let liveCompletion: ZacModelCompletion | null = null;
    let liveLatencyMs = 0;

    const resolvedIntent =
      context.roleContext === 'stylist' ? null : this.resolveIntent(question);

    if (context.roleContext === 'stylist') {
      ({ response, liveCompletion, liveLatencyMs } = await this.answerAsStylist(
        actor,
        context,
        profile,
        visibleTools,
        conversation,
        modelRequest,
        question,
        traceId,
      ));
    } else if (resolvedIntent === null && this.isStaffMembersQuestion(question)) {
      // Staff/team/member questions with no matching performance intent (staff
      // LISTS — "who works here", "team members"): no read-only staff-list tool
      // is connected, so answer honestly from the service layer — nothing is
      // dispatched and no model is called. Performance-shaped staff questions
      // ("top performer", "below target") resolve to live tools above instead.
      response = this.responseBuilder.buildStaffMembersUnavailableResponse(memoryBase);
    } else {
      const intentTool = resolvedIntent ?? 'context.capabilities';
      const { result, trace } = await this.toolRegistry.dispatch(
        actor,
        context,
        intentTool,
        this.toolInput(intentTool, question),
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
          conversationId: conversation.conversationId,
        });
      } else {
        const narration = await this.narrate(modelRequest, result, intentTool, context, traceId);
        liveCompletion = narration.liveCompletion;
        liveLatencyMs = narration.latencyMs;
        const toolBackedInput = {
          context,
          profile,
          visibleTools,
          completion: narration.completion,
          result,
          trace,
          traceId,
          conversationId: conversation.conversationId,
        };
        response = narration.narratedAnswer
          ? this.responseBuilder.buildNarratedResponse({
              ...toolBackedInput,
              narratedAnswer: narration.narratedAnswer,
            })
          : this.responseBuilder.buildToolBackedResponse(toolBackedInput);
      }
    }

    // One cost event per REAL model call (the ZacCostEvent contract) — none
    // when routing answered deterministically or the provider call failed
    // without known usage.
    if (liveCompletion) {
      this.recordQaCostEvent(
        context,
        conversation,
        liveCompletion,
        response.tool_calls.length,
        liveLatencyMs,
        traceId,
        costEvents,
      );
    }

    return this.withMode(response, classification);
  }

  /** Stamp the decided mode into technical_details — one place for every path. */
  private withMode(response: ZacResponse, classification: ZacRequestClassification): ZacResponse {
    return {
      ...response,
      technical_details: {
        ...response.technical_details,
        request_mode: classification.mode,
        classification_source: classification.source,
      },
    };
  }

  /**
   * Decide the request mode. Deterministic layers rule; the model may break a
   * genuine tie into the CLOSED enum only (anything else — including invented
   * modes — degrades to the qlooqo_data default, which is the pre-mode
   * pipeline and therefore behaviour-preserving). Classification never touches
   * authorisation: it selects a handler, and the handlers re-check permissions.
   */
  private async classifyRequest(
    question: string,
    context: ZacActingContext,
    conversation: ZacConversationState,
    traceId: string,
    costEvents: ZacCostEvent[],
  ): Promise<ZacRequestClassification> {
    let classification =
      this.requestModes.classify(question, context.roleContext) ?? null;

    if (!classification && this.modelProvider.classifyMode) {
      const classifyStartedAt = Date.now();
      const result = await this.modelProvider
        .classifyMode(question, context.roleContext)
        .catch(() => ({ mode: null, completion: null }));
      if (result.completion) {
        const event: ZacCostEvent = {
          trace_id: traceId,
          conversation_id: conversation.conversationId,
          business_id: context.businessId,
          location_id: context.locationId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          provider: result.completion.provider,
          model: result.completion.model,
          task_type: 'classification',
          input_tokens: result.completion.inputTokens,
          output_tokens: result.completion.outputTokens,
          reasoning_tokens: result.completion.reasoningTokens,
          estimated_cost_usd: result.completion.estimatedCostUsd,
          latency_ms: Date.now() - classifyStartedAt,
          tool_calls_used: 0,
          cache_hit: result.completion.cacheReadInputTokens > 0,
        };
        this.telemetry.recordCostEvent(event);
        costEvents.push(event);
      }
      if (ZacRequestModeClassifierService.isValidMode(result.mode)) {
        classification = { mode: result.mode, source: 'model', dataInstruction: null };
      }
    }

    if (!classification) {
      classification = { mode: 'qlooqo_data', source: 'fallback', dataInstruction: null };
    }

    this.telemetry.recordSpineEvent('request_classified', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      request_mode: classification.mode,
      classification_source: classification.source,
      explicit_data_instruction: classification.dataInstruction,
      conversation_id: conversation.conversationId,
    });
    return classification;
  }

  /**
   * Advisory modes: general advice, hypothetical reasoning, conversational
   * follow-ups. STRUCTURALLY tool-free — this method has no dispatch path, so
   * no prompt phrasing can reach business data through it. One model call
   * without an evidence pack; the model reasons from the question, the
   * conversation summaries and the actor's own visible memory. A narration
   * that presents any number as the user's live figure is rejected (the
   * live-claim guard) and the honest deterministic fallback serves instead.
   */
  private async answerAdvisory(
    context: ZacActingContext,
    profile: ZacRoleProfile,
    visibleTools: ZacReadOnlyTool[],
    conversation: ZacConversationState,
    question: string,
    mode: Extract<ZacRequestMode, 'general_advice' | 'hypothetical' | 'conversational'>,
    traceId: string,
    costEvents: ZacCostEvent[],
  ): Promise<ZacResponse> {
    const base = {
      context,
      profile,
      visibleTools,
      completion: this.noModelCompletion(),
      traceId,
      conversationId: conversation.conversationId,
    };

    // Bare acknowledgements deserve a warm reply, not a model bill.
    if (mode === 'conversational' && this.requestModes.isPureAcknowledgement(question)) {
      return this.responseBuilder.buildAcknowledgementResponse(base);
    }

    if (!this.modelProvider.narrates) {
      return this.responseBuilder.buildAdvisoryUnavailableResponse({ ...base, mode });
    }

    const relevantMemory = await this.memory.retrieveRelevant(context, question, traceId);
    const modelRequest: ZacModelRequest = {
      question,
      roleContext: context.roleContext,
      systemPromptSeed: profile.systemPromptSeed,
      availableToolNames: visibleTools.map((tool) => tool.name),
      memoryContext: relevantMemory.map((item) => ({ kind: item.kind, summary: item.content })),
      conversationState: {
        firstAssistantTurn: conversation.firstAssistantTurn,
        recentTurnSummaries: conversation.recentSummaries,
      },
      mode,
    };

    const callStartedAt = Date.now();
    try {
      const completion = await this.modelProvider.complete(modelRequest);
      const latencyMs = Date.now() - callStartedAt;
      const trimmed = completion.text.trim();
      this.recordQaCostEvent(context, conversation, completion, 0, latencyMs, traceId, costEvents);

      if (trimmed.length === 0) {
        // The call billed even though the text is unusable — keep honest usage.
        return this.responseBuilder.buildAdvisoryUnavailableResponse({ ...base, completion, mode });
      }
      if (!this.isAdvisoryAnswerSafe(trimmed)) {
        this.recordModelFallback(context, traceId, 'zac.advisory', 'live_claim');
        return this.responseBuilder.buildAdvisoryUnavailableResponse({ ...base, completion, mode });
      }
      return this.responseBuilder.buildAdvisoryResponse({
        ...base,
        completion,
        mode,
        narratedAnswer: trimmed,
      });
    } catch (error) {
      const latencyMs = Date.now() - callStartedAt;
      if (error instanceof ZacModelIncompleteError) {
        // Truncated: unusable text, but the call billed.
        this.recordQaCostEvent(context, conversation, error.completion, 0, latencyMs, traceId, costEvents);
        this.recordModelFallback(context, traceId, 'zac.advisory', 'truncated');
        return this.responseBuilder.buildAdvisoryUnavailableResponse({
          ...base,
          completion: error.completion,
          mode,
        });
      }
      if (error instanceof ZacModelRefusedError) {
        // Refusals bill too when usage is known — keep the cost on the spine.
        if (error.completion) {
          this.recordQaCostEvent(context, conversation, error.completion, 0, latencyMs, traceId, costEvents);
        }
        this.recordModelFallback(context, traceId, 'zac.advisory', 'refusal');
        return this.responseBuilder.buildAdvisoryUnavailableResponse({
          ...base,
          completion: error.completion ?? base.completion,
          mode,
        });
      }
      this.recordModelFallback(context, traceId, 'zac.advisory', 'unavailable');
      return this.responseBuilder.buildAdvisoryUnavailableResponse({ ...base, mode });
    }
  }

  /**
   * The live-claim guard for tool-free answers. Advisory modes have no
   * evidence banner to protect, so derived arithmetic ("a 10-point gap") is
   * legal — but a clause presenting a figure as the user's CURRENT, REAL
   * business measurement is a lie by construction (no data was read) and is
   * rejected structurally. Clause-scoped (newlines split too, so a bullet
   * list never merges with its heading), claims bind to measurement nouns and
   * verbs (harmless "your current process" phrasing passes), and spelled-out
   * numbers count as figures.
   */
  private isAdvisoryAnswerSafe(narration: string): boolean {
    // Measurement nouns only — process/approach/setup wording is harmless
    // ("improve your current booking process"), so bare 'booking' is excluded;
    // claimed rates/figures are still caught via 'rate'/'figure'/'number'.
    const metricNoun =
      '(?:rebooking|retail|revenue|sales?|takings?|turnover|utili[sz]ation|conversion|no.?show|retention|average bill|rate|figure|number|kpi|performance)';
    const liveClaim = new RegExp(
      [
        // "your current rebooking rate ..." — a claimed live metric.
        `\\byour (?:current|actual|live|real|latest)\\s+(?:[\\w-]+\\s+){0,2}${metricNoun}`,
        // "your rebooking rate is/sits at ..." — present-tense measurement.
        `\\byour\\s+(?:[\\w-]+\\s+){0,2}${metricNoun}s?\\s+(?:is|are|sits? at|stands? at|averages?)\\b`,
        // "currently achieving/at ..." and "your salon takes/makes ..."
        '\\bcurrently (?:at|achieving|running|sitting|doing|taking|averaging)\\b',
        '\\byour (?:business|salon) (?:is (?:at|doing|taking|running)|takes|makes|earns|does|gets|averages)\\b',
        '\\baccording to (?:your|the) (?:data|figures|numbers|qlooqo)\\b',
        '\\byour qlooqo\\b',
      ].join('|'),
      'i',
    );
    const figure =
      /\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i;

    for (const clause of narration.split(/[.!?…\n]+/)) {
      if (figure.test(clause) && liveClaim.test(clause)) return false;
    }
    return true;
  }

  /**
   * Shared QA cost-event shape — one per real model call, on every path.
   * Logged immediately AND buffered into the turn's sink for persistence.
   * `latencyMs` is the MODEL CALL's own duration, not the turn's.
   */
  private recordQaCostEvent(
    context: ZacActingContext,
    conversation: ZacConversationState,
    completion: ZacModelCompletion,
    toolCallsUsed: number,
    latencyMs: number,
    traceId: string,
    costEvents: ZacCostEvent[],
  ): void {
    const event: ZacCostEvent = {
      trace_id: traceId,
      conversation_id: conversation.conversationId,
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
      latency_ms: latencyMs,
      tool_calls_used: toolCallsUsed,
      cache_hit: completion.cacheReadInputTokens > 0,
    };
    this.telemetry.recordCostEvent(event);
    costEvents.push(event);
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
      return {
        completion: this.noModelCompletion(),
        liveCompletion: null,
        narratedAnswer: null,
        latencyMs: 0,
      };
    }

    const evidencePack: ZacModelEvidencePack = {
      toolName,
      toolAnswer: presentation.answer,
      evidence: presentation.evidence,
      limitations: presentation.limitations,
    };

    const callStartedAt = Date.now();
    try {
      const completion = await this.modelProvider.complete({ ...modelRequest, evidencePack });
      const latencyMs = Date.now() - callStartedAt;
      const trimmed = completion.text.trim();

      if (trimmed.length === 0) {
        return { completion, liveCompletion: completion, narratedAnswer: null, latencyMs };
      }
      // Invariant 1 is structural, not prompt-trusted: every number in the
      // narration must exist in the evidence pack — or in the user-stated
      // memory block, which the prompt requires to be attributed as the
      // user's own goal, never as a live figure. A hallucinated, recomputed
      // or injection-steered figure falls back to the deterministic answer.
      if (!this.isGroundedNarration(trimmed, evidencePack, modelRequest)) {
        this.recordModelFallback(context, traceId, toolName, 'ungrounded');
        return { completion, liveCompletion: completion, narratedAnswer: null, latencyMs };
      }
      return { completion, liveCompletion: completion, narratedAnswer: trimmed, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - callStartedAt;
      if (error instanceof ZacModelIncompleteError) {
        // Truncated narration: unusable text, but the call billed — keep the
        // real usage on the response and in the cost event.
        this.recordModelFallback(context, traceId, toolName, 'truncated');
        return {
          completion: error.completion,
          liveCompletion: error.completion,
          narratedAnswer: null,
          latencyMs,
        };
      }
      if (error instanceof ZacModelRefusedError) {
        // A refusal is still a billed call when usage is known — keep it on
        // the spine; the deterministic answer serves regardless.
        this.recordModelFallback(context, traceId, toolName, 'refusal');
        return {
          completion: error.completion ?? this.noModelCompletion(),
          liveCompletion: error.completion ?? null,
          narratedAnswer: null,
          latencyMs,
        };
      }
      this.recordModelFallback(context, traceId, toolName, 'unavailable');
      return {
        completion: this.noModelCompletion(),
        liveCompletion: null,
        narratedAnswer: null,
        latencyMs,
      };
    }
  }

  private recordModelFallback(
    context: ZacActingContext,
    traceId: string,
    toolName: ZacToolName | 'zac.advisory',
    reason: 'refusal' | 'unavailable' | 'truncated' | 'ungrounded' | 'live_claim',
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
   * normalisation, so £1,250 matches £1250.00) somewhere in the evidence pack —
   * or come from the user-stated memory context, in which case the SENTENCE
   * carrying it must read as an attribution ("your stated goal of 60%"), never
   * as a measurement. That attribution check is structural, not prompt-trusted:
   * a narration that presents a remembered number as a live figure falls back
   * to the deterministic answer, exactly like a hallucinated one.
   * Conservative by design: a legitimate number the model invents ("3 areas to
   * watch") costs only a fallback, while a fabricated figure served under the
   * evidence banner would be a lie.
   */
  private isGroundedNarration(
    narration: string,
    pack: ZacModelEvidencePack,
    modelRequest: ZacModelRequest,
  ): boolean {
    const evidenceSources = [
      pack.toolAnswer,
      ...pack.limitations,
      ...pack.evidence.map((item) => `${item.source_ref} ${item.as_of ?? ''}`),
    ].join(' ');
    const evidenceAllowed = new Set(this.extractNumericValues(evidenceSources));
    const memoryAllowed = new Set(
      this.extractNumericValues(
        (modelRequest.memoryContext ?? []).map((item) => item.summary).join(' '),
      ),
    );
    const attributionShaped =
      /\b(goal|target|aim|priorit|focus|stated|you (said|told|asked|want|wanted|mentioned)|you'?re aiming)\b/i;

    for (const sentence of narration.split(/(?<=[.!?…])\s+/)) {
      for (const value of this.extractNumericValues(sentence)) {
        if (evidenceAllowed.has(value)) continue;
        if (memoryAllowed.has(value) && attributionShaped.test(sentence)) continue;
        return false;
      }
    }
    return true;
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
   * a stylist-personal intent (own schedule/coaching/performance), a restricted
   * intent (business/pay/team/client asks — plain access-boundary refusal), or
   * the stylist-tailored capability summary. Restricted and personal intents
   * dispatch NOTHING beyond their own self-scoped tools; the capability path
   * dispatches only `context.capabilities`, which the registry re-checks. Even
   * a routing bug here cannot reach business data: every business tool's
   * `allowedRoles` excludes stylists, and dispatch re-checks that.
   */
  private async answerAsStylist(
    actor: AuthUser,
    context: ZacActingContext,
    profile: ZacRoleProfile,
    visibleTools: ZacReadOnlyTool[],
    conversation: ZacConversationState,
    modelRequest: ZacModelRequest,
    question: string,
    traceId: string,
  ): Promise<{
    response: ZacResponse;
    liveCompletion: ZacModelCompletion | null;
    liveLatencyMs: number;
  }> {
    const q = question.toLowerCase();
    const memoryBase = {
      context,
      profile,
      visibleTools,
      completion: this.noModelCompletion(),
      traceId,
      conversationId: conversation.conversationId,
    };

    // Own-work intents first: self markers beat topic keywords, so "how can I
    // improve MY rebooking" reads as personal, not restricted.
    const isPersonal =
      /\bmy (day|week|appointments?|schedule|diary|rebooking|retail|performance|utili[sz]ation|kpis?|numbers?|goals?|targets?)\b|what should i focus|how (can|do|should) i improve|\bhow can i improve\b|how am i (doing|performing)|\bwhat am i doing well\b|\bhighest.impact\b|\bbiggest impact\b|\bam i on track\b|\bappointments? (do|have) i\b|\b(do|have) i (have|got)\b.*(appointment|booking|client)|scheduled appointment/.test(
        q,
      );
    // Owner/manager territory: business-wide, money, team, other stylists, clients.
    const isRestricted =
      /\b(payroll|salar(y|ies)|wages?|commissions?|\bpay\b)\b|\b(team|staff|colleagues?|members?|employees?)\b|other stylists?|which stylist|\bstylists\b|\bclients?\b|business (revenue|health|reports?|performance)|\b(revenue|profit|turnover|takings|sales)\b|\b(owner|manager) (report|dashboard)s?\b|whole business|how('s| is) the (business|salon)|\bstock\b|\binventory\b|\bqlab\b|\butili[sz]/.test(
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
        const toolBackedInput = {
          context,
          profile,
          visibleTools,
          completion: narration.completion,
          result,
          trace,
          traceId,
          conversationId: conversation.conversationId,
        };
        const response = narration.narratedAnswer
          ? this.responseBuilder.buildNarratedResponse({
              ...toolBackedInput,
              narratedAnswer: narration.narratedAnswer,
            })
          : this.responseBuilder.buildToolBackedResponse(toolBackedInput);
        return { response, liveCompletion: narration.liveCompletion, liveLatencyMs: narration.latencyMs };
      }
      // Degrade honestly: denied/unavailable/failed personal tools fall back to
      // the "not connected" personal answer, never an error.
      return {
        response: this.responseBuilder.buildStylistPersonalUnavailableResponse(memoryBase),
        liveCompletion: null,
        liveLatencyMs: 0,
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
        response: this.responseBuilder.buildStylistRestrictedResponse(memoryBase),
        liveCompletion: null,
        liveLatencyMs: 0,
      };
    }

    // Capability question, or anything unmatched: the stylist-tailored
    // capability summary is the honest default.
    const { result, trace } = await this.toolRegistry.dispatch(
      actor,
      context,
      'context.capabilities',
      this.toolInput('context.capabilities', question),
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
              conversationId: conversation.conversationId,
            })
          : this.responseBuilder.buildControlledTestResponse({
              context,
              profile,
              visibleTools,
              completion: this.noModelCompletion(),
              toolCalls: [trace],
              traceId,
              conversationId: conversation.conversationId,
            }),
      liveCompletion: null,
      liveLatencyMs: 0,
    };
  }

  private isCapabilityQuestion(q: string): boolean {
    return /what can (you|zac|i ask)|help me with|what do you do|what can you do|capabilit|what information can you access|who are you\b/.test(
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
      /what can (you|zac|i ask)|help me with|what do you do|what can you do|capabilit|who are you\b/.test(q)
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
    // explicit KPI asks about the team, or the official "which team members
    // need my attention" acceptance phrasing (answerable from KPI standing —
    // no staff-list tool needed).
    if (
      /\b(stylists?|team|staff|members?|colleagues?|who)\b/.test(q) &&
      (/\bkpis?\b|(below|behind|under|missing|miss(es)?|not (meeting|hitting))\b.*\b(target|threshold|goal)s?\b|\btargets? (missed|not met)\b/.test(
        q,
      ) ||
        /\bneeds? (my |our )?attention\b|\bworr(y|ied) about\b|\bstruggling\b/.test(q))
    ) {
      return 'report.kpi_summary';
    }
    // Utilisation and diary-gap questions — before business health, whose
    // broad "doing" pattern would otherwise swallow them. The quiet/slow-day
    // forms yield to an explicit OTHER subject ("rebooking has been slow this
    // week" is a rebooking question, not a diary question).
    const otherSubject = /\b(rebook\w*|revenue|sales|retail|takings|turnover|profit)\b/.test(q);
    const dayWord = '(day|days|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
    const quietWord = '(quiet|quietest|empty|dead|slow|slowest|busiest)';
    if (
      /\butili[sz]/.test(q) ||
      (!otherSubject &&
        (new RegExp(`\\b${quietWord}\\b[^.?!]*\\b${dayWord}s?\\b`).test(q) ||
          new RegExp(`\\b${dayWord}s?\\b[^.?!]*\\b${quietWord}\\b`).test(q) ||
          /\bhow (full|busy) (is|was|are) (my|the|our) (diary|calendar|week|day|salon)\b/.test(q))) ||
      /\bdiary gaps?\b|\bgaps? in (the|my|our) (diary|calendar|schedule)\b|\bunbooked\b/.test(q) ||
      /\b(where are|show me|any) (the )?gaps?\b|\bgaps? (today|tomorrow|this week|next week)\b/.test(q)
    ) {
      return 'report.utilisation_summary';
    }
    if (/rebook/.test(q)) {
      return 'report.rebooking_summary';
    }
    if (
      /how('s| is| are)?\s+(my|the|our)\s+(business|salon)|business health|\bhow healthy\b|\bdoing\b|performing|revenue|\bbookings?\b/.test(
        q,
      ) ||
      // Official Owner acceptance phrasings: money worries, attention and
      // where-to-focus questions get the KPI-grounded health snapshot.
      /\blos(e|ing) money\b|\bneeds? (my |our )?attention\b|\bwhat should (i|we) focus\b|\bfocus on (first|today)\b|\bone hour\b[^.?!]*\bfocus\b/.test(
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

  /** Per-tool dispatch input, derived from the question — never from a model. */
  private toolInput(tool: ZacToolName, question: string): Record<string, unknown> {
    if (tool === 'report.kpi_summary' || tool === 'report.utilisation_summary') {
      return { period: this.parsePeriod(question) };
    }
    if (tool === 'context.capabilities' && /who are you\b/i.test(question)) {
      // Identity IS the answer here — introduce ZAC even mid-conversation.
      return { introduceIdentity: true };
    }
    return {};
  }

  /** Period words in the question → KPI engine period; the week is the default. */
  private parsePeriod(question: string): 'today' | 'week' | 'month' {
    const q = question.toLowerCase();
    if (/\bmonth\b/.test(q)) return 'month';
    if (/\btoday\b/.test(q) && !/\bweek\b/.test(q)) return 'today';
    return 'week';
  }

  /** Structural safe summary of the user turn — intent metadata, never words. */
  private describeUserTurn(question: string, response: ZacResponse): string {
    const intent = response.technical_details.detected_intent;
    if (intent === 'memory.capture') return 'Asked ZAC to remember something.';
    if (intent === 'memory.recall') return 'Asked what ZAC remembers.';
    if (intent === 'memory.declined') return 'Asked ZAC to remember something (declined).';
    const tool = response.tool_calls[0]?.tool;
    if (tool) return `Asked a question routed to ${tool}.`;
    if (intent) return `Asked a question recognised as ${intent}.`;
    const mode = response.technical_details.request_mode;
    if (mode === 'general_advice') return 'Asked for general advice (no data read).';
    if (mode === 'hypothetical') return 'Asked a hypothetical question (no data read).';
    if (mode === 'conversational') return 'Sent a conversational follow-up.';
    if (mode === 'permission_capability') return 'Asked about their access and permissions.';
    return `Asked a question (${Math.min(question.length, 2000)} chars).`;
  }

  /** Structural safe summary of the assistant turn. */
  private describeAssistantTurn(response: ZacResponse): string {
    const tool = response.tool_calls[0]?.tool;
    const narrated = response.technical_details.foundation_mode === false;
    return [
      response.response_type,
      tool ? `via ${tool}` : null,
      narrated ? '(narrated)' : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Useful/not-useful feedback on a persisted output. Fail-HARD by design:
   * errors reach the controller so the client never sees a false success.
   * Access is the output-visibility model (fail-closed 404), re-evaluated
   * against the CURRENT acting context — never a role name.
   */
  async submitFeedback(
    actor: AuthUser,
    outputId: string,
    request: ZacFeedbackRequestDto,
  ): Promise<ZacFeedbackResponse> {
    this.rollout.assertRolloutFor(actor);
    const context = this.contextService.resolve(actor, {});
    const result = await this.measurement.submitFeedback(
      context,
      outputId,
      request.rating,
      request.comment,
      randomUUID(),
    );
    return { output_id: result.outputId, rating: result.rating, recorded: true };
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
