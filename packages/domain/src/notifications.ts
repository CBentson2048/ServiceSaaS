/**
 * In-app notification contracts (V1.1, Wrike "Add in-app notification service layer").
 *
 * THE canonical registry for notification types, the wire shapes the web bell and
 * the mobile feed both consume, and the device-targeting contract that future push
 * delivery will build on.
 *
 * WHY THE TYPE REGISTRY LIVES HERE. `comms.notifications.type` is a plain text
 * column, exactly like `comms.notification_events.event_key`, and this const object
 * is its registry — the same relationship `NotificationEventKey` has with that
 * column. Keeping it in code rather than in a Postgres enum is what lets a new
 * producer (zac_opportunity, low_stock, …) ship as a code change instead of a
 * migration, while still giving every producer and consumer one list to agree on.
 * Values are PERSISTED, so they must remain stable once shipped.
 *
 * WHAT MAY GO IN A NOTIFICATION. These render on lock screens, on shared salon
 * tablets and in push payloads, so `title`/`body`/`metadata` carry the minimum
 * needed to recognise and route to the event — never a copy of the source record.
 * No client notes, no medical/allergy data, no payroll figures, no other user's ZAC
 * memory. Structured `entity` + `actionPath` is the mechanism: the notification
 * says WHERE to look, and the target screen re-authorises the read.
 */

/**
 * Canonical notification types. Persisted verbatim to `comms.notifications.type`,
 * so these string values are a stable contract — rename the key, never the value.
 *
 * lower_snake, matching every other persisted string value in this platform —
 * NotificationEventKey ('booking_confirmation'), appointment_status_enum
 * ('checked_in'), membership_status_enum ('active'). The Wrike ticket writes them
 * as CLIENT_ARRIVED etc., but that is the ticket naming the CONCEPTS; it also says
 * to use the project's own conventions, and a lone SCREAMING_SNAKE column would be
 * the odd one out in every query a human reads.
 *
 * Only types with a real producer or an approved consumer are listed. The registry
 * is deliberately additive: a new entry here needs no schema change.
 */
export const NotificationType = {
  /** A client has arrived and been checked in at the desk. Targets the assigned stylist. */
  ClientArrived: 'client_arrived',
  /** A mistaken check-in was undone — the client has not arrived. Targets the assigned stylist. */
  CheckInUndone: 'check_in_undone',
  /** An upcoming appointment reminder surfaced in-app to staff. */
  AppointmentReminder: 'appointment_reminder',
  /** An appointment's time, service or stylist changed. */
  BookingChanged: 'booking_changed',
  /** An appointment was cancelled. */
  BookingCancelled: 'booking_cancelled',
  /** A purchase order is waiting for an approver (Week 6 ordering). */
  OrderApprovalRequired: 'order_approval_required',
  /** Stock has fallen to or below its reorder point. */
  LowStock: 'low_stock',
  /** Platform/operational message with no more specific type. */
  System: 'system',
} as const;

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/** Every registered type, for runtime validation of a producer's input. */
export const NOTIFICATION_TYPES: readonly NotificationType[] = Object.values(
  NotificationType,
) as NotificationType[];

/**
 * Relative importance. A closed set — it is persisted with a check constraint on
 * `comms.notifications.priority`, so unlike the type registry, adding a value here
 * DOES require a migration.
 */
export const NotificationPriority = {
  Low: 'low',
  Normal: 'normal',
  High: 'high',
  Urgent: 'urgent',
} as const;

export type NotificationPriority =
  (typeof NotificationPriority)[keyof typeof NotificationPriority];

export const NOTIFICATION_PRIORITIES: readonly NotificationPriority[] = Object.values(
  NotificationPriority,
) as NotificationPriority[];

/** Platforms a personal device can run. Persisted with a check constraint. */
export const DevicePlatform = {
  Ios: 'ios',
  Android: 'android',
  Web: 'web',
} as const;

