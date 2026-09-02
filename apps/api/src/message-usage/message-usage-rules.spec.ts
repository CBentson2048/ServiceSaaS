/**
 * The pure message-usage rules in @sheer/domain.
 *
 * The cases that matter most are the identity ones: a retry and a WhatsApp→SMS
 * fallback must produce the SAME logical key, because that key is the only thing
 * standing between the platform and double-billing a salon.
 */
import {
  BUSINESS_TIER_LIMITS,
  COUNTABLE_CHANNELS,
  MESSAGE_CAP_REACHED_REASON,
  DEFAULT_TIER_MESSAGE_POLICY,
  daysInMonth,
  decideMessageCap,
  isCountableMessage,
  logicalMessageKey,
  monthlyPeriodFor,
  resolveEntitlement,
  summariseUsage,
  type MessageEnforcementMode,
} from '@sheer/domain';

const BUSINESS = 'b1';
const period = monthlyPeriodFor('2026-09-15', 'Europe/London');

const summary = (
  used: number,
  overrides: Partial<{
    monthlyAllowance: number | null;
    isUnlimited: boolean;
    enforcementMode: MessageEnforcementMode;
    warnAtPercent: number;
  }> = {},
) =>
  summariseUsage({
    tier: 'pulse',
    period,
    used,
    entitlement: {
      monthlyAllowance: 100,
      isUnlimited: false,
      enforcementMode: 'allow_overage',
      warnAtPercent: 80,
      ...overrides,
    },
  });

// ===========================================================================
// Countability — Wrike sections 5, 33, 34
// ===========================================================================

describe('countability', () => {
  it('counts exactly the three external client channels', () => {
    expect(COUNTABLE_CHANNELS).toEqual(['whatsapp', 'sms', 'email']);
    for (const channel of COUNTABLE_CHANNELS) expect(isCountableMessage(channel)).toBe(true);
  });

  it('does NOT count in-app or push', () => {
    // Belt and braces: these also live in comms.notifications / push_deliveries
    // with their own dispatcher and never reach this accounting path at all.
    expect(isCountableMessage('in_app')).toBe(false);
    expect(isCountableMessage('push')).toBe(false);
  });

  it('does not count an unknown or missing channel', () => {
    expect(isCountableMessage(null)).toBe(false);
    expect(isCountableMessage(undefined)).toBe(false);
    expect(isCountableMessage('carrier_pigeon')).toBe(false);
  });
});

// ===========================================================================
// Logical identity — Wrike sections 4, 8, 9
// ===========================================================================

