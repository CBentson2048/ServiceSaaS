/**
 * NotificationsService — creation, the per-user feed, and read/unread state.
 *
 * WHAT THESE SPECS PROVE. That the SERVICE asks the database for the right things:
 * that every read is scoped to the acting user AND their business, that read-state
 * writes touch only the acting user's own recipient row, that unread counts move
 * the way the product says, that pagination and newest-first ordering are actually
 * requested and honoured, and that a producer handing over a cross-business
 * recipient is refused before anything is written.
 *
 * WHAT THEY DELIBERATELY DO NOT PROVE, and where that lives instead:
 *   - That the DATABASE enforces any of it. This service holds a service-role key,
 *     which bypasses RLS entirely, so application-layer scoping IS the tenancy
 *     boundary on this path and is what is tested here. That a stylist hitting
 *     PostgREST directly with their own token cannot read another user's feed is
 *     proved in supabase/tests/in_app_notifications.sql (cases 34-45), and cannot
 *     be proved from Jest at all.
 *   - That comms.create_notification is atomic, drops ineligible recipients, or
 *     deduplicates. Those are properties of the migration's plpgsql, asserted in
 *     the SQL suite (cases 01-19). Here the RPC is faked, so what is tested is that
 *     the service CALLS it with the right arguments and handles each shape of
 *     answer — not what it does.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { NotificationPriority, NotificationType, type AuthUser } from '@sheer/domain';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type RpcHandler,
  type SupabaseFakeState,
} from '../common/testing/supabase-fake';
import { NotificationsService } from './notifications.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b0000000-0000-0000-0000-000000000001';
const OTHER_BUSINESS_ID = 'b0000000-0000-0000-0000-000000000002';
const STYLIST_ID = 'u0000000-0000-0000-0000-000000000001';
const MANAGER_ID = 'u0000000-0000-0000-0000-000000000002';
const OUTSIDER_ID = 'u0000000-0000-0000-0000-000000000003';
const LOCATION_ID = 'l0000000-0000-0000-0000-000000000001';

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: STYLIST_ID,
    roles: ['stylist'],
    primaryRole: 'stylist',
    businessId: BUSINESS_ID,
    allowedLocationIds: [LOCATION_ID],
    locationScope: 'assigned',
    locations: [],
    permissions: [],
    profile: { fullName: 'Sam Stylist', email: 'sam@example.com' },
    ...overrides,
  } as unknown as AuthUser;
}

/** A recipient row with its parent notification embedded, as PostgREST returns it. */
function feedRow(
  overrides: {
    notificationId: string;
    userProfileId?: string;
    businessId?: string;
    createdAt?: string;
    readAt?: string | null;
    seenAt?: string | null;
    expiresAt?: string | null;
    type?: string;
    title?: string;
  },
): Record<string, unknown> {
  const createdAt = overrides.createdAt ?? '2026-08-01T10:00:00.000Z';
  return {
    id: `r-${overrides.notificationId}-${overrides.userProfileId ?? STYLIST_ID}`,
    notification_id: overrides.notificationId,
    business_id: overrides.businessId ?? BUSINESS_ID,
    user_profile_id: overrides.userProfileId ?? STYLIST_ID,
    seen_at: overrides.seenAt ?? null,
    read_at: overrides.readAt ?? null,
    created_at: createdAt,
    notifications: {
      id: overrides.notificationId,
      type: overrides.type ?? NotificationType.ClientArrived,
      priority: 'high',
      title: overrides.title ?? 'Client arrived',
      body: 'Jane has arrived.',
      entity_type: 'appointment',
      entity_id: 'a0000000-0000-0000-0000-000000000001',
      action_path: '/bookings?appointmentId=a0000000-0000-0000-0000-000000000001',
      location_id: LOCATION_ID,
      metadata: {},
      created_at: createdAt,
      expires_at: overrides.expiresAt ?? null,
    },
  };
}

