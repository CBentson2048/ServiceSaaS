/**
 * Campaign configuration & automated marketing (QLOOQO V1.1, Wrike 4507283957).
 *
 * ONE campaign framework with four typed strategies — not four marketing
 * systems. Everything here is PURE: no clock reads, no I/O, no provider calls.
 * The API layer supplies "today", the salon timezone and the loaded evidence;
 * this module answers the deterministic questions:
 *
 *   - is this configuration valid?
 *   - does this template render, and with which variables?
 *   - is today a send day for this campaign?
 *   - what is this recipient's send identity (the idempotency key)?
 *   - which channel may this campaign actually use for this client?
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT OWN
 *   - Lapsed/overdue cadence. That is `evaluateClientLapse` in
 *     ./client-intelligence, the single canonical definition. A rebooking
 *     campaign CONSUMES it; it must never re-derive "overdue".
 *   - Channel policy and fallback. That is `resolveChannelPlan` in the API's
 *     communications module (WhatsApp -> SMS -> Email). A campaign may only
 *     NARROW the chain, never widen or reorder it — see
 *     {@link narrowCampaignChannel}.
 *   - Marketing consent and opt-out. `core.client_profiles.marketing_opt_in`
 *     and `comms.channel_opt_outs`, applied by MessagingService for every
 *     message class alike.
 *   - Any generation of message copy. The owner writes the template. There is
 *     no AI in this path by design (Wrike sections 49-50).
 */

import { addLocalDays, isLocalDateString, localDaysBetween } from './client-intelligence';

// ---------------------------------------------------------------------------
// Canonical vocabulary
// ---------------------------------------------------------------------------

/**
 * The four approved V1.1 campaign types. ONE canonical representation —
 * lower_snake, matching every other status/kind union in this package and the
 * CHECK constraint on `comms.campaigns.campaign_type` (migration 0104). There is
 * deliberately no `birthday_campaign` / `birthdays` / `client_birthday` variant
 * anywhere in the platform.
 */
export type CampaignType = 'rebooking' | 'birthday' | 'promotion' | 'loyalty_milestone';

export const CAMPAIGN_TYPES: readonly CampaignType[] = [
  'rebooking',
  'birthday',
  'promotion',
  'loyalty_milestone',
];

/**
 * Configuration lifecycle.
 *
 * - `draft`    — being configured. NEVER evaluated, never sends. The default for
 *                a new campaign, so setting one up cannot leak messages.
 * - `active`   — evaluated on the configured schedule.
 * - `paused`   — was active, temporarily stopped. Not evaluated.
 * - `archived` — retired. Not evaluated, hidden from the default list, and kept
 *                (never deleted) so its send history stays explicable.
 *
 * Only `active` produces messages. `draft`/`paused`/`archived` are all
 * "not evaluated" — three words for the owner, one rule for the evaluator.
 */
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'archived';

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['draft', 'active', 'paused', 'archived'];

/** Statuses the evaluator will consider. Exactly one. */
export const EVALUATABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['active'];

/**
 * The owner's channel choice for a campaign.
 *
 * `auto` — the platform's canonical WhatsApp -> SMS -> Email chain, started at
 * the client's own stored preference. This is the default and the one that
 * preserves WhatsApp-first behaviour.
 *
 * A named channel does NOT bypass the chain — it narrows it. See
 * {@link narrowCampaignChannel} for the exact rule.
 */
export type CampaignChannel = 'auto' | 'whatsapp' | 'sms' | 'email';

export const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = ['auto', 'whatsapp', 'sms', 'email'];

/** A run's lifecycle. `partial` = completed, but at least one recipient failed to queue. */
export type CampaignRunStatus = 'running' | 'completed' | 'partial' | 'failed';

/** Per-recipient outcome of one campaign evaluation. */
export type CampaignRecipientStatus = 'queued' | 'suppressed' | 'failed';

// ---------------------------------------------------------------------------
// Typed configuration — one shape per campaign type
// ---------------------------------------------------------------------------
//
// Wrike section 5: each campaign type has a TYPED configuration. There is no
// generic rule engine, no arbitrary executable JSON, no user-supplied predicate.
// Every field below is a bounded scalar or an enum, validated on the way in and
// re-validated on the way out of the database.

