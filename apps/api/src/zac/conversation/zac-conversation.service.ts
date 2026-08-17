import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacCostTelemetryService } from '../measurement/zac-cost-telemetry.service';
import { ZacConversationStore, type ZacTurnMessages } from '../persistence/zac-conversation.store';

/** The per-turn conversation state the orchestrator threads through a request. */
export interface ZacConversationState {
  /** Null when persistence is unavailable and this turn ran stateless (fail-soft). */
  conversationId: string | null;
  /** True on a brand-new conversation, or whenever no prior assistant turn exists. */
  firstAssistantTurn: boolean;
  /** Structural safe summaries of recent turns (oldest first), for continuity. */
  recentSummaries: string[];
  created: boolean;
}

/**
 * Conversation lifecycle for one ZAC turn.
 *
 * Reuse is FAIL-CLOSED: a conversationId that does not belong to the acting
 * user, is from another business, or is not active gets the same 404 as one
 * that never existed. Creation and message writes are FAIL-SOFT: ZAC's answer
 * must never break because storage is down — the turn degrades to stateless,
 * `conversation_id` comes back null, and a loud `persistence_failed` spine
 * event replaces silent loss.
 */
@Injectable()
export class ZacConversationService {
  private readonly logger = new Logger(ZacConversationService.name);

  constructor(
    private readonly store: ZacConversationStore,
    private readonly telemetry: ZacCostTelemetryService,
  ) {}

  async begin(
    context: ZacActingContext,
    requestedConversationId: string | undefined,
    traceId: string,
  ): Promise<ZacConversationState> {
    if (requestedConversationId) {
      // Ownership/scope failures must propagate (fail-closed 404); only treat
      // infrastructure faults as a degradation to stateless.
      let conversation;
      try {
        conversation = await this.store.requireOwnActive(context, requestedConversationId);
      } catch (error) {
        if (error instanceof NotFoundException) throw error;
        return this.degrade(context, traceId, 'reuse', error);
      }
      try {
        const [assistantCount, recentSummaries] = await Promise.all([
          this.store.countAssistantMessages(context.businessId, conversation.id),
          this.store.recentSummaries(context.businessId, conversation.id),
        ]);
        this.telemetry.recordSpineEvent('conversation_reused', {
          trace_id: traceId,
          business_id: context.businessId,
          actor_user_id: context.actorUserId,
          role_context: context.roleContext,
          conversation_id: conversation.id,
        });
        return {
          conversationId: conversation.id,
          firstAssistantTurn: assistantCount === 0,
          recentSummaries,
          created: false,
        };
      } catch (error) {
        // The conversation is verified as the actor's own; losing continuity
        // metadata is not a reason to refuse the turn.
        this.logger.error(
          `zac conversation state load failed: ${(error as Error).message}`,
        );
        return {
          conversationId: conversation.id,
          firstAssistantTurn: false,
          recentSummaries: [],
          created: false,
        };
      }
    }

    try {
      const conversation = await this.store.create(context);
      this.telemetry.recordSpineEvent('conversation_created', {
        trace_id: traceId,
        business_id: context.businessId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        conversation_id: conversation.id,
      });
      return {
        conversationId: conversation.id,
        firstAssistantTurn: true,
        recentSummaries: [],
        created: true,
      };
    } catch (error) {
      return this.degrade(context, traceId, 'create', error);
    }
  }

  /** Persist the turn's safe summaries. Fail-soft with a loud signal. */
  async persistTurn(
    context: ZacActingContext,
    turn: Omit<ZacTurnMessages, 'conversationId'> & { conversationId: string | null },
  ): Promise<void> {
    if (!turn.conversationId) return;
    try {
      await this.store.appendTurn(context, { ...turn, conversationId: turn.conversationId });
      await this.store.touch(context.businessId, turn.conversationId);
    } catch (error) {
      this.logger.error(`zac turn persistence failed: ${(error as Error).message}`);
      this.telemetry.recordSpineEvent('persistence_failed', {
        trace_id: turn.traceId,
        business_id: context.businessId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        operation: 'append_turn',
      });
    }
  }

  private degrade(
    context: ZacActingContext,
    traceId: string,
    operation: 'create' | 'reuse',
    error: unknown,
  ): ZacConversationState {
    this.logger.error(
      `zac conversation ${operation} failed — turn runs stateless: ${(error as Error).message}`,
    );
    this.telemetry.recordSpineEvent('persistence_failed', {
      trace_id: traceId,
      business_id: context.businessId,
      actor_user_id: context.actorUserId,
      role_context: context.roleContext,
      operation: `conversation_${operation}`,
    });
    return { conversationId: null, firstAssistantTurn: true, recentSummaries: [], created: false };
  }
}