export type DevicePlatform = (typeof DevicePlatform)[keyof typeof DevicePlatform];

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = Object.values(
  DevicePlatform,
) as DevicePlatform[];

/**
 * Structured routing context. Present so a client can navigate from a notification
 * without parsing its body text — the anti-pattern this contract exists to prevent.
 */
export interface NotificationEntityRef {
  /** Domain of the linked record, e.g. 'appointment', 'purchase_order'. */
  type: string;
  id: string;
}

/**
 * One notification as the current user sees it: the shared content plus THEIR own
 * read state. Two users looking at the same notification get the same `id` and
 * different `readAt`.
 */
export interface NotificationDto {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  body: string;
  /** Null when the notification is not about a specific record. */
  entity: NotificationEntityRef | null;
  /** Relative in-app path this notification opens. Null when it is informational. */
  actionPath: string | null;
  /** Null for a business-wide notification. */
  locationId: string | null;
  /** UI-safe extras only. Never a copy of the source record. */
  metadata: Record<string, unknown>;
  createdAt: string;
  /** When it was delivered/displayed to this user. Null if never surfaced. */
  seenAt: string | null;
  /** Null means UNREAD. */
  readAt: string | null;
}

/** Standard page envelope, matching the other paginated V1.1 list endpoints. */
export interface NotificationListPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListNotificationsResponse {
  notifications: NotificationDto[];
  pagination: NotificationListPagination;
  /**
   * Unread total across the whole feed, not just this page — the bell badge needs
   * it and would otherwise need a second round trip on every page change.
   */
  unreadCount: number;
}

export interface UnreadCountResponse {
  unreadCount: number;
}

/** Returned by mark-read / mark-unread so a client can update the badge in one hop. */
export interface MarkNotificationResponse {
  notification: NotificationDto;
  unreadCount: number;
}

export interface MarkAllNotificationsReadResponse {
  /** How many rows actually changed — zero when everything was already read. */
  markedCount: number;
  unreadCount: number;
}

/**
 * A registered personal device. Note there is deliberately no `pushToken` field:
 * the token is a delivery address the server holds, never something the API hands
 * back to a client.
 */
export interface UserDeviceDto {
  id: string;
  platform: DevicePlatform;
  deviceIdentifier: string;
  enabled: boolean;
  /** True when a push token is on file — the UI can say "push is set up" without seeing it. */
  hasPushToken: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterUserDeviceResponse {
  device: UserDeviceDto;
}

export interface ListUserDevicesResponse {
  devices: UserDeviceDto[];
}

/**
 * The reusable creation contract every producer calls. Recipients are resolved by
 * the SERVER from the business event (assigned stylist, approvers, …) — a request
 * from a browser never chooses them, which is what makes targeting trustworthy.
 */
export interface CreateNotificationInput {
  businessId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** core.user_profiles.id values. Ineligible ids are dropped, not silently accepted. */
  recipientUserProfileIds: string[];
  /** Omit for a business-wide notification. */
  locationId?: string | null;
  priority?: NotificationPriority;
  entityType?: string | null;
  entityId?: string | null;
  actionPath?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Idempotency key, unique per business. A retried business event must reuse the
   * same key so it resolves to the first notification instead of creating a second.
   * Convention: `<type-ish>:<entity-id>`, e.g. `client_arrived:<appointmentId>`.
   */
  dedupeKey?: string | null;
  createdByUserProfileId?: string | null;
  expiresAt?: string | null;
}

/** Outcome of a creation attempt. Producers log this; they do not branch on failure. */
export interface CreateNotificationResult {
  /** Null when no requested recipient was eligible — nothing was written. */
  notificationId: string | null;
  /** Recipient rows that exist for this notification. */
  recipientCount: number;
  /** How many ids the caller asked for; exceeds recipientCount when some were dropped. */
  requestedCount: number;
  /** True when an existing notification with the same dedupeKey was returned. */
  deduplicated: boolean;
}