/**
 * Which lapse statuses a rebooking campaign targets. These are exactly the
 * canonical `ClientLapseStatus` values that mean "not currently coming back";
 * `booked`, `active` and `insufficient_history` are never targetable, which is
 * what enforces Wrike section 9's "if the client already has an appropriate
 * future appointment, DO NOT send".
 */
export type RebookingTargetStatus = 'lapsed' | 'at_risk';

export interface RebookingCampaignConfig {
  /**
   * Whom to treat as due for a nudge. `['lapsed']` (the default) is the
   * conservative choice: past their expected return by more than the salon's
   * configured buffer.
   */
  targetStatuses: RebookingTargetStatus[];
  /**
   * Extra days past the point the canonical rule already calls overdue, before
   * this campaign acts. 0 = act as soon as the status applies. Exists so an
   * owner can be later than the detection buffer, never earlier.
   */
  minOverdueDays: number;
  /**
   * Restrict to clients whose cadence-defining service sits in this category.
   * Null = every service category.
   */
  serviceCategoryId: string | null;
}

export interface BirthdayCampaignConfig {
  /**
   * Send this many salon-local days BEFORE the birthday. 0 = on the day.
   * Bounded to 30 — beyond that it stops being a birthday message.
   */
  daysBefore: number;
}

/** Audience filters a promotion may use. A controlled set, not a query builder. */
export interface PromotionCampaignConfig {
  /** Salon-local inclusive send window, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  /**
   * Narrow to clients in these canonical lapse statuses. Empty = every
   * marketing-eligible client in scope (the common case).
   */
  lapseStatuses: RebookingTargetStatus[];
  /** Narrow to clients whose cadence-defining service is in this category. Null = all. */
  serviceCategoryId: string | null;
  /** Only clients with at least this many completed visits. 0 = no floor. */
  minCompletedVisits: number;
}

/** The canonical loyalty metrics. Both are derived from existing settled data. */
export type LoyaltyMilestoneMetric = 'completed_visits' | 'total_spend';

export interface LoyaltyMilestoneCampaignConfig {
  metric: LoyaltyMilestoneMetric;
  /**
   * Visits, or MINOR UNITS (pence) for `total_spend`. Integer by construction —
   * money never touches floating point anywhere in this feature.
   */
  threshold: number;
}

export type CampaignConfig =
  | ({ type: 'rebooking' } & RebookingCampaignConfig)
  | ({ type: 'birthday' } & BirthdayCampaignConfig)
  | ({ type: 'promotion' } & PromotionCampaignConfig)
  | ({ type: 'loyalty_milestone' } & LoyaltyMilestoneCampaignConfig);

/**
 * Bounds mirrored EXACTLY by the CHECK constraints in migration 0104, so an
 * insert that bypasses the API (a script, a backfill) cannot store a config the
 * evaluator would refuse to read.
 */
export const CAMPAIGN_BOUNDS = {
  nameLength: { min: 1, max: 120 },
  templateLength: { min: 1, max: 1000 },
  subjectLength: { min: 1, max: 200 },
  /**
   * The send window, in salon-local hours. This IS the quiet-hours policy: the
   * platform has no separate send-window scheduler, and a marketing message must
   * not be queued overnight. 08:00-20:00 local, inclusive of 8, exclusive of 21.
   */
  sendAtLocalHour: { min: 8, max: 20 },
  birthdayDaysBefore: { min: 0, max: 30 },
  rebookingMinOverdueDays: { min: 0, max: 365 },
  promotionMinCompletedVisits: { min: 0, max: 100 },
  loyaltyVisitThreshold: { min: 1, max: 1000 },
  /** Pence. £1 .. £1,000,000. */
  loyaltySpendThresholdMinor: { min: 100, max: 100_000_000 },
} as const;

