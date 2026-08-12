import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  | { method: 'delete'; args: unknown[] }
  | { method: 'eq'; args: unknown[] }
  | { method: 'neq'; args: unknown[] }
  | { method: 'or'; args: unknown[] }
  | { method: 'gte'; args: unknown[] }
  | { method: 'lt'; args: unknown[] }
  | { method: 'gt'; args: unknown[] }
  | { method: 'in'; args: unknown[] }
  | { method: 'order'; args: unknown[] }
  | { method: 'limit'; args: unknown[] }
  | { method: 'maybeSingle'; args: unknown[] }
  | { method: 'single'; args: unknown[] }
  | { method: 'returns'; args: unknown[] }
  | { method: 'rpc'; args: unknown[] };

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
  delete: jest.Mock;
  eq: jest.Mock;
  neq: jest.Mock;
  or: jest.Mock;
  gte: jest.Mock;
  lt: jest.Mock;
  gt: jest.Mock;
  in: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
  maybeSingle: jest.Mock;
  single: jest.Mock;
  returns: jest.Mock;
  rpc: jest.Mock;
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
    expect(client.queries[1].calls).toContainEqual({ method: 'in', args: ['status', ['accepted', 'checked_in']] });
  });

  it('itemises each booked service as its own bill line', async () => {
    const services = [
      { service_name_snapshot: 'Consultation', duration_minutes: 15, deposit_required_amount: 0, price_amount: 20 },
      { service_name_snapshot: 'Cut and blow dry', duration_minutes: 60, deposit_required_amount: 0, price_amount: 50 },
    ];
    const awaitingPayment = appointmentRow({
      status: 'awaiting_payment',
      completed_at: '2026-05-13T10:01:00.000Z',
      appointment_services: services,
    });
    // The service charge persists as a single rolled-up line (£20 + £50 = £70);
    // the bill should split it back into the two booked services.
    const aggregatedServiceLine = [
      { line_type: 'service', description: 'Consultation, Cut and blow dry', amount_cents: 7000, currency_code: 'GBP' },
    ];
    const client = createMockSupabaseClient([
      { data: appointmentRow({ appointment_services: services }), error: null },
      { data: awaitingPayment, error: null },
      { error: null },
      { data: null, error: null },
      { data: visitRow(), error: null },
      { error: null },
      { data: [], error: null },
      { data: aggregatedServiceLine, error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.complete(stylistActor(), 'appointment_1');

    const serviceLines = result.billing.lineItems.filter((item) => item.lineType === 'service');
    expect(serviceLines).toHaveLength(2);
    expect(serviceLines.map((item) => item.description)).toEqual(['Consultation', 'Cut and blow dry']);
    expect(serviceLines.map((item) => item.amountCents)).toEqual([2000, 5000]);
    // Totals stay identical — per-service prices reconcile to the rolled-up charge.
    expect(result.billing.serviceTotalCents).toBe(7000);
    expect(result.billing.totalCents).toBe(7000);
    expect(result.billing.balanceDueCents).toBe(7000);
  });

  it('shows tax-inclusive prices per service when the location charges tax', async () => {
    const services = [
      { service_name_snapshot: 'Consultation', duration_minutes: 15, deposit_required_amount: 0, price_amount: 20 },
      { service_name_snapshot: 'Cut and blow dry', duration_minutes: 60, deposit_required_amount: 0, price_amount: 50 },
    ];
    const awaitingPayment = appointmentRow({
      status: 'awaiting_payment',
      completed_at: '2026-05-13T10:01:00.000Z',
      appointment_services: services,
    });
    // Persisted line is net (£20 + £50 = £70); with 20% tax the bill shows each
    // service inclusive of tax (£24, £60) and collects the £84 gross balance.
    const aggregatedServiceLine = [
      { line_type: 'service', description: 'Consultation, Cut and blow dry', amount_cents: 7000, currency_code: 'GBP' },
    ];
    const client = createMockSupabaseClient([
      { data: appointmentRow({ appointment_services: services }), error: null },
      { data: awaitingPayment, error: null },
      { error: null },
      { data: null, error: null },
      { data: visitRow(), error: null },
      { error: null },
      { data: [], error: null },
      { data: aggregatedServiceLine, error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client, {
      locationId: 'loc',
      taxEnabled: true,
      taxLabel: 'VAT',
      taxRatePercent: 20,
      appliesTo: 'both',
      displayMode: 'ex_tax',
    });

    const result = await service.complete(stylistActor(), 'appointment_1');

    const serviceLines = result.billing.lineItems.filter((item) => item.lineType === 'service');
    expect(serviceLines.map((item) => item.amountCents)).toEqual([2400, 6000]);
    expect(result.billing.serviceTotalCents).toBe(8400);
    expect(result.billing.totalCents).toBe(8400);
    // The till collects the tax-inclusive figure — confirm-payment validates this.
    expect(result.billing.balanceDueCents).toBe(8400);
  });

  it('itemises the colour charge into one line per product and persists the breakdown', async () => {
    const awaitingPayment = appointmentRow({
      status: 'awaiting_payment',
      completed_at: '2026-05-13T10:01:00.000Z',
    });
    // Two saved formulas worth £20 of product, billed at cost. The colour products
    // used (£15 of Blondor, £5 of Koleston) should split the £20 charge accordingly.
    const savedFormulas = [
      {
        id: 'formula_1',
        external_formula_id: 'f1',
        actual_cost_cents: 2000,
        billable_charge_cents: 2000,
        currency_code: 'GBP',
        saved_at: '2026-05-13T09:45:00.000Z',
      },
    ];
    const billingRules = {
      product_billing_enabled: true,
      product_billing_rule: 'cost_only',
      product_markup_percent: null,
      product_fixed_uplift_amount: null,
      product_round_up_enabled: false,
      product_round_up_increment: null,
    };
    const formulaItems = [
      { product_name: 'Blondor', brand: 'Wella', shade: null, cost_cents: 1500 },
      { product_name: 'Koleston', brand: 'Wella', shade: '9/1', cost_cents: 500 },
    ];
    // The persisted product_usage line is a single rolled-up £20 row carrying the
    // per-product split in metadata — checkout expands it back into two lines.
    const persistedLines = [
      { line_type: 'service', description: 'Cut and blow dry', amount_cents: 5000, currency_code: 'GBP' },
      {
        line_type: 'product_usage',
        description: 'Product usage',
        amount_cents: 2000,
        currency_code: 'GBP',
        metadata: {
          product_breakdown: [
            { description: 'Wella Blondor', cost_cents: 1500 },
            { description: 'Wella Koleston · 9/1', cost_cents: 500 },
          ],
        },
      },
    ];
    const client = createMockSupabaseClient([
      { data: appointmentRow(), error: null },
      { data: awaitingPayment, error: null },
      { error: null },
      { data: null, error: null },
      { data: visitRow(), error: null },
      { error: null },
      { data: savedFormulas, error: null },
      { data: billingRules, error: null },
      { data: formulaItems, error: null },
      { error: null },
      { data: persistedLines, error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.complete(stylistActor(), 'appointment_1');

    const colourLines = result.billing.lineItems.filter((item) => item.lineType === 'product_usage');
    expect(colourLines.map((item) => item.description)).toEqual(['Wella Blondor', 'Wella Koleston · 9/1']);
    expect(colourLines.map((item) => item.amountCents)).toEqual([1500, 500]);
    // Per-product lines sum to the rolled-up colour charge, and totals are unchanged.
    expect(result.billing.productUsageTotalCents).toBe(2000);
    expect(result.billing.serviceTotalCents).toBe(5000);
    expect(result.billing.totalCents).toBe(7000);
    expect(result.billing.balanceDueCents).toBe(7000);

    // The per-product split is derived from formula_items and persisted on the line.
    const upsertCall = client.queries
      .flatMap((query) => query.calls)
      .find((call) => call.method === 'upsert' && (call.args[0] as { line_type?: string }).line_type === 'product_usage');
    expect((upsertCall?.args[0] as { metadata: { product_breakdown: unknown } }).metadata.product_breakdown).toEqual([
      { description: 'Wella Blondor', cost_cents: 1500 },
      { description: 'Wella Koleston · 9/1', cost_cents: 500 },
    ]);
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
      args: ['status', ['accepted', 'checked_in']],
    });
  });

  it('confirms in-salon payment and marks appointment paid without inventory side effects', async () => {
    const awaitingPayment = appointmentRow({ status: 'awaiting_payment', completed_at: '2026-05-13T10:01:00.000Z' });
    const paid = appointmentRow({ status: 'paid', completed_at: '2026-05-13T10:01:00.000Z' });
    const client = createMockSupabaseClient([
      { data: awaitingPayment, error: null },
      { data: visitRow(), error: null },
      { data: lineItems(), error: null },
      { data: [], error: null },
      { data: [salonPaymentRow()], error: null },
      { data: paid, error: null },
      { data: visitRow({ status: 'paid', checkout_status: 'paid', paid_at: '2026-05-13T10:05:00.000Z' }), error: null },
      // Stored-bill snapshot (0085): record_bill RPC, then the bill + lines read-back.
      { data: [{ id: 'bill_1', bill_number: 1, created: true }], error: null },
      { data: billRow(), error: null },
      { data: [], error: null },
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
    expect(result.payments).toHaveLength(1);
    expect(result.billing.balanceDueCents).toBe(0);
    expect(client.queries.some((query) => query.calls.some((call) => call.method === 'from' && call.args[0] === 'stock_movements'))).toBe(false);

    // The bill is frozen at payment with the exact figures the till collected.
    expect(result.bill?.billNumber).toBe(1);
    const rpcCall = client.queries.flatMap((query) => query.calls).find((call) => call.method === 'rpc');
    expect(rpcCall?.args[0]).toBe('record_bill');
    const rpcPayload = rpcCall?.args[1] as {
      p_bill: Record<string, unknown>;
      p_lines: Array<Record<string, unknown>>;
    };
    expect(rpcPayload.p_bill).toMatchObject({
      visit_id: 'visit_1',
      gross_cents: 5000,
      deposit_applied_cents: 0,
      balance_collected_cents: 5000,
      status: 'paid',
    });
    expect(rpcPayload.p_lines.length).toBeGreaterThan(0);
    const lineGrossTotal = rpcPayload.p_lines.reduce(
      (sum, line) => sum + Number(line.gross_cents ?? 0),
      0,
    );
    expect(lineGrossTotal).toBe(5000);
  });

  it('splits payment across cash and card, recording one payment row per tender', async () => {
    const awaitingPayment = appointmentRow({ status: 'awaiting_payment', completed_at: '2026-05-13T10:01:00.000Z' });
    const paid = appointmentRow({ status: 'paid', completed_at: '2026-05-13T10:01:00.000Z' });
    const insertedRows = [
      salonPaymentRow({ id: 'payment_card', payment_method: 'card_reader', amount_cents: 4200 }),
      salonPaymentRow({ id: 'payment_cash', payment_method: 'cash', amount_cents: 800 }),
    ];
    const client = createMockSupabaseClient([
      { data: awaitingPayment, error: null },
      { data: visitRow(), error: null },
      { data: lineItems(), error: null },
      { data: [], error: null },
      { data: insertedRows, error: null },
      { data: paid, error: null },
      { data: visitRow({ status: 'paid', checkout_status: 'paid', paid_at: '2026-05-13T10:05:00.000Z' }), error: null },
      // Stored-bill snapshot (0085): record_bill RPC, then the bill + lines read-back.
      { data: [{ id: 'bill_1', bill_number: 1, created: true }], error: null },
      { data: billRow(), error: null },
      { data: [], error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.confirmPayment(stylistActor(), 'appointment_1', {
      payments: [
        { paymentMethod: 'cash', amountCents: 800 },
        { paymentMethod: 'card_reader', amountCents: 4200 },
      ],
    });

    expect(result.payments).toHaveLength(2);
    expect(result.payments.map((payment) => payment.paymentMethod).sort()).toEqual(['card_reader', 'cash']);
    expect(result.payment.paymentMethod).toBe('card_reader');
    expect(result.billing.balanceDueCents).toBe(0);
    const insertCall = client.queries
      .flatMap((query) => query.calls)
      .find((call) => call.method === 'insert');
    expect(insertCall).toBeDefined();
    expect(insertCall?.args[0]).toHaveLength(2);
  });

  it('rejects tenders that do not add up to the balance due', async () => {
    const awaitingPayment = appointmentRow({ status: 'awaiting_payment', completed_at: '2026-05-13T10:01:00.000Z' });
    const client = createMockSupabaseClient([
      { data: awaitingPayment, error: null },
      { data: visitRow(), error: null },
      { data: lineItems(), error: null },
    ]);
    const service = createService(client);

    await expect(
      service.confirmPayment(stylistActor(), 'appointment_1', {
        payments: [
          { paymentMethod: 'cash', amountCents: 1000 },
          { paymentMethod: 'card_reader', amountCents: 1000 },
        ],
      }),
    ).rejects.toThrow('Payment amounts must add up to the remaining balance due');
  });

  it('replays existing salon payments without inserting duplicate payment records', async () => {
    const paid = appointmentRow({ status: 'paid', completed_at: '2026-05-13T10:01:00.000Z' });
    const client = createMockSupabaseClient([
      { data: paid, error: null },
      { data: visitRow({ status: 'paid', checkout_status: 'paid', paid_at: '2026-05-13T10:05:00.000Z' }), error: null },
      { data: lineItems(), error: null },
      { data: [salonPaymentRow()], error: null },
      // Replays also run the bill snapshot (idempotent — the RPC returns the
      // already-stored bill, repairing any visit whose first write failed).
      { data: [{ id: 'bill_1', bill_number: 1, created: false }], error: null },
      { data: billRow(), error: null },
      { data: [], error: null },
      { data: [clientProfileRow()], error: null },
    ]);
    const service = createService(client);

    const result = await service.confirmPayment(stylistActor(), 'appointment_1', {
      paymentMethod: 'card_reader',
      amountCents: 5000,
    });

    expect(result.alreadyPaid).toBe(true);
    expect(result.bill?.billNumber).toBe(1);
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
      roles: ['manager'],
      primaryRole: 'manager',
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
      roles: ['owner'],
      primaryRole: 'owner',
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

describe('LabAppointmentsService — edit appointment services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function ownerActor(): AuthUser {
    return {
      ...stylistActor(),
      roles: ['owner'],
      primaryRole: 'owner',
      staffProfileId: undefined,
      locationScope: { kind: 'all', locationIds: ['location_1', 'location_2'] },
    };
  }

  function appointmentWithService(serviceId: string) {
    return appointmentRow({
      appointment_services: [
        {
          id: 'as_1',
          service_id: serviceId,
          service_name_snapshot: 'Old service',
          duration_minutes: 30,
          deposit_required_amount: 0,
          price_amount: 40,
        },
      ],
    });
  }

  const catalogService = {
    id: 'svc_new',
    name: 'Balayage',
    estimated_duration_minutes: 90,
    base_price: 120,
    deposit_type: 'none',
    deposit_value: 0,
    is_active: true,
    location_id: null,
  };

  it('replaces the services, recomputing duration/price from the catalogue', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentWithService('svc_old'), error: null }, // fetchAppointmentForActor
      { data: [catalogService], error: null }, // fetchCatalogServices
      { data: [{ staff_profile_id: 'staff_1', service_id: 'svc_new' }], error: null }, // eligibility
      { data: [], error: null }, // availability (no overlap)
      { data: appointmentWithService('svc_old'), error: null }, // header update (old projection)
      { data: [{ id: 'as_1', service_id: 'svc_old' }], error: null }, // prior services snapshot
      { data: null, error: null }, // delete old service rows
      { data: null, error: null }, // insert new service rows
      {
        data: appointmentRow({
          scheduled_end_at: '2026-05-13T10:30:00.000Z',
          appointment_services: [
            {
              id: 'as_2',
              service_id: 'svc_new',
              service_name_snapshot: 'Balayage',
              duration_minutes: 90,
              deposit_required_amount: 0,
              price_amount: 120,
            },
          ],
        }),
        error: null,
      }, // finalRow re-fetch
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const service = createService(client);

    const result = await service.reschedule(ownerActor(), 'appointment_1', {
      scheduledStartAt: '2026-05-13T09:00:00.000Z',
      serviceIds: ['svc_new'],
    });

    expect(result.appointment.serviceIds).toEqual(['svc_new']);
    expect(result.appointment.serviceNames).toEqual(['Balayage']);
    expect(result.appointment.durationMinutes).toBe(90);

    // The old service rows are removed and the new ones inserted with fresh snapshots.
    const deletedServices = client.queries.some(
      (query) =>
        query.calls.some((call) => call.method === 'from' && call.args[0] === 'appointment_services') &&
        query.calls.some((call) => call.method === 'delete'),
    );
    expect(deletedServices).toBe(true);

    const insertQuery = client.queries.find(
      (query) =>
        query.calls.some((call) => call.method === 'from' && call.args[0] === 'appointment_services') &&
        query.calls.some((call) => call.method === 'insert'),
    );
    expect(insertQuery).toBeDefined();
    const insertedRows = insertQuery?.calls.find((call) => call.method === 'insert')?.args[0] as Array<
      Record<string, unknown>
    >;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      service_id: 'svc_new',
      service_name_snapshot: 'Balayage',
      duration_minutes: 90,
      price_amount: 120,
      sequence_no: 1,
      status: 'scheduled',
    });
  });

  it('rejects the edit when the assigned stylist is not eligible for a selected service', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentWithService('svc_old'), error: null }, // fetchAppointmentForActor
      { data: [catalogService], error: null }, // fetchCatalogServices
      { data: [], error: null }, // eligibility — stylist offers nothing
    ]);
    const service = createService(client);

    await expect(
      service.reschedule(ownerActor(), 'appointment_1', {
        scheduledStartAt: '2026-05-13T09:00:00.000Z',
        serviceIds: ['svc_new'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // It must not have deleted/replaced the existing services after failing validation.
    const deleted = client.queries.some((query) => query.calls.some((call) => call.method === 'delete'));
    expect(deleted).toBe(false);
  });

  it('rejects the edit when a selected service is missing from the catalogue', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentWithService('svc_old'), error: null }, // fetchAppointmentForActor
      { data: [], error: null }, // fetchCatalogServices finds nothing for svc_new
    ]);
    const service = createService(client);

    await expect(
      service.reschedule(ownerActor(), 'appointment_1', {
        scheduledStartAt: '2026-05-13T09:00:00.000Z',
        serviceIds: ['svc_new'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('leaves services untouched when no serviceIds are supplied (pure time move)', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentWithService('svc_old'), error: null }, // fetchAppointmentForActor
      { data: [], error: null }, // availability
      { data: appointmentWithService('svc_old'), error: null }, // header update
      { data: [{ id: 'as_1', duration_minutes: 30, sequence_no: 1 }], error: null }, // re-sequence load
      { data: null, error: null }, // re-sequence update (1 row)
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const service = createService(client);

    await service.reschedule(ownerActor(), 'appointment_1', {
      scheduledStartAt: '2026-05-13T11:00:00.000Z',
    });

    const touchedCatalog = client.queries.some((query) =>
      query.calls.some((call) => call.method === 'from' && call.args[0] === 'services'),
    );
    const checkedEligibility = client.queries.some((query) =>
      query.calls.some((call) => call.method === 'from' && call.args[0] === 'staff_service_eligibility'),
    );
    const deleted = client.queries.some((query) => query.calls.some((call) => call.method === 'delete'));
    expect(touchedCatalog).toBe(false);
    expect(checkedEligibility).toBe(false);
    expect(deleted).toBe(false);
  });

  it('treats an unchanged service set as a no-op (no catalogue lookup or replacement)', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentWithService('svc_old'), error: null }, // fetchAppointmentForActor
      { data: [], error: null }, // availability
      { data: appointmentWithService('svc_old'), error: null }, // header update
      { data: [{ id: 'as_1', duration_minutes: 30, sequence_no: 1 }], error: null }, // re-sequence load
      { data: null, error: null }, // re-sequence update
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const service = createService(client);

    await service.reschedule(ownerActor(), 'appointment_1', {
      scheduledStartAt: '2026-05-13T11:00:00.000Z',
      serviceIds: ['svc_old'],
    });

    const touchedCatalog = client.queries.some((query) =>
      query.calls.some((call) => call.method === 'from' && call.args[0] === 'services'),
    );
    expect(touchedCatalog).toBe(false);
  });

  it('resizes to a new total duration (no service change) and re-fetches the fresh rows', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentWithService('svc_old'), error: null }, // fetchAppointmentForActor (30 min)
      { data: [], error: null }, // availability
      { data: appointmentWithService('svc_old'), error: null }, // header update (STALE 30-min projection)
      { data: null, error: null }, // applyResizedServiceRows update (1 row)
      {
        data: appointmentRow({
          scheduled_end_at: '2026-05-13T09:45:00.000Z',
          appointment_services: [
            {
              id: 'as_1',
              service_id: 'svc_old',
              service_name_snapshot: 'Old service',
              duration_minutes: 45,
              deposit_required_amount: 0,
              price_amount: 40,
            },
          ],
        }),
        error: null,
      }, // finalRow re-fetch — the resize path must re-fetch, not return the stale header row
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const service = createService(client);

    const result = await service.reschedule(ownerActor(), 'appointment_1', {
      scheduledStartAt: '2026-05-13T09:00:00.000Z',
      durationMinutes: 45,
    });

    // The response reflects the RE-FETCHED rows (45), not the stale header projection (30).
    expect(result.appointment.durationMinutes).toBe(45);

    // A resize keeps the same services — no catalogue lookup or row replacement.
    const touchedCatalog = client.queries.some((query) =>
      query.calls.some((call) => call.method === 'from' && call.args[0] === 'services'),
    );
    const deleted = client.queries.some((query) => query.calls.some((call) => call.method === 'delete'));
    expect(touchedCatalog).toBe(false);
    expect(deleted).toBe(false);

    // The service row was updated to the new duration.
    const updateQuery = client.queries.find(
      (query) =>
        query.calls.some((call) => call.method === 'from' && call.args[0] === 'appointment_services') &&
        query.calls.some((call) => call.method === 'update'),
    );
    const payload = updateQuery?.calls.find((call) => call.method === 'update')?.args[0] as Record<string, unknown>;
    expect(payload).toMatchObject({ duration_minutes: 45 });
  });

  it('resizes into the last stylist-occupied segment, keeping development time fixed', async () => {
    const segmented = appointmentRow({
      appointment_services: [
        {
          id: 'as_1',
          service_id: 'svc_colour',
          service_name_snapshot: 'Colour',
          duration_minutes: 60,
          deposit_required_amount: 0,
          price_amount: 80,
          segments: [
            { name: 'Apply', durationMinutes: 20, isStylistFree: false },
            { name: 'Develop', durationMinutes: 30, isStylistFree: true },
            { name: 'Rinse', durationMinutes: 10, isStylistFree: false },
          ],
        },
      ],
    });
    const client = createMockSupabaseClient([
      { data: segmented, error: null }, // fetchAppointmentForActor
      { data: [], error: null }, // availability
      { data: segmented, error: null }, // header update
      { data: null, error: null }, // applyResizedServiceRows update
      { data: segmented, error: null }, // finalRow re-fetch
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const service = createService(client);

    await service.reschedule(ownerActor(), 'appointment_1', {
      scheduledStartAt: '2026-05-13T09:00:00.000Z',
      durationMinutes: 75, // +15 vs the current 60
    });

    const updateQuery = client.queries.find(
      (query) =>
        query.calls.some((call) => call.method === 'from' && call.args[0] === 'appointment_services') &&
        query.calls.some((call) => call.method === 'update'),
    );
    const payload = updateQuery?.calls.find((call) => call.method === 'update')?.args[0] as {
      duration_minutes: number;
      segments: Array<{ name: string; durationMinutes: number; isStylistFree: boolean }>;
    };
    // The +15 lands on the last OCCUPIED segment (Rinse); the free Develop time is untouched.
    expect(payload.duration_minutes).toBe(75);
    expect(payload.segments).toEqual([
      { name: 'Apply', durationMinutes: 20, isStylistFree: false },
      { name: 'Develop', durationMinutes: 30, isStylistFree: true },
      { name: 'Rinse', durationMinutes: 25, isStylistFree: false },
    ]);
  });
});

describe('LabAppointmentsService — cancel appointment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function ownerActor(): AuthUser {
    return {
      ...stylistActor(),
      roles: ['owner'],
      primaryRole: 'owner',
      staffProfileId: undefined,
      locationScope: { kind: 'all', locationIds: ['location_1', 'location_2'] },
    };
  }

  const paidDeposit = { status: 'paid', amount: 20, currency_code: 'GBP' };

  it('keeps (forfeits) a paid deposit when the manager chooses not to refund', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentRow({ deposits: [paidDeposit] }), error: null }, // fetchAppointmentForActor
      { data: appointmentRow({ status: 'cancelled', deposits: [paidDeposit] }), error: null }, // atomic cancel
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const stripe = { refundPaymentIntent: jest.fn().mockResolvedValue({ id: 're_test', status: 'succeeded' }) };
    const service = createService(client, undefined, stripe);

    const result = await service.cancel(ownerActor(), 'appointment_1', 'No longer needed', false);

    expect(result.depositRefunded).toBe(false);
    expect(result.depositForfeited).toBe(true);
    expect(stripe.refundPaymentIntent).not.toHaveBeenCalled();
    // The deposit table is never read or written when the deposit is kept.
    expect(
      client.queries.some((query) =>
        query.calls.some((call) => call.method === 'from' && call.args[0] === 'deposits'),
      ),
    ).toBe(false);
  });

  it('refunds the paid deposit by default when no choice is supplied', async () => {
    const client = createMockSupabaseClient([
      { data: appointmentRow({ deposits: [paidDeposit] }), error: null }, // fetchAppointmentForActor
      { data: appointmentRow({ status: 'cancelled', deposits: [paidDeposit] }), error: null }, // atomic cancel
      { data: { id: 'dep_1', provider_payment_intent_id: 'pi_1', status: 'paid' }, error: null }, // refund lookup
      { data: null, error: null }, // mark deposit refunded
      { data: [clientProfileRow()], error: null }, // fetchClientProfiles
    ]);
    const stripe = { refundPaymentIntent: jest.fn().mockResolvedValue({ id: 're_test', status: 'succeeded' }) };
    const service = createService(client, undefined, stripe);

    const result = await service.cancel(ownerActor(), 'appointment_1');

    expect(result.depositRefunded).toBe(true);
    expect(result.depositForfeited).toBeUndefined();
    expect(stripe.refundPaymentIntent).toHaveBeenCalledWith('pi_1');
  });
});

function createService(
  client: MockSupabaseClient,
  taxSettings: Record<string, unknown> = {
    locationId: 'loc',
    taxEnabled: false,
    taxLabel: null,
    taxRatePercent: 0,
    appliesTo: 'both',
    displayMode: 'ex_tax',
  },
  stripe: { refundPaymentIntent: jest.Mock } = {
    refundPaymentIntent: jest.fn().mockResolvedValue({ id: 're_test', status: 'succeeded' }),
  },
): LabAppointmentsService {
  mockedCreateClient.mockReturnValue(client as never);
  return new LabAppointmentsService(
    {
      getOrThrow: jest.fn((key: string) => `${key}_test`),
    } as unknown as ConfigService,
    {
      linkPersistedAppointment: jest.fn(),
    } as never,
    {
      resolveLocationTaxSettings: jest.fn().mockResolvedValue(taxSettings),
    } as never,
    {
      syncBookingNotificationsSafe: jest.fn().mockResolvedValue(undefined),
    } as never,
    {
      scheduleForCompletedAppointmentSafe: jest.fn().mockResolvedValue(undefined),
    } as never,
    stripe as never,
    {
      record: jest.fn().mockResolvedValue(undefined),
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
  query.delete = chain('delete');
  query.eq = chain('eq');
  query.neq = chain('neq');
  query.or = chain('or');
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
  // RPCs are awaited directly (no trailing .returns()/.single()), so the mock
  // resolves the configured result immediately.
  query.rpc = jest.fn((...args: unknown[]) => {
    query.calls.push({ method: 'rpc', args });
    return Promise.resolve(query.result);
  });

  return query;
}

function stylistActor(): AuthUser {
  return {
    id: 'user_1',
    roles: ['stylist'],
    primaryRole: 'stylist',
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
    permissions: [],
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
    status: 'accepted',
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

function billRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bill_1',
    business_id: 'business_1',
    location_id: 'location_1',
    visit_id: 'visit_1',
    appointment_id: 'appointment_1',
    client_profile_id: 'client_1',
    staff_profile_id: 'staff_1',
    bill_number: 1,
    status: 'paid',
    net_cents: 5000,
    tax_cents: 0,
    gross_cents: 5000,
    discount_cents: 0,
    deposit_applied_cents: 0,
    balance_collected_cents: 5000,
    currency_code: 'GBP',
    tax_label: null,
    tax_rate_percent: 0,
    occurred_at: '2026-05-13T10:05:00.000Z',
    created_at: '2026-05-13T10:05:00.000Z',
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
