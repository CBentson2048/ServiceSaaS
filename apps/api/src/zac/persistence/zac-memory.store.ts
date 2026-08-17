import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ZacRoleContext } from '../context/zac-context.types';
import type { ZacMemoryScope } from '../responses/zac-response.types';
import type { ZacMemoryItem, ZacMemoryKind } from '../memory/zac-memory.types';
import { ZAC_MEMORY_KINDS } from '../memory/zac-memory.types';

interface MemoryRow {
  id: string;
  business_id: string;
  location_id: string | null;
  actor_user_id: string | null;
  role_context: string;
  visibility_scope: string;
  kind: string;
  topic: string;
  content_redacted: string;
  source_conversation_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ZacMemoryInsert {
  businessId: string;
  locationId: string | null;
  actorUserId: string;
  roleContext: ZacRoleContext;
  visibilityScope: ZacMemoryScope;
  kind: ZacMemoryKind;
  topic: string;
  content: string;
  sourceConversationId: string | null;
}

/**
 * Server-owned persistence for zac.memory_items. Every row is business-scoped
 * on write from the verified acting context; visibility semantics (who may
 * RETRIEVE a row) live in ZacMemoryService — this store only guarantees no
 * query ever crosses a business boundary. Content arriving here is already
 * redacted (zac-redaction.ts); this class never logs it.
 */
@Injectable()
export class ZacMemoryStore {
  private readonly logger = new Logger(ZacMemoryStore.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * All ACTIVE memories in one business (visibility filtering happens above).
   * Newest-first with a deliberate Phase 1 bound: memory is explicit-capture
   * only, so a business approaching this many active rows is a product signal,
   * not an expected state — the bound keeps a runaway tenant from unbounded
   * reads while staying far above realistic volume.
   */
  async listActiveForBusiness(businessId: string, limit = 500): Promise<ZacMemoryItem[]> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('memory_items')
      .select(
        'id, business_id, location_id, actor_user_id, role_context, visibility_scope, kind, topic, content_redacted, source_conversation_id, status, created_at, updated_at',
      )
      .eq('business_id', businessId)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`zac memory list failed: ${error.message}`);
    }
    return (data ?? [])
      .map((row) => this.toItem(row as MemoryRow))
      .filter((item): item is ZacMemoryItem => item !== null);
  }

  /** Insert an active memory row; returns the stored item. */
  async insert(memory: ZacMemoryInsert): Promise<ZacMemoryItem> {
    const { data, error } = await this.admin
      .schema('zac')
      .from('memory_items')
      .insert({
        business_id: memory.businessId,
        location_id: memory.locationId,
        actor_user_id: memory.actorUserId,
        role_context: memory.roleContext,
        visibility_scope: memory.visibilityScope,
        kind: memory.kind,
        topic: memory.topic,
        content_redacted: memory.content,
        source: 'zac',
        source_conversation_id: memory.sourceConversationId,
        status: 'active',
      })
      .select(
        'id, business_id, location_id, actor_user_id, role_context, visibility_scope, kind, topic, content_redacted, source_conversation_id, status, created_at, updated_at',
      )
      .single<MemoryRow>();

    if (error || !data) {
      throw new Error(`zac memory insert failed: ${error?.message ?? 'no row returned'}`);
    }
    const item = this.toItem(data);
    if (!item) {
      throw new Error('zac memory insert returned an unrecognised row');
    }
    return item;
  }

  /** Mark superseded rows, linking them to their replacement. */
  async supersede(businessId: string, ids: string[], supersededById: string): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.admin
      .schema('zac')
      .from('memory_items')
      .update({ status: 'superseded', superseded_by_id: supersededById })
      .eq('business_id', businessId)
      .in('id', ids);

    if (error) {
      throw new Error(`zac memory supersede failed: ${error.message}`);
    }
  }

  /**
   * Rows are trusted-shape by construction (only this API writes them), but a
   * defensive parse keeps an unexpected kind/scope from ever entering the
   * retrieval path — an unrecognised row is dropped, not guessed at.
   */
  private toItem(row: MemoryRow): ZacMemoryItem | null {
    if (!ZAC_MEMORY_KINDS.includes(row.kind as ZacMemoryKind)) return null;
    if (
      !['user_private', 'business_owner', 'manager_team_theme', 'stylist_private', 'system_safe_summary'].includes(
        row.visibility_scope,
      )
    ) {
      return null;
    }
    if (!row.actor_user_id) return null;
    return {
      id: row.id,
      businessId: row.business_id,
      locationId: row.location_id,
      actorUserId: row.actor_user_id,
      roleContext: row.role_context as ZacRoleContext,
      visibilityScope: row.visibility_scope as ZacMemoryScope,
      kind: row.kind as ZacMemoryKind,
      topic: row.topic ?? 'general',
      content: row.content_redacted,
      sourceConversationId: row.source_conversation_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
