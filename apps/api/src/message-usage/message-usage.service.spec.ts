/**
 * MessageUsageService — the send-path integration, tenancy and recovery.
 *
 * The pure formulas are asserted in message-usage-rules.spec.ts and the atomic /
 * exactly-once guarantees are asserted for real against Postgres in
 * supabase/tests/message_usage_accounting.sql. What these specs prove is the
 * layer between: that the right identity reaches the recorder, that non-countable
 * channels never do, that a salon can neither see another's usage nor alter its
 * own, and that an accounting failure is never silently swallowed.
 */
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, UserRole } from '@sheer/domain';
import { ALL_PERMISSIONS, BUSINESS_TIER_LIMITS } from '@sheer/domain';
import { MessageUsageService } from './message-usage.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BUSINESS = 'b0000000-0000-4000-8000-000000000002';

type Row = Record<string, unknown>;

interface RpcCall {
  fn: string;
  args: Row;
}

interface Fixture {
  businesses?: Row[];
  locations?: Row[];
  tier_message_policy?: Row[];
  message_usage_periods?: Row[];
  notification_events?: Row[];
  readErrors?: string[];
  rpcError?: string;
  /** Logical keys already in the ledger, so the RPC reports counted=false. */
  alreadyCounted?: string[];
}

function build(fixture: Fixture = {}) {
  const rpcs: RpcCall[] = [];
  const tables: Record<string, Row[]> = {
    businesses: fixture.businesses ?? [{ id: BUSINESS, tier: 'pulse', timezone: 'Europe/London' }],
    locations: fixture.locations ?? [{ id: 'loc-1', business_id: BUSINESS, is_active: true }],
    tier_message_policy: fixture.tier_message_policy ?? [
      { tier: 'pulse', enforcement_mode: 'track_only', warn_at_percent: 80 },
    ],
    message_usage_periods: fixture.message_usage_periods ?? [],
    notification_events: fixture.notification_events ?? [],
  };

  const makeChain = (table: string) => {
    let rows = (tables[table] ?? []).map((row) => ({ ...row }));
    const read = () =>
      fixture.readErrors?.includes(table)
        ? { data: null, error: { message: `${table} unavailable` } }
        : { data: rows, error: null };

    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          // `.select('id', { count: 'exact', head: true })` resolves directly.
          return {
            eq: (column: string, value: unknown) => {
              rows = rows.filter((row) => row[column] === value);
              return chain2();
            },
          };
        }
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      returns: () => chain,
      not: () => chain,
      in: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      maybeSingle: async () => {
        const result = read();
        return result.error ? result : { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve(read()).then(resolve, reject),
    });
    // The head-count branch needs its own terminator.
    function chain2(): Record<string, unknown> {
      const c: Record<string, unknown> = {};
      Object.assign(c, {
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return c;
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ count: rows.length, error: null }).then(resolve),
      });
      return c;
    }
    return chain;
  };

  const counted = new Set(fixture.alreadyCounted ?? []);

  mockedCreateClient.mockReturnValue({
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (fn: string, args: Row) => {
        rpcs.push({ fn, args });
        if (fixture.rpcError) return { data: null, error: { message: fixture.rpcError } };
        if (fn === 'record_message_usage') {
          const key = String(args['p_logical_message_key']);
          const isNew = !counted.has(key);
          counted.add(key);
          return { data: [{ counted: isNew, used_count: counted.size, overage_count: 0 }], error: null };
        }
        if (fn === 'find_unaccounted_sends') {
          // A faithful miniature of comms.find_unaccounted_sends (0108): the
          // ANTI-JOIN runs first and the limit is applied to what survives it,
          // ordered oldest-first with a keyset cursor. That ordering is the
          // property under test — a newest-first bound could never reach an old
          // gap once newer traffic exceeded it.
          const business = args['p_business_id'] as string | null;
          const afterSentAt = args['p_after_sent_at'] as string | null;
          const afterId = args['p_after_id'] as string | null;
          const rows = (tables['notification_events'] ?? [])
            .filter((row) => row['sent_at'] != null)
            .filter((row) => ['whatsapp', 'sms', 'email'].includes(String(row['channel'])))
            .filter((row) => !business || row['business_id'] === business)
            .map((row): Row => ({
              ...row,
              message_class:
                (row['payload_json'] as Row | null)?.['message_class'] === 'marketing'
                  ? 'marketing'
                  : 'transactional',
              root_event_id: row['root_event_id'] ?? null,
              logical_message_key: fakeLogicalKey(row),
            }))
            .filter((row) => !counted.has(String(row.logical_message_key)))
            .filter((row) => {
              if (!afterSentAt) return true;
              const a = `${String(row['sent_at'])}|${String(row['id'])}`;
              return a > `${afterSentAt}|${afterId ?? ''}`;
            })
            .sort((a, b) =>
              `${String(a['sent_at'])}|${String(a['id'])}`.localeCompare(
                `${String(b['sent_at'])}|${String(b['id'])}`,
              ),
            )
            .slice(0, Number(args['p_limit'] ?? 200));
          return { data: rows, error: null };
        }
        return { data: [], error: null };
      },
    }),
  } as never);

  const config = { getOrThrow: () => 'x' } as unknown as ConfigService;
  return { service: new MessageUsageService(config), rpcs };
}