/**
 * Push enqueue stand-in. Registered by default in every test so the shared
 * creation path does not log a "not faked" error in unrelated specs; a test that
 * cares about push overrides it. Returns the number of delivery rows created,
 * exactly as comms.enqueue_push_for_notification does.
 */
const enqueuePushRpcOk: RpcHandler = () => ({ data: 1, error: null });

function makeService(
  seed: Record<string, Array<Record<string, unknown>>> = {},
  rpcs: Record<string, RpcHandler> = {},
): { service: NotificationsService; state: SupabaseFakeState } {
  const state = createSupabaseFakeState(seed, {
    enqueue_push_for_notification: enqueuePushRpcOk,
    ...rpcs,
  });
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  return { service: new NotificationsService(config), state };
}

/** The happy-path create_notification stand-in: one notification, all recipients kept. */
const createRpcOk: RpcHandler = (args) => {
  const recipients = (args['p_recipient_user_profile_ids'] as string[]) ?? [];
  return {
    data: [
      {
        notification_id: 'n0000000-0000-0000-0000-0000000000ff',
        recipient_count: recipients.length,
        requested_count: recipients.length,
        deduplicated: false,
      },
    ],
    error: null,
  };
};

describe('NotificationsService.create', () => {
  it('calls comms.create_notification with the producer’s content and recipients', async () => {
    const { service, state } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      { create_notification: createRpcOk },
    );

    const result = await service.create({
      businessId: BUSINESS_ID,
      type: NotificationType.ClientArrived,
      title: 'Client arrived',
      body: 'Jane has arrived.',
      recipientUserProfileIds: [STYLIST_ID],
      locationId: LOCATION_ID,
      priority: NotificationPriority.High,
      entityType: 'appointment',
      entityId: 'a0000000-0000-0000-0000-000000000001',
      actionPath: '/bookings?appointmentId=a1',
      dedupeKey: 'client_arrived:a1',
    });

    expect(result.notificationId).toBe('n0000000-0000-0000-0000-0000000000ff');
    expect(result.recipientCount).toBe(1);

    const call = state.rpcLog.find((entry) => entry.name === 'create_notification');
    expect(call).toBeDefined();
    expect(call?.args).toMatchObject({
      p_business_id: BUSINESS_ID,
      p_type: 'client_arrived',
      p_location_id: LOCATION_ID,
      p_priority: 'high',
      p_dedupe_key: 'client_arrived:a1',
      p_recipient_user_profile_ids: [STYLIST_ID],
    });
  });

  it('de-duplicates a repeated recipient id before it reaches the database', async () => {
    const { service, state } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      { create_notification: createRpcOk },
    );

    await service.create({
      businessId: BUSINESS_ID,
      type: NotificationType.System,
      title: 't',
      body: 'b',
      recipientUserProfileIds: [STYLIST_ID, STYLIST_ID, STYLIST_ID],
    });

    const call = state.rpcLog.find((entry) => entry.name === 'create_notification');
    expect(call?.args['p_recipient_user_profile_ids']).toEqual([STYLIST_ID]);
  });

  it('refuses a recipient who is not a member of the business, and writes nothing', async () => {
    const { service, state } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      { create_notification: createRpcOk },
    );

    await expect(
      service.create({
        businessId: BUSINESS_ID,
        type: NotificationType.System,
        title: 't',
        body: 'b',
        // OUTSIDER_ID belongs to another tenant entirely.
        recipientUserProfileIds: [STYLIST_ID, OUTSIDER_ID],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The critical half of the assertion: it failed BEFORE the write.
    expect(state.rpcLog).toHaveLength(0);
  });

  it('rejects an unknown notification type rather than persisting it', async () => {
    const { service } = makeService({}, { create_notification: createRpcOk });
    await expect(
      service.create({
        businessId: BUSINESS_ID,
        type: 'NOT_A_REAL_TYPE' as never,
        title: 't',
        body: 'b',
        recipientUserProfileIds: [STYLIST_ID],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty recipient list', async () => {
    const { service } = makeService({}, { create_notification: createRpcOk });
    await expect(
      service.create({
        businessId: BUSINESS_ID,
        type: NotificationType.System,
        title: 't',
        body: 'b',
        recipientUserProfileIds: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a half-specified entity link', async () => {
    const { service } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      { create_notification: createRpcOk },
    );
    await expect(
      service.create({
        businessId: BUSINESS_ID,
        type: NotificationType.System,
        title: 't',
        body: 'b',
        recipientUserProfileIds: [STYLIST_ID],
        entityType: 'appointment',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a deduplicated create instead of treating it as new', async () => {
    const { service } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      {
        create_notification: () => ({
          data: [
            {
              notification_id: 'n-existing',
              recipient_count: 1,
              requested_count: 1,
              deduplicated: true,
            },
          ],
          error: null,
        }),
      },
    );

    const result = await service.create({
      businessId: BUSINESS_ID,
      type: NotificationType.ClientArrived,
      title: 't',
      body: 'b',
      recipientUserProfileIds: [STYLIST_ID],
      dedupeKey: 'client_arrived:a1',
    });

    expect(result).toMatchObject({ notificationId: 'n-existing', deduplicated: true });
  });
});

describe('NotificationsService.createSafe — failure isolation', () => {
  it('swallows a database failure so the originating business action survives', async () => {
    const { service } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      { create_notification: () => ({ data: null, error: { message: 'boom' } }) },
    );

    // The whole point of the ticket's reliability requirement: this must resolve,
    // not reject, or a broken notification path takes check-in down with it.
    await expect(
      service.createSafe({
        businessId: BUSINESS_ID,
        type: NotificationType.ClientArrived,
        title: 't',
        body: 'b',
        recipientUserProfileIds: [STYLIST_ID],
      }),
    ).resolves.toBeNull();
  });

  it('swallows a validation failure too', async () => {
    const { service } = makeService({}, { create_notification: createRpcOk });
    await expect(
      service.createSafe({
        businessId: BUSINESS_ID,
        type: 'BOGUS' as never,
        title: 't',
        body: 'b',
        recipientUserProfileIds: [STYLIST_ID],
      }),
    ).resolves.toBeNull();
  });

  it('does not swallow anything on the happy path', async () => {
    const { service } = makeService(
      { 'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }] },
      { create_notification: createRpcOk },
    );
    const result = await service.createSafe({
      businessId: BUSINESS_ID,
      type: NotificationType.ClientArrived,
      title: 't',
      body: 'b',
      recipientUserProfileIds: [STYLIST_ID],
    });
    expect(result?.recipientCount).toBe(1);
  });
});

describe('NotificationsService.list', () => {
  const seed = {
    'comms.notification_recipients': [
      feedRow({ notificationId: 'n1', createdAt: '2026-08-01T10:00:00.000Z' }),
      feedRow({ notificationId: 'n2', createdAt: '2026-08-03T10:00:00.000Z' }),
      feedRow({ notificationId: 'n3', createdAt: '2026-08-02T10:00:00.000Z', readAt: '2026-08-02T12:00:00.000Z' }),
      // Another user in the same business — must never appear.
      feedRow({ notificationId: 'n4', userProfileId: MANAGER_ID }),
      // Another business — must never appear.
      feedRow({ notificationId: 'n5', businessId: OTHER_BUSINESS_ID }),
    ],
  };

  it('returns only the acting user’s own notifications', async () => {
    const { service } = makeService(seed);
    const result = await service.list(actor(), {});
    const ids = result.notifications.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['n1', 'n2', 'n3']));
    expect(ids).not.toContain('n4');
  });

  it('never returns a notification from another business', async () => {
    const { service } = makeService(seed);
    const result = await service.list(actor(), {});
    expect(result.notifications.map((n) => n.id)).not.toContain('n5');
  });

  it('orders newest first', async () => {
    const { service } = makeService(seed);
    const result = await service.list(actor(), {});
    expect(result.notifications.map((n) => n.id)).toEqual(['n2', 'n3', 'n1']);
  });

  it('paginates, and reports the total across the whole feed rather than the page', async () => {
    const { service } = makeService(seed);
    const page1 = await service.list(actor(), { page: 1, pageSize: 2 });
    expect(page1.notifications.map((n) => n.id)).toEqual(['n2', 'n3']);
    expect(page1.pagination).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });

    const page2 = await service.list(actor(), { page: 2, pageSize: 2 });
    expect(page2.notifications.map((n) => n.id)).toEqual(['n1']);
  });

  it('answers a page past the end of the feed with an empty page, not a 500', async () => {
    // PostgREST knows the total because count:'exact' was requested, so an offset
    // beyond it comes back as 416 / PGRST103 rather than an empty list. A deep link
    // or a stale bookmark hits this on an ordinary navigation.
    const { service, state } = makeService(seed);
    state.errors.set('comms.notification_recipients', {
      message: 'Requested range not satisfiable',
      code: 'PGRST103',
    });

    const result = await service.list(actor(), { page: 99, pageSize: 20 });

    expect(result.notifications).toEqual([]);
    // …and the total is still the honest one, so the client can correct itself.
    expect(result.pagination).toEqual({ page: 99, pageSize: 20, total: 3, totalPages: 1 });
  });

  it('still surfaces a genuine database error as a failure', async () => {
    const { service, state } = makeService(seed);
    state.errors.set('comms.notification_recipients', { message: 'connection reset' });
    await expect(service.list(actor(), {})).rejects.toThrow(/Unable to load notifications/);
  });

  it('pages deterministically when notifications share a created_at', async () => {
    // comms.create_notification writes every recipient row of a fan-out with one
    // now(), so equal timestamps are the normal case, not an edge case. Without the
    // `.order('id')` tie-break the two pages could repeat or skip a row.
    const SAME = '2026-08-05T10:00:00.000Z';
    const { service: svc, state } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'tie-a', createdAt: SAME }),
        feedRow({ notificationId: 'tie-b', createdAt: SAME }),
      ],
    });

    const page1 = await svc.list(actor(), { page: 1, pageSize: 1 });
    const page2 = await svc.list(actor(), { page: 2, pageSize: 1 });
    const ids = [...page1.notifications, ...page2.notifications].map((n) => n.id);

    expect(page1.notifications).toHaveLength(1);
    expect(page2.notifications).toHaveLength(1);
    // Disjoint AND complete: neither repeated nor skipped.
    expect(new Set(ids).size).toBe(2);
    expect([...ids].sort()).toEqual(['tie-a', 'tie-b']);

    // The behavioural half above cannot fail in an in-memory fake — JS's sort is
    // stable, so it returns a consistent order with or without the tie-break. What
    // is actually provable here is that the service ASKED Postgres for a total
    // order; that request is the thing that makes real paging deterministic.
    const feedRead = state.reads.find((r) => r.table === 'comms.notification_recipients');
    expect(feedRead?.orderBy).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'id', ascending: false },
    ]);
  });

  it('filters to unread only when asked', async () => {
    const { service } = makeService(seed);
    const result = await service.list(actor(), { unreadOnly: true });
    // n3 is read.
    expect(result.notifications.map((n) => n.id)).toEqual(['n2', 'n1']);
  });

  it('excludes an expired notification from the feed but keeps the row', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'live', expiresAt: '2999-01-01T00:00:00.000Z' }),
        feedRow({ notificationId: 'lapsed', expiresAt: '2000-01-01T00:00:00.000Z' }),
        feedRow({ notificationId: 'eternal', expiresAt: null }),
      ],
    });
    const result = await service.list(actor(), {});
    const ids = result.notifications.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['live', 'eternal']));
    expect(ids).not.toContain('lapsed');
  });

  it('maps the row onto the UI contract without leaking internal columns', async () => {
    const { service } = makeService(seed);
    const [first] = (await service.list(actor(), { pageSize: 1 })).notifications;
    expect(first).toEqual({
      id: 'n2',
      type: 'client_arrived',
      priority: 'high',
      title: 'Client arrived',
      body: 'Jane has arrived.',
      entity: { type: 'appointment', id: 'a0000000-0000-0000-0000-000000000001' },
      actionPath: '/bookings?appointmentId=a0000000-0000-0000-0000-000000000001',
      locationId: LOCATION_ID,
      metadata: {},
      createdAt: '2026-08-03T10:00:00.000Z',
      seenAt: null,
      readAt: null,
    });
    // dedupe_key / created_by / expires_at are internal bookkeeping.
    expect(Object.keys(first ?? {})).not.toContain('dedupeKey');
    expect(Object.keys(first ?? {})).not.toContain('expiresAt');
  });

  it('carries the unread badge alongside the page', async () => {
    const { service } = makeService(seed);
    const result = await service.list(actor(), { page: 1, pageSize: 1 });
    expect(result.unreadCount).toBe(2);
  });
});

