import type { CommunicationPreference, LocationCommunicationSettings } from '@sheer/domain';

/** Channels this module can physically deliver on. */
export type DeliveryChannel = 'whatsapp' | 'sms' | 'email';

export type ChannelPlan =
  | { deliverable: true; primary: DeliveryChannel; fallbacks: DeliveryChannel[] }
  | { deliverable: false; skipReason: string };

/** Whether the client has a usable address per channel — computed by the caller from the profile. */
export interface ContactEligibility {
  phoneValid: boolean;
  emailValid: boolean;
}

type PolicyInputs = Pick<
  LocationCommunicationSettings,
  'enabled' | 'enabledChannels' | 'emailFallbackEnabled' | 'smsFallbackEnabled'
>;

/**
 * Canonical fallback priority for booking notifications: WhatsApp first, then Email, then SMS.
 * A channel earlier in this list is always preferred over a later one.
 */
const CANONICAL_ORDER: DeliveryChannel[] = ['whatsapp', 'email', 'sms'];

/**
 * The single source of truth for "which channels should this notification use, and in what order?".
 *
 * Policy (WhatsApp → Email → SMS):
 *  - The canonical priority order is fixed: WhatsApp, then Email, then SMS.
 *  - The client's stored communication preference selects the **starting point** in that chain:
 *      • `whatsapp` / unset → full chain `[whatsapp → email → sms]`
 *      • `email`            → `[email → sms]` (the client opted out of WhatsApp)
 *      • `sms`              → `[sms]`
 *  - Each step survives only if it is enabled for the location AND the client has a valid address:
 *      • WhatsApp: the location lists `whatsapp` in `enabledChannels` and the client has a valid phone.
 *      • Email:    the client has a valid email AND (the client *prefers* email — their explicit
 *                  primary, no toggle needed — OR `emailFallbackEnabled` for email as a fallback).
 *      • SMS:      `smsFallbackEnabled` and the client has a valid phone.
 *  - The first surviving channel is the `primary`; the rest (in order) are the lazy `fallbacks`.
 *
 * Pure and synchronous so the scheduler (to pick the primary channel) and the dispatcher / delivery
 * callbacks (to decide eligibility and the next channel after a real failure) share identical,
 * testable decisions. Fallbacks are NEVER attempted up front — only when the channel before them in
 * the chain is ineligible or has a real failure (see the dispatcher / callbacks).
 */
export function resolveChannelPlan(
  settings: PolicyInputs,
  preference: CommunicationPreference | null | undefined,
  contact: ContactEligibility,
): ChannelPlan {
  if (!settings.enabled) return { deliverable: false, skipReason: 'location notifications are disabled' };

  const startIndex = preferenceStartIndex(preference);
  const prefersEmail = CANONICAL_ORDER[startIndex] === 'email';

  const available: Record<DeliveryChannel, boolean> = {
    whatsapp: settings.enabledChannels.includes('whatsapp') && contact.phoneValid,
    // Email is usable as the client's PRIMARY when they explicitly prefer it (no toggle needed);
    // `emailFallbackEnabled` additionally allows email as a downstream fallback after WhatsApp.
    email: contact.emailValid && (prefersEmail || settings.emailFallbackEnabled === true),
    sms: settings.smsFallbackEnabled === true && contact.phoneValid,
  };

  const chain = CANONICAL_ORDER.slice(startIndex).filter((c) => available[c]);

  if (chain.length === 0) {
    return { deliverable: false, skipReason: explainNoChannel(preference, contact, available) };
  }
  return { deliverable: true, primary: chain[0], fallbacks: chain.slice(1) };
}

/** Where in the canonical chain a client's preference starts (defaults to WhatsApp). */
function preferenceStartIndex(preference: CommunicationPreference | null | undefined): number {
  const idx = preference ? CANONICAL_ORDER.indexOf(preference) : 0;
  return idx >= 0 ? idx : 0;
}

function explainNoChannel(
  preference: CommunicationPreference | null | undefined,
  contact: ContactEligibility,
  available: Record<DeliveryChannel, boolean>,
): string {
  if (!contact.phoneValid && !contact.emailValid) return 'client has no valid phone or email address';
  if (preference === 'email' && !contact.emailValid) return 'client prefers email but has no valid email address';
  if (preference === 'sms' && !contact.phoneValid) return 'client prefers SMS but has no valid phone number';
  if (preference === 'email' && !available.email) return 'client prefers email but email is not enabled for this location';
  if (preference === 'sms' && !available.sms) return 'client prefers SMS but SMS is not enabled for this location';
  return 'no delivery channel is enabled for this location';
}

/** The ordered list of channels for a plan: `[primary, ...fallbacks]` (empty when undeliverable). */
export function channelChain(plan: ChannelPlan): DeliveryChannel[] {
  return plan.deliverable ? [plan.primary, ...plan.fallbacks] : [];
}

/** True when `channel` is part of the plan's chain (enabled for the location and client-eligible). */
export function channelAllowedByPlan(plan: ChannelPlan, channel: DeliveryChannel): boolean {
  return channelChain(plan).includes(channel);
}

/**
 * The next channel to try after `current` fails or is ineligible, or `null` when `current` is the
 * last channel in the chain (or not part of it). This is the one place the WhatsApp → Email → SMS
 * escalation order is read; callers enqueue the returned channel lazily, never speculatively.
 */
export function nextChannelAfter(plan: ChannelPlan, current: DeliveryChannel): DeliveryChannel | null {
  const chain = channelChain(plan);
  const i = chain.indexOf(current);
  return i >= 0 && i + 1 < chain.length ? chain[i + 1] : null;
}