/** The fake's mirror of logicalMessageKey, so the fake anti-join can filter. */
function fakeLogicalKey(row: Row): string {
  const dedupe = String(row['dedupe_key'] ?? '').trim();
  if (dedupe) return `dk:${String(row['business_id'])}:${dedupe}`;
  if (row['appointment_id']) return `ap:${String(row['appointment_id'])}:${String(row['event_key'])}`;
  return `ev:${String(row['root_event_id'] ?? row['id'])}`;
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  const roles: UserRole[] = overrides.roles ?? ['owner'];
  return {
    id: 'u1',
    roles,
    primaryRole: roles[0],
    businessId: BUSINESS,
    allowedLocationIds: ['loc-1'],
    locationScope: 'all',
    locations: [],
    profile: { firstName: 'O', lastName: 'O', email: 'o@example.com' },
    permissions: [...ALL_PERMISSIONS],
    ...overrides,
  } as AuthUser;
}

const send = (overrides: Partial<Parameters<MessageUsageService['recordSend']>[0]> = {}) => ({
  eventId: 'evt-1',
  businessId: BUSINESS,
  eventKey: 'booking_confirmation',
  channel: 'whatsapp',
  appointmentId: 'appt-1',
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

// ===========================================================================
// Countability at the send path — Wrike sections 5, 34
// ===========================================================================

describe('countability', () => {
  it('records a WhatsApp, SMS or email send', async () => {
    for (const channel of ['whatsapp', 'sms', 'email']) {
      const { service, rpcs } = build();
      await service.recordSend(send({ channel }));
      expect(rpcs.filter((r) => r.fn === 'record_message_usage')).toHaveLength(1);
    }
  });

  it('does NOT record an in-app or push channel', async () => {
    for (const channel of ['in_app', 'push']) {
      const { service, rpcs } = build();
      const result = await service.recordSend(send({ channel }));
      expect(result).toEqual({ counted: false });
      expect(rpcs).toHaveLength(0);
    }
  });

  it('does not even check the cap for a non-countable channel', async () => {
    const { service, rpcs } = build();
    expect(await service.checkCap(BUSINESS, 'push')).toEqual({ allow: true, warn: false });
    expect(rpcs).toHaveLength(0);
  });
});

// ===========================================================================
// Identity reaching the recorder — Wrike sections 8, 9, 10
// ===========================================================================

describe('logical identity at the send path', () => {
  it('sends ONE key for a WhatsApp attempt and its SMS fallback', async () => {
    const { service, rpcs } = build();
    // Two DIFFERENT event rows — which is what a fallback really is.
    await service.recordSend(send({ eventId: 'evt-whatsapp', channel: 'whatsapp' }));
    await service.recordSend(send({ eventId: 'evt-sms', channel: 'sms' }));

    const keys = rpcs.map((r) => r.args['p_logical_message_key']);
    expect(keys[0]).toBe(keys[1]);
    // The SECOND call is reported as already counted — one unit for one message.
    expect(await service.recordSend(send({ eventId: 'evt-sms', channel: 'sms' }))).toEqual({ counted: false });
  });

  it('sends ONE key across retries of the same event', async () => {
    const { service, rpcs } = build();
    await service.recordSend(send());
    await service.recordSend(send());
    expect(rpcs[0].args['p_logical_message_key']).toBe(rpcs[1].args['p_logical_message_key']);
  });

  it('records the final channel without letting it change the identity', async () => {
    const { service, rpcs } = build();
    await service.recordSend(send({ eventId: 'evt-sms', channel: 'sms' }));
    expect(rpcs[0].args['p_final_channel']).toBe('sms');
    expect(String(rpcs[0].args['p_logical_message_key'])).not.toContain('sms');
  });

  it('passes the event id for traceability but never as the identity', async () => {
    const { service, rpcs } = build();
    await service.recordSend(send({ dedupeKey: 'campaign:x:1' }));
    expect(rpcs[0].args['p_notification_event_id']).toBe('evt-1');
    expect(rpcs[0].args['p_logical_message_key']).toBe(`dk:${BUSINESS}:campaign:x:1`);
  });
});

// ===========================================================================
// Entitlement — Wrike sections 2, 3, 59
// ===========================================================================

describe('entitlement', () => {
  it('resolves the allowance from the canonical tier constant', async () => {
    const { service } = build();
    const summary = await service.currentSummary(BUSINESS);
    expect(summary.allowance).toBe(BUSINESS_TIER_LIMITS.pulse.messagingMonthlyCapPerLocation);
    expect(summary.tier).toBe('pulse');
  });

  it('POOLS the per-location cap across an account’s locations', async () => {
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'infinity', timezone: 'Europe/London' }],
      locations: [
        { id: 'loc-1', business_id: BUSINESS, is_active: true },
        { id: 'loc-2', business_id: BUSINESS, is_active: true },
        { id: 'loc-3', business_id: BUSINESS, is_active: true },
      ],
      tier_message_policy: [{ tier: 'infinity', enforcement_mode: 'track_only', warn_at_percent: 80 }],
    });
    // 1,000 per location x 3 = 3,000 in ONE shared pool.
    expect((await service.currentSummary(BUSINESS)).allowance).toBe(3000);
  });

  it('counts only ACTIVE locations', async () => {
    const { service } = build({
      locations: [
        { id: 'loc-1', business_id: BUSINESS, is_active: true },
        { id: 'loc-2', business_id: BUSINESS, is_active: false },
      ],
    });
    expect((await service.currentSummary(BUSINESS)).allowance).toBe(600);
  });

  it('reports zero used before any message this period', async () => {
    const { service } = build();
    expect(await service.currentSummary(BUSINESS)).toMatchObject({ used: 0, overage: 0, status: 'ok' });
  });

  it('reads used from the stored counter, never by counting the ledger', async () => {
    const { service } = build({
      message_usage_periods: [snapshotPeriod({ used_count: 742 })],
    });
    const summary = await service.currentSummary(BUSINESS);
    // 742 used against a 600 allowance: remaining floors at 0, overage is 142.
    expect(summary.used).toBe(742);
    expect(summary.remaining).toBe(0);
    expect(summary.overage).toBe(142);
  });
});

