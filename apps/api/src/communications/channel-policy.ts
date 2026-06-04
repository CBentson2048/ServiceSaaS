import type { CommunicationPreference, LocationCommunicationSettings } from '@sheer/domain';

/** Channels this module can physically deliver on. */
export type DeliveryChannel = 'whatsapp' | 'sms';

export type ChannelPlan =
  | { deliverable: true; primary: DeliveryChannel; fallback?: DeliveryChannel }
  | { deliverable: false; skipReason: string };

type PolicyInputs = Pick<LocationCommunicationSettings, 'enabled' | 'enabledChannels' | 'smsFallbackEnabled'>;

/**
 * The single source of truth for "which channel should this notification use?".
 *
 * Policy: **WhatsApp is the primary channel**; SMS is a configurable fallback. The client's stored
 * communication preference is respected — `email` means "no messaging" (skip), `sms` makes SMS the
 * primary channel, and `whatsapp`/unset uses WhatsApp-first with optional SMS fallback.
 *
 * Pure and synchronous so the scheduler (to pick the primary channel) and the dispatcher (to decide
 * whether a real WhatsApp failure may fall back to SMS) share identical, testable decisions.
 */
export function resolveChannelPlan(
  settings: PolicyInputs,
  preference: CommunicationPreference | null | undefined,
  phoneValid: boolean,
): ChannelPlan {
  if (!settings.enabled) return { deliverable: false, skipReason: 'location notifications are disabled' };
  if (!phoneValid) return { deliverable: false, skipReason: 'client has no valid phone number' };

  const whatsappAllowed = settings.enabledChannels.includes('whatsapp');
  const smsAllowed = settings.smsFallbackEnabled === true;

  if (preference === 'email') {
    return { deliverable: false, skipReason: 'client communication preference is email (not WhatsApp/SMS)' };
  }

  if (preference === 'sms') {
    return smsAllowed
      ? { deliverable: true, primary: 'sms' }
      : { deliverable: false, skipReason: 'client prefers SMS but SMS is not enabled for this location' };
  }

  // 'whatsapp' or no explicit preference → WhatsApp-first.
  if (whatsappAllowed) {
    return { deliverable: true, primary: 'whatsapp', fallback: smsAllowed ? 'sms' : undefined };
  }
  if (smsAllowed) return { deliverable: true, primary: 'sms' };
  return { deliverable: false, skipReason: 'no delivery channel is enabled for this location' };
}

/** True when SMS is a usable channel under the plan (either primary SMS or the WhatsApp fallback). */
export function smsAllowedByPlan(plan: ChannelPlan): boolean {
  return plan.deliverable && (plan.primary === 'sms' || plan.fallback === 'sms');
}
