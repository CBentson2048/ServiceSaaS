/**
 * Maps Resend webhook event types to the delivery statuses we persist to `comms.message_logs`, and
 * decides whether a given outcome should escalate the notification to the next channel.
 *
 * Pure functions, no framework dependency — unit-testable in isolation (mirrors `twilio-status.ts`
 * for the Twilio side, kept separate to avoid coupling the comms module to the twilio module).
 */

/** Email delivery statuses we persist (a subset of the shared `comms.notification_status_enum`). */
export type EmailDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed';

const RANK: Record<EmailDeliveryStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  // A failure is terminal-truth and always applied (see shouldApplyEmailStatus).
  failed: 2,
};

export function isEmailFailure(status: EmailDeliveryStatus): boolean {
  return status === 'failed';
}

export interface ResendStatusMapping {
  status: EmailDeliveryStatus;
  /** True when this outcome is a real delivery failure that should escalate to the next channel. */
  escalate: boolean;
}

/**
 * Map a Resend webhook `type` to a delivery status + escalation decision. Returns null for event
 * types we don't track (opened/clicked/delivery_delayed/unknown), which the caller ignores.
 *
 *  - `email.bounced`    → failed + escalate (a hard bounce means the email did NOT arrive → try SMS).
 *  - `email.complained` → failed, no escalate (spam complaint: the message arrived; stop messaging).
 *  - `email.delivered`  → delivered.
 *  - `email.sent`       → sent (already our accept state; kept for completeness/monotonic ordering).
 */
export function mapResendEvent(type: string | undefined): ResendStatusMapping | null {
  switch ((type ?? '').toLowerCase()) {
    case 'email.sent':
      return { status: 'sent', escalate: false };
    case 'email.delivered':
      return { status: 'delivered', escalate: false };
    case 'email.bounced':
    case 'email.failed':
      return { status: 'failed', escalate: true };
    case 'email.complained':
      return { status: 'failed', escalate: false };
    default:
      return null;
  }
}

/**
 * Webhooks can arrive out of order or be replayed. Apply a failure status always (terminal truth);
 * otherwise only move forward (never downgrade delivered → sent).
 */
export function shouldApplyEmailStatus(
  current: string | null | undefined,
  next: EmailDeliveryStatus,
): boolean {
  if (isEmailFailure(next)) return true;
  const currentRank = current && current in RANK ? RANK[current as EmailDeliveryStatus] : -1;
  return RANK[next] > currentRank;
}
