import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ZacActingContext } from '../context/zac-context.types';

/** A zac.conversations row as the API reads it. */
export interface ZacConversationRecord {
  id: string;
  business_id: string;
  location_id: string | null;
  actor_user_id: string | null;
  role_context: string;
  status: string;
}

export interface ZacTurnMessages {
  conversationId: string;
  traceId: string;
  /** Structural safe summary of the user turn — intent metadata, never free text. */
  userSummary: string;
  /** Structural safe summary of the assistant turn. */
  assistantSummary: string;
  responseType: string;
  model: string | null;
  outputTokens: number | null;
}

/**
 * Server-owned persistence for ZAC conversations and message events. Follows
 * the platform convention (private service-role client, per-query `.schema()`);
 * the `zac` schema is reachable only when it is on PostgREST's Exposed Schemas
 * list (see docs/ZAC/phase-1-storage-apply-and-verification-runbook.md).
 *
 * Tenancy/ownership is enforced HERE, in code, against the guard-verified
 * acting context — exactly like every other service in the API. Browsers and
 * mobile clients never touch these tables: forced RLS + read-only grants make
 * the service role the only writer.
 *
 * Data minimisation (D32): content_redacted stores structural intent summaries
 * only ("Asked about business health (week)") — never the user's words and
 * never the assistant's prose.
 */
@Injectable()
export class ZacConversationStore {
  private readonly logger = new Logger(ZacConversationStore.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Load a conversation for reuse, fail-closed. The SAME 404 covers "does not
   * exist", "belongs to someone else", "belongs to another business" and
   * "not active" — an attacker probing ids learns nothing, and the caller's
   * identity comes from the verified acting context, never the request body.
   */
  async requireOwnActive(
    context: Pick<ZacActingContext, 'actorUserId' | 'businessId'>,
    conversationId: string,
  ): Promise<ZacConversationRecord> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('conversations')
      .select('id, business_id, location_id, actor_user_id, role_context, status')
      .eq('id', conversationId)
      .eq('business_id', context.businessId)
      .eq('actor_user_id', context.actorUserId)
      .eq('status', 'active')
      .maybeSingle<ZacConversationRecord>();

    if (error) {
      // Infrastructure failure ≠ ownership failure — surface it distinctly so a
      // misconfigured schema (PGRST106) is not mistaken for a stolen id.
      this.logger.error(`zac conversation lookup failed: ${error.message}`);
      throw new Error(`zac conversation lookup failed: ${error.message}`);
    }
    if (!data) {
      throw new NotFoundException();
    }
    return data;
  }

  /** Create a conversation for the acting user. Scope comes from the context only. */
  async create(context: ZacActingContext): Promise<ZacConversationRecord> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('conversations')
      .insert({
        business_id: context.businessId,
        location_id: context.locationId,
        actor_user_id: context.actorUserId,
        role_context: context.roleContext,
        visibility_scope: 'user_private',
        status: 'active',
      })
      .select('id, business_id, location_id, actor_user_id, role_context, status')
      .single<ZacConversationRecord>();

    if (error || !data) {
      throw new Error(`zac conversation create failed: ${error?.message ?? 'no row returned'}`);
    }
    return data;
  }

  /** Assistant-message count so far — 0 means the next answer is the first turn. */
  async countAssistantMessages(businessId: string, conversationId: string): Promise<number> {
    const { count, error } = await this.admin
      .schema('zac')
      .from('messages')
      .select('id', { count: 'exact', head: true })
      // business_id is defence in depth: the conversation id is already
      // ownership-verified, but no query in this store crosses a tenant.
      .eq('business_id', businessId)
      .eq('conversation_id', conversationId)
      .eq('role', 'assistant');

    if (error) {
      throw new Error(`zac message count failed: ${error.message}`);
    }
    return count ?? 0;
  }

  /** Most recent safe summaries (oldest first), for continuity context. */
  async recentSummaries(businessId: string, conversationId: string, limit = 6): Promise<string[]> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('messages')
      .select('content_redacted, role, created_at')
      .eq('business_id', businessId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`zac recent messages failed: ${error.message}`);
    }
    return (data ?? [])
      .reverse()
      .map((row) => (row as { content_redacted: string | null }).content_redacted)
      .filter((content): content is string => Boolean(content));
  }

  /** Persist one turn (user + assistant safe summaries) in a single insert. */
  async appendTurn(context: ZacActingContext, turn: ZacTurnMessages): Promise<void> {
    const { error } = await this.admin
      .schema('zac')
      .from('messages')
      .insert([
        {
          business_id: context.businessId,
          conversation_id: turn.conversationId,
          actor_user_id: context.actorUserId,
          role: 'user',
          content_redacted: turn.userSummary,
          trace_id: turn.traceId,
        },
        {
          business_id: context.businessId,
          conversation_id: turn.conversationId,
          actor_user_id: null,
          role: 'assistant',
          content_redacted: turn.assistantSummary,
          response_type: turn.responseType,
          token_count: turn.outputTokens,
          model: turn.model,
          trace_id: turn.traceId,
        },
      ]);

    if (error) {
      throw new Error(`zac message write failed: ${error.message}`);
    }
  }

  /** Touch updated_at so conversation recency reflects the latest turn. */
  async touch(businessId: string, conversationId: string): Promise<void> {
    const { error } = await this.admin
      .schema('zac')
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('id', conversationId);

    if (error) {
      throw new Error(`zac conversation touch failed: ${error.message}`);
    }
  }
}
