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
  /**
   * Channels that cannot carry THIS PARTICULAR message, even though the location
   * enables them and the client is reachable on them.
   *
   * A provider capability, not a preference and not a consent rule: the message
   * needs something on that channel it does not have. The case this exists for
   * is proactive WhatsApp marketing, which providers only accept against an
   * approved template — with none configured for the event, WhatsApp cannot
   * carry it and the canonical chain must fall through to SMS/email rather than
   * attempting a send that would be rejected.
   *
   * Deliberately expressed as a capability here rather than as provider policy
   * in the campaign layer, so every sender inherits the same behaviour.
   */
  unsupportedChannels?: readonly DeliveryChannel[];
  /**
   * Channels this client has opted out of (`comms.channel_opt_outs`): an inbound STOP keyword, a
   * provider opt-out error code, or a staff action. An opted-out channel is removed from the chain
   * entirely — it is never the primary and never a fallback — so the next channel takes over exactly
   * as it would after a delivery failure. Per-channel by design: a WhatsApp STOP must not silence
   * transactional email.
   */
  optedOutChannels?: readonly DeliveryChannel[];
}

type PolicyInputs = Pick<
  LocationCommunicationSettings,
  'enabled' | 'enabledChannels' | 'emailFallbackEnabled' | 'smsFallbackEnabled'
>;

/**
 * Canonical fallback priority: WhatsApp first, then SMS, then Email (Wrike #4507284095 — "WhatsApp
 * primary; on failure/opt-out fall back to SMS; if SMS cannot be used/delivered, fall back to
 * email"). A channel earlier in this list is always preferred over a later one.
 */
const CANONICAL_ORDER: DeliveryChannel[] = ['whatsapp', 'sms', 'email'];

/**
 * The single source of truth for "which channels should this notification use, and in what order?".
 *
 * Policy (WhatsApp → SMS → Email):
 *  - The canonical priority order is fixed: WhatsApp, then SMS, then Email.
 *  - The client's stored communication preference selects the **starting point** in that chain:
 *      • `whatsapp` / unset → full chain `[whatsapp → sms → email]`
 *      • `sms`              → `[sms → email]` (the client opted out of WhatsApp)
 *      • `email`            → `[email]`
 *  - Each step survives only if it is enabled for the location AND the client has a valid address
 *    AND the client has not opted out of that channel:
 *      • WhatsApp: the location lists `whatsapp` in `enabledChannels` and the client has a valid phone.
 *      • SMS:      the client has a valid phone AND (the client *prefers* SMS — their explicit
 *                  primary, no toggle needed — OR `smsFallbackEnabled` for SMS as a fallback).
 *      • Email:    the client has a valid email AND (the client *prefers* email — their explicit
 *                  primary, no toggle needed — OR `emailFallbackEnabled` for email as a fallback).
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
  const prefersSms = CANONICAL_ORDER[startIndex] === 'sms';
  const prefersEmail = CANONICAL_ORDER[startIndex] === 'email';
  const optedOut = new Set<DeliveryChannel>(contact.optedOutChannels ?? []);
  const unsupported = new Set<DeliveryChannel>(contact.unsupportedChannels ?? []);

  const available: Record<DeliveryChannel, boolean> = {
    whatsapp:
      settings.enabledChannels.includes('whatsapp') &&
      contact.phoneValid &&
      !optedOut.has('whatsapp') &&
      !unsupported.has('whatsapp'),
    // SMS is usable as the client's PRIMARY when they explicitly prefer it (no toggle needed);
    // `smsFallbackEnabled` additionally allows SMS as a downstream fallback after WhatsApp.
    sms:
      contact.phoneValid &&
      !optedOut.has('sms') &&
      !unsupported.has('sms') &&
      (prefersSms || settings.smsFallbackEnabled === true),
    // Email mirrors SMS: usable as the client's PRIMARY when they explicitly prefer it (no toggle
    // needed); `emailFallbackEnabled` additionally allows email as the final fallback.
    email:
      contact.emailValid &&
      !optedOut.has('email') &&
      !unsupported.has('email') &&
      (prefersEmail || settings.emailFallbackEnabled === true),
  };

  const chain = CANONICAL_ORDER.slice(startIndex).filter((c) => available[c]);

  if (chain.length === 0) {
    if (unsupported.size > 0) {
      return {
        deliverable: false,
        skipReason: explainNoChannel(preference, contact, available, optedOut, unsupported),
      };
    }
    return { deliverable: false, skipReason: explainNoChannel(preference, contact, available, optedOut) };
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
  optedOut: Set<DeliveryChannel>,
  unsupported: Set<DeliveryChannel> = new Set(),
): string {
  // Say the capability out loud: "no approved template and nowhere else to go"
  // is a configuration answer, not a consent or contact-details one.
  if (unsupported.size > 0 && CANONICAL_ORDER.every((c) => unsupported.has(c) || !available[c])) {
    return `no channel can carry this message (${[...unsupported].join(', ')} unavailable for it)`;
  }
  if (!contact.phoneValid && !contact.emailValid) return 'client has no valid phone or email address';
  if (preference === 'email' && !contact.emailValid) return 'client prefers email but has no valid email address';
  if (preference === 'sms' && !contact.phoneValid) return 'client prefers SMS but has no valid phone number';
  if (preference === 'email' && optedOut.has('email')) return 'client has opted out of email';
  if (preference === 'sms' && optedOut.has('sms')) return 'client has opted out of SMS';
  if (preference === 'email' && !available.email) return 'client prefers email but email is not enabled for this location';
  if (preference === 'sms' && !available.sms) return 'client prefers SMS but SMS is not enabled for this location';
  if (optedOut.size > 0 && CANONICAL_ORDER.every((c) => optedOut.has(c) || !available[c])) {
    return `client has opted out of every remaining channel (${[...optedOut].join(', ')})`;
  }
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
 * The next channel to try after `current` fails or is ineligible, or `null` when there is nothing
 * further to try. This is the one place the WhatsApp → SMS → Email escalation order is read; callers
 * enqueue the returned channel lazily, never speculatively.
 *
 * When `current` is not in the chain at all, the message still needs to get through, so it hands
 * over to the first channel after it in the canonical order that survives. The channel may be
 * missing because the client opted out of it, has no valid address for it, the location disabled it,
 * or because the client's stored preference has since moved further down the chain — the message is
 * equally undelivered in every one of those cases, and the client's own current chain is exactly
 * where it should go.
 *
 * An earlier revision returned `null` for the preference case specifically, on the reasoning that
 * the scheduler had already queued the correct event and escalating would duplicate it. That premise
 * does not hold: nothing re-runs `syncBookingNotifications` when
 * `core.client_profiles.communication_preference` changes, so no replacement event exists, and the
 * queued one was being cancelled undelivered. Duplication is not what this guard prevents in any
 * case — the partial unique indexes reject a second event on the same channel and
 * `enqueueOnChannel` reports it as `duplicate`.
 */
export function nextChannelAfter(plan: ChannelPlan, current: DeliveryChannel): DeliveryChannel | null {
  const chain = channelChain(plan);
  const i = chain.indexOf(current);
  if (i >= 0) return i + 1 < chain.length ? chain[i + 1] : null;
  if (!plan.deliverable) return null;

  const currentIndex = CANONICAL_ORDER.indexOf(current);
  if (currentIndex < 0) return null;
  return CANONICAL_ORDER.slice(currentIndex + 1).find((c) => chain.includes(c)) ?? null;
}