describe('logical message identity', () => {
  const base = { eventId: 'evt-1', businessId: BUSINESS, eventKey: 'booking_confirmation' };

  it('is IDENTICAL across a WhatsApp -> SMS fallback', () => {
    // The fallback is a NEW event row with the same dedupe_key and a different
    // channel. Both must resolve to one logical message, or the salon is billed
    // twice for one client message.
    const whatsapp = logicalMessageKey({ ...base, eventId: 'evt-wa', dedupeKey: 'campaign:x:client:1' });
    const sms = logicalMessageKey({ ...base, eventId: 'evt-sms', dedupeKey: 'campaign:x:client:1' });
    expect(sms).toBe(whatsapp);
  });

  it('is IDENTICAL across a fallback for an appointment-anchored message', () => {
    const whatsapp = logicalMessageKey({ ...base, eventId: 'evt-wa', appointmentId: 'appt-9' });
    const sms = logicalMessageKey({ ...base, eventId: 'evt-sms', appointmentId: 'appt-9' });
    expect(sms).toBe(whatsapp);
  });

  it('is IDENTICAL across retries of the same event', () => {
    const first = logicalMessageKey({ ...base, appointmentId: 'appt-9' });
    const retry = logicalMessageKey({ ...base, appointmentId: 'appt-9' });
    expect(retry).toBe(first);
  });

  it('separates different messages for the same appointment', () => {
    // A confirmation and a 24h reminder are two messages, not one.
    const confirmation = logicalMessageKey({ ...base, appointmentId: 'appt-9', eventKey: 'booking_confirmation' });
    const reminder = logicalMessageKey({ ...base, appointmentId: 'appt-9', eventKey: 'appointment_reminder_24h' });
    expect(reminder).not.toBe(confirmation);
  });

  it('separates businesses even on an identical dedupe key', () => {
    const a = logicalMessageKey({ ...base, businessId: 'biz-a', dedupeKey: 'same' });
    const b = logicalMessageKey({ ...base, businessId: 'biz-b', dedupeKey: 'same' });
    expect(a).not.toBe(b);
  });

  it('prefers the dedupe key over the appointment when both exist', () => {
    const key = logicalMessageKey({ ...base, dedupeKey: 'dk-1', appointmentId: 'appt-9' });
    expect(key).toBe(`dk:${BUSINESS}:dk-1`);
  });

  it('falls back to the event id for a message with neither', () => {
    expect(logicalMessageKey(base)).toBe('ev:evt-1');
  });

  it('follows the CHAIN ROOT for a message with neither, so a fallback counts once', () => {
    // Test G/H. The WhatsApp attempt is its own root; the SMS and email hops
    // carry that root forward. Before 0108 each hop was a new event id and so a
    // new logical message — one client message, three billed units.
    const whatsapp = logicalMessageKey({ ...base, eventId: 'evt-wa' });
    const sms = logicalMessageKey({ ...base, eventId: 'evt-sms', rootEventId: 'evt-wa' });
    const email = logicalMessageKey({ ...base, eventId: 'evt-email', rootEventId: 'evt-wa' });

    expect(whatsapp).toBe('ev:evt-wa');
    expect(sms).toBe(whatsapp);
    expect(email).toBe(whatsapp);
    expect(new Set([whatsapp, sms, email]).size).toBe(1);
  });

  it('keeps two genuinely separate rootless messages apart', () => {
    // The root must never MERGE messages: that would undercount, which is the
    // failure a synthesised dedupe key would have introduced.
    expect(logicalMessageKey({ ...base, eventId: 'evt-a' })).not.toBe(
      logicalMessageKey({ ...base, eventId: 'evt-b' }),
    );
  });

  it('ignores the root once a dedupe key or appointment exists', () => {
    // Precedence is unchanged: the root is strictly the last resort.
    expect(logicalMessageKey({ ...base, dedupeKey: 'dk-1', rootEventId: 'evt-root' })).toBe(
      `dk:${BUSINESS}:dk-1`,
    );
    expect(logicalMessageKey({ ...base, appointmentId: 'appt-9', rootEventId: 'evt-root' })).toBe(
      'ap:appt-9:booking_confirmation',
    );
  });

  it('treats a blank root as no root at all', () => {
    expect(logicalMessageKey({ ...base, rootEventId: '   ' })).toBe('ev:evt-1');
    expect(logicalMessageKey({ ...base, rootEventId: null })).toBe('ev:evt-1');
  });

  // -------------------------------------------------------------------------
  // Reminder OCCURRENCE identity (Wrike 4507284256 section 13)
  // -------------------------------------------------------------------------

  it('gives a reminder re-created for a NEW appointment time a NEW identity', () => {
    // Occurrence A: the 24h reminder for the original appointment time.
    const a = logicalMessageKey({
      ...base,
      appointmentId: 'appt-1',
      eventKey: 'appointment_reminder_24h',
      occurrenceKey: '2026-10-01T09:00:00Z',
    });
    // The appointment moves; occurrence B is a genuinely second message.
    const b = logicalMessageKey({
      ...base,
      appointmentId: 'appt-1',
      eventKey: 'appointment_reminder_24h',
      occurrenceKey: '2026-10-08T09:00:00Z',
    });

    expect(a).not.toBe(b);
    expect(a).toBe('ap:appt-1:appointment_reminder_24h@2026-10-01T09:00:00Z');
  });

  it('keeps ONE identity across a retry and a fallback of the SAME occurrence', () => {
    // Same occurrence anchor, different event rows and channels — one unit.
    const attempt = { ...base, appointmentId: 'appt-1', eventKey: 'appointment_reminder_24h', occurrenceKey: '2026-10-01T09:00:00Z' };
    const whatsapp = logicalMessageKey({ ...attempt, eventId: 'evt-wa' });
    const retry = logicalMessageKey({ ...attempt, eventId: 'evt-wa' });
    const smsFallback = logicalMessageKey({ ...attempt, eventId: 'evt-sms' });

    expect(new Set([whatsapp, retry, smsFallback]).size).toBe(1);
  });

  it('keeps reminder OFFSETS independently countable', () => {
    // Four reminders for one appointment at one time are four messages, and
    // adding the occurrence must not accidentally merge them.
    const at = '2026-10-01T09:00:00Z';
    const keys = ['appointment_reminder_2h', 'appointment_reminder_24h', 'appointment_reminder_48h', 'appointment_reminder_1w'].map(
      (eventKey) => logicalMessageKey({ ...base, appointmentId: 'appt-1', eventKey, occurrenceKey: at }),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it('leaves a one-shot appointment message unchanged when no occurrence applies', () => {
    // A booking confirmation supplies no occurrence, so its key is byte-for-byte
    // what it was before this change — the previous fix stays intact.
    expect(logicalMessageKey({ ...base, appointmentId: 'appt-1', eventKey: 'booking_confirmation' })).toBe(
      'ap:appt-1:booking_confirmation',
    );
    expect(logicalMessageKey({ ...base, appointmentId: 'appt-1', eventKey: 'rebooking_nudge' })).toBe(
      'ap:appt-1:rebooking_nudge',
    );
  });

  it('ignores an occurrence on a campaign key — dk: identities are untouched', () => {
    expect(logicalMessageKey({ ...base, dedupeKey: 'campaign:x:1', occurrenceKey: '2026-10-01T09:00:00Z' })).toBe(
      `dk:${BUSINESS}:campaign:x:1`,
    );
  });

  it('treats a blank occurrence as no occurrence', () => {
    expect(logicalMessageKey({ ...base, appointmentId: 'appt-1', occurrenceKey: '  ' })).toBe(
      'ap:appt-1:booking_confirmation',
    );
    expect(logicalMessageKey({ ...base, appointmentId: 'appt-1', occurrenceKey: null })).toBe(
      'ap:appt-1:booking_confirmation',
    );
  });

  it('never uses a provider message id — it changes per attempt', () => {
    const key = logicalMessageKey({ ...base, dedupeKey: 'dk-1' });
    expect(key).not.toMatch(/SM[0-9a-f]{10,}|provider/i);
  });
});

// ===========================================================================
// Period — Wrike sections 11, 16, 17, 18
// ===========================================================================

describe('monthly period', () => {
  it('spans the whole calendar month', () => {
    expect(monthlyPeriodFor('2026-09-15', 'Europe/London')).toMatchObject({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
    });
  });

  it('handles 31-day months, February and leap February', () => {
    expect(monthlyPeriodFor('2026-01-31', 'UTC').periodEnd).toBe('2026-01-31');
    expect(monthlyPeriodFor('2026-02-10', 'UTC').periodEnd).toBe('2026-02-28');
    expect(monthlyPeriodFor('2028-02-10', 'UTC').periodEnd).toBe('2028-02-29');
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it('puts the last and first instants of adjacent months in different periods', () => {
    const august = monthlyPeriodFor('2026-08-31', 'Europe/London');
    const september = monthlyPeriodFor('2026-09-01', 'Europe/London');
    expect(august.periodStart).toBe('2026-08-01');
    expect(september.periodStart).toBe('2026-09-01');
    expect(september.periodStart).not.toBe(august.periodStart);
  });

  it('is a calendar question, so a DST month is still one period', () => {
    // October 2026 contains the UK clock change. The period is still 1-31.
    expect(monthlyPeriodFor('2026-10-25', 'Europe/London')).toMatchObject({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    });
  });

  it('echoes the timezone it was resolved in', () => {
    expect(monthlyPeriodFor('2026-09-15', 'Pacific/Auckland').timezone).toBe('Pacific/Auckland');
  });
});

// ===========================================================================
// Usage formulas — Wrike section 12
// ===========================================================================

describe('usage formulas', () => {
  it('starts a period empty', () => {
    expect(summary(0)).toMatchObject({ used: 0, remaining: 100, overage: 0, status: 'ok' });
  });

  it('counts down the allowance', () => {
    expect(summary(1)).toMatchObject({ used: 1, remaining: 99, overage: 0 });
    expect(summary(998 - 898)).toMatchObject({ used: 100, remaining: 0 });
  });

  it('is exact at the boundary: used === allowance is AT LIMIT, not overage', () => {
    expect(summary(99)).toMatchObject({ remaining: 1, overage: 0, status: 'near_limit' });
    expect(summary(100)).toMatchObject({ remaining: 0, overage: 0, status: 'at_limit' });
    expect(summary(101)).toMatchObject({ remaining: 0, overage: 1, status: 'overage' });
    expect(summary(125)).toMatchObject({ remaining: 0, overage: 25, status: 'overage' });
  });

  it('never reports a negative remaining', () => {
    expect(summary(500).remaining).toBe(0);
  });

  it('warns from the configured percentage', () => {
    expect(summary(79).status).toBe('ok');
    expect(summary(80).status).toBe('near_limit');
    expect(summary(70, { warnAtPercent: 70 }).status).toBe('near_limit');
  });

  it('treats an unlimited tier as unlimited, not as a huge number', () => {
    const unlimited = summary(5000, { isUnlimited: true, monthlyAllowance: null });
    expect(unlimited).toMatchObject({
      allowance: null,
      remaining: null,
      overage: 0,
      percentUsed: null,
      status: 'unlimited',
    });
    // Usage is still tracked — an unlimited plan still wants its volume known.
    expect(unlimited.used).toBe(5000);
  });

  it('reports an unconfigured allowance honestly rather than as zero', () => {
    const unset = summary(42, { monthlyAllowance: null });
    expect(unset).toMatchObject({
      allowance: null,
      remaining: null,
      overage: 0,
      status: 'allowance_not_configured',
    });
    // Counting continues regardless: history is built from day one.
    expect(unset.used).toBe(42);
  });

  it('handles a configured ZERO allowance deterministically', () => {
    // 0 is a legitimate configured value and is NOT the same as unconfigured.
    expect(summary(0, { monthlyAllowance: 0 })).toMatchObject({
      allowance: 0,
      remaining: 0,
      overage: 0,
      status: 'at_limit',
    });
    expect(summary(1, { monthlyAllowance: 0 })).toMatchObject({ overage: 1, status: 'overage' });
  });
});

// ===========================================================================
// Enforcement — Wrike sections 24, 25, 38
// ===========================================================================

describe('enforcement', () => {
  it('never blocks in the shipped track_only default', () => {
    expect(decideMessageCap(summary(9999, { enforcementMode: 'track_only' }))).toEqual({
      allow: true,
      warn: true,
    });
  });

  it('never blocks in allow_overage', () => {
    expect(decideMessageCap(summary(9999, { enforcementMode: 'allow_overage' })).allow).toBe(true);
  });

  it('blocks at the cap only in block_at_cap', () => {
    const mode: MessageEnforcementMode = 'block_at_cap';
    expect(decideMessageCap(summary(99, { enforcementMode: mode })).allow).toBe(true);
    const blocked = decideMessageCap(summary(100, { enforcementMode: mode }));
    expect(blocked).toEqual({ allow: false, reason: MESSAGE_CAP_REACHED_REASON });
    expect(decideMessageCap(summary(101, { enforcementMode: mode })).allow).toBe(false);
  });

  it('gives a structured reason, never a fake provider failure', () => {
    expect(MESSAGE_CAP_REACHED_REASON).toBe('message_cap_reached');
  });

  it('never blocks an unlimited tier, whatever the mode', () => {
    expect(
      decideMessageCap(summary(999_999, { isUnlimited: true, monthlyAllowance: null, enforcementMode: 'block_at_cap' }))
        .allow,
    ).toBe(true);
  });

  it('never blocks when the allowance is unconfigured', () => {
    // The critical safety property: an unset limit must not silence a salon.
    expect(
      decideMessageCap(summary(10_000, { monthlyAllowance: null, enforcementMode: 'block_at_cap' })).allow,
    ).toBe(true);
  });

  it('ships non-blocking for every tier', () => {
    expect(DEFAULT_TIER_MESSAGE_POLICY.enforcementMode).toBe('track_only');
  });
});

// ===========================================================================
// Entitlement resolution — Wrike sections 2, 3, 20, 59
// ===========================================================================

describe('entitlement resolution', () => {
  it('uses the platform’s canonical per-tier caps, not a second copy', () => {
    // These are BUSINESS_TIER_LIMITS.messagingMonthlyCapPerLocation — the same
    // constant the API enforces location/column limits from and the plan card
    // already shows customers. Nothing stores a duplicate that could drift.
    expect(BUSINESS_TIER_LIMITS.spark.messagingMonthlyCapPerLocation).toBe(100);
    expect(BUSINESS_TIER_LIMITS.pulse.messagingMonthlyCapPerLocation).toBe(600);
    expect(BUSINESS_TIER_LIMITS.infinity.messagingMonthlyCapPerLocation).toBe(1000);
  });

  it('resolves a single-location account to the tier cap', () => {
    expect(
      resolveEntitlement({ tier: 'spark', perLocationCap: 100, locationCount: 1 }),
    ).toMatchObject({ monthlyAllowance: 100, isUnlimited: false, locationCount: 1 });
  });

  it('POOLS the per-location cap across an account’s locations', () => {
    // A three-location Infinity salon gets 3,000 in ONE shared pool — never
    // three separate 1,000-message allowances with three month boundaries.
    expect(
      resolveEntitlement({ tier: 'infinity', perLocationCap: 1000, locationCount: 3 }),
    ).toMatchObject({ monthlyAllowance: 3000, locationCount: 3 });
  });

  it('never resolves to zero locations', () => {
    // A zero multiplier would silently produce a zero allowance and read as
    // "immediately over" for an account that simply has no location row yet.
    expect(resolveEntitlement({ tier: 'pulse', perLocationCap: 600, locationCount: 0 }).monthlyAllowance).toBe(600);
  });

  it('treats a null cap as unlimited, which multiplication cannot change', () => {
    const unlimited = resolveEntitlement({ tier: 'infinity', perLocationCap: null, locationCount: 4 });
    expect(unlimited).toMatchObject({ monthlyAllowance: null, isUnlimited: true });
  });

  it('applies the stored policy, defaulting to non-blocking', () => {
    expect(resolveEntitlement({ tier: 'spark', perLocationCap: 100, locationCount: 1 }).enforcementMode).toBe(
      'track_only',
    );
    expect(
      resolveEntitlement({
        tier: 'spark',
        perLocationCap: 100,
        locationCount: 1,
        policy: { enforcementMode: 'block_at_cap', warnAtPercent: 90 },
      }),
    ).toMatchObject({ enforcementMode: 'block_at_cap', warnAtPercent: 90 });
  });

  it('produces a real summary end to end for each shipped tier', () => {
    for (const tier of ['spark', 'pulse', 'infinity'] as const) {
      const entitlement = resolveEntitlement({
        tier,
        perLocationCap: BUSINESS_TIER_LIMITS[tier].messagingMonthlyCapPerLocation,
        locationCount: 1,
      });
      const cap = BUSINESS_TIER_LIMITS[tier].messagingMonthlyCapPerLocation as number;

      expect(summariseUsage({ tier, period, used: 0, entitlement })).toMatchObject({
        allowance: cap,
        remaining: cap,
        overage: 0,
        status: 'ok',
      });
      expect(summariseUsage({ tier, period, used: cap, entitlement })).toMatchObject({
        remaining: 0,
        overage: 0,
        status: 'at_limit',
      });
      expect(summariseUsage({ tier, period, used: cap + 1, entitlement })).toMatchObject({
        remaining: 0,
        overage: 1,
        status: 'overage',
      });
    }
  });
});
