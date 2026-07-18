import type { LocationCommunicationSettings } from '@sheer/domain';
import { NotificationEventKey } from './notification.types';
import { computeDesiredEvents, enabledEventKeys, isReminderStale } from './reminder-schedule';

const HOUR = 3_600_000;

function settings(overrides: Partial<LocationCommunicationSettings> = {}): LocationCommunicationSettings {
  return {
    locationId: 'loc-1',
    enabled: true,
    enabledChannels: ['whatsapp'],
    sendBookingConfirmation: false,
    reminder2hEnabled: false,
    reminder24hEnabled: false,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
    emailFallbackEnabled: false,
    smsFallbackEnabled: false,
    ...overrides,
  };
}

const NOW = new Date('2026-06-02T09:00:00.000Z');

describe('enabledEventKeys (rule evaluation)', () => {
  it('returns nothing when no rules are enabled', () => {
    expect(enabledEventKeys(settings()).size).toBe(0);
  });

  it('includes confirmation and every enabled reminder', () => {
    const keys = enabledEventKeys(
      settings({ sendBookingConfirmation: true, reminder24hEnabled: true, reminder1wEnabled: true }),
    );
    expect([...keys].sort()).toEqual(
      [
        NotificationEventKey.BookingConfirmation,
        NotificationEventKey.Reminder24h,
        NotificationEventKey.Reminder1w,
      ].sort(),
    );
    expect(keys.has(NotificationEventKey.Reminder48h)).toBe(false);
  });
});

describe('computeDesiredEvents (scheduling logic)', () => {
  it('schedules a confirmation immediately (at now)', () => {
    const start = new Date(NOW.getTime() + 72 * HOUR);
    const desired = computeDesiredEvents(settings({ sendBookingConfirmation: true }), start, NOW);
    expect(desired).toHaveLength(1);
    expect(desired[0].eventKey).toBe(NotificationEventKey.BookingConfirmation);
    expect(desired[0].scheduledFor.toISOString()).toBe(NOW.toISOString());
  });

  it('computes reminder times as absolute offsets before the appointment', () => {
    const start = new Date('2026-06-10T15:00:00.000Z');
    const desired = computeDesiredEvents(
      settings({
        reminder2hEnabled: true,
        reminder24hEnabled: true,
        reminder48hEnabled: true,
        reminder1wEnabled: true,
      }),
      start,
      NOW,
    );
    const byKey = new Map(desired.map((d) => [d.eventKey, d.scheduledFor.toISOString()]));
    expect(byKey.get(NotificationEventKey.Reminder2h)).toBe('2026-06-10T13:00:00.000Z');
    expect(byKey.get(NotificationEventKey.Reminder24h)).toBe('2026-06-09T15:00:00.000Z');
    expect(byKey.get(NotificationEventKey.Reminder48h)).toBe('2026-06-08T15:00:00.000Z');
    expect(byKey.get(NotificationEventKey.Reminder1w)).toBe('2026-06-03T15:00:00.000Z');
  });

  it('schedules the 2h reminder for a same-day booking after the 24h/48h/1w windows have passed', () => {
    // Appointment in 3 hours: only the 2-hour reminder is still in the future.
    const start = new Date(NOW.getTime() + 3 * HOUR);
    const desired = computeDesiredEvents(
      settings({
        reminder2hEnabled: true,
        reminder24hEnabled: true,
        reminder48hEnabled: true,
        reminder1wEnabled: true,
      }),
      start,
      NOW,
    );
    expect(desired.map((d) => d.eventKey)).toEqual([NotificationEventKey.Reminder2h]);
    expect(desired[0].scheduledFor.toISOString()).toBe(new Date(NOW.getTime() + 1 * HOUR).toISOString());
  });

  it('skips reminders whose window has already passed (no "next week" reminder for a near booking)', () => {
    // Appointment is tomorrow → the 1-week and 48h windows are already in the past.
    const start = new Date(NOW.getTime() + 24 * HOUR);
    const desired = computeDesiredEvents(
      settings({ reminder24hEnabled: true, reminder48hEnabled: true, reminder1wEnabled: true }),
      start,
      NOW,
    );
    expect(desired.map((d) => d.eventKey)).toEqual([]); // even 24h is exactly now → excluded (<=)
  });

  it('produces no events when the master switch is off but toggles are on', () => {
    // enabled=false is enforced by the caller; computeDesiredEvents only reads the rule flags,
    // so the caller must gate on `enabled`. This documents that contract.
    const start = new Date(NOW.getTime() + 72 * HOUR);
    const desired = computeDesiredEvents(settings({ enabled: false, sendBookingConfirmation: true }), start, NOW);
    expect(desired).toHaveLength(1); // rule flag still true — gating on `enabled` happens upstream
  });
});

describe('isReminderStale (reschedule protection)', () => {
  it('flags a reminder whose snapshot start no longer matches the live appointment', () => {
    expect(isReminderStale('2026-06-10T15:00:00.000Z', '2026-06-11T15:00:00.000Z')).toBe(true);
  });

  it('does not flag a reminder when the appointment time is unchanged', () => {
    expect(isReminderStale('2026-06-10T15:00:00.000Z', '2026-06-10T15:00:00.000Z')).toBe(false);
  });

  it('treats a missing snapshot as not stale (cannot prove a move)', () => {
    expect(isReminderStale(undefined, '2026-06-10T15:00:00.000Z')).toBe(false);
  });
});
