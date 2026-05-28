import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { LabAppointmentsService } from './lab-appointments.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

type QueryCall =
  | { method: 'schema'; args: unknown[] }
  | { method: 'from'; args: unknown[] }
  | { method: 'select'; args: unknown[] }
  | { method: 'update'; args: unknown[] }
  | { method: 'insert'; args: unknown[] }
  | { method: 'upsert'; args: unknown[] }
  | { method: 'eq'; args: unknown[] }
  | { method: 'gte'; args: unknown[] }
  | { method: 'lt'; args: unknown[] }
  | { method: 'gt'; args: unknown[] }
  | { method: 'in'; args: unknown[] }
  | { method: 'order'; args: unknown[] }
  | { method: 'limit'; args: unknown[] }
  | { method: 'maybeSingle'; args: unknown[] }
  | { method: 'single'; args: unknown[] }
  | { method: 'returns'; args: unknown[] };

interface MockSupabaseClient {
  queries: MockQuery[];
  schema: jest.Mock;
}

interface MockQuery {
  calls: QueryCall[];
  result: unknown;
  schema: jest.Mock;
  from: jest.Mock;
  select: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
  upsert: jest.Mock;
  eq: jest.Mock;
  gte: jest.Mock;
  lt: jest.Mock;
  gt: jest.Mock;
  in: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
  maybeSingle: jest.Mock;
  single: jest.Mock;
  returns: jest.Mock;
}

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

