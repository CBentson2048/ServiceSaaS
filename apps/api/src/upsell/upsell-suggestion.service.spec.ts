/**
 * UpsellSuggestionService — context resolution, tenancy, eligibility, pricing
 * and failure isolation.
 *
 * The precedence/ranking rules are pinned by upsell-rule.spec; these specs
 * prove what the SERVICE sends and refuses: that the booking context is derived
 * from the appointment rather than from the caller, that a service belonging to
 * another business or unavailable at the acting location can neither seed the
 * context nor be suggested, that an assigned stylist's capability filters the
 * list and their price override reaches it, and that the history source failing
 * degrades the answer instead of failing the request.
 *
 * What these specs do NOT prove: that the SQL in 0103 counts the right
 * appointments (that lives in supabase/tests/upsell_suggestions.sql), nor that
 * PostgREST enforces anything — the API holds a service-role key and RLS is
 * dormant on this path, so application-layer scoping IS the tenancy boundary
 * and is what is tested here.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { UpsellSuggestionService } from './upsell-suggestion.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

type Row = Record<string, unknown>;

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface Captured {
  table: string;
  verb: string;
  payload?: unknown;
}

interface FakeOptions {
  tables?: Record<string, Row[]>;
  rpc?: Record<string, Row[] | ((args: Record<string, unknown>) => Row[])>;
  rpcErrors?: string[];
  /** RPC names that should REJECT (throw) rather than resolve with an error. */
  rpcThrows?: string[];
}

/**
 * Filter-aware chain fake. eq/in/is genuinely filter the seeded rows, so a
 * missing `.eq('business_id', …)` shows up as a cross-tenant row in the result
 * rather than passing silently. `.or()` is applied for the two shapes this
 * service uses, so an unscoped location read is caught too.
 */
function build(options: FakeOptions = {}) {
  const rpcCalls: RpcCall[] = [];
  const captured: Captured[] = [];
  const tables = options.tables ?? {};

  const makeChain = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: unknown;

    const chain: Record<string, unknown> = {};
    const settle = () => {
      if (verb !== 'select') {
        captured.push({ table, verb, payload });
        return { data: null, error: null };
      }
      return { data: rows, error: null };
    };

    Object.assign(chain, {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      returns: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      is: (column: string, value: unknown) => {
        rows = rows.filter((row) => (row[column] ?? null) === value);
        return chain;
      },
      or: (expression: string) => {
        rows = rows.filter((row) =>
          expression.split(',').some((clause) => {
            // `col.is.null`
            let match = /^([a-z_]+)\.is\.null$/.exec(clause);
            if (match) return (row[match[1]] ?? null) === null;
            // `col.eq.value`
            match = /^([a-z_]+)\.eq\.(.+)$/.exec(clause);
            if (match) return row[match[1]] === match[2];
            // `col.in.(a,b)` — the `.or()` argument is pre-split on commas, so
            // an `in.(…)` list arrives here in fragments. Reassemble by testing
            // membership of the single value each fragment carries.
            match = /^([a-z_]+)\.in\.\(?([^)]*)\)?$/.exec(clause);
            if (match) return row[match[1]] === match[2];
            return false;
          }),
        );
        return chain;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve, reject),
    });
    return chain;
  };

  const root = {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (options.rpcThrows?.includes(name)) throw new Error(`${name} connection reset`);
        if (options.rpcErrors?.includes(name)) {
          return { data: null, error: { message: `${name} exploded` } };
        }
        const configured = options.rpc?.[name] ?? [];
        const data = typeof configured === 'function' ? configured(args) : configured;
        return { data, error: null };
      },
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new UpsellSuggestionService(config), rpcCalls, captured };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS = 'biz-1';
const OTHER_BUSINESS = 'biz-2';
const PINNER = 'loc-pinner';
const PRIMROSE = 'loc-primrose';
const APPOINTMENT = 'appt-1';
const STYLIST_PROFILE = 'staff-1';