describe('NotificationsService — a customer who has not joined a salon', () => {
  // AuthUser.businessId is '' until a customer's first booking creates a
  // membership. Passing that empty string into a uuid column is a 500, so every
  // entry point has to answer "you have nothing" instead of erroring.
  const salonless = () => actor({ businessId: '', roles: ['client'], primaryRole: 'client' });

  it('gets an empty feed rather than a 500', async () => {
    const { service } = makeService({ 'comms.notification_recipients': [feedRow({ notificationId: 'n1' })] });
    const result = await service.list(salonless(), {});
    expect(result.notifications).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
    expect(result.unreadCount).toBe(0);
  });

  it('gets a zero badge rather than a 500', async () => {
    const { service } = makeService({ 'comms.notification_recipients': [feedRow({ notificationId: 'n1' })] });
    expect(await service.unreadCount(salonless())).toEqual({ unreadCount: 0 });
  });

  it('gets a 404 when trying to mark anything read', async () => {
    const { service } = makeService({ 'comms.notification_recipients': [feedRow({ notificationId: 'n1' })] });
    await expect(service.markRead(salonless(), 'n1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('markAllRead is a no-op', async () => {
    const { service } = makeService({ 'comms.notification_recipients': [feedRow({ notificationId: 'n1' })] });
    expect(await service.markAllRead(salonless())).toEqual({ markedCount: 0, unreadCount: 0 });
  });

  it('never touches the database at all — no query carries an empty business id', async () => {
    // `state.log` records mutations only, so asserting on it alone cannot see a
    // SELECT — and an unguarded select with businessId '' matches no rows in the
    // fake, producing exactly the empty result the guard produces. `state.reads` is
    // what makes the guard's absence detectable.
    const { service, state } = makeService({
      'comms.notification_recipients': [feedRow({ notificationId: 'n1' })],
    });

    await service.list(salonless(), {});
    await service.unreadCount(salonless());
    await service.markAllRead(salonless());

    expect(state.reads).toHaveLength(0);
    expect(state.log).toHaveLength(0);
  });
});

describe('NotificationsService.unreadCount', () => {
  it('counts only the acting user’s unread rows in their business', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'n1' }),
        feedRow({ notificationId: 'n2' }),
        feedRow({ notificationId: 'n3', readAt: '2026-08-02T12:00:00.000Z' }),
        feedRow({ notificationId: 'n4', userProfileId: MANAGER_ID }),
        feedRow({ notificationId: 'n5', businessId: OTHER_BUSINESS_ID }),
      ],
    });
    expect(await service.unreadCount(actor())).toEqual({ unreadCount: 2 });
  });

  it('excludes expired notifications from the badge', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'live' }),
        feedRow({ notificationId: 'lapsed', expiresAt: '2000-01-01T00:00:00.000Z' }),
      ],
    });
    expect(await service.unreadCount(actor())).toEqual({ unreadCount: 1 });
  });
});

