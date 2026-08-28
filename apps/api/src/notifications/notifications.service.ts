import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  NOTIFICATION_PRIORITIES,
  NotificationPriority,
  type AuthUser,
  type CreateNotificationInput,
  type CreateNotificationResult,
  type ListNotificationsResponse,
  type MarkAllNotificationsReadResponse,
  type MarkNotificationResponse,
  type NotificationDto,
  type UnreadCountResponse,
  userHasJoinedSalon,
} from '@sheer/domain';
import type { ListNotificationsQueryDto } from './dto';
import {
  NOTIFICATION_COUNT_COLUMNS,
  NOTIFICATION_FEED_COLUMNS,
  buildPagination,
  isKnownNotificationType,
  pageRange,
  toNotificationDto,
  type NotificationFeedRow,
} from './notification-mapping';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/** Ceiling on recipients in a single create call — a fan-out larger than this is a bug. */
const MAX_RECIPIENTS = 500;

/**
 * Recipient ids per membership-validation query.
 *
 * PostgREST truncates any response at max_rows = 1000 (supabase/config.toml), and
 * core.user_memberships is unique on (business_id, location_id, user_profile_id) —
 * so ONE user legitimately has several rows in a multi-location salon (manager at
 * one site, stylist at another). Validating 500 ids in a single `.in()` could
 * therefore return more than 1000 rows and be silently cut off, which would make
 * genuine members look like non-members and fail the whole notification with
 * "recipients do not belong to this business". 200 ids keeps the worst case far
 * under the cap and keeps the URL comfortably short. Mirrors the batching in
 * client-intelligence.service.ts, which hit exactly this hazard first.
 */
const RECIPIENT_VALIDATION_BATCH = 200;

interface CreateNotificationRpcRow {
  notification_id: string | null;
  recipient_count: number | string;
  requested_count: number | string;
  deduplicated: boolean;
}

interface MembershipRow {
  user_profile_id: string;
}

