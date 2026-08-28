/**
 * ArrivalNotificationService — the first producer on the notification foundation.
 *
 * WHAT THESE SPECS PROVE. That an arrival resolves the assigned stylist's USER id
 * from their staff profile, addresses the notification to exactly that person,
 * carries structured routing context rather than a prose-only body, keys itself for
 * idempotency, keeps the body free of anything sensitive — and, above all, NEVER
 * throws, whatever fails underneath.
 *
 * The last point is the ticket's reliability requirement in test form: check-in must
 * survive a broken notification path. `lab-appointments.service.spec.ts` covers the
 * other half — that check-in only emits on the transition it actually won.
 */

import type { ConfigService } from '@nestjs/config';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../common/testing/supabase-fake';
import { ArrivalNotificationService, buildArrivalBody } from './arrival-notification.service';
import type { NotificationsService } from './notifications.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b0000000-0000-0000-0000-000000000001';
const LOCATION_ID = 'l0000000-0000-0000-0000-000000000001';
const APPOINTMENT_ID = 'a0000000-0000-0000-0000-000000000001';
const STAFF_PROFILE_ID = 's0000000-0000-0000-0000-000000000001';
const STYLIST_USER_ID = 'u0000000-0000-0000-0000-000000000001';
const CLIENT_PROFILE_ID = 'c0000000-0000-0000-0000-000000000001';
const RECEPTIONIST_USER_ID = 'u0000000-0000-0000-0000-000000000009';

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    business_id: BUSINESS_ID,
    location_id: LOCATION_ID,
    client_profile_id: CLIENT_PROFILE_ID,
    assigned_staff_profile_id: STAFF_PROFILE_ID,
    ...overrides,
  } as {
    id: string;
    business_id: string;
    location_id: string;
    client_profile_id: string | null;
    assigned_staff_profile_id: string | null;
  };
}

function makeService(
  seed: Record<string, Array<Record<string, unknown>>> = {
    'core.staff_profiles': [
      { id: STAFF_PROFILE_ID, business_id: BUSINESS_ID, user_profile_id: STYLIST_USER_ID },
    ],
    'core.client_profiles': [
      { id: CLIENT_PROFILE_ID, business_id: BUSINESS_ID, first_name: 'Jane' },
    ],
  },
): {
  service: ArrivalNotificationService;
  createSafe: jest.Mock;
  state: SupabaseFakeState;
} {
  const state = createSupabaseFakeState(seed);
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  const createSafe = jest.fn().mockResolvedValue({
    notificationId: 'n1',
    recipientCount: 1,
    requestedCount: 1,
    deduplicated: false,
  });
  const notifications = { createSafe } as unknown as NotificationsService;
  return { service: new ArrivalNotificationService(config, notifications), createSafe, state };
}

describe('ArrivalNotificationService.notifyClientArrivedSafe', () => {
  it('addresses the assigned stylist by resolving their user profile from staff', async () => {
    const { service, createSafe } = makeService();
    await service.notifyClientArrivedSafe(appointment(), RECEPTIONIST_USER_ID);

    expect(createSafe).toHaveBeenCalledTimes(1);
    expect(createSafe.mock.calls[0]?.[0]).toMatchObject({
      businessId: BUSINESS_ID,
      locationId: LOCATION_ID,
      type: 'client_arrived',
      recipientUserProfileIds: [STYLIST_USER_ID],
    });
  });

  it('records the person who performed the check-in as the author, not a recipient', async () => {
    const { service, createSafe } = makeService();
    await service.notifyClientArrivedSafe(appointment(), RECEPTIONIST_USER_ID);

    const input = createSafe.mock.calls[0]?.[0];
    expect(input.createdByUserProfileId).toBe(RECEPTIONIST_USER_ID);
    expect(input.recipientUserProfileIds).not.toContain(RECEPTIONIST_USER_ID);
  });

  it('carries structured routing context, not just a body string', async () => {
    const { service, createSafe } = makeService();
    await service.notifyClientArrivedSafe(appointment());

    expect(createSafe.mock.calls[0]?.[0]).toMatchObject({
      entityType: 'appointment',
      entityId: APPOINTMENT_ID,
      actionPath: `/bookings?appointmentId=${APPOINTMENT_ID}`,
    });
  });

  it('keys the notification so a replayed check-in cannot notify twice', async () => {
    const { service, createSafe } = makeService();
    await service.notifyClientArrivedSafe(appointment());
    expect(createSafe.mock.calls[0]?.[0].dedupeKey).toBe(`client_arrived:${APPOINTMENT_ID}`);
  });

  it('sends nothing when no stylist is assigned', async () => {
    // staff_request_mode can be 'next_available', and the FK is ON DELETE SET NULL.
    const { service, createSafe } = makeService();
    await service.notifyClientArrivedSafe(appointment({ assigned_staff_profile_id: null }));
    expect(createSafe).not.toHaveBeenCalled();
  });

  it('sends nothing when the staff profile has no user (and does not throw)', async () => {
    const { service, createSafe } = makeService({ 'core.staff_profiles': [] });
    await expect(service.notifyClientArrivedSafe(appointment())).resolves.toBeUndefined();
    expect(createSafe).not.toHaveBeenCalled();
  });

  it('does not resolve a staff profile belonging to another business', async () => {
    const { service, createSafe } = makeService({
      'core.staff_profiles': [
        {
          id: STAFF_PROFILE_ID,
          business_id: 'b0000000-0000-0000-0000-000000000002',
          user_profile_id: STYLIST_USER_ID,
        },
      ],
    });
    await service.notifyClientArrivedSafe(appointment());
    expect(createSafe).not.toHaveBeenCalled();
  });

  it('still notifies when the client name cannot be resolved', async () => {
    const { service, createSafe } = makeService({
      'core.staff_profiles': [
        { id: STAFF_PROFILE_ID, business_id: BUSINESS_ID, user_profile_id: STYLIST_USER_ID },
      ],
      'core.client_profiles': [],
    });
    await service.notifyClientArrivedSafe(appointment());
    expect(createSafe).toHaveBeenCalledTimes(1);
    expect(createSafe.mock.calls[0]?.[0].body).toBe('Your next client has arrived.');
  });

  it('NEVER throws when the notification service itself blows up', async () => {
    // Failure isolation: this is called after a committed check-in.
    const { service, createSafe } = makeService();
    createSafe.mockRejectedValueOnce(new Error('everything is on fire'));
    await expect(service.notifyClientArrivedSafe(appointment())).resolves.toBeUndefined();
  });

  it('NEVER throws when the appointment payload is malformed', async () => {
    const { service } = makeService();
    await expect(
      service.notifyClientArrivedSafe(
        undefined as unknown as ReturnType<typeof appointment>,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('buildArrivalBody — notification content safety', () => {
  it('uses the client’s first name only', () => {
    expect(buildArrivalBody('Jane')).toBe('Jane has arrived.');
  });

  it('falls back to a name-free message when there is no first name', () => {
    expect(buildArrivalBody(null)).toBe('Your next client has arrived.');
    expect(buildArrivalBody(undefined)).toBe('Your next client has arrived.');
    expect(buildArrivalBody('   ')).toBe('Your next client has arrived.');
  });

  it('never includes a surname, service, price or note', () => {
    // These strings render on lock screens and shared salon devices; anything
    // beyond a first name is a privacy regression the moment somebody else looks.
    const body = buildArrivalBody('Jane');
    expect(body).not.toMatch(/smith|balayage|£|allergy|note/i);
    expect(body.split(' ').length).toBeLessThanOrEqual(4);
  });
});
