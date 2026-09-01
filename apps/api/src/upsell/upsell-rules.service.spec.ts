/**
 * UpsellRulesService — owner configuration: authorization, validation, tenancy
 * and the audit trail.
 *
 * These specs prove what the CRUD layer refuses: a non-owner editing rules, a
 * service or category from another business, a self-suggesting rule, a trigger
 * that does not match its declared type, and a partial PATCH nulling fields the
 * caller never mentioned. They also prove every mutation reaches the existing
 * audit trail, because "who turned this rule off?" has to be answerable.
 *
 * The DB is the other half: the unique indexes and CHECK constraints in 0103
 * are asserted in supabase/tests/upsell_suggestions.sql, not here.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import type { AuditService } from '../audit/audit.service';
import { UpsellRulesService } from './upsell-rules.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

type Row = Record<string, unknown>;

interface Captured {
  table: string;
  verb: string;
  payload?: unknown;
}

interface FakeOptions {
  tables?: Record<string, Row[]>;
  /** Postgres error codes to return for a write on the named table. */
  writeErrors?: Record<string, { code: string }>;
}

function build(options: FakeOptions = {}) {
  const captured: Captured[] = [];
  const tables = options.tables ?? {};

  const makeChain = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: unknown;

    const writeError = () => options.writeErrors?.[table] ?? null;

    const chain: Record<string, unknown> = {};
    const settleWrite = () => {
      captured.push({ table, verb, payload });
      const error = writeError();
      if (error) return { data: null, error };
      // An insert echoes what was written; an update merges onto the matched row.
      const body = (payload ?? {}) as Row;
      const merged = verb === 'insert' ? { ...ruleDefaults(), ...body } : { ...(rows[0] ?? {}), ...body };
      return { data: verb === 'delete' ? null : merged, error: null };
    };

    Object.assign(chain, {
      select: () => chain,
      order: () => chain,
      returns: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      or: (expression: string) => {
        rows = rows.filter((row) =>
          expression.split(',').some((clause) => {
            let match = /^([a-z_]+)\.is\.null$/.exec(clause);
            if (match) return (row[match[1]] ?? null) === null;
            match = /^([a-z_]+)\.eq\.(.+)$/.exec(clause);
            if (match) return row[match[1]] === match[2];
            return false;
          }),
        );
        return chain;
      },
      insert: (body: unknown) => {
        verb = 'insert';
        payload = body;
        return chain;
      },
      update: (body: unknown) => {
        verb = 'update';
        payload = body;
        return chain;
      },
      delete: () => {
        verb = 'delete';
        return chain;
      },
      maybeSingle: async () =>
        verb === 'select' ? { data: rows[0] ?? null, error: null } : settleWrite(),
      single: async () => (verb === 'select' ? { data: rows[0] ?? null, error: null } : settleWrite()),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        const value = verb === 'select' ? { data: rows, error: null } : settleWrite();
        return Promise.resolve(value).then(resolve, reject);
      },
    });
    return chain;
  };

  const root = { schema: () => ({ from: (table: string) => makeChain(table) }) };
  mockedCreateClient.mockReturnValue(root as never);

  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  const record = jest.fn(async () => undefined);
  const audit = { record } as unknown as AuditService;
  return { service: new UpsellRulesService(config, audit), captured, record };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS = 'biz-1';
const OTHER_BUSINESS = 'biz-2';
const PINNER = 'loc-pinner';
const COLOUR = 'svc-colour';
const TONER = 'svc-toner';
const COLOUR_CATEGORY = 'cat-colour';
const RULE = 'rule-1';

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS,
    allowedLocationIds: [PINNER],
    locationScope: { kind: 'all' },
    locations: [],
    profile: { id: 'user-1', email: 'owner@salon.test', fullName: 'Owner' },
    permissions: ['settings.booking.manage'],
    ...overrides,
  } as unknown as AuthUser;
}

const OWNER = authUser();
const MANAGER = authUser({ id: 'user-2', roles: ['manager'], primaryRole: 'manager' });
const STYLIST = authUser({ id: 'user-3', roles: ['stylist'], primaryRole: 'stylist' });

function ruleDefaults(): Row {
  return {
    id: RULE,
    business_id: BUSINESS,
    location_id: null,
    name: 'Colour → Toner',
    enabled: true,
    trigger_type: 'service',
    trigger_service_id: COLOUR,
    trigger_service_category_id: null,
    suggested_service_id: TONER,
    priority: 100,
    created_by_user_profile_id: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    trigger_service: { name: 'Full Head Colour' },
    suggested_service: { name: 'Toner' },
    service_categories: null,
    locations: null,
  };
}