// ===========================================================================
// Reminder occurrence counting — Wrike 4507284256 section 13, tests 1,2,3,6,7,8
// ===========================================================================

describe('reminder occurrence counting', () => {
  const OCCURRENCE_A = '2026-10-01T09:00:00Z';
  const OCCURRENCE_B = '2026-10-08T09:00:00Z';

  const reminder = (over: Partial<Parameters<MessageUsageService['recordSend']>[0]> = {}) =>
    send({
      eventKey: 'appointment_reminder_24h',
      appointmentId: 'appt-1',
      occurrenceKey: OCCURRENCE_A,
      ...over,
    });

  /** How many DISTINCT logical messages the recorder was asked to count. */
  const counted = (rpcs: Array<{ fn: string; args: Record<string, unknown> }>) =>
    new Set(
      rpcs.filter((r) => r.fn === 'record_message_usage').map((r) => String(r.args['p_logical_message_key'])),
    );

  it('counts a normal reminder once (test 1)', async () => {
    const { service, rpcs } = build();
    expect(await service.recordSend(reminder({ eventId: 'evt-a-wa' }))).toEqual({ counted: true });
    expect(counted(rpcs).size).toBe(1);
  });

  it('counts a retry of the same row once (test 2)', async () => {
    const { service, rpcs } = build();
    await service.recordSend(reminder({ eventId: 'evt-a-wa' }));
    expect(await service.recordSend(reminder({ eventId: 'evt-a-wa' }))).toEqual({ counted: false });
    expect(counted(rpcs).size).toBe(1);
  });

  it('counts a WhatsApp -> SMS fallback of one occurrence once (test 3)', async () => {
    const { service, rpcs } = build();
    // A fallback is a DIFFERENT event row carrying the SAME occurrence anchor.
    await service.recordSend(reminder({ eventId: 'evt-a-wa', channel: 'whatsapp' }));
    expect(await service.recordSend(reminder({ eventId: 'evt-a-sms', channel: 'sms' }))).toEqual({
      counted: false,
    });
    expect(counted(rpcs).size).toBe(1);
  });

  it('counts a reminder re-created for a NEW appointment time as a SECOND unit (test 6)', async () => {
    const { service, rpcs } = build();
    await service.recordSend(reminder({ eventId: 'evt-a-wa' }));
    // The appointment moved, so this is a genuinely different message to the
    // client. Before this fix it collapsed onto occurrence A and was free.
    expect(
      await service.recordSend(reminder({ eventId: 'evt-b-wa', occurrenceKey: OCCURRENCE_B })),
    ).toEqual({ counted: true });
    expect(counted(rpcs).size).toBe(2);
  });

  it('does not let a fallback on the NEW occurrence become a third unit (test 7)', async () => {
    const { service, rpcs } = build();
    await service.recordSend(reminder({ eventId: 'evt-a-wa' }));
    await service.recordSend(reminder({ eventId: 'evt-a-sms', channel: 'sms' }));
    await service.recordSend(reminder({ eventId: 'evt-b-wa', occurrenceKey: OCCURRENCE_B }));
    expect(
      await service.recordSend(
        reminder({ eventId: 'evt-b-sms', channel: 'sms', occurrenceKey: OCCURRENCE_B }),
      ),
    ).toEqual({ counted: false });

    // Two occurrences, two units — four provider sends, two logical messages.
    expect(counted(rpcs).size).toBe(2);
  });

  it('keeps the four reminder offsets independently countable (test 8)', async () => {
    const { service, rpcs } = build();
    for (const eventKey of [
      'appointment_reminder_1w',
      'appointment_reminder_48h',
      'appointment_reminder_24h',
      'appointment_reminder_2h',
    ]) {
      await service.recordSend(reminder({ eventId: `evt-${eventKey}`, eventKey }));
    }
    expect(counted(rpcs).size).toBe(4);
  });

  it('leaves the booking confirmation identity untouched (test 9)', async () => {
    const { service, rpcs } = build();
    await service.recordSend(send({ eventId: 'evt-c', eventKey: 'booking_confirmation', appointmentId: 'appt-1' }));
    // No occurrence suffix: exactly the key the previous fix relies on.
    expect(rpcs[0].args['p_logical_message_key']).toBe('ap:appt-1:booking_confirmation');
  });

  it('leaves campaign identities untouched (test 10)', async () => {
    const { service, rpcs } = build();
    await service.recordSend(send({ dedupeKey: 'campaign:x:1', appointmentId: null }));
    expect(rpcs[0].args['p_logical_message_key']).toBe(`dk:${BUSINESS}:campaign:x:1`);
  });
});

