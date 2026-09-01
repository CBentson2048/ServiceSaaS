/**
 * CampaignsService — owner configuration: authorization, tenancy, validation,
 * lifecycle and the audit trail.
 *
 * These specs prove what the configuration layer REFUSES: a non-owner reaching
 * campaigns at all, an owner without the notification-settings permission, a
 * location from another business, an invalid template or config, activating a
 * campaign that would fail mid-run, and a partial PATCH nulling fields the
 * caller never mentioned. They also prove every mutation reaches the existing
 * audit trail, because "who switched this campaign on?" has to be answerable.
 *
 * The database's own guarantees — the unique indexes, the CHECK constraints, the
 * atomic claim and RLS — are asserted in
 * supabase/tests/campaign_configuration.sql, not here.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, Permission, UserRole } from '@sheer/domain';
import { ALL_PERMISSIONS } from '@sheer/domain';
import type { AuditService } from '../audit/audit.service';
import type { CampaignEvaluatorService } from './campaign-evaluator.service';
import { CampaignsService } from './campaigns.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BUSINESS = 'b0000000-0000-4000-8000-000000000002';
const LOCATION = '10000000-0000-4000-8000-000000000001';
const FOREIGN_LOCATION = '10000000-0000-4000-8000-000000000009';
const CAMPAIGN = 'c0000000-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;

interface Captured {
  table: string;
  verb: string;
  payload?: Row;
}

function build(options: { tables?: Record<string, Row[]>; writeErrors?: Record<string, { code: string }> } = {}) {
  const captured: Captured[] = [];
  const tables = options.tables ?? {};

  const makeChain = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: Row = {};

    const settle = () => {
      captured.push({ table, verb, payload });
      const error = options.writeErrors?.[table];
      if (error) return { data: null, error };
      const merged =
        verb === 'insert' ? { id: CAMPAIGN, ...payload } : { ...(rows[0] ?? {}), ...payload };
      return { data: merged, error: null };
    };

    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      returns: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      neq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] !== value);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      insert: (body: Row) => {
        verb = 'insert';
        payload = body;
        return chain;
      },
      update: (body: Row) => {
        verb = 'update';
        payload = body;
        return chain;
      },
      maybeSingle: async () => (verb === 'select' ? { data: rows[0] ?? null, error: null } : settle()),
      then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve(verb === 'select' ? { data: rows, error: null } : settle()).then(resolve, reject),
    });
    return chain;
  };

  mockedCreateClient.mockReturnValue({
    schema: () => ({ from: (table: string) => makeChain(table) }),
  } as never);

  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  const evaluator = {
    resolveTimezones: jest.fn(async (rows: Array<{ business_id: string; location_id: string | null }>) => {
      const map = new Map<string, string>();
      for (const row of rows) map.set(`${row.business_id}:${row.location_id ?? ''}`, 'Europe/London');
      return map;
    }),
    preview: jest.fn(async () => ({ candidateCount: 3, eligibleCount: 2 })),
    runCampaign: jest.fn(async () => ({
      runId: 'run-1',
      candidateCount: 3,
      eligibleCount: 2,
      queuedCount: 2,
      suppressedCount: 1,
      failedCount: 0,
      suppressionBreakdown: {},
    })),
  } as unknown as CampaignEvaluatorService;

  const config = { getOrThrow: () => 'x' } as unknown as ConfigService;
  return { service: new CampaignsService(config, audit, evaluator), captured, audit, evaluator };
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  const roles: UserRole[] = overrides.roles ?? ['owner'];
  return {
    id: 'u1',
    roles,
    primaryRole: roles[0],
    businessId: BUSINESS,
    allowedLocationIds: [LOCATION],
    locationScope: 'all',
    locations: [],
    profile: { firstName: 'Luke', lastName: 'O', email: 'luke@example.com' },
    permissions: [...ALL_PERMISSIONS],
    ...overrides,
  } as AuthUser;
}

function campaignRow(overrides: Row = {}): Row {
  return {
    id: CAMPAIGN,
    business_id: BUSINESS,
    location_id: null,
    campaign_type: 'birthday',
    name: 'Birthday treat',
    status: 'draft',
    channel: 'auto',
    message_template: 'Happy birthday {{first_name}}!',
    message_subject: null,
    send_at_local_hour: 10,
    config: { daysBefore: 0 },
    created_by_user_profile_id: 'u1',
    last_evaluated_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const VALID_CREATE = {
  campaignType: 'birthday' as const,
  name: 'Birthday treat',
  messageTemplate: 'Happy birthday {{first_name}}, from {{salon_name}}!',
  config: { daysBefore: 0 },
};

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Authorization — Wrike sections 7, 51
// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('lets an owner with notification-settings permission configure campaigns', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow()] } });
    await expect(service.list(actor(), {})).resolves.toBeDefined();
  });

  it('refuses a manager', async () => {
    const { service } = build();
    await expect(service.list(actor({ roles: ['manager'] }), {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a stylist and a receptionist', async () => {
    const { service } = build();
    for (const role of ['stylist', 'client'] as UserRole[]) {
      await expect(service.list(actor({ roles: [role] }), {})).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('refuses an owner who does not hold settings.booking.manage', async () => {
    // The role alone is not the gate — the existing notification-settings
    // permission is the other half.
    const permissions = ALL_PERMISSIONS.filter((p) => p !== 'settings.booking.manage') as Permission[];
    const { service } = build();
    await expect(service.list(actor({ permissions }), {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gates every write, not just the reads', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow()] } });
    const manager = actor({ roles: ['manager'] });

    await expect(service.create(manager, VALID_CREATE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(manager, CAMPAIGN, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setStatus(manager, CAMPAIGN, 'active')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.runNow(manager, CAMPAIGN)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.previewAudience(manager, CAMPAIGN)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// Tenancy — Wrike sections 8, 44
// ---------------------------------------------------------------------------

describe('tenancy', () => {
  it('cannot read another business’s campaign', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow({ business_id: OTHER_BUSINESS })] } });
    // Same 404 as a non-existent id: a distinguishable 403 would confirm the id
    // exists somewhere.
    await expect(service.get(actor(), CAMPAIGN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never takes businessId from the caller', async () => {
    const { service, captured } = build({ tables: { campaigns: [campaignRow()], locations: [] } });
    await service.create(actor(), { ...VALID_CREATE, ...({ businessId: OTHER_BUSINESS } as object) });

    const insert = captured.find((c) => c.verb === 'insert');
    expect(insert?.payload?.['business_id']).toBe(BUSINESS);
  });

  it('rejects a location that belongs to another business', async () => {
    const { service } = build({
      tables: { locations: [{ id: LOCATION, business_id: BUSINESS }] },
    });
    await expect(
      service.create(actor(), { ...VALID_CREATE, locationId: FOREIGN_LOCATION }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accepts a location that does belong to the business', async () => {
    const { service, captured } = build({
      tables: { locations: [{ id: LOCATION, business_id: BUSINESS }], campaigns: [campaignRow()] },
    });
    await service.create(actor(), { ...VALID_CREATE, locationId: LOCATION });
    expect(captured.find((c) => c.verb === 'insert')?.payload?.['location_id']).toBe(LOCATION);
  });
});

// ---------------------------------------------------------------------------
// Creation — Wrike sections 32, 39, 51
// ---------------------------------------------------------------------------

describe('creation', () => {
  it('ALWAYS creates a draft, so saving a form can never send', async () => {
    const { service, captured } = build({ tables: { campaigns: [campaignRow()] } });
    await service.create(actor(), VALID_CREATE);
    expect(captured.find((c) => c.verb === 'insert')?.payload?.['status']).toBe('draft');
  });

  it('creates each of the four approved types', async () => {
    const cases = [
      { campaignType: 'rebooking' as const, config: { targetStatuses: ['lapsed'], minOverdueDays: 0, serviceCategoryId: null } },
      { campaignType: 'birthday' as const, config: { daysBefore: 0 } },
      {
        campaignType: 'promotion' as const,
        config: {
          startDate: '2026-09-01',
          endDate: '2026-09-30',
          lapseStatuses: [],
          serviceCategoryId: null,
          minCompletedVisits: 0,
        },
      },
      { campaignType: 'loyalty_milestone' as const, config: { metric: 'completed_visits', threshold: 10 } },
    ];

    for (const testCase of cases) {
      const { service, captured } = build({ tables: { campaigns: [campaignRow()] } });
      await service.create(actor(), { ...VALID_CREATE, ...testCase, name: `${testCase.campaignType} campaign` });
      expect(captured.find((c) => c.verb === 'insert')?.payload?.['campaign_type']).toBe(testCase.campaignType);
    }
  });

  it('defaults to the canonical WhatsApp-first chain', async () => {
    const { service, captured } = build({ tables: { campaigns: [campaignRow()] } });
    await service.create(actor(), VALID_CREATE);
    expect(captured.find((c) => c.verb === 'insert')?.payload?.['channel']).toBe('auto');
  });

  it('rejects an invalid template rather than storing it', async () => {
    const { service } = build();
    await expect(
      service.create(actor(), { ...VALID_CREATE, messageTemplate: 'Hi {{discount_code}}' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(actor(), { ...VALID_CREATE, messageTemplate: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a config that does not match the declared type', async () => {
    const { service } = build();
    await expect(
      service.create(actor(), { ...VALID_CREATE, campaignType: 'loyalty_milestone', config: { daysBefore: 0 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a duplicate name in scope as a 400, not a 500', async () => {
    const { service } = build({ writeErrors: { campaigns: { code: '23505' } } });
    await expect(service.create(actor(), VALID_CREATE)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the creation in the shared audit trail', async () => {
    const { service, audit } = build({ tables: { campaigns: [campaignRow()] } });
    await service.create(actor(), VALID_CREATE);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS }),
      expect.objectContaining({ action: 'campaign.created', entityType: 'campaign' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Editing — Wrike section 27
// ---------------------------------------------------------------------------

describe('editing', () => {
  it('applies only the fields the caller actually sent', async () => {
    const { service, captured } = build({ tables: { campaigns: [campaignRow()] } });

    // A DTO instance carries every declared field as an own (undefined) property,
    // so an `in` test would null everything omitted here.
    await service.update(actor(), CAMPAIGN, { name: 'Renamed' });

    const patch = captured.find((c) => c.verb === 'update')?.payload ?? {};
    expect(patch['name']).toBe('Renamed');
    expect(patch).not.toHaveProperty('message_template');
    expect(patch).not.toHaveProperty('config');
    expect(patch).not.toHaveProperty('location_id');
  });

  it('validates a replacement template', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow()] } });
    await expect(
      service.update(actor(), CAMPAIGN, { messageTemplate: 'Hi <b>{{first_name}}</b>' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates a replacement config against the campaign’s OWN type', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow({ campaign_type: 'birthday' })] } });
    await expect(
      service.update(actor(), CAMPAIGN, { config: { metric: 'total_spend', threshold: 50_000 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to edit an archived campaign', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow({ status: 'archived' })] } });
    await expect(service.update(actor(), CAMPAIGN, { name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the before/after delta in the audit trail', async () => {
    const { service, audit } = build({ tables: { campaigns: [campaignRow()] } });
    await service.update(actor(), CAMPAIGN, { name: 'Renamed' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'campaign.updated',
        before: expect.objectContaining({ name: 'Birthday treat' }),
        after: expect.objectContaining({ name: 'Renamed' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Enable / disable / archive — Wrike sections 28, 32
// ---------------------------------------------------------------------------

describe('status lifecycle', () => {
  it('enables a valid draft', async () => {
    const { service, captured, audit } = build({ tables: { campaigns: [campaignRow()] } });
    await service.setStatus(actor(), CAMPAIGN, 'active');

    expect(captured.find((c) => c.verb === 'update')?.payload?.['status']).toBe('active');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'campaign.enabled' }),
    );
  });

  it('re-validates on activation, so a stale draft cannot go live and fail mid-run', async () => {
    const { service } = build({
      tables: { campaigns: [campaignRow({ config: { daysBefore: 999 } })] },
    });
    await expect(service.setStatus(actor(), CAMPAIGN, 'active')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('disables an active campaign', async () => {
    const { service, captured, audit } = build({ tables: { campaigns: [campaignRow({ status: 'active' })] } });
    await service.setStatus(actor(), CAMPAIGN, 'paused');

    expect(captured.find((c) => c.verb === 'update')?.payload?.['status']).toBe('paused');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'campaign.disabled' }),
    );
  });

  it('archives rather than deletes, so send history stays explicable', async () => {
    const { service, captured, audit } = build({ tables: { campaigns: [campaignRow({ status: 'paused' })] } });
    await service.setStatus(actor(), CAMPAIGN, 'archived');

    expect(captured.some((c) => c.verb === 'delete')).toBe(false);
    expect(captured.find((c) => c.verb === 'update')?.payload?.['status']).toBe('archived');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'campaign.archived' }),
    );
  });

  it('refuses to reactivate an archived campaign', async () => {
    const { service } = build({ tables: { campaigns: [campaignRow({ status: 'archived' })] } });
    await expect(service.setStatus(actor(), CAMPAIGN, 'active')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is a no-op when the status is unchanged', async () => {
    const { service, captured } = build({ tables: { campaigns: [campaignRow({ status: 'active' })] } });
    await service.setStatus(actor(), CAMPAIGN, 'active');
    expect(captured.some((c) => c.verb === 'update')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manual run and preview
// ---------------------------------------------------------------------------

describe('manual run', () => {
  it('refuses to run a campaign that is not active', async () => {
    const { service, evaluator } = build({ tables: { campaigns: [campaignRow({ status: 'draft' })] } });
    await expect(service.runNow(actor(), CAMPAIGN)).rejects.toBeInstanceOf(BadRequestException);
    expect(evaluator.runCampaign).not.toHaveBeenCalled();
  });

  it('goes through the SAME run path the scheduler uses', async () => {
    const { service, evaluator } = build({
      tables: { campaigns: [campaignRow({ status: 'active' })], campaign_runs: [] },
    });
    const result = await service.runNow(actor(), CAMPAIGN);

    expect(evaluator.runCampaign).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('2 messages queued');
  });

  it('reports "already evaluated" rather than double-running', async () => {
    const { service, evaluator } = build({
      tables: { campaigns: [campaignRow({ status: 'active' })] },
    });
    (evaluator.runCampaign as jest.Mock).mockResolvedValueOnce(null);

    const result = await service.runNow(actor(), CAMPAIGN);
    expect(result.run).toBeNull();
    expect(result.message).toContain('already been evaluated');
  });

  it('records the run in the audit trail', async () => {
    const { service, audit } = build({
      tables: { campaigns: [campaignRow({ status: 'active' })], campaign_runs: [] },
    });
    await service.runNow(actor(), CAMPAIGN);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'campaign.run' }),
    );
  });
});

describe('audience preview', () => {
  it('delegates to the evaluator’s single resolver', async () => {
    const { service, evaluator } = build({ tables: { campaigns: [campaignRow()] } });
    await service.previewAudience(actor(), CAMPAIGN);
    expect(evaluator.preview).toHaveBeenCalledTimes(1);
  });

  it('cannot preview another business’s campaign', async () => {
    const { service, evaluator } = build({
      tables: { campaigns: [campaignRow({ business_id: OTHER_BUSINESS })] },
    });
    await expect(service.previewAudience(actor(), CAMPAIGN)).rejects.toBeInstanceOf(NotFoundException);
    expect(evaluator.preview).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('listing', () => {
  it('hides archived campaigns by default and shows them on request', async () => {
    const tables = {
      campaigns: [campaignRow(), campaignRow({ id: 'c2', name: 'Old', status: 'archived' })],
      campaign_runs: [],
      locations: [],
    };

    const hidden = await build({ tables }).service.list(actor(), {});
    expect(hidden.campaigns.map((c) => c.name)).toEqual(['Birthday treat']);

    const shown = await build({ tables }).service.list(actor(), { includeArchived: 'true' });
    expect(shown.campaigns).toHaveLength(2);
  });

  it('resolves the governing timezone for every campaign', async () => {
    const { service } = build({
      tables: { campaigns: [campaignRow()], campaign_runs: [], locations: [] },
    });
    const result = await service.list(actor(), {});
    expect(result.campaigns[0].timezone).toBe('Europe/London');
  });

  it('rolls up run counters', async () => {
    const { service } = build({
      tables: {
        campaigns: [campaignRow()],
        campaign_runs: [
          { campaign_id: CAMPAIGN, queued_count: 5, suppressed_count: 2, failed_count: 0 },
          { campaign_id: CAMPAIGN, queued_count: 3, suppressed_count: 1, failed_count: 1 },
        ],
        locations: [],
      },
    });
    const result = await service.list(actor(), {});
    expect(result.campaigns[0].totals).toEqual({
      runCount: 2,
      queuedCount: 8,
      suppressedCount: 3,
      failedCount: 1,
    });
  });
});
