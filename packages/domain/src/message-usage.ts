/**
 * Tier-based monthly message usage (QLOOQO V1.1, Wrike 4507284256).
 *
 * The platform-wide accounting layer the campaign ticket (0104) found missing.
 * Everything here is PURE: period arithmetic, the countability rule, the usage
 * formulas and the status ladder. The caller supplies the clock and the loaded
 * entitlement, so the same inputs always give the same answer.
 *
 * ---------------------------------------------------------------------------
 * ONE LOGICAL MESSAGE = ONE UNIT
 * ---------------------------------------------------------------------------
 * A booking confirmation that tries WhatsApp, fails, and succeeds on SMS is ONE
 * message to the client and costs ONE unit. Retries cost nothing extra either.
 * Provider attempts stay visible in `comms.message_logs`; they are a delivery
 * detail, not a billing event. See {@link logicalMessageKey}.
 */

import type { BusinessTier } from './index';

// ---------------------------------------------------------------------------
// Countability
// ---------------------------------------------------------------------------

/** The channels an outbound message can be accepted on. */
export type MessageUsageChannel = 'whatsapp' | 'sms' | 'email';

/**
 * Channels that consume the account's client-message allowance.
 *
 * Exactly the three external client-facing channels. In-app notifications and
 * mobile push are excluded — and not merely by this list: they live in
 * `comms.notifications` / `comms.push_deliveries` with their own dispatcher and
 * never enter `comms.notification_events` at all, so they are structurally
 * incapable of reaching this accounting path. Internal staff alerts likewise.
 */
export const COUNTABLE_CHANNELS: readonly MessageUsageChannel[] = ['whatsapp', 'sms', 'email'];

/**
 * Does this send consume a unit?
 *
 * ONE rule, in one place, so every caller gets identical behaviour and no
 * channel check is ever scattered into a feature service.
 *
 * Message CLASS is deliberately not part of it: the ticket defines a single
 * account-level allowance, so a marketing campaign and a booking confirmation
 * draw on the same pool. Splitting transactional from marketing would be a
 * commercial decision nobody has made.
 *
 * Direction is implicit — this is only ever reached from the outbound dispatch
 * path. An inbound WhatsApp reply never touches it.
 */
export function isCountableMessage(channel: string | null | undefined): channel is MessageUsageChannel {
  return COUNTABLE_CHANNELS.includes(channel as MessageUsageChannel);
}

// ---------------------------------------------------------------------------
// Logical message identity
// ---------------------------------------------------------------------------

/** The fields of a queued event the identity is derived from. */
export interface LogicalMessageIdentitySource {
  eventId: string;
  businessId: string;
  dedupeKey?: string | null;
  appointmentId?: string | null;
  eventKey: string;
}

/**
 * The stable identity of ONE outbound message to a client.
 *
 * It must survive both things the messaging layer does to a message:
 *
 *   RETRY    — the same `comms.notification_events` row attempted again.
 *   FALLBACK — a NEW row with the SAME `dedupe_key` (or the same
 *              `appointment_id` + `event_key`) and a DIFFERENT `channel`, queued
 *              by NotificationEscalationService.
 *
 * Both unique indexes on `notification_events` (0020 for appointment-anchored
 * messages, 0098 for keyed ones) include `channel` precisely so the fallback
 * chain can exist as separate rows. Dropping `channel` from those same tuples
 * therefore yields exactly the logical message — which is why this key does.
 *
 * The provider's message id is deliberately NOT used: it changes per attempt,
 * so it would count a fallback twice and a retry twice.
 */