const COLOUR = 'svc-colour';
const TONER = 'svc-toner';
const TREATMENT = 'svc-treatment';
const COLOUR_CATEGORY = 'cat-colour';

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS,
    allowedLocationIds: [PINNER, PRIMROSE],
    locationScope: { kind: 'all' },
    locations: [],
    profile: { id: 'user-1', email: 'owner@salon.test', fullName: 'Owner' },
    permissions: ['bookings.manage'],
    ...overrides,
  } as unknown as AuthUser;
}

const OWNER = authUser();
const STYLIST = authUser({
  id: 'user-3',
  roles: ['stylist'],
  primaryRole: 'stylist',
  allowedLocationIds: [PINNER],
});

function serviceRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    business_id: BUSINESS,
    location_id: null,
    name: id,
    service_category_id: COLOUR_CATEGORY,
    estimated_duration_minutes: 30,
    base_price: 35,
    is_active: true,
    service_categories: { name: 'Colour' },
    ...overrides,
  };
}

function appointmentRow(overrides: Row = {}): Row {
  return {
    id: APPOINTMENT,
    business_id: BUSINESS,
    location_id: PINNER,
    assigned_staff_profile_id: null,
    appointment_services: [{ service_id: COLOUR, status: 'scheduled' }],
    ...overrides,
  };
}

