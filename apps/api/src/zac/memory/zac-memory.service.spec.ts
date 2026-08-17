import type { ConfigService } from '@nestjs/config';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../../common/testing/supabase-fake';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacCostTelemetryService } from '../measurement/zac-cost-telemetry.service';
import { ZacMemoryStore } from '../persistence/zac-memory.store';
import { ZacMemoryExtractionService } from './zac-memory-extraction.service';
import { ZacMemoryService } from './zac-memory.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    return (globalThis as { __supabaseFake?: unknown }).__supabaseFake;
  }),
}));

function contextWith(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: 'owner-1',
    actorFirstName: 'Owner',
    businessId: 'biz-1',
    businessName: 'Shear Genius',
    locationId: null,
    accessibleLocationIds: ['loc-1', 'loc-2'],
    accessibleLocations: [
      { id: 'loc-1', name: 'Main' },
      { id: 'loc-2', name: 'Second' },
    ],
    roleContext: 'owner',
    roles: ['owner'],
    permissions: ['zac.access'],
    staffProfileId: null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
    ...overrides,
  };
}

const stylistContext = (overrides: Partial<ZacActingContext> = {}) =>
  contextWith({
    actorUserId: 'stylist-1',
    roleContext: 'stylist',
    roles: ['stylist'],
    staffProfileId: 'staff-1',
    accessibleLocationIds: ['loc-1'],
    ...overrides,
  });

function makeMemoryService(state: SupabaseFakeState = createSupabaseFakeState()): {
  service: ZacMemoryService;
  telemetry: { recordCostEvent: jest.Mock; recordSpineEvent: jest.Mock };
  state: SupabaseFakeState;
} {
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  const telemetry = { recordCostEvent: jest.fn(), recordSpineEvent: jest.fn() };
  const service = new ZacMemoryService(
    new ZacMemoryStore(config),
    new ZacMemoryExtractionService(),
    telemetry as unknown as ZacCostTelemetryService,
  );
  return { service, telemetry, state };
}

const extraction = new ZacMemoryExtractionService();

function commandFor(question: string, roleContext: 'owner' | 'manager' | 'stylist') {
  const command = extraction.detectCommand(question, roleContext);
  if (!command) throw new Error(`no command extracted from: ${question}`);
  return command;
}

