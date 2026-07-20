import { NotificationEventKey } from './notification.types';

export interface NotificationContext {
  clientFirstName?: string | null;
  locationName: string;
  /** IANA timezone of the location, e.g. `Europe/London`. */
  timezone: string;
  /** Appointment start as an ISO-8601 / timestamptz string. */
  scheduledStartAt: string;
  serviceNames: string[];
  stylistName?: string | null;
}

export interface RenderedMessage {
  /** WhatsApp message body. */
  body: string;
  /** Short single-line summary stored in `comms.message_logs.content_preview`. */
  preview: string;
}

/**
 * Format an absolute instant in the location's timezone. Reminder *scheduling* uses
 * absolute offsets from `scheduled_start_at` (timezone-independent); the timezone only
 * affects how the time is *displayed* to the client here. This keeps reminders correct
 * regardless of where the API server runs.
 */
export function formatInTimezone(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    // Invalid timezone — fall back to a UTC-labelled rendering rather than throwing.
    return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  }
}

function greeting(name?: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? `Hi ${trimmed},` : 'Hi,';
}

function serviceLine(serviceNames: string[]): string {
  const names = serviceNames.filter(Boolean);
  return names.length ? ` for ${names.join(', ')}` : '';
}

function stylistLine(stylistName?: string | null): string {
  const trimmed = stylistName?.trim();
  return trimmed ? ` with ${trimmed}` : '';
}

/**
 * Positional Content template variables for Twilio's Content API. Approved templates must
 * reference these positions consistently across confirmation + reminders:
 *   {{1}} client first name   {{2}} location name   {{3}} service(s)
 *   {{4}} stylist             {{5}} date & time (formatted in the location timezone)
 *
 * Values are always non-empty strings (Twilio rejects empty ContentVariables), so missing
 * fields fall back to friendly defaults.
 */
export function buildContentVariables(ctx: NotificationContext): Record<string, string> {
  const services = ctx.serviceNames.filter(Boolean);
  return {
    '1': ctx.clientFirstName?.trim() || 'there',
    '2': ctx.locationName,
    '3': services.length ? services.join(', ') : 'your appointment',
    '4': ctx.stylistName?.trim() || 'our team',
    '5': formatInTimezone(ctx.scheduledStartAt, ctx.timezone),
  };
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the email variant of a notification for clients whose communication preference is email.
 * Reuses {@link renderNotification} for the body so all channels stay consistent; adds an email
 * subject and a minimal HTML wrapper.
 */
export function renderEmail(eventKey: NotificationEventKey, ctx: NotificationContext): RenderedEmail {
  const { body } = renderNotification(eventKey, ctx);
  const subject =
    eventKey === NotificationEventKey.BookingConfirmation
      ? `Your booking at ${ctx.locationName} is confirmed`
      : eventKey === NotificationEventKey.RebookingNudge
        ? `Time to book your next appointment at ${ctx.locationName}`
        : eventKey === NotificationEventKey.Reminder1w
          ? `Reminder: your appointment at ${ctx.locationName} next week`
          : eventKey === NotificationEventKey.Reminder48h
            ? `Reminder: your appointment at ${ctx.locationName} in 2 days`
            : eventKey === NotificationEventKey.Reminder2h
              ? `Reminder: your appointment at ${ctx.locationName} in 2 hours`
              : `Reminder: your appointment at ${ctx.locationName} tomorrow`;
  return { subject, text: body, html: `<p>${escapeHtml(body)}</p>` };
}

export function renderNotification(
  eventKey: NotificationEventKey,
  ctx: NotificationContext,
): RenderedMessage {
  const when = formatInTimezone(ctx.scheduledStartAt, ctx.timezone);
  const services = serviceLine(ctx.serviceNames);
  const stylist = stylistLine(ctx.stylistName);

  if (eventKey === NotificationEventKey.RebookingNudge) {
    return {
      body:
        `${greeting(ctx.clientFirstName)} it's been a little while since your last visit to ${ctx.locationName}` +
        `${services}. Ready for your next appointment? Reply to this message and we'll get you booked in.`,
      preview: `Time to rebook at ${ctx.locationName}`,
    };
  }

  if (eventKey === NotificationEventKey.BookingConfirmation) {
    return {
      body:
        `${greeting(ctx.clientFirstName)} your booking at ${ctx.locationName} is confirmed` +
        `${services}${stylist} on ${when}. We look forward to seeing you!`,
      preview: `Booking confirmed for ${when}`,
    };
  }

  const lead =
    eventKey === NotificationEventKey.Reminder1w
      ? 'This is a reminder that you have an appointment coming up next week'
      : eventKey === NotificationEventKey.Reminder48h
        ? 'This is a reminder that your appointment is in 2 days'
        : eventKey === NotificationEventKey.Reminder2h
          ? 'This is a reminder that your appointment is in 2 hours'
          : 'This is a reminder that your appointment is tomorrow';

  return {
    body:
      `${greeting(ctx.clientFirstName)} ${lead} at ${ctx.locationName}` +
      `${services}${stylist} on ${when}. Reply to this message if you need to make any changes.`,
    preview: `Reminder: appointment on ${when}`,
  };
}
