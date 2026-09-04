/**
 * Post-check-in service lifecycle (0110) — the API side of booked vs performed.
 *
 * The SQL suite proves the database (atomic add/remove/replace, idempotency,
 * paid immutability, tenancy, RLS). These specs prove the service asks it the
 * right things and reads the answer correctly: the actor comes from the
 * session and never the body, the status guard runs before any write, a
 * replay writes no audit entry, and — the money question — everything that
 * projects an appointment (names, checkout bill, visit roll-up) uses the
 * PERFORMED lines and never a removed one.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { LabAppointmentsService } from './lab-appointments.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

type Call = { method: string; args: unknown[] };
interface MockQuery {
  calls: Call[];
  result: unknown;
  [method: string]: unknown;
}
interface MockClient {
  queries: MockQuery[];
  schema: jest.Mock;
}

const CHAINED = [
  'schema', 'from', 'select', 'update', 'insert', 'upsert', 'delete', 'eq', 'neq', 'or',
  'gte', 'lt', 'gt', 'in', 'order', 'limit',
] as const;

function createMockQuery(result: unknown): MockQuery {
  const query: MockQuery = { calls: [], result };
  for (const method of CHAINED) {
    query[method] = jest.fn((...args: unknown[]) => {
      query.calls.push({ method, args });
      return query;
    });
  }
  for (const terminal of ['maybeSingle', 'single', 'returns', 'rpc'] as const) {
    query[terminal] = jest.fn((...args: unknown[]) => {
      query.calls.push({ method: terminal, args });
      return Promise.resolve(query.result);
    });
  }
  return query;
}

function createMockClient(results: unknown[]): MockClient {
  const client: MockClient = { queries: results.map(createMockQuery), schema: jest.fn() };
  client.schema = jest.fn((...args: unknown[]) => {
    const query = client.queries.find((candidate) => !candidate.calls.some((call) => call.method === 'schema'));
    if (!query) throw new Error('No mock query result configured');
    query.calls.push({ method: 'schema', args });
    return query;
  });
  return client;
}

function createService(client: MockClient, audit = { record: jest.fn().mockResolvedValue(undefined) }) {
  mockedCreateClient.mockReturnValue(client as never);
  const service = new LabAppointmentsService(
    { getOrThrow: jest.fn((key: string) => `${key}_test`) } as unknown as ConfigService,
    { linkPersistedAppointment: jest.fn() } as never,
    {
      resolveLocationTaxSettings: jest.fn().mockResolvedValue({
        locationId: 'location_1',
        taxEnabled: false,
        taxLabel: null,
        taxRatePercent: 0,
        appliesTo: 'both',
        displayMode: 'ex_tax',
      }),
    } as never,
    { syncBookingNotificationsSafe: jest.fn().mockResolvedValue(undefined) } as never,
    { scheduleForCompletedAppointmentSafe: jest.fn().mockResolvedValue(undefined) } as never,
    { refundPaymentIntent: jest.fn() } as never,
    audit as never,
    { notifyClientArrivedSafe: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, audit };
}

function stylistActor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user_1',
    roles: ['stylist'],
    primaryRole: 'stylist',
    businessId: 'business_1',
    allowedLocationIds: ['location_1'],
    locationScope: { kind: 'subset', locationIds: ['location_1'] },
    locations: [],
    profile: { fullName: 'Jane Stylist' } as never,
    staffProfileId: 'staff_1',
    permissions: ['bookings.manage', 'bookings.services.modify_after_checkin'],
    ...overrides,
  } as AuthUser;
}

const BOOKED_COLOUR = {
  id: 'as_colour',
  service_id: 'svc_colour',
  service_name_snapshot: 'Full Head Colour',
  duration_minutes: 60,
  deposit_required_amount: 0,
  price_amount: 100,
  sequence_no: 1,
  scheduled_start_at: '2026-05-13T09:00:00.000Z',
  scheduled_end_at: '2026-05-13T10:00:00.000Z',
  status: 'scheduled',
  origin: 'booked',
  assigned_staff_profile_id: 'staff_1',
};
const BOOKED_CUT = {
  id: 'as_cut',
  service_id: 'svc_cut',
  service_name_snapshot: 'Cut & Finish',
  duration_minutes: 45,
  deposit_required_amount: 0,
  price_amount: 50,
  sequence_no: 2,
  scheduled_start_at: '2026-05-13T10:00:00.000Z',
  scheduled_end_at: '2026-05-13T10:45:00.000Z',
  status: 'scheduled',
  origin: 'booked',
  assigned_staff_profile_id: 'staff_1',
};
const REMOVED_CUT = { ...BOOKED_CUT, status: 'cancelled', removed_at: '2026-05-13T09:30:00.000Z', removed_by_user_profile_id: 'user_2' };
const ADDED_TONER = {
  id: 'as_toner',
  service_id: 'svc_toner',
  service_name_snapshot: 'Toner',
  duration_minutes: 20,
  deposit_required_amount: 0,
  price_amount: 30,
  sequence_no: 3,
  scheduled_start_at: null,
  scheduled_end_at: null,
  status: 'scheduled',
  origin: 'post_checkin_add',
  assigned_staff_profile_id: 'staff_1',
  added_at: '2026-05-13T09:20:00.000Z',
  added_by_user_profile_id: 'user_1',
};

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appointment_1',
    business_id: 'business_1',
    location_id: 'location_1',
    client_profile_id: 'client_1',
    assigned_staff_profile_id: 'staff_1',
    requested_staff_profile_id: null,
    status: 'checked_in',
    scheduled_start_at: '2026-05-13T09:00:00.000Z',
    scheduled_end_at: '2026-05-13T10:45:00.000Z',
    check_in_at: '2026-05-13T09:02:00.000Z',
    client_note: null,
    internal_note: null,
    appointment_services: [BOOKED_COLOUR, BOOKED_CUT],
    deposits: [],
    ...overrides,
  };
}

function visitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'visit_1',
    business_id: 'business_1',
    location_id: 'location_1',
    appointment_id: 'appointment_1',
    client_profile_id: 'client_1',
    primary_staff_profile_id: 'staff_1',
    status: 'awaiting_payment',
    checked_in_at: '2026-05-13T09:02:00.000Z',
    started_at: '2026-05-13T09:02:00.000Z',
    completed_at: '2026-05-13T10:40:00.000Z',
    checkout_status: 'awaiting_payment',
    checkout_ready_at: '2026-05-13T10:40:00.000Z',
    service_summary: 'Full Head Colour, Cut & Finish',
    client_visible_summary: 'Full Head Colour, Cut & Finish',
    created_at: '2026-05-13T09:02:00.000Z',
    ...overrides,
  };
}

const TONER_CATALOG = {
  id: 'svc_toner',
  name: 'Toner',
  estimated_duration_minutes: 20,
  base_price: 30,
  deposit_type: 'none',
  deposit_value: 0,
  is_active: true,
  location_id: null,
};

function changeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chg_1',
    appointment_id: 'appointment_1',
    appointment_service_id: 'as_toner',
    replaced_appointment_service_id: null,
    action: 'added',
    appointment_status_at_change: 'checked_in',
    actor_user_profile_id: 'user_1',
    actor_staff_profile_id: 'staff_1',
    before: null,
    after: { lineId: 'as_toner', serviceId: 'svc_toner', serviceName: 'Toner', priceAmount: 30, staffProfileId: 'staff_1', status: 'scheduled', origin: 'post_checkin_add' },
    reason: null,
    created_at: '2026-05-13T09:20:00.000Z',
    ...overrides,
  };
}

const rpcOk = { data: { changeId: 'chg_1', lineId: 'as_toner', replayed: false, alreadyApplied: false }, error: null };
const clientProfiles = { data: [{ id: 'client_1', first_name: 'Jane', last_name: 'Test' }], error: null };
const staffNames = { data: [{ id: 'staff_1', display_name: 'Jane' }], error: null };
const userNames = { data: [{ id: 'user_1', full_name: 'Jane Stylist', display_name: null }], error: null };

function rpcPayload(client: MockClient, index: number): Record<string, unknown> {
  const call = client.queries[index].calls.find((entry) => entry.method === 'rpc');
  expect(call).toBeDefined();
  const [name, args] = call!.args as [string, { p_payload: Record<string, unknown> }];
  expect(name).toBe('amend_appointment_services');
  return args.p_payload;
}

describe('LabAppointmentsService — post-check-in service changes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adds a service through the canonical mutation with the SESSION actor, then re-reads the visit', async () => {
    const client = createMockClient([
      { data: appointmentRow(), error: null }, // fetchAppointmentForActor
      { data: [TONER_CATALOG], error: null }, // fetchCatalogServices (tenancy/availability)
      { data: [{ staff_profile_id: 'staff_1', service_id: 'svc_toner' }], error: null }, // eligibility
      rpcOk, // amend_appointment_services
      { data: appointmentRow({ appointment_services: [BOOKED_COLOUR, BOOKED_CUT, ADDED_TONER] }), error: null }, // reload
      { data: null, error: null }, // no visit yet
      { data: changeRow(), error: null }, // the recorded change
      staffNames,
      userNames,
      clientProfiles,
    ]);
    const { service, audit } = createService(client);

    const result = await service.addService(stylistActor(), 'appointment_1', {
      serviceId: 'svc_toner',
      idempotencyKey: 'key-1',
      // A client cannot smuggle an actor: these are ignored by the DTO and the
      // payload below proves the session identity is what reaches the database.
    });

    const payload = rpcPayload(client, 3);
    expect(payload).toMatchObject({
      appointmentId: 'appointment_1',
      businessId: 'business_1',
      action: 'add',
      serviceId: 'svc_toner',
      staffProfileId: 'staff_1',
      actorUserProfileId: 'user_1',
      actorStaffProfileId: 'staff_1',
      actorRole: 'stylist',
      idempotencyKey: 'key-1',
      lineId: null,
    });

    expect(result.replayed).toBe(false);
    expect(result.change?.action).toBe('added');
    expect(result.change?.actorDisplayName).toBe('Jane');
    expect(result.change?.after?.serviceName).toBe('Toner');
    expect(result.appointment.serviceNames).toEqual(['Full Head Colour', 'Cut & Finish', 'Toner']);
    expect(result.appointment.serviceLines?.map((line) => line.origin)).toEqual(['booked', 'booked', 'post_checkin_add']);
    // The diary window is untouched by an added line: duration is the header's.
    expect(result.appointment.durationMinutes).toBe(105);
    // Added lines have no schedule, so the calendar sub-bands stay the booked ones.
    expect(result.appointment.services?.map((line) => line.name)).toEqual(['Full Head Colour', 'Cut & Finish']);
    expect(result.billing).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1' }),
      expect.objectContaining({ action: 'booking.service.added', entityType: 'booking', entityId: 'appointment_1' }),
    );
  });

  it('replays an idempotent retry without a second audit entry', async () => {
    const client = createMockClient([
      { data: appointmentRow({ appointment_services: [BOOKED_COLOUR, BOOKED_CUT, ADDED_TONER] }), error: null },
      { data: [TONER_CATALOG], error: null },
      { data: [{ staff_profile_id: 'staff_1', service_id: 'svc_toner' }], error: null },
      { data: { changeId: 'chg_1', lineId: 'as_toner', replayed: true, alreadyApplied: false }, error: null },
      { data: appointmentRow({ appointment_services: [BOOKED_COLOUR, BOOKED_CUT, ADDED_TONER] }), error: null },
      { data: null, error: null },
      { data: changeRow(), error: null },
      staffNames,
      userNames,
      clientProfiles,
    ]);
    const { service, audit } = createService(client);

    const result = await service.addService(stylistActor(), 'appointment_1', { serviceId: 'svc_toner', idempotencyKey: 'key-1' });

    expect(result.replayed).toBe(true);
    expect(result.change?.id).toBe('chg_1');
    expect(audit.record).not.toHaveBeenCalled();
    // Still exactly one Toner line in the projection.
    expect(result.appointment.serviceNames.filter((name) => name === 'Toner')).toHaveLength(1);
  });

  it('refuses before any write once the appointment is paid, and before check-in', async () => {
    for (const status of ['paid', 'accepted', 'cancelled', 'no_show']) {
      const client = createMockClient([{ data: appointmentRow({ status }), error: null }]);
      const { service } = createService(client);
      await expect(service.addService(stylistActor(), 'appointment_1', { serviceId: 'svc_toner' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Only the load happened — no catalogue lookup, no RPC.
      expect(client.queries[0].calls.some((call) => call.method === 'schema')).toBe(true);
    }
  });

  it('keeps a pure stylist to their own column', async () => {
    const client = createMockClient([{ data: appointmentRow({ assigned_staff_profile_id: 'staff_2' }), error: null }]);
    const { service } = createService(client);
    await expect(service.addService(stylistActor(), 'appointment_1', { serviceId: 'svc_toner' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('maps the database guard messages onto conflict / not-found', async () => {
    for (const [message, expected] of [
      ['SERVICE_NOT_AVAILABLE: service x is not available at this location', ConflictException],
      ['LINE_NOT_FOUND: line y', NotFoundException],
      ['APPOINTMENT_NOT_AMENDABLE:paid', ConflictException],
      ['LAST_PERFORMED_SERVICE: keep one', ConflictException],
    ] as const) {
      const client = createMockClient([
        { data: appointmentRow(), error: null },
        { data: [TONER_CATALOG], error: null },
        { data: [{ staff_profile_id: 'staff_1', service_id: 'svc_toner' }], error: null },
        { data: null, error: { message } },
      ]);
      const { service } = createService(client);
      await expect(service.addService(stylistActor(), 'appointment_1', { serviceId: 'svc_toner' })).rejects.toBeInstanceOf(expected);
    }
  });

  it('removes a line by id — no catalogue round trip, the row stays and drops out of the performed names', async () => {
    const client = createMockClient([
      { data: appointmentRow(), error: null },
      { data: { changeId: 'chg_2', lineId: 'as_cut', replayed: false, alreadyApplied: false }, error: null },
      { data: appointmentRow({ appointment_services: [BOOKED_COLOUR, REMOVED_CUT] }), error: null },
      { data: null, error: null },
      { data: changeRow({ id: 'chg_2', action: 'removed', appointment_service_id: 'as_cut', before: { serviceName: 'Cut & Finish', priceAmount: 50, staffProfileId: 'staff_1' }, after: null, reason: 'No cut today' }), error: null },
      staffNames,
      userNames,
      clientProfiles,
    ]);
    const { service, audit } = createService(client);

    const result = await service.removeService(stylistActor(), 'appointment_1', 'as_cut', { reason: 'No cut today' });

    expect(rpcPayload(client, 1)).toMatchObject({ action: 'remove', lineId: 'as_cut', reason: 'No cut today', serviceId: null });
    expect(result.appointment.serviceNames).toEqual(['Full Head Colour']);
    expect(result.appointment.serviceLines?.find((line) => line.id === 'as_cut')).toMatchObject({
      performed: false,
      status: 'cancelled',
      origin: 'booked',
      removedByUserProfileId: 'user_2',
    });
    expect(result.change?.action).toBe('removed');
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'booking.service.removed' }));
  });

  it('re-reconciles the live bill when a service is added after completion', async () => {
    const awaiting = appointmentRow({ status: 'awaiting_payment', appointment_services: [BOOKED_COLOUR, REMOVED_CUT] });
    const afterAdd = appointmentRow({
      status: 'awaiting_payment',
      appointment_services: [BOOKED_COLOUR, REMOVED_CUT, { ...ADDED_TONER, status: 'completed', assigned_staff_profile_id: 'staff_2' }],
    });
    const client = createMockClient([
      { data: awaiting, error: null },
      { data: [TONER_CATALOG], error: null },
      // Attributing to someone other than the appointment's stylist runs the same
      // pair of hard blocks the booking flow does: bookable, then eligible.
      { data: { id: 'staff_2', display_name: 'Sarah', is_bookable: true }, error: null },
      { data: [{ staff_profile_id: 'staff_2', service_id: 'svc_toner' }], error: null }, // eligibility for Sarah
      rpcOk,
      { data: afterAdd, error: null },
      { data: visitRow(), error: null }, // the visit exists — the bill is live
      { error: null }, // reconcileServiceLineItem upsert
      { error: null }, // visit summary refresh
      { data: [{ line_type: 'service', description: 'Full Head Colour, Toner', amount_cents: 13000, currency_code: 'GBP' }], error: null },
      { data: changeRow({ after: { serviceName: 'Toner', priceAmount: 30, staffProfileId: 'staff_2' } }), error: null },
      { data: [{ id: 'staff_1', display_name: 'Jane' }, { id: 'staff_2', display_name: 'Sarah' }], error: null },
      userNames,
      clientProfiles,
    ]);
    const { service } = createService(client);

    const owner = stylistActor({ roles: ['owner'], primaryRole: 'owner', staffProfileId: undefined });
    const result = await service.addService(owner, 'appointment_1', { serviceId: 'svc_toner', staffProfileId: 'staff_2' });

    // The roll-up is rewritten from the PERFORMED lines: £100 + £30, never the removed £50.
    const upsert = client.queries[7].calls.find((call) => call.method === 'upsert');
    expect(upsert?.args[0]).toMatchObject({ visit_id: 'visit_1', line_type: 'service', amount_cents: 13000 });
    expect((upsert?.args[0] as { metadata: { appointment_service_ids: string[] } }).metadata.appointment_service_ids).toEqual(['as_colour', 'as_toner']);
    // The visit label follows the performed set.
    const summaryUpdate = client.queries[8].calls.find((call) => call.method === 'update');
    expect(summaryUpdate?.args[0]).toMatchObject({ service_summary: 'Full Head Colour, Toner' });

    expect(result.billing?.totalCents).toBe(13000);
    expect(result.billing?.lineItems.filter((item) => item.lineType === 'service')).toEqual([
      expect.objectContaining({ description: 'Full Head Colour', amountCents: 10000, origin: 'booked', staffProfileId: 'staff_1', appointmentServiceId: 'as_colour' }),
      expect.objectContaining({ description: 'Toner', amountCents: 3000, origin: 'post_checkin_add', staffProfileId: 'staff_2', appointmentServiceId: 'as_toner' }),
    ]);
    expect(result.change?.after?.staffDisplayName).toBe('Sarah');
  });

  it('refuses the whole-array service replacement once the client has checked in', async () => {
    const client = createMockClient([{ data: appointmentRow(), error: null }]);
    const { service } = createService(client);
    await expect(
      service.reschedule(stylistActor(), 'appointment_1', {
        scheduledStartAt: '2026-05-13T09:00:00.000Z',
        serviceIds: ['svc_colour', 'svc_toner'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('bills the performed set at completion and marks lines added during the visit', async () => {
    const services = [BOOKED_COLOUR, REMOVED_CUT, ADDED_TONER];
    const awaiting = appointmentRow({ status: 'awaiting_payment', completed_at: '2026-05-13T10:40:00.000Z', appointment_services: services });
    const client = createMockClient([
      { data: appointmentRow({ appointment_services: services }), error: null }, // load (checked_in)
      { data: awaiting, error: null }, // header → awaiting_payment
      { error: null }, // lines → completed
      { data: null, error: null }, // no visit yet
      { data: visitRow(), error: null }, // visit created
      { error: null }, // service roll-up upsert
      { data: [], error: null }, // no formulas
      { data: [{ line_type: 'service', description: 'Full Head Colour, Toner', amount_cents: 13000, currency_code: 'GBP' }], error: null },
      clientProfiles,
    ]);
    const { service } = createService(client);

    const result = await service.complete(stylistActor(), 'appointment_1');

    const upsert = client.queries[5].calls.find((call) => call.method === 'upsert');
    expect(upsert?.args[0]).toMatchObject({ amount_cents: 13000, description: 'Full Head Colour, Toner' });
    const serviceLines = result.billing.lineItems.filter((item) => item.lineType === 'service');
    expect(serviceLines.map((item) => [item.description, item.amountCents, item.origin])).toEqual([
      ['Full Head Colour', 10000, 'booked'],
      ['Toner', 3000, 'post_checkin_add'],
    ]);
    expect(result.billing.serviceTotalCents).toBe(13000);
    expect(result.billing.balanceDueCents).toBe(13000);
    expect(result.appointment.serviceNames).toEqual(['Full Head Colour', 'Toner']);
  });

  it('lists booked vs performed and the change history for an appointment', async () => {
    const client = createMockClient([
      { data: appointmentRow({ status: 'paid', appointment_services: [BOOKED_COLOUR, REMOVED_CUT, ADDED_TONER] }), error: null },
      { data: [changeRow(), changeRow({ id: 'chg_2', action: 'removed', appointment_service_id: 'as_cut', before: { serviceName: 'Cut & Finish' }, after: null })], error: null },
      staffNames,
      userNames,
    ]);
    const { service } = createService(client);

    const result = await service.serviceChanges(stylistActor(), 'appointment_1');

    expect(result.bookedServices.map((line) => line.name)).toEqual(['Full Head Colour', 'Cut & Finish']);
    expect(result.performedServices.map((line) => line.name)).toEqual(['Full Head Colour', 'Toner']);
    // Nothing was captured for this fixture, so the original booking is UNKNOWN
    // — the current set must never be passed off as it.
    expect(result.originalBookingAvailable).toBe(false);
    expect(result.originalBookedServices).toEqual([]);
    expect(result.changes.map((change) => change.action)).toEqual(['added', 'removed']);
    expect(result.changes[0].actorDisplayName).toBe('Jane');
    expect(client.queries[1].calls).toContainEqual({ method: 'order', args: ['change_no', { ascending: true }] });
  });

  it('answers all three questions — original, booked at check-in, performed — after payment', async () => {
    // T0 Full Head Colour + Cut, T1 swapped the colour, T2 dropped the cut and
    // added a toner. All three must come back as structured data.
    const client = createMockClient([
      {
        data: appointmentRow({
          status: 'paid',
          original_services_snapshot: [
            { serviceId: 'svc_colour', serviceName: 'Full Head Colour', priceAmount: 95, durationMinutes: 60, staffProfileId: 'staff_1', sequenceNo: 1 },
            { serviceId: 'svc_cut', serviceName: 'Cut & Finish', priceAmount: 45, durationMinutes: 45, staffProfileId: 'staff_1', sequenceNo: 2 },
          ],
          appointment_services: [
            { ...BOOKED_COLOUR, service_id: 'svc_hhc', service_name_snapshot: 'Half Head Colour', price_amount: 75 },
            REMOVED_CUT,
            ADDED_TONER,
          ],
        }),
        error: null,
      },
      { data: [], error: null },
      staffNames,
      userNames,
    ]);
    const { service } = createService(client);

    const result = await service.serviceChanges(stylistActor(), 'appointment_1');

    expect(result.originalBookingAvailable).toBe(true);
    expect(result.originalBookedServices.map((s) => s.serviceName)).toEqual(['Full Head Colour', 'Cut & Finish']);
    expect(result.originalBookedServices[0]).toMatchObject({ serviceId: 'svc_colour', priceAmount: 95 });
    expect(result.bookedServices.map((line) => line.name)).toEqual(['Half Head Colour', 'Cut & Finish']);
    expect(result.performedServices.map((line) => line.name)).toEqual(['Half Head Colour', 'Toner']);
  });

  describe('assigning a service to another stylist', () => {
    // The line-level attribution guard. A PURE stylist is capped to themselves;
    // anyone who is also an owner or manager is not.
    function clientForAssign() {
      return createMockClient([
        { data: appointmentRow(), error: null },
        { data: [TONER_CATALOG], error: null },
        { data: { id: 'staff_2', display_name: 'Sarah', is_bookable: true }, error: null },
        { data: [{ staff_profile_id: 'staff_2', service_id: 'svc_toner' }], error: null },
        rpcOk,
        { data: appointmentRow({ appointment_services: [BOOKED_COLOUR, BOOKED_CUT, ADDED_TONER] }), error: null },
        { data: null, error: null },
        { data: changeRow(), error: null },
        staffNames,
        userNames,
        clientProfiles,
      ]);
    }

    it('refuses a pure stylist attributing to a colleague', async () => {
      const { service } = createService(clientForAssign());
      await expect(
        service.addService(stylistActor(), 'appointment_1', { serviceId: 'svc_toner', staffProfileId: 'staff_2' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a manager, a manager who also styles, and an owner who also styles', async () => {
      for (const actor of [
        stylistActor({ roles: ['manager'], primaryRole: 'manager', staffProfileId: undefined }),
        // The case the old guard got wrong: holding a stylist membership as well
        // must not cap a manager to their own column.
        stylistActor({ roles: ['manager', 'stylist'], primaryRole: 'manager' }),
        stylistActor({ roles: ['owner', 'stylist'], primaryRole: 'owner' }),
      ]) {
        const { service } = createService(clientForAssign());
        const result = await service.addService(actor, 'appointment_1', {
          serviceId: 'svc_toner',
          staffProfileId: 'staff_2',
        });
        expect(result.appointment.id).toBe('appointment_1');
      }
    });
  });
});
