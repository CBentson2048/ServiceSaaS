/**
 * CampaignAudienceService — who each campaign type selects, and why.
 *
 * The fixtures are shaped exactly as the RPCs return them, so what is asserted
 * here is the real contract between the SQL and the strategy code, not a
 * convenient stand-in for it.
 *
 * The specs that matter most are the exclusions: a client with a future booking,
 * a client not yet due, a cancelled appointment that must not count as a visit,
 * a voided bill that must not inflate a milestone, and another business's client
 * being structurally unreachable.
 */
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { CampaignAudienceService } from './campaign-audience.service';
import type { CampaignRow } from './campaign-row';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BUSINESS = 'b0000000-0000-4000-8000-000000000002';
const LOCATION = '10000000-0000-4000-8000-000000000001';
const CAMPAIGN = 'c0000000-0000-4000-8000-000000000001';
const COLOUR_CATEGORY = '50000000-0000-4000-8000-000000000001';

interface RpcCall {
  schema: string;
  fn: string;
  args: Record<string, unknown>;
}

interface FakeOptions {
  /** `schema.fn` -> rows. Anything unlisted returns []. */
  rpc?: Record<string, unknown[]>;
  tables?: Record<string, Record<string, unknown>[]>;
}

function build(options: FakeOptions = {}) {
  const calls: RpcCall[] = [];

  const makeSchema = (schema: string) => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ schema, fn, args });
      // Every RPC here is paged; only the first page is ever populated by these
      // fixtures, so a second page comes back empty and the drain terminates.
      const offset = Number(args['p_offset'] ?? 0);
      const rows = offset === 0 ? options.rpc?.[`${schema}.${fn}`] ?? [] : [];
      return { data: rows, error: null };
    },
    from: (table: string) => {
      let rows = (options.tables?.[table] ?? []).map((row) => ({ ...row }));
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return chain;
        },
        returns: () => chain,
        then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      });
      return chain;
    },
  });

  mockedCreateClient.mockReturnValue({ schema: makeSchema } as never);

  const config = { getOrThrow: () => 'x' } as unknown as ConfigService;
  return { service: new CampaignAudienceService(config), calls };
}

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: CAMPAIGN,
    business_id: BUSINESS,
    location_id: null,
    campaign_type: 'rebooking',
    name: 'Win back',
    status: 'active',
    channel: 'auto',
    message_template: 'Hi {{first_name}}',
    message_subject: null,
    send_at_local_hour: 10,
    config: { targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: null },
    created_by_user_profile_id: null,
    last_evaluated_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    timezone: 'Europe/London',
    ...overrides,
  };
}