// ===========================================================================
// V1.1 entitlement semantics — the snapshot is authoritative until the next
// period (Wrike section 6). Tests I, J, K, L.
// ===========================================================================

describe('period entitlement semantics', () => {
  it('prices the period from its SNAPSHOT, not from today\u2019s live tier (test I: upgrade)', async () => {
    // The period opened on Spark (100). The account has since upgraded to Pulse.
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'pulse', timezone: 'Europe/London' }],
      tier_message_policy: [
        { tier: 'spark', enforcement_mode: 'track_only', warn_at_percent: 80 },
        { tier: 'pulse', enforcement_mode: 'track_only', warn_at_percent: 80 },
      ],
      message_usage_periods: [snapshotPeriod({ tier_key: 'spark', allowance: 100, used_count: 140 })],
    });

    const summary = await service.currentSummary(BUSINESS);
    // The month keeps the allowance it was opened with, so the panel and the
    // stored overage counter finally describe the same month.
    expect(summary.allowance).toBe(100);
    expect(summary.tier).toBe('spark');
    expect(summary.overage).toBe(40);
    expect(summary.remaining).toBe(0);
  });

  it('does not let a mid-month DOWNGRADE retro-price the period (test J)', async () => {
    // Opened on Infinity (1000); the account has since dropped to Spark.
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'spark', timezone: 'Europe/London' }],
      tier_message_policy: [
        { tier: 'infinity', enforcement_mode: 'track_only', warn_at_percent: 80 },
        { tier: 'spark', enforcement_mode: 'track_only', warn_at_percent: 80 },
      ],
      message_usage_periods: [snapshotPeriod({ tier_key: 'infinity', allowance: 1000, used_count: 700 })],
    });

    const summary = await service.currentSummary(BUSINESS);
    // Before this change the owner saw "700 against 100 — 600 over" while the
    // stored evidence said zero overage. Now there is one answer.
    expect(summary.allowance).toBe(1000);
    expect(summary.overage).toBe(0);
    expect(summary.status).toBe('ok');
  });

  it('ignores a location added or disabled mid-period (test K)', async () => {
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'infinity', timezone: 'Europe/London' }],
      tier_message_policy: [{ tier: 'infinity', enforcement_mode: 'track_only', warn_at_percent: 80 }],
      // Three locations are active RIGHT NOW; the period was opened with one.
      locations: [
        { id: 'loc-1', business_id: BUSINESS, is_active: true },
        { id: 'loc-2', business_id: BUSINESS, is_active: true },
        { id: 'loc-3', business_id: BUSINESS, is_active: true },
      ],
      message_usage_periods: [
        snapshotPeriod({ tier_key: 'infinity', allowance: 1000, location_count: 1, used_count: 10 }),
      ],
    });

    expect((await service.currentSummary(BUSINESS)).allowance).toBe(1000);
  });

  it('enforces the cap against the SNAPSHOT allowance, not the live one', async () => {
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'infinity', timezone: 'Europe/London' }],
      tier_message_policy: [{ tier: 'spark', enforcement_mode: 'block_at_cap', warn_at_percent: 80 }],
      // Opened on Spark at 100 and already there; the account is now Infinity.
      message_usage_periods: [snapshotPeriod({ tier_key: 'spark', allowance: 100, used_count: 100 })],
    });

    // The gate and the ledger agree, which is the whole point: an upgrade takes
    // effect next period, so it cannot silently un-block a period mid-flight.
    expect(await service.checkCap(BUSINESS, 'whatsapp')).toEqual({
      allow: false,
      reason: 'message_cap_reached',
    });
  });

  it('falls back to the LIVE entitlement only before the period exists', async () => {
    // No period row: nothing has been sent this month, so there is no snapshot
    // to honour. The live value is what the first send will seed it with.
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'spark', timezone: 'Europe/London' }],
      tier_message_policy: [{ tier: 'spark', enforcement_mode: 'track_only', warn_at_percent: 80 }],
    });
    const summary = await service.currentSummary(BUSINESS);
    expect(summary.allowance).toBe(BUSINESS_TIER_LIMITS.spark.messagingMonthlyCapPerLocation);
    expect(summary.used).toBe(0);
  });

  it('never creates a period row just because usage was READ', async () => {
    const { service, rpcs } = build();
    await service.currentSummary(BUSINESS);
    // A read that wrote billing evidence would let merely opening the panel
    // decide which allowance the month is priced at.
    expect(rpcs).toHaveLength(0);
  });

  it('reports the same allowance for a month while current and once historical (test L)', async () => {
    const { service } = build({
      businesses: [{ id: BUSINESS, tier: 'infinity', timezone: 'Europe/London' }],
      tier_message_policy: [{ tier: 'spark', enforcement_mode: 'track_only', warn_at_percent: 80 }],
      message_usage_periods: [
        snapshotPeriod({ tier_key: 'spark', allowance: 100, used_count: 140, overage_count: 40 }),
      ],
    });

    const usage = await service.usageForActor(actor());
    // History renders straight from the snapshot; `current` now does too, so the
    // month cannot change its story the moment it stops being the current one.
    expect(usage.current.allowance).toBe(100);
    expect(usage.current.tier).toBe('spark');
    expect(usage.current.overage).toBe(40);
  });
});