/** Platform default send hour: 10:00 salon-local. Comfortably inside the window. */
export const DEFAULT_CAMPAIGN_SEND_HOUR = 10;

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/**
 * The complete set of interpolation variables. Every one of these resolves
 * deterministically from data the campaign evaluator already holds — there is no
 * variable here that could render as an empty string or leak another client's
 * details.
 *
 * This is a closed list ON PURPOSE. An unknown placeholder is a validation
 * error at save time, not a silent `{{whatever}}` in a client's WhatsApp.
 */
export const CAMPAIGN_TEMPLATE_VARIABLES = [
  'first_name',
  'last_name',
  'salon_name',
  'location_name',
  'booking_link',
] as const;

export type CampaignTemplateVariable = (typeof CAMPAIGN_TEMPLATE_VARIABLES)[number];

export type CampaignTemplateValues = Record<CampaignTemplateVariable, string>;

/**
 * Representative values for the owner-facing preview (Wrike section 20). Never a
 * real client's data — a preview must not become a way to read the CRM.
 */
export const CAMPAIGN_PREVIEW_VALUES: CampaignTemplateValues = {
  first_name: 'Jane',
  last_name: 'Smith',
  salon_name: 'Your salon',
  location_name: 'Your salon',
  booking_link: 'https://example.com/book',
};

/** A `{{ placeholder }}` occurrence, tolerant of internal whitespace. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface CampaignTemplateValidation {
  valid: boolean;
  /** Placeholders present in the template that are not in the approved list. */
  unknownVariables: string[];
  /** Approved placeholders the template actually uses. */
  usedVariables: CampaignTemplateVariable[];
  errors: string[];
}

/**
 * Validate an owner-written template.
 *
 * Rejects: empty/whitespace-only bodies, bodies past the length bound, unknown
 * placeholders, and raw HTML tags. HTML is refused rather than escaped because
 * WhatsApp and SMS cannot render it at all — a template containing markup would
 * be delivered as literal angle brackets on two of three channels, which is a
 * configuration mistake worth surfacing at save time.
 *
 * There is NO template execution of any kind: `{{...}}` is a lookup in a fixed
 * map and nothing else.
 */
