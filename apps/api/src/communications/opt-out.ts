import type { DeliveryChannel } from './channel-policy';

/** What an inbound message asked for, when it is a subscription command. */
export type OptOutIntent = 'opt_out' | 'opt_in';

/**
 * Twilio's standard opt-out / opt-in keyword set, which the carriers and WhatsApp honour whether or
 * not we act on them. We mirror it exactly so our own record matches what the provider has already
 * done to the subscription — otherwise we would keep queueing messages the provider silently drops.
 */
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stop all']);
const OPT_IN_KEYWORDS = new Set(['start', 'yes', 'unstop']);

/**
 * Classify an inbound message body as an opt-out / opt-in command, or null when it is ordinary
 * conversation. Deliberately strict: only a message whose entire body is the keyword counts, so
 * "please cancel my appointment" is a conversation, not an unsubscribe. Punctuation and case are
 * ignored ("STOP." / "Stop").
 */
export function parseOptOutKeyword(body: string | null | undefined): OptOutIntent | null {
  const normalized = (body ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (OPT_OUT_KEYWORDS.has(normalized)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(normalized)) return 'opt_in';
  return null;
}

/**
 * Twilio error 21610 — "Attempt to send to unsubscribed recipient". The carrier has already recorded
 * a STOP we never saw (the keyword may predate us, or have gone to a different sender). Recording it
 * stops us re-attempting a channel the provider will always reject.
 *
 * Only this code is pinned. WhatsApp's block/unreachable codes are not reliably documented as
 * opt-outs, so they are deliberately left to behave as ordinary delivery failures — which already
 * escalate to the next channel. We never infer a permanent opt-out from an ambiguous code.
 */
const PINNED_OPT_OUT_ERROR_CODES = new Set(['21610']);

/** True when a provider failure means "this recipient has unsubscribed from this channel". */
export function isProviderOptOut(errorCode: string | undefined, errorMessage: string | undefined): boolean {
  if (errorCode && PINNED_OPT_OUT_ERROR_CODES.has(errorCode.trim())) return true;
  const text = (errorMessage ?? '').toLowerCase();
  if (!text) return false;
  return /\bunsubscribed\b|\bopted[- ]out\b|\bhas replied with stop\b/.test(text);
}

/** How an opt-out was learned. Recorded on `comms.channel_opt_outs.source` for auditability. */
export type OptOutSource = 'inbound_keyword' | 'provider_error' | 'staff';

export interface ChannelOptOut {
  channel: DeliveryChannel;
  source: OptOutSource;
  reason: string | null;
}
