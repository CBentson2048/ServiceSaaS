import {
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
  NotificationPriority,
  type DevicePlatform,
  type NotificationDto,
  type NotificationListPagination,
  type NotificationType,
  type UserDeviceDto,
} from '@sheer/domain';

/**
 * Row shapes and pure row -> DTO mapping for the in-app notification feed.
 *
 * Deliberately not @Injectable and free of I/O, following the module convention
 * that decision/shape logic lives in a plain module with its own spec while the
 * service only orchestrates the database around it (channel-policy.ts,
 * notification.templates.ts, reminder-schedule.ts all do this).
 *
 * These mappers are also the response boundary: the API returns THESE shapes, never
 * a raw database row. That is what keeps `dedupe_key`, `created_by_user_profile_id`
 * and `expires_at` — internal bookkeeping the UI has no business seeing — out of
 * the wire contract, and what makes a column rename a non-event for clients.
 */

/** Columns selected from comms.notifications. One list, so every reader agrees. */
export const NOTIFICATION_CONTENT_COLUMNS =
  'id,type,priority,title,body,entity_type,entity_id,action_path,location_id,metadata,created_at,expires_at';

/**
 * The feed row: per-user state from comms.notification_recipients with its parent
 * content embedded. `!inner` so the expiry filter on the referenced table actually
 * narrows the parent rows (and the exact count) rather than just nulling the embed.
 */
export const NOTIFICATION_FEED_COLUMNS = `id,seen_at,read_at,created_at,notification_id,notifications!inner(${NOTIFICATION_CONTENT_COLUMNS})`;

/**
 * The narrowest select that still supports a COUNT with the expiry filter. The
 * embed has to be present for PostgREST to accept `notifications.or=(…)`, but a
 * head-only count transfers no rows, so projecting the full notification body just
 * makes the URL longer and the plan wider for nothing.
 */
export const NOTIFICATION_COUNT_COLUMNS = 'id,notifications!inner(expires_at)';

export const USER_DEVICE_COLUMNS =
  'id,business_id,user_profile_id,device_identifier,platform,push_token,enabled,last_seen_at,created_at,updated_at';

export interface NotificationContentRow {
  id: string;
  type: string;
  priority: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  action_path: string | null;
  location_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  expires_at: string | null;
}

export interface NotificationFeedRow {
  id: string;
  notification_id: string;
  seen_at: string | null;
  read_at: string | null;
  created_at: string;
  /**
   * PostgREST returns a many-to-one embed as an object, but the generated
   * supabase-js types model embeds as arrays, and a hand-rolled test fake can
   * legitimately supply either. Both are accepted rather than trusting one shape.
   */
  notifications: NotificationContentRow | NotificationContentRow[] | null;
}

export interface UserDeviceRow {
  id: string;
  business_id: string;
  user_profile_id: string;
  device_identifier: string;
  platform: string;
  push_token: string | null;
  enabled: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Unwrap a PostgREST many-to-one embed, whichever shape it arrived in. */
export function embeddedContent(
  row: Pick<NotificationFeedRow, 'notifications'>,
): NotificationContentRow | null {
  const embedded = row.notifications;
  if (!embedded) return null;
  return Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
}

/**
 * `type` and `priority` are text columns whose registry lives in @sheer/domain, so a
 * row written by an older/newer deploy can carry a value this build does not know.
 * Unknown values are passed through for `type` (a client that cannot render it can
 * still show the title/body) but normalised for `priority`, which drives styling and
 * has a fixed set — an unknown priority would be an unstyled notification.
 */
function normalisePriority(value: string): NotificationPriority {
  return (NOTIFICATION_PRIORITIES as readonly string[]).includes(value)
    ? (value as NotificationPriority)
    : NotificationPriority.Normal;
}

/** True when the value is a type this build knows. Used to validate PRODUCER input. */
export function isKnownNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * Map one feed row to the wire DTO. Returns null when the embed is missing, which
 * means the caller's `!inner` join did not hold — a row worth skipping rather than
 * rendering half of.
 */
export function toNotificationDto(row: NotificationFeedRow): NotificationDto | null {
  const content = embeddedContent(row);
  if (!content) return null;

  return {
    id: content.id,
    type: content.type as NotificationType,
    priority: normalisePriority(content.priority),
    title: content.title,
    body: content.body,
    // Both-or-neither is enforced by the notifications_entity_pairing check
    // constraint; the guard here is what makes that guarantee visible in the type.
    entity:
      content.entity_type && content.entity_id
        ? { type: content.entity_type, id: content.entity_id }
        : null,
    actionPath: content.action_path,
    locationId: content.location_id,
    metadata: content.metadata ?? {},
    createdAt: content.created_at,
    seenAt: row.seen_at,
    readAt: row.read_at,
  };
}

export function toUserDeviceDto(row: UserDeviceRow): UserDeviceDto {
  return {
    id: row.id,
    platform: row.platform as DevicePlatform,
    deviceIdentifier: row.device_identifier,
    enabled: row.enabled,
    // The token itself never crosses the API boundary — only whether one is on file.
    hasPushToken: Boolean(row.push_token),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Page envelope matching the other V1.1 list endpoints. `totalPages` is at least 1
 * so an empty feed reads as "page 1 of 1" rather than "page 1 of 0".
 */
export function buildPagination(
  page: number,
  pageSize: number,
  total: number,
): NotificationListPagination {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Inclusive PostgREST `.range()` bounds for a 1-based page. */
export function pageRange(page: number, pageSize: number): { from: number; to: number } {
  const from = (page - 1) * pageSize;
  return { from, to: from + pageSize - 1 };
}
