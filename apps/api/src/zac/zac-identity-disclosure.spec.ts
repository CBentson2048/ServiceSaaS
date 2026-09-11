/**
 * THE ACCEPTANCE TEST FOR NAMING CLIENTS.
 *
 * The client asked ZAC to be able to identify lapsed clients for an actor whose
 * QLOOQO access already covers client records. The risk that came with it is not
 * the answer — it is what happens AFTER the answer.
 *
 * `zac.outputs.body_redacted` stores `redactForStorage(answer)`, and that
 * redactor has patterns for emails, tokens and long digit runs but NONE for
 * names. So the naive implementation would have written a durable, owner-
 * readable roster of named lapsed clients into a table whose read path re-checks
 * no client permission and no location scope — while rewriting their emails to
 * `[redacted]`, so the stored record would not even match what the user saw.
 *
 * These tests hold the line: names reach the WIRE, and nothing else.
 */
import { ClientLapseListTool } from './tools/tools/client-lapse-list.tool';
import { ZacMeasurementStore } from './persistence/zac-measurement.store';
import type { ClientIntelligenceService } from '../client-intelligence/client-intelligence.service';
import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from './context/zac-context.types';

const CLIENTS = [
  { clientCode: 'C-1042', firstName: 'Jane', lastName: 'Whitfield', displayName: 'Jane Whitfield', email: 'jane@example.com', phone: '07700900123' },
  { clientCode: 'C-1188', firstName: 'Marco', lastName: 'Silva', displayName: 'Marco Silva', email: 'marco@example.com', phone: '07700900456' },
];

const LAPSE = {
  clients: CLIENTS,
  counts: { active: 120, atRisk: 5, lapsed: 2, booked: 3, insufficientHistory: 8 },
  settings: { lapsedBufferDays: 14, minCompletedVisits: 3, historyVisitLimit: 10 },
  truncated: false,
  evaluatedClientCount: 127,
  pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
};

function actor(): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: 'biz-1',
    allowedLocationIds: ['loc-1'],
    locationScope: { kind: 'all', locationIds: ['loc-1'] },
    permissions: ['zac.access', 'crm.view'],
  } as unknown as AuthUser;
}

function context(): ZacActingContext {
  return { businessId: 'biz-1', locationId: null, roleContext: 'owner' } as unknown as ZacActingContext;
}

function makeTool(overrides: Partial<ClientIntelligenceService> = {}) {
  const listLapsedClients = jest.fn().mockResolvedValue(LAPSE);
  const service = { listLapsedClients, ...overrides } as unknown as ClientIntelligenceService;
  return { tool: new ClientLapseListTool(service), listLapsedClients };
}

