import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuditLogEntry,
  AuthUser,
  ListAuditLogResponse,
} from '@sheer/domain';
import type { ListAuditLogQueryDto } from './dto';

/**
 * Parameters for a single audit entry. `entityType`/`action` are dotted,
 * human-readable keys (e.g. entity 'booking', action 'booking.cancelled').
 * `before`/`after` capture edit deltas — creates set only `after`, deletes
 * only `before`.
 */
export interface RecordAuditParams {
  action: string;
  entityType: string;
  entityId?: string | null;
  locationId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

interface ActivityLogRow {
  id: string;
  business_id: string;
  location_id: string | null;
  actor_user_profile_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Shared audit-trail writer/reader. Injected into feature services to record
 * mutations, and exposed (owner/manager, `audit.read`) via AuditController.
 *
 * Writes are fail-soft: an audit failure is logged but never blocks or rolls
 * back the primary business action.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Record an audit entry. Never throws — failures are logged and swallowed. */
  async record(actor: Pick<AuthUser, 'id' | 'businessId' | 'primaryRole'>, params: RecordAuditParams): Promise<void> {
    try {
      const { error } = await this.admin
        .schema('audit')
        .from('activity_log')
        .insert({
          business_id: actor.businessId,
          location_id: params.locationId ?? null,
          actor_user_profile_id: actor.id ?? null,
          actor_role: actor.primaryRole ?? null,
          action: params.action,
          entity_type: params.entityType,
          entity_id: params.entityId ?? null,
          before: params.before ?? null,
          after: params.after ?? null,
          metadata: params.metadata ?? {},
        });
      if (error) {
        this.logger.error(`audit record failed (${params.action}): ${error.message}`);
      }
    } catch (err) {
      this.logger.error(`audit record threw (${params.action}): ${(err as Error).message}`);
    }
  }

  /** Read the business audit log (owner/manager). Keyset-paginated, newest first. */
  async list(actor: AuthUser, query: ListAuditLogQueryDto): Promise<ListAuditLogResponse> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    let request = this.admin
      .schema('audit')
      .from('activity_log')
      .select(
        'id,business_id,location_id,actor_user_profile_id,actor_role,action,entity_type,entity_id,before,after,metadata,created_at',
      )
      .eq('business_id', actor.businessId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (query.entityType) request = request.eq('entity_type', query.entityType);
    if (query.action) request = request.eq('action', query.action);
    if (query.actorUserProfileId) request = request.eq('actor_user_profile_id', query.actorUserProfileId);
    if (query.from) request = request.gte('created_at', query.from);
    if (query.to) request = request.lte('created_at', query.to);

    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      request = request.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await request.returns<ActivityLogRow[]>();
    if (error) {
      this.logger.error(`audit list failed: ${error.message}`);
      return { entries: [], nextCursor: null };
    }

    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const [nameByProfileId, nameByLocationId] = await Promise.all([
      this.fetchProfileNames(page.map((r) => r.actor_user_profile_id)),
      this.fetchLocationNames(actor.businessId, page.map((r) => r.location_id)),
    ]);

    const entries: AuditLogEntry[] = page.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      actor: {
        userProfileId: row.actor_user_profile_id,
        role: row.actor_role,
        name: row.actor_user_profile_id ? nameByProfileId.get(row.actor_user_profile_id) ?? null : null,
      },
      locationId: row.location_id,
      locationName: row.location_id ? nameByLocationId.get(row.location_id) ?? null : null,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      before: row.before,
      after: row.after,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
    }));

    const last = page[page.length - 1];
    return {
      entries,
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  private async fetchProfileNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const map = new Map<string, string>();
    if (unique.length === 0) return map;
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,full_name')
      .in('id', unique)
      .returns<{ id: string; full_name: string | null }[]>();
    if (error || !data) return map;
    for (const row of data) map.set(row.id, row.full_name ?? '');
    return map;
  }

  private async fetchLocationNames(
    businessId: string,
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const map = new Map<string, string>();
    if (unique.length === 0) return map;
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name')
      .eq('business_id', businessId)
      .in('id', unique)
      .returns<{ id: string; name: string }[]>();
    if (error || !data) return map;
    for (const row of data) map.set(row.id, row.name);
    return map;
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
