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
        return { data: [], error: null };
      },
    }),
  } as never);

  const config = { getOrThrow: () => 'x' } as unknown as ConfigService;
  return { service: new MessageUsageService(config), rpcs };
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
      message_usage_periods: [{ business_id: BUSINESS, period_start: currentPeriodStart(), used_count: 742 }],
    });
    const summary = await service.currentSummary(BUSINESS);
    // 742 used against a 600 allowance: remaining floors at 0, overage is 142.
    expect(summary.used).toBe(742);
    expect(summary.remaining).toBe(0);
    expect(summary.overage).toBe(142);
  });
});

// ===========================================================================
// Enforcement — Wrike sections 24, 25, 26
// ===========================================================================

describe('enforcement', () => {
  it('allows by default even far past the allowance', async () => {
    const { service } = build({
      message_usage_periods: [{ business_id: BUSINESS, period_start: currentPeriodStart(), used_count: 99_999 }],
    });
    expect((await service.checkCap(BUSINESS, 'whatsapp')).allow).toBe(true);
  });

  it('blocks at the cap only when the tier is configured to', async () => {
    const { service } = build({
      tier_message_policy: [{ tier: 'pulse', enforcement_mode: 'block_at_cap', warn_at_percent: 80 }],
      message_usage_periods: [{ business_id: BUSINESS, period_start: currentPeriodStart(), used_count: 600 }],
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
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('backfillUnrecordedSends'));
  });

  it('recovers unrecorded sends from the durable sent_at marker', async () => {
    // The provider accepted (sent_at is stamped) but accounting never landed.
    const { service, rpcs } = build({
      notification_events: [
        {
          id: 'evt-lost',
          business_id: BUSINESS,
          dedupe_key: 'campaign:x:1',
          appointment_id: null,
          event_key: 'campaign_promotion',
          channel: 'whatsapp',
          payload_json: { message_class: 'marketing' },
          sent_at: '2026-09-10T10:00:00Z',
        },
      ],
    });

    const result = await service.backfillUnrecordedSends(BUSINESS);
    expect(result).toMatchObject({ examined: 1, recorded: 1 });
    expect(rpcs[0].args['p_message_class']).toBe('marketing');
  });

  it('is idempotent: a second backfill records nothing new', async () => {
    const events = [
      {
        id: 'evt-lost',
        business_id: BUSINESS,
        dedupe_key: 'campaign:x:1',
        appointment_id: null,
        event_key: 'campaign_promotion',
        channel: 'whatsapp',
        payload_json: null,
        sent_at: '2026-09-10T10:00:00Z',
      },
    ];
    const { service } = build({ notification_events: events });
    await service.backfillUnrecordedSends(BUSINESS);
    expect(await service.backfillUnrecordedSends(BUSINESS)).toMatchObject({ recorded: 0 });
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

/** The period the service will resolve for "now", so fixtures line up with it. */
function currentPeriodStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