describe('NotificationsService read state', () => {
  function twoRecipientSeed() {
    return {
      'comms.notification_recipients': [
        feedRow({ notificationId: 'shared', userProfileId: STYLIST_ID }),
        feedRow({ notificationId: 'shared', userProfileId: MANAGER_ID }),
      ],
    };
  }

  it('marks read and drops the unread count', async () => {
    const { service } = makeService(twoRecipientSeed());
    expect((await service.unreadCount(actor())).unreadCount).toBe(1);

    const result = await service.markRead(actor(), 'shared');
    expect(result.notification.readAt).not.toBeNull();
    expect(result.unreadCount).toBe(0);
  });

  it('marks unread again and restores the count', async () => {
    const { service } = makeService(twoRecipientSeed());
    await service.markRead(actor(), 'shared');
    const result = await service.markUnread(actor(), 'shared');
    expect(result.notification.readAt).toBeNull();
    expect(result.unreadCount).toBe(1);
  });

  it('ONE recipient reading it leaves the other recipient unread', async () => {
    // The reason recipient state is a separate table at all.
    const { service, state } = makeService(twoRecipientSeed());
    await service.markRead(actor(), 'shared');

    const rows = state.tables.get('comms.notification_recipients') ?? [];
    const mine = rows.find((r) => r['user_profile_id'] === STYLIST_ID);
    const theirs = rows.find((r) => r['user_profile_id'] === MANAGER_ID);
    expect(mine?.['read_at']).not.toBeNull();
    expect(theirs?.['read_at']).toBeNull();
  });

  it('re-reading does not move the original read timestamp', async () => {
    // Seeded ALREADY READ at a fixed past instant rather than calling markRead
    // twice: two live calls can land in the same millisecond, so the second write
    // produces a byte-identical timestamp and the assertion passes even with the
    // `.is('read_at', null)` guard removed. Pinning the prior value makes the
    // guard the only thing that can keep it.
    const ORIGINAL = '2026-08-01T09:00:00.000Z';
    const { service, state } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'shared', userProfileId: STYLIST_ID, readAt: ORIGINAL }),
      ],
    });

    const result = await service.markRead(actor(), 'shared');

    expect(result.notification.readAt).toBe(ORIGINAL);
    const rows = state.tables.get('comms.notification_recipients') ?? [];
    expect(rows[0]?.['read_at']).toBe(ORIGINAL);
  });

  it('404s on another user’s notification, indistinguishably from a made-up id', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [feedRow({ notificationId: 'theirs', userProfileId: MANAGER_ID })],
    });
    await expect(service.markRead(actor(), 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.markRead(actor(), 'no-such-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not touch another user’s row when marking read', async () => {
    const { service, state } = makeService({
      'comms.notification_recipients': [feedRow({ notificationId: 'theirs', userProfileId: MANAGER_ID })],
    });
    await expect(service.markRead(actor(), 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    const rows = state.tables.get('comms.notification_recipients') ?? [];
    expect(rows[0]?.['read_at']).toBeNull();
  });

  it('cannot reach a notification in another business', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'foreign', businessId: OTHER_BUSINESS_ID }),
      ],
    });
    await expect(service.markRead(actor(), 'foreign')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('markAllRead clears the badge and reports how many rows changed', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'n1' }),
        feedRow({ notificationId: 'n2' }),
        feedRow({ notificationId: 'n3', readAt: '2026-08-02T12:00:00.000Z' }),
        feedRow({ notificationId: 'n4', userProfileId: MANAGER_ID }),
      ],
    });

    const result = await service.markAllRead(actor());
    expect(result.markedCount).toBe(2);
    expect(result.unreadCount).toBe(0);
  });

  it('markAllRead leaves other users’ rows alone', async () => {
    const { service, state } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'n1' }),
        feedRow({ notificationId: 'n4', userProfileId: MANAGER_ID }),
      ],
    });
    await service.markAllRead(actor());
    const theirs = (state.tables.get('comms.notification_recipients') ?? []).find(
      (r) => r['user_profile_id'] === MANAGER_ID,
    );
    expect(theirs?.['read_at']).toBeNull();
  });

  it('markAllRead is a no-op when everything is already read', async () => {
    const { service } = makeService({
      'comms.notification_recipients': [
        feedRow({ notificationId: 'n1', readAt: '2026-08-02T12:00:00.000Z' }),
      ],
    });
    expect(await service.markAllRead(actor())).toEqual({ markedCount: 0, unreadCount: 0 });
  });
});