export function logicalMessageKey(source: LogicalMessageIdentitySource): string {
  const dedupe = source.dedupeKey?.trim();
  if (dedupe) return `dk:${source.businessId}:${dedupe}`;
  if (source.appointmentId) return `ap:${source.appointmentId}:${source.eventKey}`;
  // No shared identity to group on: a lone event is its own logical message.
  // Its own id is stable across retries, which is the guarantee that matters.
  return `ev:${source.eventId}`;
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

/**
 * How the platform behaves when the allowance runs out.
 *
 * `track_only` is the shipped default and is deliberately non-blocking: with no
 * approved allowance numbers configured, blocking would silence a salon's
 * booking confirmations on the strength of a guess.
 */
export type MessageEnforcementMode = 'track_only' | 'allow_overage' | 'block_at_cap';

export interface TierMessagePolicy {
  enforcementMode: MessageEnforcementMode;
  warnAtPercent: number;
}

/** Shipped policy for every tier: count and surface, never block. */
export const DEFAULT_TIER_MESSAGE_POLICY: TierMessagePolicy = {
  enforcementMode: 'track_only',
  warnAtPercent: 80,
};

export interface TierMessageEntitlement extends TierMessagePolicy {
  tier: BusinessTier;
  /** The RESOLVED account allowance. NULL = unlimited. */
  monthlyAllowance: number | null;
  isUnlimited: boolean;
  /** Locations the allowance was multiplied across, for explainability. */
  locationCount: number;
}

/**
 * Resolve the account's monthly allowance.
 *
 * The per-tier number comes from BUSINESS_TIER_LIMITS.messagingMonthlyCapPerLocation
 * — the platform's authoritative tier constant, already used to enforce location
 * and bookable-column limits and already shown to customers on the plan card. It
 * is read, never copied: a second stored copy would drift from the figure the
 * product displays.
 *
 * It is expressed PER LOCATION, so the account allowance is that cap times the
 * number of active locations — pooled into ONE business-wide period. A
 * three-location Infinity salon therefore has 3,000 shared messages, not three
 * separate 1,000-message allowances with three separate month boundaries. No
 * location ever receives an allowance of its own.
 *
 * A null per-location cap means unlimited, which multiplication cannot change.
 */
export function resolveEntitlement(input: {
  tier: BusinessTier;
  perLocationCap: number | null;
  locationCount: number;
  policy?: TierMessagePolicy;
}): TierMessageEntitlement {
  const policy = input.policy ?? DEFAULT_TIER_MESSAGE_POLICY;
  // At least one: an account always has somewhere to message from, and a zero
  // multiplier would silently produce a zero allowance.
  const locations = Math.max(1, Math.trunc(input.locationCount));

  if (input.perLocationCap === null || input.perLocationCap === undefined) {
    return { tier: input.tier, monthlyAllowance: null, isUnlimited: true, locationCount: locations, ...policy };
  }
  return {
    tier: input.tier,
    monthlyAllowance: Math.max(0, Math.trunc(input.perLocationCap)) * locations,
    isUnlimited: false,
    locationCount: locations,
    ...policy,
  };
}

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

/** A monthly usage period, in salon-local calendar dates. */
export interface MessageUsagePeriodWindow {
  /** Inclusive first day, `YYYY-MM-DD`. */
  periodStart: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  periodEnd: string;
  timezone: string;
}

/**
 * The calendar month containing `atLocalDate`, in the account's timezone.
 *
 * A CALENDAR month, because no subscription/billing period exists on this
 * platform — Stripe is used for booking deposits only and stores no subscription
 * cycle. If one is added later, this is the single function that changes.
 *
 * Dates rather than instants on purpose: month boundaries are a calendar
 * question, so a DST transition inside the month cannot move them. The caller
 * resolves "today" in the business timezone once; nothing here reads a clock.
 */
export function monthlyPeriodFor(atLocalDate: string, timezone: string): MessageUsagePeriodWindow {
  const year = Number(atLocalDate.slice(0, 4));
  const month = Number(atLocalDate.slice(5, 7));
  const lastDay = daysInMonth(year, month);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    periodStart: `${year}-${pad(month)}-01`,
    periodEnd: `${year}-${pad(month)}-${pad(lastDay)}`,
    timezone,
  };
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one. Handles leap years
  // without a special case.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Usage formulas and status
// ---------------------------------------------------------------------------

export type MessageUsageStatus =
  | 'ok'
  | 'near_limit'
  | 'at_limit'
  | 'overage'
  | 'unlimited'
  /**
   * No allowance could be resolved for the tier at all. Not reachable for the
   * three shipped tiers; retained so a future tier added without a cap counts
   * usage honestly instead of silently reading as zero.
   */
  | 'allowance_not_configured';

export interface MessageUsageSummary {
  tier: BusinessTier;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  /** Null when unlimited or unconfigured. */
  allowance: number | null;
  isUnlimited: boolean;
  used: number;
  /** Null when there is no allowance to remain out of. */
  remaining: number | null;
  overage: number;
  /** Null when a percentage would be meaningless. */
  percentUsed: number | null;
  enforcementMode: MessageEnforcementMode;
  status: MessageUsageStatus;
  warnAtPercent: number;
}

/**
 * Derive the reportable summary from the stored counters.
 *
 *   remaining = max(allowance - used, 0)
 *   overage   = max(used - allowance, 0)
 *
 * The boundary is exact and is stated once here: at `used === allowance` the
 * allowance is fully consumed — remaining 0, overage 0. The FIRST message beyond
 * it is overage 1.
 */
export function summariseUsage(input: {
  tier: BusinessTier;
  period: MessageUsagePeriodWindow;
  used: number;
  entitlement: Pick<
    TierMessageEntitlement,
    'monthlyAllowance' | 'isUnlimited' | 'enforcementMode' | 'warnAtPercent'
  >;
}): MessageUsageSummary {
  const used = Math.max(0, Math.trunc(input.used));
  const { monthlyAllowance, isUnlimited, enforcementMode, warnAtPercent } = input.entitlement;

  const base = {
    tier: input.tier,
    periodStart: input.period.periodStart,
    periodEnd: input.period.periodEnd,
    timezone: input.period.timezone,
    used,
    isUnlimited,
    enforcementMode,
    warnAtPercent,
  };

  if (isUnlimited) {
    // Usage is still tracked — an unlimited plan still wants to know its volume —
    // but there is nothing to remain out of and nothing to be over.
    return { ...base, allowance: null, remaining: null, overage: 0, percentUsed: null, status: 'unlimited' };
  }
  if (monthlyAllowance === null || monthlyAllowance === undefined) {
    return {
      ...base,
      allowance: null,
      remaining: null,
      overage: 0,
      percentUsed: null,
      status: 'allowance_not_configured',
    };
  }

  const allowance = Math.max(0, Math.trunc(monthlyAllowance));
  const remaining = Math.max(allowance - used, 0);
  const overage = Math.max(used - allowance, 0);
  // Integer percent, and 0 rather than a division by zero for a zero allowance.
  const percentUsed = allowance === 0 ? (used > 0 ? 100 : 0) : Math.round((used * 100) / allowance);

  const status: MessageUsageStatus =
    overage > 0
      ? 'overage'
      : remaining === 0
        ? 'at_limit'
        : percentUsed >= warnAtPercent
          ? 'near_limit'
          : 'ok';

  return { ...base, allowance, remaining, overage, percentUsed, status };
}

// ---------------------------------------------------------------------------
// Enforcement decision — kept separate from accounting
// ---------------------------------------------------------------------------

export type MessageCapDecision =
  | { allow: true; warn: boolean }
  | { allow: false; reason: 'message_cap_reached' };

/**
 * May this message be handed to a provider?
 *
 * DELIBERATELY SEPARATE FROM COUNTING. A pre-send policy question and a
 * post-send accounting fact are different things, and merging them produces the
 * classic bug where a race either blocks a message that should have sent or
 * counts one that never did. Accounting stays exact under concurrency because
 * the ledger's unique key makes it exact; this decision is allowed to be
 * approximate at the boundary, and the overage counter absorbs the difference.
 *
 * Only `block_at_cap` ever refuses. `track_only` and `allow_overage` always
 * allow — the salon keeps messaging and the overage is recorded for billing.
 */
export function decideMessageCap(summary: MessageUsageSummary): MessageCapDecision {
  if (summary.isUnlimited) return { allow: true, warn: false };
  if (summary.status === 'allowance_not_configured') return { allow: true, warn: false };

  const warn = summary.status === 'near_limit' || summary.status === 'at_limit' || summary.status === 'overage';
  if (summary.enforcementMode !== 'block_at_cap') return { allow: true, warn };

  // At or beyond the allowance, a blocking plan stops here. The message is
  // suppressed with a structured reason — never disguised as a provider failure.
  return summary.remaining !== null && summary.remaining <= 0
    ? { allow: false, reason: 'message_cap_reached' }
    : { allow: true, warn };
}

/** The structured suppression reason recorded when a send is refused by the cap. */
export const MESSAGE_CAP_REACHED_REASON = 'message_cap_reached';

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface MessageUsageResponse {
  current: MessageUsageSummary;
  /** Previous periods, newest first. Never deleted — future billing evidence. */
  history: Array<{
    periodStart: string;
    periodEnd: string;
    tier: string;
    allowance: number | null;
    isUnlimited: boolean;
    used: number;
    overage: number;
  }>;
}