function ruleRow(overrides: Row = {}): Row {
  return {
    id: 'rule-1',
    business_id: BUSINESS,
    location_id: null,
    name: 'Colour → Toner',
    enabled: true,
    trigger_type: 'service',
    trigger_service_id: COLOUR,
    trigger_service_category_id: null,
    suggested_service_id: TONER,
    priority: 100,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const LOCATION_ROW = {
  id: PINNER,
  business_id: BUSINESS,
  businesses: { default_currency_code: 'GBP' },
  location_settings: { currency_code: 'GBP' },
};

/** The standard "Colour is booked at Pinner, Colour → Toner is configured" world. */
function standardTables(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    appointments: [appointmentRow()],
    services: [serviceRow(COLOUR, { name: 'Full Head Colour' }), serviceRow(TONER, { name: 'Toner' })],
    upsell_rules: [ruleRow()],
    locations: [LOCATION_ROW],
    staff_service_eligibility: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('booking context', () => {
  it('suggests the configured add-on for a booking containing the trigger', async () => {
    const { service } = build({ tables: standardTables() });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.contextKind).toBe('booking');
    expect(result.locationId).toBe(PINNER);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      serviceId: TONER,
      name: 'Toner',
      source: 'owner_rule',
      reason: 'Configured add-on for Full Head Colour',
      priceAmount: 35,
      currencyCode: 'GBP',
      durationMinutes: 30,
      rank: 1,
    });
  });

  it('returns nothing for a booking with no matching trigger', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [
          appointmentRow({ appointment_services: [{ service_id: 'svc-cut', status: 'scheduled' }] }),
        ],
        services: [serviceRow('svc-cut'), serviceRow(TONER)],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('excludes an add-on already on the booking', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [
          appointmentRow({
            appointment_services: [
              { service_id: COLOUR, status: 'scheduled' },
              { service_id: TONER, status: 'scheduled' },
            ],
          }),
        ],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('ignores a cancelled service line, so its add-on is offered again', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [
          appointmentRow({
            appointment_services: [
              { service_id: COLOUR, status: 'scheduled' },
              { service_id: TONER, status: 'cancelled' },
            ],
          }),
        ],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });

  it('reports a missing appointment as not found', async () => {
    const { service } = build({ tables: standardTables({ appointments: [] }) });
    await expect(service.forAppointment(OWNER, APPOINTMENT, 'booking')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('checkout context', () => {
  it('produces the same candidates with checkout wording', async () => {
    const { service } = build({ tables: standardTables() });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'checkout');

    expect(result.contextKind).toBe('checkout');
    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });

  it('excludes a service already billed on the visit', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [
          appointmentRow({
            appointment_services: [
              { service_id: COLOUR, status: 'completed' },
              { service_id: TONER, status: 'completed' },
            ],
          }),
        ],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'checkout');

    expect(result.suggestions).toEqual([]);
  });
});

describe('tenancy', () => {
  it('cannot read another business’s appointment', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [appointmentRow({ business_id: OTHER_BUSINESS })],
      }),
    });
    await expect(service.forAppointment(OWNER, APPOINTMENT, 'booking')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never applies another business’s rule', async () => {
    const { service } = build({
      tables: standardTables({
        upsell_rules: [ruleRow({ business_id: OTHER_BUSINESS })],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('never suggests a service belonging to another business', async () => {
    const { service } = build({
      tables: standardTables({
        services: [serviceRow(COLOUR), serviceRow(TONER, { business_id: OTHER_BUSINESS })],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('refuses a draft context for a location outside the actor’s scope', async () => {
    const { service } = build({ tables: standardTables() });
    await expect(
      service.forDraft(STYLIST, { locationId: PRIMROSE, serviceIds: [COLOUR] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an appointment at a location outside the actor’s scope', async () => {
    const { service } = build({
      tables: standardTables({ appointments: [appointmentRow({ location_id: PRIMROSE })] }),
    });
    await expect(service.forAppointment(STYLIST, APPOINTMENT, 'booking')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('derives the business from the token, so a draft cannot name another tenant', async () => {
    const { service } = build({ tables: standardTables() });
    // The DTO has no businessId at all; the rules read is filtered on the
    // actor's. A service id from another business simply resolves to nothing.
    const result = await service.forDraft(OWNER, { locationId: PINNER, serviceIds: [COLOUR] });
    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });
});

describe('service eligibility', () => {
  it('does not suggest an inactive service', async () => {
    const { service } = build({
      tables: standardTables({
        services: [serviceRow(COLOUR), serviceRow(TONER, { is_active: false })],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('does not suggest a service scoped to a different location', async () => {
    const { service } = build({
      tables: standardTables({
        services: [serviceRow(COLOUR), serviceRow(TONER, { location_id: PRIMROSE })],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('suggests a service scoped to THIS location', async () => {
    const { service } = build({
      tables: standardTables({
        services: [serviceRow(COLOUR), serviceRow(TONER, { location_id: PINNER })],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });

  it('drops an add-on the assigned stylist is not qualified to perform', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [appointmentRow({ assigned_staff_profile_id: STYLIST_PROFILE })],
        staff_service_eligibility: [
          { business_id: BUSINESS, staff_profile_id: STYLIST_PROFILE, service_id: COLOUR, price_amount: null },
        ],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });

  it('keeps an add-on the assigned stylist can perform, at their price', async () => {
    const { service } = build({
      tables: standardTables({
        appointments: [appointmentRow({ assigned_staff_profile_id: STYLIST_PROFILE })],
        staff_service_eligibility: [
          { business_id: BUSINESS, staff_profile_id: STYLIST_PROFILE, service_id: TONER, price_amount: 48 },
        ],
      }),
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions[0]).toMatchObject({
      serviceId: TONER,
      // The stylist's override, not the £35 base price.
      priceAmount: 48,
      requiresAvailabilityCheck: false,
    });
  });

  it('flags that availability still needs checking when no stylist is assigned', async () => {
    const { service } = build({ tables: standardTables() });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions[0].requiresAvailabilityCheck).toBe(true);
  });
});

describe('historical patterns', () => {
  const patternTables = () =>
    standardTables({
      upsell_rules: [],
      services: [
        serviceRow(COLOUR, { name: 'Full Head Colour' }),
        serviceRow(TREATMENT, { name: 'Olaplex Treatment' }),
      ],
    });

  it('surfaces a co-occurrence candidate with its evidence and plain-language reason', async () => {
    const { service, rpcCalls } = build({
      tables: patternTables(),
      rpc: {
        service_cooccurrence: [
          {
            trigger_service_id: COLOUR,
            suggested_service_id: TREATMENT,
            base_count: 100,
            cooccurrence_count: 34,
          },
        ],
      },
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions[0]).toMatchObject({
      serviceId: TREATMENT,
      source: 'booking_pattern',
      reason: 'Frequently booked with Full Head Colour',
      supportCount: 34,
      baseCount: 100,
      coBookRate: 0.34,
    });
    // ONE set-based call for every trigger service, never one per candidate.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args).toMatchObject({
      p_business_id: BUSINESS,
      p_trigger_service_ids: [COLOUR],
      p_min_base_sample: 10,
      p_min_cooccurrence: 3,
      p_min_rate: 0.2,
    });
    // Bounded lookback, not an unbounded history scan.
    expect(typeof rpcCalls[0].args.p_since).toBe('string');
  });

  it('still applies location eligibility to a business-wide pattern candidate', async () => {
    const { service } = build({
      tables: standardTables({
        upsell_rules: [],
        services: [serviceRow(COLOUR), serviceRow(TREATMENT, { location_id: PRIMROSE })],
      }),
      rpc: {
        service_cooccurrence: [
          {
            trigger_service_id: COLOUR,
            suggested_service_id: TREATMENT,
            base_count: 100,
            cooccurrence_count: 90,
          },
        ],
      },
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.suggestions).toEqual([]);
  });
});

describe('failure isolation', () => {
  it('answers from owner rules alone when the pattern query errors', async () => {
    const { service } = build({
      tables: standardTables(),
      rpcErrors: ['service_cooccurrence'],
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.patternsUnavailable).toBe(true);
    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });

  it('answers from owner rules alone when the pattern query throws', async () => {
    const { service } = build({
      tables: standardTables(),
      rpcThrows: ['service_cooccurrence'],
    });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.patternsUnavailable).toBe(true);
    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });

  it('reports patternsUnavailable = false on the happy path', async () => {
    const { service } = build({ tables: standardTables() });
    const result = await service.forAppointment(OWNER, APPOINTMENT, 'booking');

    expect(result.patternsUnavailable).toBe(false);
  });
});

describe('draft (pre-save) context', () => {
  it('suggests from the services staff have selected so far', async () => {
    const { service } = build({ tables: standardTables() });
    const result = await service.forDraft(OWNER, { locationId: PINNER, serviceIds: [COLOUR] });

    expect(result.contextKind).toBe('booking');
    expect(result.suggestions.map((s) => s.serviceId)).toEqual([TONER]);
  });

  it('rejects an empty selection', async () => {
    const { service } = build({ tables: standardTables() });
    await expect(
      service.forDraft(OWNER, { locationId: PINNER, serviceIds: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a supplied service that is not offered at the location', async () => {
    const { service } = build({
      tables: standardTables({
        services: [serviceRow(COLOUR, { location_id: PRIMROSE }), serviceRow(TONER)],
      }),
    });
    const result = await service.forDraft(OWNER, { locationId: PINNER, serviceIds: [COLOUR] });

    expect(result.suggestions).toEqual([]);
  });

  it('filters by the chosen stylist before the booking is saved', async () => {
    const { service } = build({
      tables: standardTables({
        staff_service_eligibility: [
          { business_id: BUSINESS, staff_profile_id: STYLIST_PROFILE, service_id: COLOUR, price_amount: null },
        ],
      }),
    });
    const result = await service.forDraft(OWNER, {
      locationId: PINNER,
      serviceIds: [COLOUR],
      staffProfileId: STYLIST_PROFILE,
    });

    expect(result.suggestions).toEqual([]);
  });
});

describe('read-only guarantee', () => {
  it('performs no write of any kind while producing suggestions', async () => {
    const { service, captured } = build({
      tables: standardTables(),
      rpc: {
        service_cooccurrence: [
          {
            trigger_service_id: COLOUR,
            suggested_service_id: TREATMENT,
            base_count: 100,
            cooccurrence_count: 34,
          },
        ],
      },
    });
    await service.forAppointment(OWNER, APPOINTMENT, 'booking');
    await service.forAppointment(OWNER, APPOINTMENT, 'checkout');
    await service.forDraft(OWNER, { locationId: PINNER, serviceIds: [COLOUR] });

    // Nothing was inserted, updated, upserted or deleted anywhere.
    expect(captured).toEqual([]);
  });
});
