/** Delivery statuses we persist to `comms.message_logs.delivery_status` from Twilio callbacks. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered' | 'read';

/**
 * Map a Twilio `MessageStatus` to our delivery-status enum. Returns null for statuses we don't
 * track (e.g. inbound `receiving`/`received`), which the caller ignores.
 *
 * Twilio statuses: accepted, scheduled, queued, sending, sent, delivered, undelivered, failed, read.
 */
export function mapTwilioStatus(raw: string | undefined): DeliveryStatus | null {
  switch ((raw ?? '').toLowerCase()) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
      return 'queued';
    case 'sending':
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

const RANK: Record<DeliveryStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  // Terminal failures sit alongside delivered in ordering but are always applied (see shouldApply).
  undelivered: 2,
  failed: 2,
};

export function isFailureStatus(status: DeliveryStatus): boolean {
  return status === 'failed' || status === 'undelivered';
}

/**
 * Status callbacks can arrive out of order or be replayed. Apply a failure status always (it is the
 * important terminal truth); otherwise only move forward (never downgrade delivered → sent).
 */
export function shouldApplyStatus(current: string | null | undefined, next: DeliveryStatus): boolean {
  if (isFailureStatus(next)) return true;
  const currentRank = current && current in RANK ? RANK[current as DeliveryStatus] : -1;
  return RANK[next] > currentRank;
}