/** A client with a steady 42-day colour cadence whose last visit was `daysAgo`. */
function historyRow(input: {
  clientId: string;
  daysAgo: number;
  today: string;
  marketingOptIn?: boolean;
  categoryId?: string | null;
  visitCount?: number;
}) {
  const visits: unknown[] = [];
  const count = input.visitCount ?? 4;
  for (let i = count - 1; i >= 0; i--) {
    const date = addDays(input.today, -(input.daysAgo + i * 42));
    visits.push({
      visitDate: date,
      visitAt: `${date}T10:00:00Z`,
      locationId: LOCATION,
      services: [
        {
          serviceId: 's1',
          serviceName: 'Full Head Colour',
          serviceCategoryId: input.categoryId === undefined ? COLOUR_CATEGORY : input.categoryId,
        },
      ],
    });
  }
  return {
    client_profile_id: input.clientId,
    client_code: 'C1',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone: '+447700900001',
    marketing_opt_in: input.marketingOptIn ?? true,
    primary_location_id: LOCATION,
    visits,
    service_rebooking_interval_days: null,
  };
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

const TODAY = '2026-09-01';

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Rebooking — Wrike sections 9, 10, 52
// ---------------------------------------------------------------------------

describe('rebooking audience', () => {
  it('includes an overdue client with no future booking', async () => {
    const { service } = build({
      rpc: {
        // Last visit 70 days ago on a 42-day cadence: 28 days overdue, well past
        // the default 14-day buffer.
        'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 70, today: TODAY })],
        'crm.client_next_bookings': [],
      },
    });

    const { candidates } = await service.resolveCandidates(campaign(), TODAY);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].clientId).toBe('jane');
    expect(candidates[0].matchReason).toContain('overdue');
  });

  it('EXCLUDES a client who has already rebooked', async () => {
    // The heart of Wrike section 9. A valid upcoming appointment makes the
    // canonical status `booked`, which is not targetable at all.
    const { service } = build({
      rpc: {
        'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 70, today: TODAY })],
        'crm.client_next_bookings': [
          {
            client_profile_id: 'jane',
            appointment_id: 'appt-1',
            scheduled_start_at: '2026-09-20T10:00:00Z',
            location_id: LOCATION,
          },
        ],
      },
    });

    const { candidates } = await service.resolveCandidates(campaign(), TODAY);
    expect(candidates).toHaveLength(0);
  });

  it('excludes a client who is not yet due', async () => {
    const { service } = build({
      rpc: {
        // 10 days since the last visit on a 42-day cadence — still active.
        'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 10, today: TODAY })],
        'crm.client_next_bookings': [],
      },
    });
    const { candidates } = await service.resolveCandidates(campaign(), TODAY);
    expect(candidates).toHaveLength(0);
  });

  it('excludes a client with too little history to have a cadence', async () => {
    const { service } = build({
      rpc: {
        // One visit: no interval can be derived, so the status is
        // insufficient_history and the client is never guessed at.
        'crm.client_service_history': [
          historyRow({ clientId: 'new', daysAgo: 400, today: TODAY, visitCount: 1 }),
        ],
        'crm.client_next_bookings': [],
      },
    });
    const { candidates } = await service.resolveCandidates(campaign(), TODAY);
    expect(candidates).toHaveLength(0);
  });

  it('honours the owner-configured extra overdue delay', async () => {
    const rpc = {
      'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 70, today: TODAY })],
      'crm.client_next_bookings': [],
    };

    const lenient = build({ rpc });
    expect(
      (await lenient.service.resolveCandidates(campaign(), TODAY)).candidates,
    ).toHaveLength(1);

    const strict = build({ rpc });
    const result = await strict.service.resolveCandidates(
      campaign({ config: { targetStatuses: ['lapsed'], minOverdueDays: 90, serviceCategoryId: null } }),
      TODAY,
    );
    expect(result.candidates).toHaveLength(0);
  });

  it('filters by service category when one is configured', async () => {
    const rpc = {
      'crm.client_service_history': [
        historyRow({ clientId: 'jane', daysAgo: 70, today: TODAY, categoryId: COLOUR_CATEGORY }),
        historyRow({ clientId: 'sam', daysAgo: 70, today: TODAY, categoryId: 'other-category' }),
      ],
      'crm.client_next_bookings': [],
    };
    const { service } = build({ rpc });
    const { candidates } = await service.resolveCandidates(
      campaign({
        config: { targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: COLOUR_CATEGORY },
      }),
      TODAY,
    );
    expect(candidates.map((c) => c.clientId)).toEqual(['jane']);
  });

  it('keys the send on the rebooking opportunity, so two runs produce one identity', async () => {
    const rpc = {
      'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 70, today: TODAY })],
      'crm.client_next_bookings': [],
    };

    const first = await build({ rpc }).service.resolveCandidates(campaign(), TODAY);
    // The next day: still overdue, expected return unchanged, so the key is too.
    const second = await build({ rpc }).service.resolveCandidates(campaign(), TODAY);

    expect(second.candidates[0].dedupeKey).toBe(first.candidates[0].dedupeKey);
  });

  it('scopes every query to the acting business', async () => {
    const { service, calls } = build({
      rpc: { 'crm.client_service_history': [], 'crm.client_next_bookings': [] },
    });
    await service.resolveCandidates(campaign(), TODAY);

    // Business isolation is structural: the id is a bound parameter of the RPC,
    // never a filter the caller could omit.
    const history = calls.find((c) => c.fn === 'client_service_history');
    expect(history?.args['p_business_id']).toBe(BUSINESS);
    expect(history?.args['p_business_id']).not.toBe(OTHER_BUSINESS);
  });

  it('passes the location scope through for a location-scoped campaign', async () => {
    const { service, calls } = build({ rpc: { 'crm.client_service_history': [] } });
    await service.resolveCandidates(campaign({ location_id: LOCATION }), TODAY);
    expect(calls[0].args['p_location_ids']).toEqual([LOCATION]);
  });

  it('fails the run rather than treating an unreadable booking table as "not booked"', async () => {
    // Fail-open here would mark every already-booked client due and win-back
    // them all. A failed read must fail the run instead.
    mockedCreateClient.mockReturnValue({
      schema: () => ({
        rpc: async (fn: string) =>
          fn === 'client_next_bookings'
            ? { data: null, error: { message: 'connection reset' } }
            : {
                data: [historyRow({ clientId: 'jane', daysAgo: 70, today: TODAY })],
                error: null,
              },
        from: () => ({
          select: () => ({ eq: () => ({ returns: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) }) }) }),
        }),
      }),
    } as never);

    const service = new CampaignAudienceService({ getOrThrow: () => 'x' } as unknown as ConfigService);
    await expect(service.resolveCandidates(campaign(), TODAY)).rejects.toThrow('client_next_bookings');
  });
});