describe('LabAppointmentsService — stylist booking visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries only bookings assigned to the signed-in stylist and within their locations', async () => {
    const client = createMockSupabaseClient([{ data: [], error: null }]);
    const service = createService(client);

    await service.today(stylistActor());

    const query = client.queries[0];
    expect(query.calls).toContainEqual({ method: 'eq', args: ['business_id', 'business_1'] });
    expect(query.calls).toContainEqual({ method: 'eq', args: ['assigned_staff_profile_id', 'staff_1'] });
    expect(query.calls).toContainEqual({
      method: 'in',
      args: ['location_id', ['location_1', 'location_2']],
    });
  });

  it('rejects stylist list access when no staff profile is resolved', async () => {
    const client = createMockSupabaseClient([{ data: [], error: null }]);
    const service = createService(client);

    await expect(service.today({ ...stylistActor(), staffProfileId: undefined })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects stylist list access when no location scope is resolved', async () => {
    const client = createMockSupabaseClient([{ data: [], error: null }]);
    const service = createService(client);

    await expect(service.today({ ...stylistActor(), allowedLocationIds: [] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects stylist detail access to bookings assigned to another stylist', async () => {
    const client = createMockSupabaseClient([
      {
        data: appointmentRow({ assigned_staff_profile_id: 'staff_2' }),
        error: null,
      },
    ]);
    const service = createService(client);

    await expect(service.detail(stylistActor(), 'appointment_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows stylist detail access to their assigned booking', async () => {
    const client = createMockSupabaseClient([
      {
        data: appointmentRow({ assigned_staff_profile_id: 'staff_1' }),
        error: null,
      },
      {
        data: [clientProfileRow()],
        error: null,
      },
    ]);
    const service = createService(client);

    const detail = await service.detail(stylistActor(), 'appointment_1');

    expect(detail.id).toBe('appointment_1');
    expect(detail.assignedStaffProfileId).toBe('staff_1');
    expect(detail.clientDisplayName).toBe('Client One');
  });
});

describe('LabAppointmentsService — appointment completion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects stylist completion for another stylist appointment', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentRow({ assigned_staff_profile_id: 'staff_2' }), error: null },
    ]);
    const service = createService(client);

    await expect(service.complete(stylistActor(), 'appointment_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects invalid completion transitions', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentRow({ status: 'cancelled' }), error: null },
    ]);
    const service = createService(client);

    await expect(service.complete(stylistActor(), 'appointment_1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks an assigned appointment awaiting payment and returns checkout billing context', async () => {
    const awaitingPayment = appointmentRow({
      status: 'awaiting_payment',
      completed_at: '2026-05-13T10:01:00.000Z',
      completed_by_user_profile_id: 'user_1',
      completed_by_staff_profile_id: 'staff_1',
    });
    const client = createMockSupabaseClient([
      { data: appointmentRow(), error: null },
      { data: awaitingPayment, error: null },
      { error: null },
      { data: null, error: null },
      { data: visitRow(), error: null },
      { error: null },
      { data: [], error: null },
      { data: lineItems(), error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.complete(stylistActor(), 'appointment_1');

    expect(result.appointment.status).toBe('awaiting_payment');
    expect(result.appointment.completedByUserProfileId).toBe('user_1');
    expect(result.checkout.status).toBe('awaiting_payment');
    expect(result.billing.totalCents).toBe(5000);
    expect(result.billing.balanceDueCents).toBe(5000);
    expect(result.alreadyCompleted).toBe(false);
    expect(client.queries[1].calls).toContainEqual({ method: 'in', args: ['status', ['confirmed', 'checked_in', 'in_progress']] });
  });

  it('replays awaiting-payment appointments without re-running the status transition', async () => {
    const awaitingPayment = appointmentRow({ status: 'awaiting_payment', completed_at: '2026-05-13T10:01:00.000Z' });
    const client = createMockSupabaseClient([
      { data: awaitingPayment, error: null },
      { error: null },
      { data: null, error: null },
      { data: visitRow(), error: null },
      { error: null },
      { data: [], error: null },
      { data: lineItems(), error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.complete(stylistActor(), 'appointment_1');

    expect(result.alreadyCompleted).toBe(true);
    expect(client.queries[1].calls).not.toContainEqual({
      method: 'in',
      args: ['status', ['confirmed', 'checked_in', 'in_progress']],
    });
  });

  it('confirms in-salon payment and marks appointment paid without inventory side effects', async () => {
    const awaitingPayment = appointmentRow({ status: 'awaiting_payment', completed_at: '2026-05-13T10:01:00.000Z' });
    const paid = appointmentRow({ status: 'paid', completed_at: '2026-05-13T10:01:00.000Z' });
    const client = createMockSupabaseClient([
      { data: awaitingPayment, error: null },
      { data: visitRow(), error: null },
      { data: lineItems(), error: null },
      { data: null, error: null },
      { data: salonPaymentRow(), error: null },
      { data: paid, error: null },
      { data: visitRow({ status: 'paid', checkout_status: 'paid', paid_at: '2026-05-13T10:05:00.000Z' }), error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.confirmPayment(stylistActor(), 'appointment_1', {
      paymentMethod: 'card_reader',
      amountCents: 5000,
    });

    expect(result.appointment.status).toBe('paid');
    expect(result.checkout.status).toBe('paid');
    expect(result.payment.paymentMethod).toBe('card_reader');
    expect(result.billing.balanceDueCents).toBe(0);
    expect(client.queries.some((query) => query.calls.some((call) => call.method === 'from' && call.args[0] === 'stock_movements'))).toBe(false);
  });

  it('replays existing salon payment without inserting a duplicate payment record', async () => {
    const paid = appointmentRow({ status: 'paid', completed_at: '2026-05-13T10:01:00.000Z' });
    const client = createMockSupabaseClient([
      { data: paid, error: null },
      { data: visitRow({ status: 'paid', checkout_status: 'paid', paid_at: '2026-05-13T10:05:00.000Z' }), error: null },
      { data: lineItems(), error: null },
      { data: salonPaymentRow(), error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.confirmPayment(stylistActor(), 'appointment_1', {
      paymentMethod: 'card_reader',
      amountCents: 5000,
    });

    expect(result.alreadyPaid).toBe(true);
    expect(client.queries.some((query) => query.calls.some((call) => call.method === 'insert'))).toBe(false);
  });
});

describe('LabAppointmentsService — manager and owner booking visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes manager list access to assigned locations when no location is requested', async () => {
    const client = createMockSupabaseClient([{ data: [], error: null }]);
    const service = createService(client);

    await service.today({
      ...stylistActor(),
      role: 'manager',
      staffProfileId: undefined,
      locationScope: { kind: 'locations', locationIds: ['location_1', 'location_2'] },
    });

    const query = client.queries[0];
    expect(query.calls).toContainEqual({
      method: 'in',
      args: ['location_id', ['location_1', 'location_2']],
    });
    expect(query.calls).not.toContainEqual({
      method: 'eq',
      args: ['assigned_staff_profile_id', 'staff_1'],
    });
  });

  it('allows owner list access without stylist or manager predicates', async () => {
    const client = createMockSupabaseClient([{ data: [], error: null }]);
    const service = createService(client);

    await service.today({
      ...stylistActor(),
      role: 'owner',
      staffProfileId: undefined,
      locationScope: { kind: 'all', locationIds: ['location_1', 'location_2'] },
    });

    const query = client.queries[0];
    expect(query.calls).not.toContainEqual({
      method: 'in',
      args: ['location_id', ['location_1', 'location_2']],
    });
    expect(query.calls).not.toContainEqual({
      method: 'eq',
      args: ['assigned_staff_profile_id', 'staff_1'],
    });
  });
});

function createService(client: MockSupabaseClient): LabAppointmentsService {
  mockedCreateClient.mockReturnValue(client as never);
  return new LabAppointmentsService(
    {
      getOrThrow: jest.fn((key: string) => `${key}_test`),
    } as unknown as ConfigService,
    {
      linkPersistedAppointment: jest.fn(),
    } as never,
  );
}

function createMockSupabaseClient(results: unknown[]): MockSupabaseClient {
  const client = {
    queries: results.map(createMockQuery),
    schema: jest.fn(),
  };

  client.schema = jest.fn((...args: unknown[]) => {
    const query = client.queries.find((candidate) => !candidate.calls.some((call) => call.method === 'schema'));
    if (!query) throw new Error('No mock query result configured');
    query.calls.push({ method: 'schema', args });
    return query;
  });

  return client;
}

function createMockQuery(result: unknown): MockQuery {
  const query = {
    calls: [] as QueryCall[],
    result,
  } as MockQuery;

  const chain = (method: QueryCall['method']) =>
    jest.fn((...args: unknown[]) => {
      query.calls.push({ method, args } as QueryCall);
      return query;
    });

  query.schema = chain('schema');
  query.from = chain('from');
  query.select = chain('select');
  query.update = chain('update');
  query.insert = chain('insert');
  query.upsert = chain('upsert');
  query.eq = chain('eq');
  query.gte = chain('gte');
  query.lt = chain('lt');
  query.gt = chain('gt');
  query.in = chain('in');
  query.order = chain('order');
  query.limit = chain('limit');
  query.maybeSingle = jest.fn((...args: unknown[]) => {
    query.calls.push({ method: 'maybeSingle', args });
    return Promise.resolve(query.result);
  });
  query.single = jest.fn((...args: unknown[]) => {
    query.calls.push({ method: 'single', args });
    return Promise.resolve(query.result);
  });
  query.returns = jest.fn((...args: unknown[]) => {
    query.calls.push({ method: 'returns', args });
    return Promise.resolve(query.result);
  });

  return query;
}

function stylistActor(): AuthUser {
  return {
    id: 'user_1',
    role: 'stylist',
    businessId: 'business_1',
    allowedLocationIds: ['location_1', 'location_2'],
    locationScope: { kind: 'self', locationIds: ['location_1', 'location_2'] },
    locations: [
      { id: 'location_1', name: 'North' },
      { id: 'location_2', name: 'South' },
    ],
    profile: {
      id: 'user_1',
      email: 'stylist@example.com',
      fullName: 'Stylist One',
    },
    staffProfileId: 'staff_1',
  };
}

function appointmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appointment_1',
    business_id: 'business_1',
    location_id: 'location_1',
    client_profile_id: 'client_1',
    assigned_staff_profile_id: 'staff_1',
    requested_staff_profile_id: null,
    status: 'confirmed',
    scheduled_start_at: '2026-05-13T09:00:00.000Z',
    scheduled_end_at: '2026-05-13T10:00:00.000Z',
    communication_preference: 'sms',
    client_note: null,
    internal_note: null,
    appointment_services: [
      {
        service_name_snapshot: 'Cut and blow dry',
        duration_minutes: 60,
        deposit_required_amount: 0,
        price_amount: 50,
      },
    ],
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
    checked_in_at: '2026-05-13T09:00:00.000Z',
    started_at: '2026-05-13T09:00:00.000Z',
    completed_at: '2026-05-13T10:01:00.000Z',
    completed_by_user_profile_id: 'user_1',
    completed_by_staff_profile_id: 'staff_1',
    checkout_status: 'awaiting_payment',
    checkout_ready_at: '2026-05-13T10:01:00.000Z',
    service_summary: 'Cut and blow dry',
    client_visible_summary: 'Cut and blow dry',
    created_at: '2026-05-13T09:00:00.000Z',
    ...overrides,
  };
}

function salonPaymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment_1',
    appointment_id: 'appointment_1',
    visit_id: 'visit_1',
    payment_method: 'card_reader',
    amount_cents: 5000,
    currency_code: 'GBP',
    paid_at: '2026-05-13T10:05:00.000Z',
    confirmed_by_user_profile_id: 'user_1',
    confirmed_by_staff_profile_id: 'staff_1',
    notes: null,
    ...overrides,
  };
}

function lineItems() {
  return [
    {
      line_type: 'service',
      description: 'Cut and blow dry',
      amount_cents: 5000,
      currency_code: 'GBP',
    },
  ];
}

function clientProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'client_1',
    first_name: 'Client',
    last_name: 'One',
    ...overrides,
  };
}