function tables(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    upsell_rules: [ruleDefaults()],
    services: [
      { id: COLOUR, business_id: BUSINESS },
      { id: TONER, business_id: BUSINESS },
    ],
    service_categories: [{ id: COLOUR_CATEGORY, business_id: BUSINESS }],
    locations: [{ id: PINNER, business_id: BUSINESS }],
    ...overrides,
  };
}

const VALID_CREATE = {
  name: 'Colour → Toner',
  triggerType: 'service' as const,
  triggerServiceId: COLOUR,
  suggestedServiceId: TONER,
  priority: 100,
};

// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('lets an owner list rules', async () => {
    const { service } = build({ tables: tables() });
    const result = await service.list(OWNER, {});

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({
      id: RULE,
      triggerServiceName: 'Full Head Colour',
      suggestedServiceName: 'Toner',
      enabled: true,
    });
  });

  it.each([
    ['a manager', MANAGER],
    ['a stylist', STYLIST],
  ])('refuses %s creating a rule', async (_label, actor) => {
    const { service } = build({ tables: tables() });
    await expect(service.create(actor, VALID_CREATE)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a stylist toggling a rule off', async () => {
    const { service, captured } = build({ tables: tables() });
    await expect(service.update(STYLIST, RULE, { enabled: false })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(captured).toEqual([]);
  });

  it('refuses a manager deleting a rule', async () => {
    const { service } = build({ tables: tables() });
    await expect(service.remove(MANAGER, RULE)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('validation', () => {
  it('rejects a rule whose trigger and suggestion are the same service', async () => {
    const { service } = build({ tables: tables() });
    await expect(
      service.create(OWNER, { ...VALID_CREATE, suggestedServiceId: COLOUR }),
    ).rejects.toThrow('A service cannot suggest itself');
  });

  it('rejects a service trigger with no trigger service', async () => {
    const { service } = build({ tables: tables() });
    await expect(
      service.create(OWNER, { ...VALID_CREATE, triggerServiceId: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a category trigger with no category', async () => {
    const { service } = build({ tables: tables() });
    await expect(
      service.create(OWNER, {
        ...VALID_CREATE,
        triggerType: 'service_category',
        triggerServiceId: null,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a service belonging to another business', async () => {
    const { service } = build({
      tables: tables({
        services: [
          { id: COLOUR, business_id: BUSINESS },
          { id: TONER, business_id: OTHER_BUSINESS },
        ],
      }),
    });
    await expect(service.create(OWNER, VALID_CREATE)).rejects.toThrow(
      'Service not found for this business',
    );
  });

  it('rejects a category belonging to another business', async () => {
    const { service } = build({
      tables: tables({ service_categories: [{ id: COLOUR_CATEGORY, business_id: OTHER_BUSINESS }] }),
    });
    await expect(
      service.create(OWNER, {
        ...VALID_CREATE,
        triggerType: 'service_category',
        triggerServiceId: null,
        triggerServiceCategoryId: COLOUR_CATEGORY,
      }),
    ).rejects.toThrow('Service category not found for this business');
  });

  it('rejects a location belonging to another business', async () => {
    const { service } = build({
      tables: tables({ locations: [{ id: PINNER, business_id: OTHER_BUSINESS }] }),
    });
    await expect(
      service.create(OWNER, { ...VALID_CREATE, locationId: PINNER }),
    ).rejects.toThrow('Location not found for this business');
  });

  it('drops the stale category id when a rule switches to a service trigger', async () => {
    const { service, captured } = build({ tables: tables() });
    await service.create(OWNER, {
      ...VALID_CREATE,
      // A category id sent alongside a service trigger must not be persisted:
      // it would violate the table's trigger/type CHECK.
      triggerServiceCategoryId: COLOUR_CATEGORY,
    });

    const insert = captured.find((call) => call.verb === 'insert')!;
    expect(insert.payload).toMatchObject({
      trigger_type: 'service',
      trigger_service_id: COLOUR,
      trigger_service_category_id: null,
    });
  });

  it('reports a duplicate rule as a conflict, not a 500', async () => {
    const { service } = build({
      tables: tables(),
      writeErrors: { upsell_rules: { code: '23505' } },
    });
    await expect(service.create(OWNER, VALID_CREATE)).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports a constraint violation as a bad request, not a 500', async () => {
    const { service } = build({
      tables: tables(),
      writeErrors: { upsell_rules: { code: '23514' } },
    });
    await expect(service.create(OWNER, VALID_CREATE)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('create', () => {
  it('stamps the business and the acting user, never a client-supplied tenant', async () => {
    const { service, captured } = build({ tables: tables() });
    await service.create(OWNER, VALID_CREATE);

    const insert = captured.find((call) => call.verb === 'insert')!;
    expect(insert.payload).toMatchObject({
      business_id: BUSINESS,
      created_by_user_profile_id: 'user-1',
      suggested_service_id: TONER,
      priority: 100,
      enabled: true,
    });
  });

  it('defaults a rule to enabled and priority 0', async () => {
    const { service, captured } = build({ tables: tables() });
    await service.create(OWNER, {
      name: 'Colour → Toner',
      triggerType: 'service',
      triggerServiceId: COLOUR,
      suggestedServiceId: TONER,
    });

    const insert = captured.find((call) => call.verb === 'insert')!;
    expect(insert.payload).toMatchObject({ enabled: true, priority: 0, location_id: null });
  });
});

describe('update', () => {
  it('toggles a rule off without touching any other field', async () => {
    const { service, captured } = build({ tables: tables() });
    const result = await service.update(OWNER, RULE, { enabled: false });

    const update = captured.find((call) => call.verb === 'update')!;
    // Exactly one field. A partial PATCH must not null what it never mentioned
    // — the `in`-operator trap that would send every declared DTO key.
    expect(update.payload).toEqual({ enabled: false });
    expect(result.rule.enabled).toBe(false);
  });

  it('rejects an empty patch rather than issuing a no-op write', async () => {
    const { service, captured } = build({ tables: tables() });
    await expect(service.update(OWNER, RULE, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(captured.filter((call) => call.verb === 'update')).toEqual([]);
  });

  it('revalidates the whole trigger when only the suggested service moves', async () => {
    const { service } = build({ tables: tables() });
    // Re-pointing the suggestion at the trigger service itself must be caught
    // even though triggerServiceId was not part of the patch.
    await expect(service.update(OWNER, RULE, { suggestedServiceId: COLOUR })).rejects.toThrow(
      'A service cannot suggest itself',
    );
  });

  it('cannot update another business’s rule', async () => {
    const { service } = build({
      tables: tables({ upsell_rules: [{ ...ruleDefaults(), business_id: OTHER_BUSINESS }] }),
    });
    await expect(service.update(OWNER, RULE, { enabled: false })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('delete', () => {
  it('deletes a rule scoped to the acting business', async () => {
    const { service, captured } = build({ tables: tables() });
    await service.remove(OWNER, RULE);

    expect(captured.some((call) => call.table === 'upsell_rules' && call.verb === 'delete')).toBe(true);
  });

  it('cannot delete another business’s rule', async () => {
    const { service, captured } = build({
      tables: tables({ upsell_rules: [{ ...ruleDefaults(), business_id: OTHER_BUSINESS }] }),
    });
    await expect(service.remove(OWNER, RULE)).rejects.toBeInstanceOf(NotFoundException);
    expect(captured.filter((call) => call.verb === 'delete')).toEqual([]);
  });
});

describe('audit trail', () => {
  it('records a create', async () => {
    const { service, record } = build({ tables: tables() });
    await service.create(OWNER, VALID_CREATE);

    expect(record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ action: 'upsell.rule.created', entityType: 'upsell_rule' }),
    );
  });

  it('records a disable distinctly from a generic update', async () => {
    const { service, record } = build({ tables: tables() });
    await service.update(OWNER, RULE, { enabled: false });

    expect(record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        action: 'upsell.rule.disabled',
        before: expect.objectContaining({ enabled: true }),
        after: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('records a rename as a generic update', async () => {
    const { service, record } = build({ tables: tables() });
    await service.update(OWNER, RULE, { name: 'Colour then Toner' });

    expect(record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ action: 'upsell.rule.updated' }),
    );
  });

  it('records a delete with the rule that was removed', async () => {
    const { service, record } = build({ tables: tables() });
    await service.remove(OWNER, RULE);

    expect(record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        action: 'upsell.rule.deleted',
        before: expect.objectContaining({ suggestedServiceId: TONER }),
      }),
    );
  });
});