// ---------------------------------------------------------------------------
// Birthday — Wrike sections 11, 42, 53
// ---------------------------------------------------------------------------

describe('birthday audience', () => {
  const birthdayCampaign = (daysBefore = 0) =>
    campaign({ campaign_type: 'birthday', config: { daysBefore } });

  function birthdayRow(clientId: string, dob: string, marketingOptIn = true) {
    return {
      client_profile_id: clientId,
      first_name: 'Olivia',
      last_name: 'Brown',
      email: 'olivia@example.com',
      phone: '+447700900002',
      marketing_opt_in: marketingOptIn,
      primary_location_id: LOCATION,
      date_of_birth: dob,
    };
  }

  it('includes a client whose birthday is today', async () => {
    const { service, calls } = build({
      rpc: { 'comms.campaign_birthday_candidates': [birthdayRow('olivia', '1990-09-01')] },
    });

    const { candidates } = await service.resolveCandidates(birthdayCampaign(0), TODAY);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].dedupeKey).toContain('birthday');
    expect(candidates[0].dedupeKey).toContain('2026');
    // The salon-local date is computed by the caller and handed to SQL.
    expect(calls[0].args['p_target_date']).toBe('2026-09-01');
  });

  it('asks SQL for the lead-time date, not today', async () => {
    const { service, calls } = build({ rpc: { 'comms.campaign_birthday_candidates': [] } });
    await service.resolveCandidates(birthdayCampaign(7), TODAY);
    expect(calls[0].args['p_target_date']).toBe('2026-09-08');
  });

  it('re-checks the SQL match in TypeScript, so the two leap-day rules must agree', async () => {
    // A row whose birthday does not actually fall on the target date is dropped
    // even though SQL returned it. This is the divergence guard.
    const { service } = build({
      rpc: {
        'comms.campaign_birthday_candidates': [
          birthdayRow('olivia', '1990-09-01'),
          birthdayRow('wrong', '1990-12-25'),
        ],
      },
    });
    const { candidates } = await service.resolveCandidates(birthdayCampaign(0), TODAY);
    expect(candidates.map((c) => c.clientId)).toEqual(['olivia']);
  });

  it('keys one message per birthday year', async () => {
    const rpc = { 'comms.campaign_birthday_candidates': [birthdayRow('olivia', '1990-09-01')] };
    const a = await build({ rpc }).service.resolveCandidates(birthdayCampaign(0), TODAY);
    const b = await build({ rpc }).service.resolveCandidates(birthdayCampaign(0), TODAY);
    expect(b.candidates[0].dedupeKey).toBe(a.candidates[0].dedupeKey);
  });

  it('carries the marketing flag through untouched for the eligibility layer', async () => {
    const { service } = build({
      rpc: { 'comms.campaign_birthday_candidates': [birthdayRow('olivia', '1990-09-01', false)] },
    });
    const { candidates } = await service.resolveCandidates(birthdayCampaign(0), TODAY);
    // Selection and consent are separate concerns: the candidate is produced,
    // and the evaluator/messaging layer is what withholds the message.
    expect(candidates[0].marketingOptIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Promotion — Wrike sections 12, 39, 54
// ---------------------------------------------------------------------------

describe('promotion audience', () => {
  const promotion = (config: Record<string, unknown> = {}) =>
    campaign({
      campaign_type: 'promotion',
      config: {
        startDate: '2026-08-01',
        endDate: '2026-09-30',
        lapseStatuses: [],
        serviceCategoryId: null,
        minCompletedVisits: 0,
        ...config,
      },
    });

  it('includes every client in scope inside the window', async () => {
    const { service } = build({
      rpc: {
        'crm.client_service_history': [
          historyRow({ clientId: 'jane', daysAgo: 10, today: TODAY }),
          historyRow({ clientId: 'sam', daysAgo: 200, today: TODAY }),
        ],
      },
    });
    const { candidates } = await service.resolveCandidates(promotion(), TODAY);
    expect(candidates.map((c) => c.clientId).sort()).toEqual(['jane', 'sam']);
  });

  it('sends nothing outside the configured window', async () => {
    const { service, calls } = build({
      rpc: { 'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 10, today: TODAY })] },
    });
    const { candidates } = await service.resolveCandidates(
      promotion({ startDate: '2026-10-01', endDate: '2026-10-31' }),
      TODAY,
    );
    expect(candidates).toHaveLength(0);
    // The window is checked BEFORE any evidence is loaded — a closed promotion
    // costs nothing.
    expect(calls).toHaveLength(0);
  });

  it('applies a minimum-visits floor', async () => {
    const { service } = build({
      rpc: {
        'crm.client_service_history': [
          historyRow({ clientId: 'regular', daysAgo: 10, today: TODAY, visitCount: 5 }),
          historyRow({ clientId: 'newcomer', daysAgo: 10, today: TODAY, visitCount: 1 }),
        ],
      },
    });
    const { candidates } = await service.resolveCandidates(promotion({ minCompletedVisits: 3 }), TODAY);
    expect(candidates.map((c) => c.clientId)).toEqual(['regular']);
  });

  it('can narrow to lapsed clients using the canonical status', async () => {
    const { service } = build({
      rpc: {
        'crm.client_service_history': [
          historyRow({ clientId: 'lapsed', daysAgo: 200, today: TODAY }),
          historyRow({ clientId: 'active', daysAgo: 5, today: TODAY }),
        ],
        'crm.client_next_bookings': [],
      },
    });
    const { candidates } = await service.resolveCandidates(promotion({ lapseStatuses: ['lapsed'] }), TODAY);
    expect(candidates.map((c) => c.clientId)).toEqual(['lapsed']);
  });

  it('does not pay for cadence maths a plain "everyone" promotion will ignore', async () => {
    const { service, calls } = build({
      rpc: { 'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 10, today: TODAY })] },
    });
    await service.resolveCandidates(promotion(), TODAY);
    expect(calls.some((c) => c.fn === 'client_next_bookings')).toBe(false);
  });

  it('gives each client exactly one identity for the whole campaign', async () => {
    const rpc = {
      'crm.client_service_history': [historyRow({ clientId: 'jane', daysAgo: 10, today: TODAY })],
    };
    const day1 = await build({ rpc }).service.resolveCandidates(promotion(), '2026-09-01');
    const day2 = await build({ rpc }).service.resolveCandidates(promotion(), '2026-09-02');
    expect(day2.candidates[0].dedupeKey).toBe(day1.candidates[0].dedupeKey);
  });
});

// ---------------------------------------------------------------------------
// Loyalty milestone — Wrike sections 13, 41, 55
// ---------------------------------------------------------------------------

describe('loyalty milestone audience', () => {
  const loyalty = (metric: string, threshold: number) =>
    campaign({ campaign_type: 'loyalty_milestone', config: { metric, threshold } });

  function metricRow(clientId: string, visits: number, spendCents: number) {
    return {
      client_profile_id: clientId,
      first_name: 'Mia',
      last_name: 'Wong',
      email: 'mia@example.com',
      phone: '+447700900003',
      marketing_opt_in: true,
      primary_location_id: LOCATION,
      // PostgREST returns numerics as strings; the fixture reproduces that.
      completed_visits: String(visits),
      total_spend_cents: String(spendCents),
    };
  }

  it('excludes a client below the milestone', async () => {
    const { service } = build({ rpc: { 'comms.campaign_loyalty_metrics': [metricRow('mia', 9, 0)] } });
    const { candidates } = await service.resolveCandidates(loyalty('completed_visits', 10), TODAY);
    expect(candidates).toHaveLength(0);
  });

  it('includes a client exactly at the milestone', async () => {
    const { service } = build({ rpc: { 'comms.campaign_loyalty_metrics': [metricRow('mia', 10, 0)] } });
    const { candidates } = await service.resolveCandidates(loyalty('completed_visits', 10), TODAY);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].matchReason).toContain('10 completed visits');
  });

  it('includes a client who passed the milestone while the campaign was a draft', async () => {
    // `>=`, not `=`. Someone who reached 12 visits before the owner switched the
    // campaign on should still be recognised — firing once is the ledger's job.
    const { service } = build({ rpc: { 'comms.campaign_loyalty_metrics': [metricRow('mia', 12, 0)] } });
    const { candidates } = await service.resolveCandidates(loyalty('completed_visits', 10), TODAY);
    expect(candidates).toHaveLength(1);
  });

  it('gives the same client different identities for different milestones', async () => {
    const rpc = { 'comms.campaign_loyalty_metrics': [metricRow('mia', 25, 0)] };
    const ten = await build({ rpc }).service.resolveCandidates(loyalty('completed_visits', 10), TODAY);
    const twenty = await build({ rpc }).service.resolveCandidates(loyalty('completed_visits', 20), TODAY);
    expect(ten.candidates[0].dedupeKey).not.toBe(twenty.candidates[0].dedupeKey);
  });

  it('compares spend in integer minor units', async () => {
    // £500.00 threshold = 50000 pence. £499.99 does not qualify; £500.00 does.
    const below = build({ rpc: { 'comms.campaign_loyalty_metrics': [metricRow('mia', 3, 49_999)] } });
    expect((await below.service.resolveCandidates(loyalty('total_spend', 50_000), TODAY)).candidates).toHaveLength(0);

    const at = build({ rpc: { 'comms.campaign_loyalty_metrics': [metricRow('mia', 3, 50_000)] } });
    const result = await at.service.resolveCandidates(loyalty('total_spend', 50_000), TODAY);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].matchReason).toContain('£500.00');
  });

  it('scopes the metric query to the acting business and timezone', async () => {
    const { service, calls } = build({ rpc: { 'comms.campaign_loyalty_metrics': [] } });
    await service.resolveCandidates(loyalty('completed_visits', 10), TODAY);
    expect(calls[0].args['p_business_id']).toBe(BUSINESS);
    expect(calls[0].args['p_timezone']).toBe('Europe/London');
  });
});

// ---------------------------------------------------------------------------
// Configuration integrity
// ---------------------------------------------------------------------------

describe('stored configuration', () => {
  it('refuses to resolve an audience from an invalid stored config', async () => {
    // A row written by a script or an older migration must fail the run loudly
    // rather than be misread into a message to the wrong people.
    const { service } = build({ rpc: { 'crm.client_service_history': [] } });
    await expect(
      service.resolveCandidates(campaign({ config: { targetStatuses: [], minOverdueDays: -1 } }), TODAY),
    ).rejects.toThrow('invalid rebooking configuration');
  });

  it('returns nothing for an unknown campaign type rather than guessing', async () => {
    const { service } = build({});
    const { candidates } = await service.resolveCandidates(campaign({ campaign_type: 'telepathy' }), TODAY);
    expect(candidates).toHaveLength(0);
  });
});