/**
 * The reusable in-app notification service.
 *
 * ONE foundation, many producers. Arrival alerts consume it today; booking changes,
 * reminders, low-stock, order approvals and later ZAC insights are meant to consume
 * the SAME service rather than inventing their own storage, read state or device
 * logic. That is the whole point of the ticket — see the class-level contract below.
 *
 * ---------------------------------------------------------------------------
 * FAILURE ISOLATION
 * ---------------------------------------------------------------------------
 * Notifications are operational support, NOT a dependency of diary/till/client
 * operation. Producers therefore call {@link createSafe}, which never throws: a
 * check-in that succeeds must stay succeeded even if the notification insert, the
 * database or this whole module is broken. {@link create} (which does throw) exists
 * for callers that genuinely want the error — currently only tests and any future
 * admin surface where a failed notification is the user's problem to see.
 *
 * There is deliberately no attempt to make notification creation atomic with the
 * originating business write: PostgREST has no multi-statement transaction, every
 * appointment status change in this codebase already commits before its side
 * effects run, and forcing atomicity would mean a notification failure could roll
 * back a check-in. Idempotency (`dedupeKey`) is what makes at-least-once emission
 * safe instead.
 *
 * ---------------------------------------------------------------------------
 * TENANCY
 * ---------------------------------------------------------------------------
 * This service uses the service-role key, which BYPASSES RLS. Tenant and recipient
 * isolation on every read/write here is therefore the explicit
 * `.eq('business_id', …)` + `.eq('user_profile_id', actor.id)` filters below — the
 * RLS in migration 0099 is defence-in-depth for direct PostgREST access, not the
 * mechanism protecting these queries. Every query in this file must carry both.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // -------------------------------------------------------------------------
  // Creation (producer-facing)
  // -------------------------------------------------------------------------

  /**
   * Best-effort creation hook for business flows. NEVER throws.
   *
   * This is the method producers call. A notification failure must degrade
   * notification functionality only — never the booking, till or client operation
   * that triggered it.
   */
  async createSafe(input: CreateNotificationInput): Promise<CreateNotificationResult | null> {
    try {
      return await this.create(input);
    } catch (err) {
      this.logger.error(
        `create notification failed (type=${input.type} business=${input.businessId} ` +
          `dedupeKey=${input.dedupeKey ?? 'none'}): ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Create one notification and fan it out to its recipients, atomically.
   *
   * Recipients are validated HERE for a clear error, and again inside
   * comms.create_notification for correctness: a membership can be revoked between
   * the two, and the database is the only place that check can be race-free.
   *
   * Throws when the caller got it wrong (unknown type, empty recipient list, a user
   * who is not a member of this business at all). Does NOT throw when a recipient is
   * merely ineligible right now — an inactive or out-of-location user is dropped and
   * logged, because a stylist going on leave must not start breaking check-ins.
   */
  async create(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    this.assertValidInput(input);

    const requested = [...new Set(input.recipientUserProfileIds)];
    await this.assertRecipientsBelongToBusiness(input.businessId, requested);

    const { data, error } = await this.admin.schema('comms').rpc('create_notification', {
      p_business_id: input.businessId,
      p_type: input.type,
      p_title: input.title,
      p_body: input.body,
      p_recipient_user_profile_ids: requested,
      p_location_id: input.locationId ?? null,
      p_priority: input.priority ?? NotificationPriority.Normal,
      p_entity_type: input.entityType ?? null,
      p_entity_id: input.entityId ?? null,
      p_action_path: input.actionPath ?? null,
      p_metadata: input.metadata ?? {},
      p_dedupe_key: input.dedupeKey ?? null,
      p_created_by_user_profile_id: input.createdByUserProfileId ?? null,
      p_expires_at: input.expiresAt ?? null,
    });

    if (error) {
      this.logger.error(`create_notification rpc failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to create notification');
    }

    // The function is RETURNS TABLE, so PostgREST delivers a one-row array.
    const row = (Array.isArray(data) ? data[0] : data) as CreateNotificationRpcRow | undefined;
    if (!row) {
      throw new InternalServerErrorException('Unable to create notification');
    }

    const result: CreateNotificationResult = {
      notificationId: row.notification_id,
      recipientCount: Number(row.recipient_count ?? 0),
      requestedCount: Number(row.requested_count ?? requested.length),
      deduplicated: Boolean(row.deduplicated),
    };

    if (!result.notificationId) {
      // Everyone requested was ineligible at write time. Nothing was written — say
      // so loudly, because a producer silently notifying nobody is a real defect
      // that would otherwise only surface as "the stylist never gets alerts".
      this.logger.warn(
        `notification type=${input.type} business=${input.businessId} reached NO eligible ` +
          `recipients (requested ${result.requestedCount})`,
      );
    } else if (!result.deduplicated && result.recipientCount < result.requestedCount) {
      this.logger.warn(
        `notification ${result.notificationId} (type=${input.type}) reached ` +
          `${result.recipientCount} of ${result.requestedCount} requested recipients — ` +
          'the rest were inactive, revoked or out of location scope',
      );
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Reads — always the acting user, never a supplied id
  // -------------------------------------------------------------------------

  /**
   * The acting user's feed, newest first.
   *
   * Recipient-scoped by construction: the query filters on `actor.id`, so there is
   * no request shape — and no role, including owner — that can widen it to another
   * user's notifications.
   *
   * Two round trips at most (the page plus its exact count, in one call), never one
   * query per notification: title, body and routing context are all persisted on the
   * notification row, so rendering a list needs no appointment or client lookup.
   */
  async list(
    actor: AuthUser,
    query: ListNotificationsQueryDto,
  ): Promise<ListNotificationsResponse> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    // A customer who has registered but not yet joined any salon carries
    // businessId '' (see userHasJoinedSalon). Querying with it would send an empty
    // string where PostgREST expects a uuid and 500 the request; the honest answer
    // is that they have no notifications, so say so instead of erroring.
    if (!userHasJoinedSalon(actor)) {
      return {
        notifications: [],
        pagination: buildPagination(page, pageSize, 0),
        unreadCount: 0,
      };
    }

    const { from, to } = pageRange(page, pageSize);

    let builder = this.admin
      .schema('comms')
      .from('notification_recipients')
      .select(NOTIFICATION_FEED_COLUMNS, { count: 'exact' })
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId);

    if (query.unreadOnly) {
      builder = builder.is('read_at', null);
    }

    const { data, error, count } = await this.applyUnexpiredFilter(builder)
      .order('created_at', { ascending: false })
      // Ties on created_at (a fan-out writes every recipient row with the same
      // timestamp) would otherwise page non-deterministically and could repeat or
      // skip a row across pages.
      .order('id', { ascending: false })
      .range(from, to)
      .returns<NotificationFeedRow[]>();

    if (error) {
      // Asking for a page past the end of the feed is a normal thing for a client to
      // do — a deep link, a bookmark, or a refresh after notifications were read and
      // filtered out. Because `count: 'exact'` tells PostgREST the total, it can
      // answer an out-of-range offset with 416 / PGRST103 rather than an empty list,
      // and turning that into a 500 would break the bell for an ordinary navigation.
      // Answer it the way an empty page should be answered, with the real total.
      if (error.code === 'PGRST103') {
        const total = await this.countMatching(actor, Boolean(query.unreadOnly));
        return {
          notifications: [],
          pagination: buildPagination(page, pageSize, total),
          unreadCount: await this.countUnread(actor),
        };
      }
      this.logger.error(`list notifications failed for user ${actor.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to load notifications');
    }

    const notifications = (data ?? [])
      .map((row) => toNotificationDto(row))
      .filter((dto): dto is NotificationDto => dto !== null);

    return {
      notifications,
      pagination: buildPagination(page, pageSize, count ?? notifications.length),
      unreadCount: await this.countUnread(actor),
    };
  }

  async unreadCount(actor: AuthUser): Promise<UnreadCountResponse> {
    return { unreadCount: await this.countUnread(actor) };
  }

  // -------------------------------------------------------------------------
  // Read-state transitions — only ever the acting user's own recipient row
  // -------------------------------------------------------------------------

  /**
   * Mark read. Writes ONLY the acting user's recipient row, so a notification sent
   * to the Owner and the Manager stays unread for the Manager after the Owner reads
   * it. Idempotent: re-reading keeps the original timestamp rather than moving it.
   */
  async markRead(actor: AuthUser, notificationId: string): Promise<MarkNotificationResponse> {
    return this.setReadState(actor, notificationId, new Date().toISOString());
  }

  /** Mark unread — read_at back to NULL. Same single-row scoping as {@link markRead}. */
  async markUnread(actor: AuthUser, notificationId: string): Promise<MarkNotificationResponse> {
    return this.setReadState(actor, notificationId, null);
  }

  /**
   * Clear the badge in one call. Bounded to the acting user's own unread rows in
   * this business; `.is('read_at', null)` also makes it idempotent and keeps the
   * write off rows that are already read.
   */
  async markAllRead(actor: AuthUser): Promise<MarkAllNotificationsReadResponse> {
    if (!userHasJoinedSalon(actor)) {
      return { markedCount: 0, unreadCount: 0 };
    }

    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_recipients')
      .update({ read_at: new Date().toISOString() })
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId)
      .is('read_at', null)
      .select('id')
      .returns<Array<{ id: string }>>();

    if (error) {
      this.logger.error(`mark all read failed for user ${actor.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to update notifications');
    }

    return {
      markedCount: data?.length ?? 0,
      unreadCount: await this.countUnread(actor),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Expired notifications stay in the table as history but leave the feed and the
   * badge — an alert about something that has passed is noise, and a badge that
   * cannot be cleared by reading is worse.
   */
  private applyUnexpiredFilter<T>(builder: T): T {
    // Second precision, NOT the default toISOString(). PostgREST parses each clause
    // inside `or=(…)` as `column.operator.value`, splitting on dots; a value of
    // 2026-08-28T18:00:00.000Z puts two more dots inside that triple. It happens to
    // parse today because only the first two dots are significant, but relying on
    // that is a needless bet on parser internals when a whole-second timestamp is
    // exactly as correct for an expiry check and contains no dots at all.
    const nowIso = `${new Date().toISOString().slice(0, 19)}Z`;
    return (builder as unknown as {
      or: (filter: string, opts: { referencedTable: string }) => T;
    }).or(`expires_at.is.null,expires_at.gt.${nowIso}`, { referencedTable: 'notifications' });
  }

  /**
   * How many rows the feed WOULD return for these filters, ignoring paging. Used
   * only to answer an out-of-range page with the honest total; the happy path gets
   * its count from the page query itself and never runs this.
   */
  private async countMatching(actor: AuthUser, unreadOnly: boolean): Promise<number> {
    let builder = this.admin
      .schema('comms')
      .from('notification_recipients')
      .select(NOTIFICATION_COUNT_COLUMNS, { count: 'exact', head: true })
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId);

    if (unreadOnly) {
      builder = builder.is('read_at', null);
    }

    const { count, error } = await this.applyUnexpiredFilter(builder);
    if (error) {
      this.logger.error(`count notifications failed for user ${actor.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to load notifications');
    }
    return count ?? 0;
  }

  private async countUnread(actor: AuthUser): Promise<number> {
    // Guarded here rather than only at the entry points so every caller —
    // list(), unreadCount(), and both read-state transitions — is covered.
    if (!userHasJoinedSalon(actor)) return 0;

    // head:true + count:'exact' asks Postgres for the number and transfers no rows.
    // idx_notification_recipients_unread is a partial index on exactly the
    // (user, business) + read_at is null predicate, so the scan is bounded by the
    // user's UNREAD rows rather than their history. The !inner join to notifications
    // then costs one primary-key lookup per surviving row to apply the expiry
    // filter — cheap because the partial index has already done the narrowing, but
    // not free, so this is not a pure index-only count.
    const { count, error } = await this.applyUnexpiredFilter(
      this.admin
        .schema('comms')
        .from('notification_recipients')
        .select(NOTIFICATION_COUNT_COLUMNS, { count: 'exact', head: true })
        .eq('user_profile_id', actor.id)
        .eq('business_id', actor.businessId)
        .is('read_at', null),
    );

    if (error) {
      this.logger.error(`unread count failed for user ${actor.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to load unread count');
    }

    return count ?? 0;
  }

  private async setReadState(
    actor: AuthUser,
    notificationId: string,
    readAt: string | null,
  ): Promise<MarkNotificationResponse> {
    // No salon, no notifications to mark — and no query to run with an empty
    // business id.
    if (!userHasJoinedSalon(actor)) {
      throw new NotFoundException('Notification not found');
    }

    const update = this.admin
      .schema('comms')
      .from('notification_recipients')
      .update({ read_at: readAt })
      .eq('notification_id', notificationId)
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId);

    // Marking read twice must not move the timestamp: the first read is when they
    // actually read it. Marking unread is unconditional.
    const scoped = readAt === null ? update : update.is('read_at', null);

    const { error } = await scoped.select('id').returns<Array<{ id: string }>>();
    if (error) {
      this.logger.error(
        `set read state failed for notification ${notificationId} user ${actor.id}: ${error.message}`,
      );
      throw new InternalServerErrorException('Unable to update notification');
    }

    // Re-read rather than trusting the update's return: when the row was already in
    // the target state the guarded update matches nothing, which is a no-op and not
    // a 404. Only a genuinely absent/foreign row is a 404 — and because this fetch
    // is scoped to the actor, another user's notification id is indistinguishable
    // from a made-up one, which is exactly the response an enumeration attempt
    // should get.
    const dto = await this.fetchOwnNotification(actor, notificationId);
    if (!dto) {
      throw new NotFoundException('Notification not found');
    }

    return { notification: dto, unreadCount: await this.countUnread(actor) };
  }

  private async fetchOwnNotification(
    actor: AuthUser,
    notificationId: string,
  ): Promise<NotificationDto | null> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('notification_recipients')
      .select(NOTIFICATION_FEED_COLUMNS)
      .eq('notification_id', notificationId)
      .eq('user_profile_id', actor.id)
      .eq('business_id', actor.businessId)
      .maybeSingle<NotificationFeedRow>();

    if (error) {
      this.logger.error(`load notification ${notificationId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load notification');
    }
    if (!data) return null;
    return toNotificationDto(data);
  }

  private assertValidInput(input: CreateNotificationInput): void {
    if (!input.businessId) {
      throw new BadRequestException('A notification requires a businessId');
    }
    if (!isKnownNotificationType(input.type)) {
      // The registry is the contract. A typo'd type would persist forever and no
      // client would know how to render it.
      throw new BadRequestException(`Unknown notification type: ${input.type}`);
    }
    if (!input.title?.trim() || !input.body?.trim()) {
      throw new BadRequestException('A notification requires a title and a body');
    }
    if (input.priority && !(NOTIFICATION_PRIORITIES as readonly string[]).includes(input.priority)) {
      throw new BadRequestException(`Unknown notification priority: ${input.priority}`);
    }
    if (Boolean(input.entityType) !== Boolean(input.entityId)) {
      throw new BadRequestException('entityType and entityId must be supplied together');
    }
    const recipients = input.recipientUserProfileIds ?? [];
    if (recipients.length === 0) {
      throw new BadRequestException('A notification requires at least one recipient');
    }
    if (new Set(recipients).size > MAX_RECIPIENTS) {
      throw new BadRequestException(
        `A notification cannot target more than ${MAX_RECIPIENTS} recipients`,
      );
    }
  }

  /**
   * Cross-tenant targeting is a security failure, not a bad request to absorb, so a
   * user with NO membership of this business fails the call outright. Being a member
   * whose membership is currently inactive/revoked is a different thing entirely —
   * that is left to the database function, which drops them and reports the count.
   */
  private async assertRecipientsBelongToBusiness(
    businessId: string,
    recipientIds: string[],
  ): Promise<void> {
    const known = new Set<string>();

    for (let i = 0; i < recipientIds.length; i += RECIPIENT_VALIDATION_BATCH) {
      const batch = recipientIds.slice(i, i + RECIPIENT_VALIDATION_BATCH);
      const { data, error } = await this.admin
        .schema('core')
        .from('user_memberships')
        .select('user_profile_id')
        .eq('business_id', businessId)
        .in('user_profile_id', batch)
        .returns<MembershipRow[]>();

      if (error) {
        this.logger.error(
          `recipient validation failed for business ${businessId}: ${error.message}`,
        );
        throw new InternalServerErrorException('Unable to validate notification recipients');
      }

      for (const row of data ?? []) known.add(row.user_profile_id);
    }

    const foreign = recipientIds.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      this.logger.error(
        `refusing notification for business ${businessId}: ${foreign.length} recipient(s) ` +
          'are not members of it',
      );
      throw new BadRequestException('One or more recipients do not belong to this business');
    }
  }
}