// ===========================================================================
// Enforcement — Wrike sections 24, 25, 26
// ===========================================================================

describe('enforcement', () => {
  it('allows by default even far past the allowance', async () => {
    const { service } = build({
      message_usage_periods: [snapshotPeriod({ used_count: 99_999 })],
    });
    expect((await service.checkCap(BUSINESS, 'whatsapp')).allow).toBe(true);
  });

  it('blocks at the cap only when the tier is configured to', async () => {
    const { service } = build({
      tier_message_policy: [{ tier: 'pulse', enforcement_mode: 'block_at_cap', warn_at_percent: 80 }],
      message_usage_periods: [snapshotPeriod({ used_count: 600 })],
    });
    expect(await service.checkCap(BUSINESS, 'whatsapp')).toEqual({
      allow: false,
      reason: 'message_cap_reached',
    });
  });

  it('ALLOWS when the usage lookup fails — a broken counter must not silence a salon', async () => {
    const { service } = build({ readErrors: ['businesses'] });
    expect((await service.checkCap(BUSINESS, 'whatsapp')).allow).toBe(true);
  });
});

// ===========================================================================
// Accounting failure — Wrike sections 27, 28, 29
// ===========================================================================

describe('accounting failure', () => {
  it('never throws into the send path', async () => {
    const { service } = build({ rpcError: 'connection reset' });
    await expect(service.recordSend(send())).resolves.toBeNull();
  });

  it('does not silently swallow — it logs the logical key for recovery', async () => {
    const { service } = build({ rpcError: 'connection reset' });
    const spy = jest.spyOn(
      (service as unknown as { logger: { error: (m: string) => void } }).logger,
      'error',
    );
    await service.recordSend(send({ dedupeKey: 'campaign:x:1' }));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`dk:${BUSINESS}:campaign:x:1`));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('recoverUnaccountedSends'));
  });

  it('recovers unrecorded sends from the durable sent_at marker', async () => {
    // The provider accepted (sent_at is stamped) but accounting never landed.
    const { service, rpcs } = build({
      notification_events: [
        sentEvent({ id: 'evt-lost', dedupe_key: 'campaign:x:1', payload_json: { message_class: 'marketing' } }),
      ],
    });

    const result = await service.recoverUnaccountedSends({ businessId: BUSINESS });
    expect(result).toMatchObject({ found: 1, recorded: 1, failed: 0 });
    const record = rpcs.find((r) => r.fn === 'record_message_usage');
    expect(record?.args['p_message_class']).toBe('marketing');
  });

  it('is idempotent: a second recovery pass records nothing new', async () => {
    const { service } = build({ notification_events: [sentEvent({ id: 'evt-lost', dedupe_key: 'campaign:x:1' })] });
    await service.recoverUnaccountedSends({ businessId: BUSINESS });
    // Test D: the ledger has the key now, so the anti-join no longer offers it.
    expect(await service.recoverUnaccountedSends({ businessId: BUSINESS })).toMatchObject({
      found: 0,
      recorded: 0,
    });
  });

  it('counts once when two recovery workers race the same gap (test E)', async () => {
    const { service, rpcs } = build({ notification_events: [sentEvent({ id: 'evt-lost', dedupe_key: 'campaign:x:1' })] });
    // Both workers see the gap — they run the anti-join before either records.
    const [a, b] = await Promise.all([
      service.recoverUnaccountedSends({ businessId: BUSINESS }),
      service.recoverUnaccountedSends({ businessId: BUSINESS }),
    ]);
    // Exactly one of them counted it. The other's RPC returned counted=false,
    // which is the ledger's UNIQUE doing the work no application lock could.
    expect(a.recorded + b.recorded).toBe(1);
    expect(rpcs.filter((r) => r.fn === 'record_message_usage')).toHaveLength(2);
  });

  it('posts a recovered send into the period it was SENT in, not today (test B)', async () => {
    // Sent 30 September at 23:40 London; recovered now, in a later month.
    const { service, rpcs } = build({
      notification_events: [
        sentEvent({ id: 'evt-sep', dedupe_key: 'sep-msg', sent_at: '2026-09-30T22:40:00Z' }),
      ],
    });
    await service.recoverUnaccountedSends({ businessId: BUSINESS });
    const record = rpcs.find((r) => r.fn === 'record_message_usage');
    expect(record?.args['p_period_start']).toBe('2026-09-01');
    expect(record?.args['p_period_end']).toBe('2026-09-30');
  });

  it('finds an OLD gap that sits behind newer already-accounted sends (test C)', async () => {
    // 5 newer sends, all already counted, plus one old gap behind them. A
    // newest-first window of size 5 could never reach the gap; the anti-join
    // never offers the accounted five in the first place.
    const newer = Array.from({ length: 5 }, (_, i) =>
      sentEvent({ id: `evt-new-${i}`, dedupe_key: `new-${i}`, sent_at: `2026-09-2${i}T10:00:00Z` }),
    );
    const { service, rpcs } = build({
      notification_events: [sentEvent({ id: 'evt-old', dedupe_key: 'old-gap', sent_at: '2026-09-01T10:00:00Z' }), ...newer],
      alreadyCounted: newer.map((e) => `dk:${BUSINESS}:${String(e.dedupe_key)}`),
    });

    const result = await service.recoverUnaccountedSends({ businessId: BUSINESS, limit: 5 });
    expect(result).toMatchObject({ found: 1, recorded: 1 });
    expect(rpcs.find((r) => r.fn === 'record_message_usage')?.args['p_logical_message_key']).toBe(
      `dk:${BUSINESS}:old-gap`,
    );
  });

  it('recovery never reaches a provider — it only reads and records', async () => {
    const { service, rpcs } = build({ notification_events: [sentEvent({ id: 'evt-lost', dedupe_key: 'k' })] });
    await service.recoverUnaccountedSends({ businessId: BUSINESS });
    // The only writes it can make are accounting RPCs. There is no send path
    // here at all: the service has no provider dependency to call.
    expect(rpcs.every((r) => ['find_unaccounted_sends', 'record_message_usage'].includes(r.fn))).toBe(true);
  });

  it('requires owner access to run a manual recovery pass', async () => {
    const { service } = build();
    await expect(service.recoverForActor(actor({ roles: ['manager'] }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

// ===========================================================================
// Tenancy — Wrike sections 43, 45, 68
// ===========================================================================

describe('tenancy and access', () => {
  it('requires owner access to read usage', async () => {
    const { service } = build();
    for (const role of ['manager', 'stylist', 'client'] as UserRole[]) {
      await expect(service.usageForActor(actor({ roles: [role] }))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('reads usage only for the acting business', async () => {
    const { service } = build({
      message_usage_periods: [
        { business_id: BUSINESS, period_start: currentPeriodStart(), used_count: 5, period_end: '2026-09-30', tier_key: 'pulse', allowance: 600, is_unlimited: false, overage_count: 0 },
        { business_id: OTHER_BUSINESS, period_start: '2026-08-01', used_count: 999, period_end: '2026-08-31', tier_key: 'pulse', allowance: 600, is_unlimited: false, overage_count: 0 },
      ],
    });
    const usage = await service.usageForActor(actor());
    expect(usage.current.used).toBe(5);
    // The other tenant's period is filtered out before it can reach history.
    expect(usage.history.every((h) => h.used !== 999)).toBe(true);
  });

  it('requires owner access to reconcile', async () => {
    const { service } = build();
    await expect(service.reconcile(actor({ roles: ['manager'] }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('exposes counts, never message content or client identity', async () => {
    const { service } = build({
      message_usage_periods: [
        { business_id: BUSINESS, period_start: currentPeriodStart(), period_end: '2026-09-30', tier_key: 'pulse', allowance: 600, is_unlimited: false, used_count: 5, overage_count: 0 },
      ],
    });
    const usage = await service.usageForActor(actor());
    const serialised = JSON.stringify(usage);
    for (const leak of ['body', 'recipient', 'phone', 'clientProfileId']) {
      expect(serialised).not.toContain(leak);
    }
  });
});

/**
 * The period the service will resolve for "now", so fixtures line up with it.
 *
 * Resolved in Europe/London — the fixture business's timezone — because the
 * service resolves the month there too. Using UTC would silently disagree for a
 * day either side of a month boundary.
 */
function currentPeriodStart(): string {
  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .split('-');
  return `${year}-${month}-01`;
}

/**
 * A period row as `record_message_usage` actually writes it — WITH the snapshot.
 *
 * Fixtures must carry it now: since the snapshot is authoritative for the whole
 * period, a row without one is not a leaner fixture, it is a period whose
 * allowance was never resolved.
 */
function snapshotPeriod(overrides: Row = {}): Row {
  return {
    business_id: BUSINESS,
    period_start: currentPeriodStart(),
    period_end: '2026-09-30',
    tier_key: 'pulse',
    allowance: 600,
    is_unlimited: false,
    location_count: 1,
    used_count: 0,
    overage_count: 0,
    ...overrides,
  };
}

/** A notification event the provider accepted — `sent_at` is the durable proof. */
function sentEvent(overrides: Row = {}): Row {
  return {
    id: 'evt-lost',
    business_id: BUSINESS,
    dedupe_key: null,
    appointment_id: null,
    root_event_id: null,
    event_key: 'campaign_promotion',
    channel: 'whatsapp',
    payload_json: null,
    sent_at: '2026-09-10T10:00:00Z',
    ...overrides,
  };
}
