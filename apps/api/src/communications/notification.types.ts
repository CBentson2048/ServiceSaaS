import type { CommunicationPreference, LocationCommunicationSettings } from '@sheer/domain';

/**
 * Stable identifiers written to `comms.notification_events.event_key` and mirrored
 * into `comms.message_logs.message_type`. They participate in the partial unique
 * index `notification_events_booking_event_unique_idx (appointment_id, event_key,
 * channel) where status <> 'cancelled'`, so they must remain stable.
 */
export const NotificationEventKey = {
  BookingConfirmation: 'booking_confirmation',
  Reminder2h: 'appointment_reminder_2h',
  Reminder24h: 'appointment_reminder_24h',
  Reminder48h: 'appointment_reminder_48h',
  Reminder1w: 'appointment_reminder_1w',
  /**
   * Post-completion retention nudge (Wrike #4507281502). Scheduled when a
   * qualifying appointment completes, at a per-service interval, and delivered
   * over the same WhatsApp → Email → SMS chain. Not a reminder — it fires long
   * after the appointment, so it is excluded from REMINDER_EVENT_KEYS.
   */
  RebookingNudge: 'rebooking_nudge',
} as const;

export type NotificationEventKey = (typeof NotificationEventKey)[keyof typeof NotificationEventKey];

/** Reminder offsets, in hours before `scheduled_start_at`. 1 week === 168h. */
export const REMINDER_OFFSET_HOURS = {
  [NotificationEventKey.Reminder2h]: 2,
  [NotificationEventKey.Reminder24h]: 24,
  [NotificationEventKey.Reminder48h]: 48,
  [NotificationEventKey.Reminder1w]: 168,
} as const;

/** Primary delivery channel. */
export const WHATSAPP_CHANNEL = 'whatsapp' as const;
/** Fallback delivery channel. */
export const SMS_CHANNEL = 'sms' as const;
/** Delivery channel for clients whose communication preference is email. */
export const EMAIL_CHANNEL = 'email' as const;

/** Reminder event keys (everything except the booking confirmation). Shared scheduling/dispatch guard. */
export const REMINDER_EVENT_KEYS = new Set<string>([
  NotificationEventKey.Reminder2h,
  NotificationEventKey.Reminder24h,
  NotificationEventKey.Reminder48h,
  NotificationEventKey.Reminder1w,
]);

export const DEFAULT_COMMUNICATION_SETTINGS: Omit<LocationCommunicationSettings, 'locationId'> = {
  enabled: false,
  enabledChannels: ['whatsapp'],
  sendBookingConfirmation: false,
  reminder2hEnabled: false,
  reminder24hEnabled: false,
  reminder48hEnabled: false,
  reminder1wEnabled: false,
  emailFallbackEnabled: false,
  smsFallbackEnabled: false,
};

/**
 * Raw JSON shape persisted under `core.location_settings.metadata.communication`.
 * Matches the contract documented in migration 0020_client_communications.sql:
 * `{ enabled, enabledChannels, reminderOffsetsHours, sendBookingConfirmation, ... }`.
 */
export interface CommunicationMetadata {
  enabled?: boolean;
  enabledChannels?: CommunicationPreference[];
  sendBookingConfirmation?: boolean;
  sendCancellationNotice?: boolean;
  sendWaitlistNotifications?: boolean;
  reminderOffsetsHours?: number[];
  emailFallbackEnabled?: boolean;
  smsFallbackEnabled?: boolean;
}

/** Map the persisted JSON metadata onto the typed, toggle-oriented settings DTO. */
export function metadataToSettings(
  locationId: string,
  metadata: CommunicationMetadata | null | undefined,
): LocationCommunicationSettings {
  const offsets = new Set(Array.isArray(metadata?.reminderOffsetsHours) ? metadata!.reminderOffsetsHours : []);
  return {
    locationId,
    enabled: metadata?.enabled ?? DEFAULT_COMMUNICATION_SETTINGS.enabled,
    enabledChannels:
      Array.isArray(metadata?.enabledChannels) && metadata!.enabledChannels.length > 0
        ? metadata!.enabledChannels
        : [...DEFAULT_COMMUNICATION_SETTINGS.enabledChannels],
    sendBookingConfirmation:
      metadata?.sendBookingConfirmation ?? DEFAULT_COMMUNICATION_SETTINGS.sendBookingConfirmation,
    reminder2hEnabled: offsets.has(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder2h]),
    reminder24hEnabled: offsets.has(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder24h]),
    reminder48hEnabled: offsets.has(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder48h]),
    reminder1wEnabled: offsets.has(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder1w]),
    emailFallbackEnabled: metadata?.emailFallbackEnabled ?? DEFAULT_COMMUNICATION_SETTINGS.emailFallbackEnabled,
    smsFallbackEnabled: metadata?.smsFallbackEnabled ?? DEFAULT_COMMUNICATION_SETTINGS.smsFallbackEnabled,
  };
}

/** Inverse of {@link metadataToSettings} — produce the JSON to persist (preserving unknown keys). */
export function settingsToMetadata(
  settings: LocationCommunicationSettings,
  existing: CommunicationMetadata | null | undefined,
): CommunicationMetadata {
  const offsets: number[] = [];
  if (settings.reminder1wEnabled) offsets.push(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder1w]);
  if (settings.reminder48hEnabled) offsets.push(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder48h]);
  if (settings.reminder24hEnabled) offsets.push(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder24h]);
  if (settings.reminder2hEnabled) offsets.push(REMINDER_OFFSET_HOURS[NotificationEventKey.Reminder2h]);

  return {
    ...(existing ?? {}),
    enabled: settings.enabled,
    enabledChannels: settings.enabledChannels,
    sendBookingConfirmation: settings.sendBookingConfirmation,
    reminderOffsetsHours: offsets,
    emailFallbackEnabled: settings.emailFallbackEnabled,
    smsFallbackEnabled: settings.smsFallbackEnabled,
  };
}

/** Enabled reminder event keys for the given settings, ordered earliest-first (1w → 2h). */
export function enabledReminderKeys(settings: LocationCommunicationSettings): NotificationEventKey[] {
  const keys: NotificationEventKey[] = [];
  if (settings.reminder1wEnabled) keys.push(NotificationEventKey.Reminder1w);
  if (settings.reminder48hEnabled) keys.push(NotificationEventKey.Reminder48h);
  if (settings.reminder24hEnabled) keys.push(NotificationEventKey.Reminder24h);
  if (settings.reminder2hEnabled) keys.push(NotificationEventKey.Reminder2h);
  return keys;
}