describe('client identity disclosure', () => {
  describe('the tool separates what is said from what is stored', () => {
    it('puts identities on identityDisclosure, never on answer', async () => {
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});

      const p = result.presentation;
      expect(p?.identityDisclosure?.block).toContain('Jane Whitfield');
      expect(p?.identityDisclosure?.block).toContain('C-1042');
      // `answer` is what reaches the model provider and the outputs table.
      expect(p?.answer).not.toContain('Jane');
      expect(p?.answer).not.toContain('Whitfield');
      expect(p?.answer).not.toContain('C-1042');
      // It is still a real answer, not a stub.
      expect(p?.answer).toContain('2');
    });

    it('keeps every identity out of `data`', async () => {
      // `data` feeds evidence normalisation and the signal framework, both of
      // which must stay identity-free by construction rather than by review.
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});
      const serialised = JSON.stringify(result.data);

      expect(serialised).not.toMatch(/Jane|Whitfield|Marco|Silva|C-1042|C-1188/);
      expect(serialised).not.toMatch(/@example\.com|07700/);
      expect(result.data).toMatchObject({ cohort: 'lapsed', named_count: 2, cohort_total: 2 });
    });

    it('never emits contact details anywhere', async () => {
      // The client's decision: names identify, contacts are for the CRM screen.
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});
      const everything = JSON.stringify(result);

      expect(everything).not.toContain('jane@example.com');
      expect(everything).not.toContain('07700900123');
    });

    it('keeps entities_used empty', async () => {
      // The column is persisted UNREDACTED and its contract says safe handles
      // only. Nothing reads it today, so codes there would buy nothing and cost
      // a second copy of the identities.
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.evidence[0]?.entities_used).toEqual([]);
    });
  });

  describe('it offers the cohort it was not asked about', () => {
    it('points at the overdue clients when asked about the lapsed', async () => {
      // Lapsed clients have already gone; overdue ones are still reachable.
      // Answering only the question asked hands back the half that is hardest
      // to act on.
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.answer).toContain('5 more clients are overdue but not yet lapsed');
      expect(result.presentation?.answer).toContain('who is overdue?');
      // Offered as a COUNT — the other cohort is never named unasked.
      expect(result.presentation?.answer).not.toContain('(C-');
    });

    it('points the other way when asked about the overdue', async () => {
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), { cohort: 'at_risk' });
      expect(result.presentation?.answer).toContain('already lapsed');
      expect(result.presentation?.answer).toContain('who has lapsed?');
    });

    it('says nothing about the other cohort when it is empty', async () => {
      const { tool } = makeTool({
        listLapsedClients: jest.fn().mockResolvedValue({
          ...LAPSE,
          counts: { ...LAPSE.counts, atRisk: 0 },
        }),
      } as Partial<ClientIntelligenceService>);
      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.answer).not.toContain('overdue but not yet lapsed');
    });
  });

  describe('the gate', () => {
    it('requires crm.view and owner/manager, and never requires a write key', () => {
      const { tool } = makeTool();
      expect(tool.requiredPermissions).toEqual(['crm.view']);
      expect(tool.allowedRoles).toEqual(['owner', 'manager']);
      // crm.manage sits on POST/PATCH handlers; gating a read behind it would
      // tie reading to an edit grant.
      expect(tool.requiredPermissions).not.toContain('crm.manage');
      expect(tool.allowedRoles).not.toContain('stylist');
    });

    it('asks the guarded service for the cohort, not the whole client book', async () => {
      const { tool, listLapsedClients } = makeTool();
      await tool.execute(actor(), context(), {});
      expect(listLapsedClients).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ status: ['lapsed'], page: 1, pageSize: 25 }),
      );
    });

    it('honours the at_risk cohort when asked for it', async () => {
      const { tool, listLapsedClients } = makeTool();
      await tool.execute(actor(), context(), { cohort: 'at_risk' });
      expect(listLapsedClients).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: ['at_risk'] }),
      );
    });
  });

  describe('honest partiality', () => {
    it('says how many of the cohort it named when the list is capped', async () => {
      const { tool } = makeTool({
        listLapsedClients: jest.fn().mockResolvedValue({
          ...LAPSE,
          pagination: { page: 1, pageSize: 25, total: 63, totalPages: 3 },
        }),
      } as Partial<ClientIntelligenceService>);

      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.identityDisclosure?.block).toContain('most overdue of 63');
      expect(result.presentation?.limitations.join(' ')).toContain('61 more');
    });

    it('distinguishes a capped LIST from capped COUNTS', async () => {
      // Two different partiality flags. Conflating them tells the user the
      // wrong thing about which number to trust.
      const { tool } = makeTool({
        listLapsedClients: jest.fn().mockResolvedValue({ ...LAPSE, truncated: true }),
      } as Partial<ClientIntelligenceService>);

      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.limitations.join(' ')).toContain('platform cap');
      expect(result.presentation?.confidence).toBe('medium');
    });

    it('says so plainly when nobody is lapsed', async () => {
      const { tool } = makeTool({
        listLapsedClients: jest.fn().mockResolvedValue({
          ...LAPSE,
          clients: [],
          pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
        }),
      } as Partial<ClientIntelligenceService>);

      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.answer).toContain('nobody to name');
      expect(result.presentation?.identityDisclosure).toBeUndefined();
    });

    it('fails closed to a safe result when the guarded service throws', async () => {
      const { tool } = makeTool({
        listLapsedClients: jest.fn().mockRejectedValue(new Error('denied')),
      } as Partial<ClientIntelligenceService>);

      const result = await tool.execute(actor(), context(), {});
      expect(result.status).toBe('unavailable');
      expect(result.data).toBeNull();
      expect(result.presentation).toBeUndefined();
    });
  });

  describe('the list is not a contactable audience', () => {
    it('points at Campaigns, which applies consent and suppression', async () => {
      // The lapse row carries marketingOptIn but no GDPR state, so a named
      // client here could have a pending erasure request with nothing in the
      // payload to say so.
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});
      expect(result.presentation?.suggestedNextStep).toMatch(/campaigns/i);
      expect(result.presentation?.suggestedNextStep).toMatch(/consent|suppression/i);
    });
  });

  describe('the historical door stays open', () => {
    it('describes today as the measurement point, not as a permanent limit', async () => {
      const { tool } = makeTool();
      const result = await tool.execute(actor(), context(), {});
      const limits = result.presentation?.limitations.join(' ') ?? '';
      expect(limits).toContain('as it stands today');
      // Wording must not claim retention CANNOT be reconstructed — the service
      // takes a `today` parameter, so this is a call-shape limit, not an
      // architectural one.
      expect(limits).not.toMatch(/can only ever|never be able|not possible/i);
    });
  });
});

