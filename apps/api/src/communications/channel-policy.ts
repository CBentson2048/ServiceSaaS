import type { CommunicationPreference, LocationCommunicationSettings } from '@sheer/domain';

/** Channels this module can physically deliver on. */
export type DeliveryChannel = 'whatsapp' | 'sms' | 'email';

export type ChannelPlan =
  | { deliverable: true; primary: DeliveryChannel; fallback?: DeliveryChannel }
  | { deliverable: false; skipReason: string };

/** Whether the client has a usable address per channel — computed by the caller from the profile. */
export interface ContactEligibility {
  phoneValid: boolean;
  emailValid: boolean;
}

type PolicyInputs = Pick<LocationCommunicationSettings, 'enabled' | 'enabledChannels' | 'smsFallbackEnabled'>;

/**
 * The single source of truth for "which channel should this notification use?".
 *
 * Policy: the client's stored communication preference selects the channel.
 *  - `email` → deliver by **email** (the channel the client asked for).
 *  - `sms` → SMS is the primary channel (when SMS is enabled for the location).
 *  - `whatsapp` / unset → **WhatsApp-first** with an optional SMS fallback.
 *
 * Pure and synchronous so the scheduler (to pick the primary channel) and the dispatcher (to decide
 * eligibility / whether a WhatsApp failure may fall back to SMS) share identical, testable decisions.
 */
export function resolveChannelPlan(
  settings: PolicyInputs,
  preference: CommunicationPreference | null | undefined,
  contact: ContactEligibility,
): ChannelPlan {
  if (!settings.enabled) return { deliverable: false, skipReason: 'location notifications are disabled' };

  const whatsappAllowed = settings.enabledChannels.includes('whatsapp');
  const smsAllowed = settings.smsFallbackEnabled === true;

  // Client explicitly prefers email → deliver by email (no WhatsApp/SMS fallback).
  if (preference === 'email') {
    return contact.emailValid
      ? { deliverable: true, primary: 'email' }
      : { deliverable: false, skipReason: 'client prefers email but has no valid email address' };
  }

  if (preference === 'sms') {
    if (!contact.phoneValid) return { deliverable: false, skipReason: 'client has no valid phone number' };
    return smsAllowed
      ? { deliverable: true, primary: 'sms' }
      : { deliverable: false, skipReason: 'client prefers SMS but SMS is not enabled for this location' };
  }

  // 'whatsapp' or no explicit preference → WhatsApp-first.
  if (!contact.phoneValid) return { deliverable: false, skipReason: 'client has no valid phone number' };
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
