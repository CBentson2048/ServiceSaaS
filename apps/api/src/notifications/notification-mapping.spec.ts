/**
 * Pure row -> DTO mapping for the notification feed.
 *
 * These specs pin the RESPONSE CONTRACT the web bell and the mobile feed are built
 * against: which fields exist, and — just as importantly — which internal columns
 * never cross the boundary. They prove nothing about the database; the shapes come
 * in as literals.
 */

import { NotificationType } from '@sheer/domain';
import {
  NOTIFICATION_FEED_COLUMNS,
  buildPagination,
  embeddedContent,
  isKnownNotificationType,
  pageRange,
  toNotificationDto,
  toUserDeviceDto,
  type NotificationContentRow,
  type NotificationFeedRow,
  type UserDeviceRow,
} from './notification-mapping';

function content(overrides: Partial<NotificationContentRow> = {}): NotificationContentRow {
  return {
    id: 'n1',
    type: 'client_arrived',
    priority: 'high',
    title: 'Client arrived',
    body: 'Jane has arrived.',
    entity_type: 'appointment',
    entity_id: 'a1',
    action_path: '/bookings?appointmentId=a1',
    location_id: 'loc1',
    metadata: { source: 'front_desk' },
    created_at: '2026-08-01T10:00:00.000Z',
    expires_at: null,
    ...overrides,
  };
}

function feedRow(overrides: Partial<NotificationFeedRow> = {}): NotificationFeedRow {
  return {
    id: 'r1',
    notification_id: 'n1',
    seen_at: null,
    read_at: null,
    created_at: '2026-08-01T10:00:00.000Z',
    notifications: content(),
    ...overrides,
  };
}

describe('embeddedContent', () => {
  it('accepts the object form PostgREST returns for a many-to-one embed', () => {
    expect(embeddedContent({ notifications: content() })?.id).toBe('n1');
  });

  it('accepts the array form the generated types model', () => {
    expect(embeddedContent({ notifications: [content()] })?.id).toBe('n1');
  });

  it('returns null for a missing or empty embed rather than throwing', () => {
    expect(embeddedContent({ notifications: null })).toBeNull();
    expect(embeddedContent({ notifications: [] })).toBeNull();
  });
});

describe('toNotificationDto', () => {
  it('maps every field of the wire contract', () => {
    expect(toNotificationDto(feedRow({ seen_at: '2026-08-01T11:00:00.000Z' }))).toEqual({
      id: 'n1',
      type: 'client_arrived',
      priority: 'high',
      title: 'Client arrived',
      body: 'Jane has arrived.',
      entity: { type: 'appointment', id: 'a1' },
      actionPath: '/bookings?appointmentId=a1',
      locationId: 'loc1',
      metadata: { source: 'front_desk' },
      createdAt: '2026-08-01T10:00:00.000Z',
      seenAt: '2026-08-01T11:00:00.000Z',
      readAt: null,
    });
  });

  it('never exposes dedupe_key, created_by or expires_at', () => {
    // Internal bookkeeping: a client that could see the dedupe key would be able to
    // infer notifications it was never sent.
    const dto = toNotificationDto(
      feedRow({
        notifications: {
          ...content(),
          dedupe_key: 'client_arrived:a1',
          created_by_user_profile_id: 'u9',
        } as unknown as NotificationContentRow,
      }),
    );
    const keys = Object.keys(dto ?? {});
    expect(keys).not.toContain('dedupe_key');
    expect(keys).not.toContain('dedupeKey');
    expect(keys).not.toContain('created_by_user_profile_id');
    expect(keys).not.toContain('expiresAt');
  });

  it('reads read_at from the RECIPIENT row, not the shared notification', () => {
    // The distinction the whole two-table model exists for.
    const dto = toNotificationDto(feedRow({ read_at: '2026-08-02T09:00:00.000Z' }));
    expect(dto?.readAt).toBe('2026-08-02T09:00:00.000Z');
  });

  it('nulls the entity when the link is absent', () => {
    const dto = toNotificationDto(
      feedRow({ notifications: content({ entity_type: null, entity_id: null }) }),
    );
    expect(dto?.entity).toBeNull();
  });

  it('nulls the entity when only half of it is present', () => {
    // The DB check constraint makes this unreachable; the guard keeps the DTO type
    // honest anyway rather than emitting `{ type: 'appointment', id: null }`.
    const dto = toNotificationDto(
      feedRow({ notifications: content({ entity_id: null }) }),
    );
    expect(dto?.entity).toBeNull();
  });

  it('defaults absent metadata to an empty object so clients need no null check', () => {
    expect(toNotificationDto(feedRow({ notifications: content({ metadata: null }) }))?.metadata).toEqual({});
  });

  it('normalises an unrecognised priority to normal', () => {
    // priority drives styling; an unknown value would render unstyled.
    expect(
      toNotificationDto(feedRow({ notifications: content({ priority: 'apocalyptic' }) }))?.priority,
    ).toBe('normal');
  });

  it('passes an unrecognised type through so an older client still shows the text', () => {
    const dto = toNotificationDto(
      feedRow({ notifications: content({ type: 'zac_opportunity' }) }),
    );
    expect(dto?.type).toBe('zac_opportunity');
    expect(dto?.title).toBe('Client arrived');
  });

  it('returns null when the inner join did not hold', () => {
    expect(toNotificationDto(feedRow({ notifications: null }))).toBeNull();
  });
});

