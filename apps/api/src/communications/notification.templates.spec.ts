import { NotificationEventKey } from './notification.types';
import { formatInTimezone, renderNotification, type NotificationContext } from './notification.templates';

const ctx: NotificationContext = {
  clientFirstName: 'Sam',
  locationName: 'Sheer Soho',
  timezone: 'Europe/London',
  // 15:00 UTC in summer === 16:00 BST (London is UTC+1 on this date).
  scheduledStartAt: '2026-06-10T15:00:00.000Z',
  serviceNames: ['Cut & Finish'],
  stylistName: 'Alex',
};

describe('formatInTimezone (timezone correctness)', () => {
  it('renders the appointment in the location timezone, not UTC', () => {
    const formatted = formatInTimezone(ctx.scheduledStartAt, 'Europe/London');
    expect(formatted).toContain('16:00'); // BST, not 15:00 UTC
  });

  it('renders a different wall-clock time for a different timezone', () => {
    const ny = formatInTimezone(ctx.scheduledStartAt, 'America/New_York');
    expect(ny).toContain('11:00'); // EDT (UTC-4)
  });

  it('falls back gracefully on an invalid timezone instead of throwing', () => {
    expect(() => formatInTimezone(ctx.scheduledStartAt, 'Not/AZone')).not.toThrow();
  });
});

describe('renderNotification', () => {
  it('renders a confirmation mentioning the salon and service', () => {
    const msg = renderNotification(NotificationEventKey.BookingConfirmation, ctx);
    expect(msg.body).toContain('Sheer Soho');
    expect(msg.body).toContain('Cut & Finish');
    expect(msg.body).toContain('confirmed');
    expect(msg.preview).toContain('Booking confirmed');
  });

  it('uses distinct lead copy per reminder window', () => {
    expect(renderNotification(NotificationEventKey.Reminder24h, ctx).body).toContain('tomorrow');
    expect(renderNotification(NotificationEventKey.Reminder48h, ctx).body).toContain('2 days');
    expect(renderNotification(NotificationEventKey.Reminder1w, ctx).body).toContain('next week');
  });

  it('handles a missing client name without producing "Hi undefined"', () => {
    const msg = renderNotification(NotificationEventKey.Reminder24h, { ...ctx, clientFirstName: null });
    expect(msg.body).not.toContain('undefined');
    expect(msg.body.startsWith('Hi,')).toBe(true);
  });
});