export function validateCampaignTemplate(body: string): CampaignTemplateValidation {
  const errors: string[] = [];
  const trimmed = (body ?? '').trim();

  if (trimmed.length < CAMPAIGN_BOUNDS.templateLength.min) {
    errors.push('Message cannot be empty');
  }
  if (trimmed.length > CAMPAIGN_BOUNDS.templateLength.max) {
    errors.push(`Message must be ${CAMPAIGN_BOUNDS.templateLength.max} characters or fewer`);
  }
  if (/<[a-zA-Z/][^>]*>/.test(trimmed)) {
    errors.push('Message cannot contain HTML tags — WhatsApp and SMS deliver them as literal text');
  }

  const known = new Set<string>(CAMPAIGN_TEMPLATE_VARIABLES);
  const unknownVariables: string[] = [];
  const usedVariables: CampaignTemplateVariable[] = [];

  for (const match of trimmed.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (known.has(name)) {
      if (!usedVariables.includes(name as CampaignTemplateVariable)) {
        usedVariables.push(name as CampaignTemplateVariable);
      }
    } else if (!unknownVariables.includes(name)) {
      unknownVariables.push(name);
    }
  }

  if (unknownVariables.length > 0) {
    errors.push(
      `Unknown placeholder${unknownVariables.length > 1 ? 's' : ''}: ${unknownVariables
        .map((name) => `{{${name}}}`)
        .join(', ')}. Available: ${CAMPAIGN_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }

  // A lone `{{` or an unterminated placeholder is almost certainly a typo that
  // would ship to a client verbatim.
  if (/\{\{(?![^{}]*\}\})/.test(trimmed)) {
    errors.push('Message contains an unclosed {{placeholder}}');
  }

  return { valid: errors.length === 0, unknownVariables, usedVariables, errors };
}

/**
 * Substitute the approved variables. Unknown placeholders are left EXACTLY as
 * written rather than blanked — validation already refuses to store them, and if
 * one ever reaches here it must be visible rather than silently swallowed.
 */
export function renderCampaignTemplate(body: string, values: CampaignTemplateValues): string {
  return (body ?? '').replace(PLACEHOLDER_RE, (whole, name: string) =>
    (CAMPAIGN_TEMPLATE_VARIABLES as readonly string[]).includes(name)
      ? values[name as CampaignTemplateVariable] ?? ''
      : whole,
  );
}

/** Single-line summary for `comms.message_logs.content_preview`. */
export function campaignPreviewLine(rendered: string, maxLength = 120): string {
  const flat = rendered.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}

// ---------------------------------------------------------------------------
// Channel narrowing
// ---------------------------------------------------------------------------

/** The canonical chain order. Mirrors CANONICAL_ORDER in channel-policy.ts. */
const CANONICAL_CHANNEL_ORDER = ['whatsapp', 'sms', 'email'] as const;

export type CampaignDeliveryPreference = 'whatsapp' | 'sms' | 'email';

/**
 * The effective starting point in the WhatsApp -> SMS -> Email chain for one
 * campaign message to one client.
 *
 * The rule is NARROW-ONLY: take whichever of the two preferences sits LATER in
 * the canonical order.
 *
 *   campaign `auto`                  -> the client's own preference, untouched.
 *   campaign email, client whatsapp  -> email (the owner chose email for this campaign).
 *   campaign whatsapp, client email  -> email (the CLIENT chose email; a campaign
 *                                       setting can never drag them back up the chain).
 *
 * This is why a campaign cannot become a second messaging policy: it can only
 * ever remove channels from a client's chain, and the chain itself, its
 * fallbacks and its opt-out handling stay entirely inside the messaging layer.
 */
export function narrowCampaignChannel(
  campaignChannel: CampaignChannel,
  clientPreference: CampaignDeliveryPreference | null | undefined,
): CampaignDeliveryPreference | null {
  const clientIndex = clientPreference ? CANONICAL_CHANNEL_ORDER.indexOf(clientPreference) : -1;
  const campaignIndex =
    campaignChannel === 'auto'
      ? -1
      : CANONICAL_CHANNEL_ORDER.indexOf(campaignChannel as CampaignDeliveryPreference);

  const effective = Math.max(clientIndex, campaignIndex);
  return effective < 0 ? null : CANONICAL_CHANNEL_ORDER[effective];
}

// ---------------------------------------------------------------------------
// Send identity (idempotency keys) — Wrike section 26
// ---------------------------------------------------------------------------
//
// Every campaign message has a DETERMINISTIC identity, derived only from stable
// facts. Two evaluator instances, a retry, and a re-run after a crash all
// compute the same string, and the database's unique constraints turn that into
// "at most one message" without any check-then-insert race.
//
// The message TEXT is deliberately NOT part of any key (Wrike section 27):
// editing the wording of a campaign must never make already-messaged clients
// eligible again.

const KEY_PREFIX = 'campaign';

/**
 * Birthday: one message per client per calendar year, per campaign.
 * `birthdayYear` is the year of the BIRTHDAY (not of the send), so a campaign
 * configured to send 10 days early does not send twice when the birthday falls
 * in early January.
 */
export function birthdayDedupeKey(campaignId: string, clientId: string, birthdayYear: number): string {
  return `${KEY_PREFIX}:${campaignId}:birthday:${clientId}:${birthdayYear}`;
}

/**
 * Loyalty: one message per client per MILESTONE, forever. The metric and
 * threshold are in the key, so an owner who later configures a 20-visit
 * milestone reaches clients who already got the 10-visit one — a different
 * milestone is a different message, and the same milestone never repeats.
 */
export function loyaltyDedupeKey(
  campaignId: string,
  clientId: string,
  metric: LoyaltyMilestoneMetric,
  threshold: number,
): string {
  return `${KEY_PREFIX}:${campaignId}:loyalty:${clientId}:${metric}:${threshold}`;
}

/**
 * Promotion: one message per client per campaign, ever.
 *
 * Deliberately conservative (Wrike sections 10 and 65: no drip sequences in
 * V1.1). Neither the config nor the message text is in the key, so editing a
 * live promotion re-targets nobody who has already received it. A second push
 * is a second campaign — an explicit, visible, auditable act.
 */
export function promotionDedupeKey(campaignId: string, clientId: string): string {
  return `${KEY_PREFIX}:${campaignId}:promotion:${clientId}`;
}

/**
 * Rebooking: one message per client per REBOOKING OPPORTUNITY.
 *
 * The opportunity is identified by the client's canonical expected-return date
 * (`ClientLapseResult.expectedNextVisitAt`, derived from their own cadence and
 * their last visit on the basis). While a client stays overdue, that date does
 * not move, so a daily evaluator sends once and then never again for that cycle.
 * When they finally come in, their next expected return is a new date and a new
 * opportunity — which is exactly the cycle boundary Wrike section 10 asks for.
 */
export function rebookingDedupeKey(
  campaignId: string,
  clientId: string,
  expectedReturnDate: string,
): string {
  return `${KEY_PREFIX}:${campaignId}:rebooking:${clientId}:${expectedReturnDate}`;
}

/** The `event_key` written to `comms.notification_events` / `message_logs.message_type`. */
export function campaignEventKey(type: CampaignType): string {
  return `campaign_${type}`;
}

/** Every campaign event key, for log filtering. */
export const CAMPAIGN_EVENT_KEYS: readonly string[] = CAMPAIGN_TYPES.map(campaignEventKey);

// ---------------------------------------------------------------------------
// Birthday calendar maths — Wrike sections 11 and 42
// ---------------------------------------------------------------------------

/**
 * The salon-local date a client's birthday falls on in `year`.
 *
 * LEAP DAY: a 29 February birthday is observed on 28 February in a common year.
 * Chosen over 1 March so the greeting always lands inside the birth month, and
 * so it can never jump a year boundary. Returns null for a missing or malformed
 * date of birth — a birthday is never inferred (Wrike section 11).
 */
export function birthdayOccurrence(dateOfBirth: string | null | undefined, year: number): string | null {
  if (!dateOfBirth || !isLocalDateString(dateOfBirth)) return null;
  const month = Number(dateOfBirth.slice(5, 7));
  const day = Number(dateOfBirth.slice(8, 10));

  if (month === 2 && day === 29 && !isLeapYear(year)) {
    return `${String(year).padStart(4, '0')}-02-28`;
  }
  const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isLocalDateString(candidate) ? candidate : null;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Is `today` the send day for this client's birthday, and if so which birthday
 * year is it for?
 *
 * Checks this year AND next year, because a campaign that sends N days early
 * must reach a 3 January birthday from late December. Returns the BIRTHDAY's
 * year, which is what {@link birthdayDedupeKey} keys on.
 */
export function birthdaySendMatch(
  dateOfBirth: string | null | undefined,
  today: string,
  daysBefore: number,
): { birthdayYear: number; birthdayDate: string } | null {
  if (!dateOfBirth || !isLocalDateString(dateOfBirth) || !isLocalDateString(today)) return null;

  const thisYear = Number(today.slice(0, 4));
  for (const year of [thisYear, thisYear + 1]) {
    const occurrence = birthdayOccurrence(dateOfBirth, year);
    if (!occurrence) continue;
    if (addLocalDays(occurrence, -daysBefore) === today) {
      return { birthdayYear: year, birthdayDate: occurrence };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timing — Wrike section 22
// ---------------------------------------------------------------------------

/**
 * Should this campaign be evaluated now?
 *
 * Both inputs are SALON-LOCAL, resolved by the caller from the campaign's
 * governing timezone (the location's when the campaign is location-scoped,
 * otherwise the business's). Server UTC never reaches this decision.
 *
 * The rule is simply: the local hour has reached the configured send hour, and
 * today's local date has not been run yet. `lastRunLocalDate` comes from the
 * durable `comms.campaign_runs` ledger, not from memory, so a restart or a
 * second API instance cannot re-run a completed day.
 */
export function shouldEvaluateToday(input: {
  status: CampaignStatus;
  todayLocalDate: string;
  localHour: number;
  sendAtLocalHour: number;
  lastRunLocalDate: string | null;
}): boolean {
  if (!EVALUATABLE_CAMPAIGN_STATUSES.includes(input.status)) return false;
  if (input.lastRunLocalDate === input.todayLocalDate) return false;
  return input.localHour >= input.sendAtLocalHour;
}

/**
 * Is `today` inside a promotion's configured window? Inclusive at both ends and
 * compared as calendar dates, so a promotion ending "today" still sends today.
 */
export function promotionWindowIsOpen(config: PromotionCampaignConfig, today: string): boolean {
  if (!isLocalDateString(today)) return false;
  return today >= config.startDate && today <= config.endDate;
}

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

export interface CampaignConfigValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a typed config against its declared campaign type. Returns every
 * problem at once rather than the first, so the owner fixes the form in one go.
 *
 * The API re-runs this on read as well as write: a row written by an older
 * migration, a script or a manual fix cannot feed the evaluator a shape it would
 * misinterpret.
 */
export function validateCampaignConfig(type: CampaignType, config: unknown): CampaignConfigValidation {
  const errors: string[] = [];
  const raw = (config ?? {}) as Record<string, unknown>;

  const requireInt = (field: string, value: unknown, bounds: { min: number; max: number }): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      errors.push(`${field} must be a whole number between ${bounds.min} and ${bounds.max}`);
    }
  };
  const requireNullableUuidish = (field: string, value: unknown): void => {
    if (value !== null && value !== undefined && typeof value !== 'string') {
      errors.push(`${field} must be an id or null`);
    }
  };

  switch (type) {
    case 'rebooking': {
      const statuses = raw['targetStatuses'];
      if (!Array.isArray(statuses) || statuses.length === 0) {
        errors.push('Choose at least one group of clients to reach');
      } else if (!statuses.every((s) => s === 'lapsed' || s === 'at_risk')) {
        errors.push('targetStatuses may only contain lapsed or at_risk');
      }
      requireInt('minOverdueDays', raw['minOverdueDays'], CAMPAIGN_BOUNDS.rebookingMinOverdueDays);
      requireNullableUuidish('serviceCategoryId', raw['serviceCategoryId']);
      break;
    }
    case 'birthday': {
      requireInt('daysBefore', raw['daysBefore'], CAMPAIGN_BOUNDS.birthdayDaysBefore);
      break;
    }
    case 'promotion': {
      const start = raw['startDate'];
      const end = raw['endDate'];
      if (typeof start !== 'string' || !isLocalDateString(start)) {
        errors.push('startDate must be a YYYY-MM-DD date');
      }
      if (typeof end !== 'string' || !isLocalDateString(end)) {
        errors.push('endDate must be a YYYY-MM-DD date');
      }
      if (
        typeof start === 'string' &&
        typeof end === 'string' &&
        isLocalDateString(start) &&
        isLocalDateString(end)
      ) {
        if (localDaysBetween(start, end) < 0) errors.push('endDate cannot be before startDate');
        // A promotion is a defined push, not a standing rule. Two years of
        // "promotion" is a configuration mistake worth catching.
        if (localDaysBetween(start, end) > 365) errors.push('A promotion window cannot exceed 365 days');
      }
      const statuses = raw['lapseStatuses'];
      if (statuses !== undefined && statuses !== null) {
        if (!Array.isArray(statuses) || !statuses.every((s) => s === 'lapsed' || s === 'at_risk')) {
          errors.push('lapseStatuses may only contain lapsed or at_risk');
        }
      }
      requireNullableUuidish('serviceCategoryId', raw['serviceCategoryId']);
      requireInt(
        'minCompletedVisits',
        raw['minCompletedVisits'],
        CAMPAIGN_BOUNDS.promotionMinCompletedVisits,
      );
      break;
    }
    case 'loyalty_milestone': {
      const metric = raw['metric'];
      if (metric !== 'completed_visits' && metric !== 'total_spend') {
        errors.push('metric must be completed_visits or total_spend');
      } else {
        requireInt(
          'threshold',
          raw['threshold'],
          metric === 'completed_visits'
            ? CAMPAIGN_BOUNDS.loyaltyVisitThreshold
            : CAMPAIGN_BOUNDS.loyaltySpendThresholdMinor,
        );
      }
      break;
    }
    default: {
      errors.push(`Unknown campaign type: ${String(type)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Sensible starting configuration per type, used by the "new campaign" form. */
export function defaultCampaignConfig(type: CampaignType, today: string): CampaignConfig {
  switch (type) {
    case 'rebooking':
      return { type, targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: null };
    case 'birthday':
      return { type, daysBefore: 0 };
    case 'promotion':
      return {
        type,
        startDate: today,
        endDate: addLocalDays(today, 14),
        lapseStatuses: [],
        serviceCategoryId: null,
        minCompletedVisits: 0,
      };
    case 'loyalty_milestone':
      return { type, metric: 'completed_visits', threshold: 10 };
  }
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface CampaignDetail {
  id: string;
  businessId: string;
  /** Null = business-wide. Set = that location's clients only. */
  locationId: string | null;
  locationName: string | null;
  campaignType: CampaignType;
  name: string;
  status: CampaignStatus;
  channel: CampaignChannel;
  messageTemplate: string;
  /** Email subject line. Ignored on WhatsApp/SMS. */
  messageSubject: string | null;
  sendAtLocalHour: number;
  /** The IANA timezone this campaign's timing is resolved in. */
  timezone: string;
  config: CampaignConfig;
  createdByUserProfileId: string | null;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt: string | null;
  /** Rolled-up delivery counts across every run, for the list view. */
  totals: CampaignTotals;
}

export interface CampaignTotals {
  runCount: number;
  queuedCount: number;
  suppressedCount: number;
  failedCount: number;
}

export interface CampaignRunSummary {
  id: string;
  campaignId: string;
  /** The salon-local date this run covered, `YYYY-MM-DD`. */
  runLocalDate: string;
  status: CampaignRunStatus;
  startedAt: string;
  completedAt: string | null;
  candidateCount: number;
  eligibleCount: number;
  queuedCount: number;
  suppressedCount: number;
  failedCount: number;
  /** Suppression reason -> count. The "why was nothing sent?" answer. */
  suppressionBreakdown: Record<string, number>;
  errorMessage: string | null;
}

/** One row of the owner-facing audience preview. Contact details are masked. */
export interface CampaignAudienceSample {
  clientId: string;
  displayName: string;
  /** Masked (`j***@example.com`, `+44 ***** **1234`) — enough to recognise, not to export. */
  maskedContact: string | null;
  /** Plain-language statement of why this client matched. */
  reason: string;
  eligible: boolean;
  /** Present when `eligible` is false. */
  suppressionReason: string | null;
}

export interface CampaignAudiencePreview {
  campaignId: string;
  campaignType: CampaignType;
  evaluatedOn: string;
  timezone: string;
  candidateCount: number;
  eligibleCount: number;
  suppressedCount: number;
  suppressionBreakdown: Record<string, number>;
  /** Capped sample, never the whole audience (Wrike section 34). */
  sample: CampaignAudienceSample[];
  sampleTruncated: boolean;
  /** True when the campaign would not run today at all (wrong window, disabled). */
  wouldNotRunToday: boolean;
  wouldNotRunReason: string | null;
  /** The template rendered with representative values. */
  renderedPreview: string;
}

export interface ListCampaignsResponse {
  campaigns: CampaignDetail[];
}

export interface CampaignResponse {
  campaign: CampaignDetail;
}

export interface ListCampaignRunsResponse {
  runs: CampaignRunSummary[];
}

export interface UpsertCampaignRequest {
  campaignType: CampaignType;
  name: string;
  locationId?: string | null;
  channel?: CampaignChannel;
  messageTemplate: string;
  messageSubject?: string | null;
  sendAtLocalHour?: number;
  config: Record<string, unknown>;
}

export interface UpdateCampaignStatusRequest {
  status: CampaignStatus;
}

/** Max preview rows returned to the owner. Counts are exact; the list is a sample. */
export const CAMPAIGN_PREVIEW_SAMPLE_LIMIT = 25;