describe('isKnownNotificationType', () => {
  it('accepts every registered type', () => {
    expect(isKnownNotificationType(NotificationType.ClientArrived)).toBe(true);
    expect(isKnownNotificationType(NotificationType.LowStock)).toBe(true);
    expect(isKnownNotificationType(NotificationType.System)).toBe(true);
  });

  it('rejects anything outside the registry', () => {
    expect(isKnownNotificationType('client_arrive')).toBe(false);
    expect(isKnownNotificationType('zac_opportunity')).toBe(false);
    expect(isKnownNotificationType('')).toBe(false);
  });

  it('is case-sensitive — the persisted values are lower_snake', () => {
    // Matching the repo-wide convention for persisted string values. A producer
    // that shouts its type must fail validation, not create a second spelling of
    // the same notification that no client knows how to render.
    expect(isKnownNotificationType('CLIENT_ARRIVED')).toBe(false);
    expect(isKnownNotificationType('client_arrived')).toBe(true);
  });
});

describe('toUserDeviceDto', () => {
  function deviceRow(overrides: Partial<UserDeviceRow> = {}): UserDeviceRow {
    return {
      id: 'd1',
      business_id: 'b1',
      user_profile_id: 'u1',
      device_identifier: 'installation-aaa',
      platform: 'ios',
      push_token: 'ExponentPushToken[SECRET]',
      enabled: true,
      last_seen_at: '2026-08-01T10:00:00.000Z',
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-08-01T10:00:00.000Z',
      ...overrides,
    };
  }

  it('NEVER returns the push token, only whether one is on file', () => {
    const dto = toUserDeviceDto(deviceRow());
    expect(JSON.stringify(dto)).not.toContain('SECRET');
    expect(Object.keys(dto)).not.toContain('pushToken');
    expect(dto.hasPushToken).toBe(true);
  });

  it('reports hasPushToken false when none is stored', () => {
    expect(toUserDeviceDto(deviceRow({ push_token: null })).hasPushToken).toBe(false);
  });

  it('maps the rest of the device contract', () => {
    expect(toUserDeviceDto(deviceRow({ enabled: false }))).toEqual({
      id: 'd1',
      platform: 'ios',
      deviceIdentifier: 'installation-aaa',
      enabled: false,
      hasPushToken: true,
      lastSeenAt: '2026-08-01T10:00:00.000Z',
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    });
  });
});

describe('pagination helpers', () => {
  it('computes inclusive PostgREST ranges from a 1-based page', () => {
    expect(pageRange(1, 20)).toEqual({ from: 0, to: 19 });
    expect(pageRange(3, 20)).toEqual({ from: 40, to: 59 });
  });

  it('rounds total pages up', () => {
    expect(buildPagination(1, 20, 41).totalPages).toBe(3);
  });

  it('reports an empty feed as page 1 of 1, not 1 of 0', () => {
    expect(buildPagination(1, 20, 0)).toEqual({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  });
});

describe('feed column list', () => {
  it('uses an inner join so the expiry filter narrows the parent rows and the count', () => {
    // With a left join, an expired notification would still return a recipient row
    // (with a null embed) and would still be counted in the pagination total.
    expect(NOTIFICATION_FEED_COLUMNS).toContain('notifications!inner(');
  });

  it('selects the recipient-side read state', () => {
    expect(NOTIFICATION_FEED_COLUMNS).toContain('read_at');
    expect(NOTIFICATION_FEED_COLUMNS).toContain('seen_at');
  });
});