/**
 * The stored-output visibility matrix.
 *
 * This admitted any manager to any business-scoped output on base role alone —
 * no permission, no location predicate. Harmless only while nothing reads an
 * output body back, which is exactly the assumption this workstream changes.
 */
describe('stored outputs are visible by scope, not by job title', () => {
  const store = Object.create(ZacMeasurementStore.prototype) as {
    canSeeOutput: (c: unknown, o: unknown) => boolean;
  };
  const at = (roleContext: string, locations: string[] = ['loc-1']) => ({
    actorUserId: 'user-1',
    businessId: 'biz-1',
    roleContext,
    accessibleLocationIds: locations,
  });
  const output = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    business_id: 'biz-1',
    actor_user_id: 'someone-else',
    location_id: null,
    visibility_scope: 'business_owner',
    ...over,
  });

  it('lets an actor read their own output whatever its scope', () => {
    expect(
      store.canSeeOutput(at('stylist'), output({ actor_user_id: 'user-1', visibility_scope: 'user_private' })),
    ).toBe(true);
  });

  it('keeps a business-wide output owner-only', () => {
    // The underlying tools are location-scoped for everyone but an owner, so an
    // output derived from them must not widen what a manager can see.
    expect(store.canSeeOutput(at('owner'), output())).toBe(true);
    expect(store.canSeeOutput(at('manager'), output())).toBe(false);
  });

  it('scopes a team output to a manager who covers that location', () => {
    const team = { visibility_scope: 'manager_team_theme', location_id: 'loc-2' };
    expect(store.canSeeOutput(at('manager', ['loc-2']), output(team))).toBe(true);
    expect(store.canSeeOutput(at('manager', ['loc-1']), output(team))).toBe(false);
  });

  it('fails closed on a team output with no location', () => {
    // Otherwise it broadcasts to every manager in the business.
    expect(
      store.canSeeOutput(at('manager'), output({ visibility_scope: 'manager_team_theme', location_id: null })),
    ).toBe(false);
  });

  it("never lets a role widen into someone else's private output", () => {
    for (const role of ['owner', 'manager']) {
      expect(store.canSeeOutput(at(role), output({ visibility_scope: 'stylist_private' }))).toBe(false);
      expect(store.canSeeOutput(at(role), output({ visibility_scope: 'user_private' }))).toBe(false);
    }
  });

  it('denies an unrecognised scope and another business outright', () => {
    expect(store.canSeeOutput(at('owner'), output({ visibility_scope: 'system_safe_summary' }))).toBe(false);
    expect(store.canSeeOutput(at('owner'), output({ business_id: 'biz-2' }))).toBe(false);
  });
});