/**
 * Push enqueue, from the creation path's point of view.
 *
 * The RULE these guard: queueing push is downstream of a notification that has
 * already been written, and it can never change whether creation succeeded. The
 * delivery itself is PushDispatchService's job and is tested there.
 */
describe('NotificationsService push enqueue', () => {
  const membership = {
    'core.user_memberships': [{ business_id: BUSINESS_ID, user_profile_id: STYLIST_ID }],
  };

  const input = () => ({
    businessId: BUSINESS_ID,
    locationId: LOCATION_ID,
    type: NotificationType.ClientArrived,
    title: 'Client arrived',
    body: 'Jane has arrived.',
    recipientUserProfileIds: [STYLIST_ID],
  });

  it('queues push for the notification it just created', async () => {
    const { service, state } = makeService(membership, { create_notification: createRpcOk });

    await service.create(input());

    const call = state.rpcLog.find((entry) => entry.name === 'enqueue_push_for_notification');
    expect(call).toBeDefined();
    // The id comes from the create RPC's answer, never from the caller: push must
    // attach to the row that was actually written.
    expect(call?.args).toEqual({ p_notification_id: 'n0000000-0000-0000-0000-0000000000ff' });
  });

  it('does NOT queue push for a deduplicated create', async () => {
    const { service, state } = makeService(membership, {
      create_notification: () => ({
        data: [
          {
            notification_id: 'n0000000-0000-0000-0000-0000000000ff',
            recipient_count: 1,
            requested_count: 1,
            deduplicated: true,
          },
        ],
        error: null,
      }),
    });

    const result = await service.create({ ...input(), dedupeKey: 'client_arrived:appt-1' });

    expect(result.deduplicated).toBe(true);
    // A double-tapped check-in resolves to the FIRST notification, which was
    // already pushed. Queueing again would buzz the stylist twice for one arrival.
    expect(state.rpcLog.some((entry) => entry.name === 'enqueue_push_for_notification')).toBe(false);
  });

  it('does NOT queue push when no notification was written', async () => {
    const { service, state } = makeService(membership, {
      create_notification: () => ({
        data: [
          {
            notification_id: null,
            recipient_count: 0,
            requested_count: 1,
            deduplicated: false,
          },
        ],
        error: null,
      }),
    });

    await service.create(input());

    expect(state.rpcLog.some((entry) => entry.name === 'enqueue_push_for_notification')).toBe(false);
  });

  it('still reports success when the push queue is broken', async () => {
    const { service } = makeService(membership, {
      create_notification: createRpcOk,
      enqueue_push_for_notification: () => ({ data: null, error: { message: 'outbox unavailable' } }),
    });

    // The in-app notification is the durable record. A dead push outbox must not
    // turn a written notification into a failed create — which, through createSafe,
    // would be indistinguishable from the notification itself failing.
    const result = await service.create(input());
    expect(result.notificationId).toBe('n0000000-0000-0000-0000-0000000000ff');
    expect(result.recipientCount).toBe(1);
  });

  it('still reports success when the push queue throws', async () => {
    const { service } = makeService(membership, {
      create_notification: createRpcOk,
      enqueue_push_for_notification: () => {
        throw new Error('connection reset');
      },
    });

    await expect(service.create(input())).resolves.toMatchObject({
      notificationId: 'n0000000-0000-0000-0000-0000000000ff',
    });
  });

  it('treats zero push-capable devices as normal, not as a failure', async () => {
    const { service } = makeService(membership, {
      create_notification: createRpcOk,
      // The stylist has not installed the app, or denied notification permission.
      // This is the "push not supported" path the ticket asks to degrade gracefully.
      enqueue_push_for_notification: () => ({ data: 0, error: null }),
    });

    await expect(service.create(input())).resolves.toMatchObject({ recipientCount: 1 });
  });
});