describe('ZacMemoryService', () => {
  describe('server-side scope resolution', () => {
    it('keeps preferences private for every role', () => {
      const { service } = makeMemoryService();
      expect(service.resolveScope(contextWith(), 'user_preference')).toBe('user_private');
      expect(service.resolveScope(stylistContext(), 'user_preference')).toBe('user_private');
    });

    it('makes stylist coaching focus stylist_private — the hard Phase 1 rule', () => {
      const { service } = makeMemoryService();
      expect(service.resolveScope(stylistContext(), 'coaching_focus')).toBe('stylist_private');
    });

    it('never lets a stylist create business- or team-visible memory', () => {
      const { service } = makeMemoryService();
      expect(service.resolveScope(stylistContext(), 'business_goal')).toBe('user_private');
      expect(service.resolveScope(stylistContext(), 'manager_team_theme')).toBe('user_private');
    });

    it('scopes owner business statements to the business and manager ones to the team', () => {
      const { service } = makeMemoryService();
      expect(service.resolveScope(contextWith(), 'business_goal')).toBe('business_owner');
      expect(
        service.resolveScope(contextWith({ roleContext: 'manager', roles: ['manager'] }), 'business_goal'),
      ).toBe('manager_team_theme');
    });
  });

  describe('capture and supersession', () => {
    it('stores the Luke rebooking goal business-visible with its redacted summary', async () => {
      const { service, telemetry } = makeMemoryService();

      const { item } = await service.capture(
        contextWith(),
        commandFor(
          'My main goal this month is to increase rebooking to 60%. Please remember that.',
          'owner',
        ),
        'conv-1',
        'trace-1',
      );

      expect(item.kind).toBe('business_goal');
      expect(item.visibilityScope).toBe('business_owner');
      expect(item.content).toBe('My main goal this month is to increase rebooking to 60%.');
      expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
        'memory_created',
        expect.objectContaining({ kind: 'business_goal', visibility_scope: 'business_owner' }),
      );
      // Content never enters telemetry.
      const payloads = telemetry.recordSpineEvent.mock.calls.map((call) => JSON.stringify(call));
      expect(payloads.join(' ')).not.toContain('60%');
    });

    it('replaces a goal instead of keeping two active contradictory ones', async () => {
      const { service, state } = makeMemoryService();
      const context = contextWith();

      await service.capture(context, commandFor('My rebooking goal is 55%.', 'owner'), 'c1', 't1');
      const updated = await service.capture(
        context,
        commandFor('Actually make my rebooking goal 60% this month.', 'owner'),
        'c1',
        't2',
      );

      const rows = state.tables.get('zac.memory_items') ?? [];
      const active = rows.filter((row) => row['status'] === 'active');
      const superseded = rows.filter((row) => row['status'] === 'superseded');
      expect(active).toHaveLength(1);
      expect(String(active[0]['content_redacted'])).toContain('60%');
      expect(superseded).toHaveLength(1);
      expect(String(superseded[0]['content_redacted'])).toContain('55%');
      expect(superseded[0]['superseded_by_id']).toBe(updated.item.id);
    });

    it('resolves "update that goal to 60%" against the predecessor and synthesises a readable summary', async () => {
      const { service, state } = makeMemoryService();
      const context = contextWith();

      await service.capture(context, commandFor('My rebooking goal is 55%.', 'owner'), 'c1', 't1');
      const { item, supersededCount } = await service.capture(
        context,
        commandFor('Update that goal to 60%.', 'owner'),
        'c1',
        't2',
      );

      expect(supersededCount).toBe(1);
      expect(item.topic).toBe('rebooking');
      expect(item.content).toBe('Business goal (rebooking): 60%.');
      const active = (state.tables.get('zac.memory_items') ?? []).filter(
        (row) => row['status'] === 'active',
      );
      expect(active).toHaveLength(1);
    });

    it('keeps goals about different topics side by side', async () => {
      const { service, state } = makeMemoryService();
      const context = contextWith();

      await service.capture(context, commandFor('My rebooking goal is 60%.', 'owner'), 'c1', 't1');
      await service.capture(
        context,
        commandFor('Our biggest priority this month is reducing colour waste.', 'owner'),
        'c1',
        't2',
      );

      const active = (state.tables.get('zac.memory_items') ?? []).filter(
        (row) => row['status'] === 'active',
      );
      expect(active).toHaveLength(2);
    });
  });

  describe('visibility and privacy', () => {
    async function seedStylistCoaching(state: SupabaseFakeState) {
      const { service } = makeMemoryService(state);
      await service.capture(
        stylistContext(),
        commandFor(
          'Please remember that I struggle with asking clients to rebook and want coaching on it.',
          'stylist',
        ),
        'c-stylist',
        't-stylist',
      );
    }

    it('lets the stylist recall their own private coaching focus', async () => {
      const state = createSupabaseFakeState();
      await seedStylistCoaching(state);
      const { service } = makeMemoryService(state);

      const items = await service.recall(stylistContext(), 'about_me', 't1');
      expect(items).toHaveLength(1);
      expect(items[0].visibilityScope).toBe('stylist_private');
    });

    it('never returns stylist-private coaching to an owner or manager — any subject', async () => {
      const state = createSupabaseFakeState();
      await seedStylistCoaching(state);
      const { service } = makeMemoryService(state);

      for (const subject of ['about_me', 'about_business', 'about_team', 'goals'] as const) {
        const forOwner = await service.recall(contextWith(), subject, 't1');
        const forManager = await service.recall(
          contextWith({ actorUserId: 'manager-1', roleContext: 'manager', roles: ['manager'] }),
          subject,
          't2',
        );
        expect(forOwner).toHaveLength(0);
        expect(forManager).toHaveLength(0);
      }
    });

    it("keeps one user's PERSONAL memory invisible to another user in the same business", async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      await service.capture(
        contextWith(),
        commandFor('Please remember that I prefer concise answers.', 'owner'),
        'c1',
        't1',
      );

      const other = await service.recall(
        contextWith({ actorUserId: 'owner-2' }),
        'about_me',
        't2',
      );
      expect(other).toHaveLength(0);
    });

    it('keeps memory strictly inside its business', async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      await service.capture(
        contextWith(),
        commandFor('My rebooking goal is 60%.', 'owner'),
        'c1',
        't1',
      );

      const otherBusiness = await service.recall(
        contextWith({ businessId: 'biz-2' }),
        'about_business',
        't2',
      );
      expect(otherBusiness).toHaveLength(0);
    });

    it('applies CURRENT role on every retrieval — a demoted owner loses business memory access', async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      await service.capture(
        contextWith(),
        commandFor('My rebooking goal is 60%.', 'owner'),
        'c1',
        't1',
      );

      // Same person, now holding only the stylist role.
      const demoted = await service.recall(
        contextWith({ roleContext: 'stylist', roles: ['stylist'], staffProfileId: 'staff-9' }),
        'about_business',
        't2',
      );
      expect(demoted).toHaveLength(0);
    });

    it('scopes manager team themes to the manager location scope', async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      const managerLoc1 = contextWith({
        actorUserId: 'manager-1',
        roleContext: 'manager',
        roles: ['manager'],
        accessibleLocationIds: ['loc-1'],
        locationId: 'loc-1',
      });
      await service.capture(
        managerLoc1,
        commandFor('Remember that I want to coach the team on rebooking this week.', 'manager'),
        'c1',
        't1',
      );

      const sameLocation = await service.recall(managerLoc1, 'about_team', 't2');
      expect(sameLocation).toHaveLength(1);

      const otherLocationManager = await service.recall(
        contextWith({
          actorUserId: 'manager-2',
          roleContext: 'manager',
          roles: ['manager'],
          accessibleLocationIds: ['loc-2'],
          locationId: 'loc-2',
        }),
        'about_team',
        't3',
      );
      expect(otherLocationManager).toHaveLength(0);

      // Owners see all team themes in their business.
      const owner = await service.recall(contextWith(), 'about_team', 't4');
      expect(owner).toHaveLength(1);
    });

    it('keeps a location-less team theme to its author and owners — never every manager', async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      // A multi-location manager with no explicit location focus: the theme
      // cannot be pinned to one location.
      const multiLocationManager = contextWith({
        actorUserId: 'manager-1',
        roleContext: 'manager',
        roles: ['manager'],
        accessibleLocationIds: ['loc-1', 'loc-2'],
        locationId: null,
      });
      await service.capture(
        multiLocationManager,
        commandFor('Remember that I want to coach the team on rebooking this week.', 'manager'),
        'c1',
        't1',
      );

      // Author still sees it; an unrelated manager in the business does not.
      expect(await service.recall(multiLocationManager, 'about_team', 't2')).toHaveLength(1);
      const otherManager = await service.recall(
        contextWith({
          actorUserId: 'manager-2',
          roleContext: 'manager',
          roles: ['manager'],
          accessibleLocationIds: ['loc-3'],
        }),
        'about_team',
        't3',
      );
      expect(otherManager).toHaveLength(0);
      // Owners keep full business visibility.
      expect(await service.recall(contextWith(), 'about_team', 't4')).toHaveLength(1);
    });
  });

  describe('relevance retrieval', () => {
    it('surfaces the rebooking goal for a rebooking question, not for unrelated ones', async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      const context = contextWith();
      await service.capture(context, commandFor('My rebooking goal is 60%.', 'owner'), 'c1', 't1');

      const relevant = await service.retrieveRelevant(
        context,
        'How can I improve my rebooking?',
        't2',
      );
      expect(relevant.map((item) => item.kind)).toContain('business_goal');

      const unrelated = await service.retrieveRelevant(
        context,
        'What locations can I see?',
        't3',
      );
      expect(unrelated).toHaveLength(0);
    });

    it('always carries communication-style preferences, and caps the total at five', async () => {
      const state = createSupabaseFakeState();
      const { service } = makeMemoryService(state);
      const context = contextWith();
      await service.capture(
        context,
        commandFor('Please remember that I prefer concise answers.', 'owner'),
        'c1',
        't1',
      );

      const relevant = await service.retrieveRelevant(context, 'How is my business doing?', 't2');
      expect(relevant.map((item) => item.topic)).toContain('communication_style');
      expect(relevant.length).toBeLessThanOrEqual(5);
    });

    it('fails soft to an empty set when storage is down', async () => {
      const { service } = makeMemoryService();
      const fake = (globalThis as { __supabaseFake?: { schema: unknown } }).__supabaseFake!;
      fake.schema = () => {
        throw new Error('zac schema unavailable');
      };

      await expect(
        service.retrieveRelevant(contextWith(), 'How can I improve my rebooking?', 't1'),
      ).resolves.toEqual([]);
    });
  });
});
