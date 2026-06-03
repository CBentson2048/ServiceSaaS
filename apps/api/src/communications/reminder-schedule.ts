import type { LocationCommunicationSettings } from '@sheer/domain';
import {
  enabledReminderKeys,
  NotificationEventKey,
  REMINDER_OFFSET_HOURS,
} from './notification.types';

export interface DesiredEvent {
  eventKey: NotificationEventKey;
  scheduledFor: Date;
}

/** Event keys whose rule is currently enabled (confirmation + each enabled reminder). */
export function enabledEventKeys(settings: LocationCommunicationSettings): Set<NotificationEventKey> {
  const keys = new Set<NotificationEventKey>();
  if (settings.sendBookingConfirmation) keys.add(NotificationEventKey.BookingConfirmation);
  for (const key of enabledReminderKeys(settings)) keys.add(key);
  return keys;
}

/**
 * Pure scheduling math: given the enabled rules, the appointment start, and "now",
 * return the events that should be queued.
 *
 *  - Confirmation (if enabled) is scheduled for `now` (send immediately).
 *  - Each enabled reminder is scheduled at `start - offset`, but only if that instant
 *    is still in the future — we never queue an already-past reminder (e.g. a "1 week
 *    before" reminder for an appointment booked tomorrow).
 *
 * Offsets are absolute (timezone-independent); the location timezone only affects how
 * the time is rendered in the message body.
 */
export function computeDesiredEvents(
  settings: LocationCommunicationSettings,
  start: Date,
  now: Date,
): DesiredEvent[] {
  const enabled = enabledEventKeys(settings);
  const desired: DesiredEvent[] = [];

  if (enabled.has(NotificationEventKey.BookingConfirmation)) {
    desired.push({ eventKey: NotificationEventKey.BookingConfirmation, scheduledFor: now });
  }

  for (const key of [
    NotificationEventKey.Reminder1w,
    NotificationEventKey.Reminder48h,
    NotificationEventKey.Reminder24h,
  ] as const) {
    if (!enabled.has(key)) continue;
    const offsetMs = REMINDER_OFFSET_HOURS[key] * 60 * 60 * 1000;
    const scheduledFor = new Date(start.getTime() - offsetMs);
    if (scheduledFor.getTime() <= now.getTime()) continue;
    desired.push({ eventKey: key, scheduledFor });
  }

  return desired;
}

/** True when a reminder event was scheduled against an appointment time that has since moved. */
export function isReminderStale(snapshotStartIso: unknown, currentStartIso: string): boolean {
  return typeof snapshotStartIso === 'string' && snapshotStartIso !== currentStartIso;
}
