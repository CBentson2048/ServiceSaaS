/**
 * Deposit source integrity under Stripe webhook re-delivery and declined-then-paid
 * payments.
 *
 * Stripe re-delivers `payment_intent.succeeded` until it receives a 2xx and may
 * deliver an event more than once. A repeat must never reverse a later refund or
 * partial refund, move the original collection instant (`paid_at`), or record a
 * second collection — R1 Money reads collections by `paid_at` and refunds by
 * `refunded_at` (docs/V1.1/week-8-ticket-b-r1-money.md §2).
 *
 * A declined card leaves the PaymentIntent reusable, and the booking page keeps
 * it, so `payment_intent.payment_failed` can be processed before a later success
 * on the same intent. That success must still complete the booking and the
 * deposit exactly once.
 *
 * The Supabase client is an in-memory table store that applies the same filters
 * PostgREST would (`eq`, `is`, `in`), so conditional writes are exercised as
 * written. `finalizePaidBookingAttempt` runs for real; only slot revalidation and
 * the appointment inserts it calls are stubbed.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { ReportFilter } from '@sheer/domain';
import type { AuthService } from '../auth/auth.service';
import type { BookingNotificationService } from '../communications/booking-notification.service';
import type { RebookingService } from '../rebooking/rebooking.service';
import { MoneyReportService } from '../reports/money/money-report.service';
import { instantKey, poundsToCents } from '../reports/money/money-values';
import { MemoryMoneySource, type LedgerDeposit } from '../reports/money/testing/memory-money-source';
import { firstPage, moneyScope } from '../reports/money/testing/money-scope';
import type { DepositEventStatus } from '../reports/money/money-source';
import type { StripePaymentIntent, StripeService } from '../stripe/stripe.service';
import { PublicBookingService } from './public-booking.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

const BIZ = '80000000-0000-4000-8000-000000000001';
const LOCATION = { id: '80000000-0000-4000-8000-000000000002', name: 'London', timezone: 'Europe/London' };
const ATTEMPT = '80000000-0000-4000-8000-000000000003';
const DEPOSIT = '80000000-0000-4000-8000-000000000004';

const DECLINED_AT = '2026-09-14T08:59:00.000Z';
const COLLECTED_AT = '2026-09-14T09:00:00.000Z';
const REFUNDED_AT = '2026-09-15T11:00:00.000Z';
const REPEATED_AT = '2026-09-18T20:00:00.000Z';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** An in-memory PostgREST: filters narrow the rows a read returns or an update changes. */
class FakeTables {
  readonly tables = new Map<string, Row[]>();
  readonly updates: Array<{ table: string; patch: Row; changed: number }> = [];
  failDepositUpdates = 0;
  /** Holds the next matching query until released, to interleave two webhook deliveries. */
  private gate: { table: string; op: 'read' | 'update'; reached: () => void; release: Promise<void> } | null = null;

  rows(table: string): Row[] {
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`no table ${table}`);
    return rows;
  }

  pauseNext(table: string, op: 'read' | 'update') {
    const reached = deferred();
    const release = deferred();
    this.gate = { table, op, reached: reached.resolve, release: release.promise };
    return { reached: reached.promise, release: release.resolve };
  }

  takeGate(table: string, op: 'read' | 'update') {
    if (this.gate === null || this.gate.table !== table || this.gate.op !== op) return null;
    const gate = this.gate;
    this.gate = null;
    return gate;
  }

  client() {
    return { schema: (schema: string) => ({ from: (table: string) => new FakeQuery(this, `${schema}.${table}`) }) };
  }
}

class FakeQuery implements PromiseLike<Result> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private patch: Row | null = null;
  private returning = false;
  private single = false;

  constructor(
    private readonly store: FakeTables,
    private readonly table: string,
  ) {}

  select(): this {
    if (this.patch) this.returning = true;
    return this;
  }
  update(patch: Row): this {
    this.patch = patch;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: null): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  then<A = Result, B = never>(onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<Result> {
    const gate = this.store.takeGate(this.table, this.patch === null ? 'read' : 'update');
    if (gate) {
      gate.reached();
      await gate.release;
    }
    return this.execute();
  }

  private execute(): Result {
    const matched = this.store.rows(this.table).filter((row) => this.filters.every((filter) => filter(row)));
    if (this.patch !== null) {
      if (this.table === 'booking.deposits' && this.store.failDepositUpdates > 0) {
        this.store.failDepositUpdates -= 1;
        return { data: null, error: { message: 'connection reset' } };
      }
      for (const row of matched) Object.assign(row, this.patch);
      this.store.updates.push({ table: this.table, patch: this.patch, changed: matched.length });
      if (!this.returning) return { data: null, error: null };
    }
    const copies = matched.map((row) => ({ ...row }));
    return { data: this.single ? (copies[0] ?? null) : copies, error: null };
  }
}

const intent = (id = 'pi_1', lastError?: string) =>
  ({
    id,
    status: lastError ? 'requires_payment_method' : 'succeeded',
    latest_charge: lastError ? null : 'ch_1',
    last_payment_error: lastError ? { message: lastError } : null,
    metadata: { booking_attempt_id: ATTEMPT },
  }) as unknown as StripePaymentIntent;

interface Internals {
  resolveBookingContext: () => Promise<unknown>;
  fetchServiceIdsForAttempt: () => Promise<string[]>;
  clientDetailsForAttempt: () => Promise<unknown>;
  insertAppointmentForAttempt: () => Promise<Row>;
  insertAppointmentServicesForAttempt: () => Promise<void>;
  deleteAppointmentAfterFailedFinalization: (attempt: Row, appointmentId: string) => Promise<void>;
  fetchAppointmentInsertRow: (appointmentId: string) => Promise<Row>;
}

function setUp() {
  const store = new FakeTables();
  store.tables.set('booking.booking_attempts', [
    { id: ATTEMPT, business_id: BIZ, location_id: LOCATION.id, status: 'pending_payment', appointment_id: null, stripe_payment_intent_id: 'pi_1' },
  ]);
  store.tables.set('booking.deposits', [
    {
      id: DEPOSIT,
      business_id: BIZ,
      location_id: LOCATION.id,
      booking_attempt_id: ATTEMPT,
      appointment_id: null,
      provider_payment_intent_id: 'pi_1',
      provider_charge_id: null,
      status: 'pending',
      amount: '25.00',
      currency_code: 'GBP',
      paid_at: null,
      refunded_at: null,
      failure_reason: null,
      metadata: { source: 'public_booking_flow' },
    },
  ]);
  store.tables.set('booking.appointments', []);
  (createClient as jest.Mock).mockReturnValue(store.client());
  const config = { getOrThrow: (key: string) => `placeholder-${key}` } as unknown as ConfigService;
  const service = new PublicBookingService(config, {} as StripeService, {} as RebookingService, {} as BookingNotificationService, {} as AuthService);

  // Slot revalidation and the appointment rows are outside this spec; the attempt
  // status gate and the conditional confirmation in finalizePaidBookingAttempt run for real.
  const internals = service as unknown as Internals;
  let appointmentSerial = 0;
  const insertGate: { next: { reached: () => void; release: Promise<void> } | null } = { next: null };
  jest.spyOn(internals, 'resolveBookingContext').mockResolvedValue({});
  jest.spyOn(internals, 'fetchServiceIdsForAttempt').mockResolvedValue([]);
  jest.spyOn(internals, 'clientDetailsForAttempt').mockResolvedValue({});
  jest.spyOn(internals, 'insertAppointmentServicesForAttempt').mockResolvedValue(undefined);
  jest.spyOn(internals, 'insertAppointmentForAttempt').mockImplementation(async () => {
    appointmentSerial += 1;
    const row = { id: `appointment-${appointmentSerial}`, status: 'pending', scheduled_start_at: '', scheduled_end_at: '' };
    store.rows('booking.appointments').push(row);
    const gate = insertGate.next;
    insertGate.next = null;
    if (gate) {
      gate.reached();
      await gate.release;
    }
    return row;
  });
  jest.spyOn(internals, 'deleteAppointmentAfterFailedFinalization').mockImplementation(async (_attempt, appointmentId) => {
    const rows = store.rows('booking.appointments');
    rows.splice(rows.findIndex((row) => row.id === appointmentId), 1);
  });
  jest.spyOn(internals, 'fetchAppointmentInsertRow').mockImplementation(async (appointmentId) => {
    const row = store.rows('booking.appointments').find((candidate) => candidate.id === appointmentId);
    if (!row) throw new Error(`no appointment ${appointmentId}`);
    return row;
  });

  const pauseInsideFinalize = () => {
    const reached = deferred();
    const release = deferred();
    insertGate.next = { reached: reached.resolve, release: release.promise };
    return { reached: reached.promise, release: release.resolve };
  };
  const attempt = () => ({ ...store.rows('booking.booking_attempts')[0] });
  const deposit = () => ({ ...store.rows('booking.deposits')[0] });
  const appointments = () => store.rows('booking.appointments').map((row) => row.id);
  const depositUpdates = () => store.updates.filter((update) => update.table === 'booking.deposits');
  return { store, service, attempt, deposit, appointments, depositUpdates, pauseInsideFinalize };
}

async function succeedAt(service: PublicBookingService, iso: string, paymentIntent = intent()): Promise<void> {
  jest.setSystemTime(new Date(iso));
  await service.handlePaymentIntentSucceeded(paymentIntent);
}

async function declineAt(service: PublicBookingService, iso: string): Promise<void> {
  jest.setSystemTime(new Date(iso));
  await service.handlePaymentIntentFailed(intent('pi_1', 'Your card was declined.'));
}

/** The in-app refund's write (LabAppointmentsService.refundPaidDeposit), after Stripe accepted the refund. */
async function refundInApp(store: FakeTables, iso: string): Promise<void> {
  jest.setSystemTime(new Date(iso));
  await store.client().schema('booking').from('deposits').update({ status: 'refunded', refunded_at: new Date().toISOString() }).eq('id', DEPOSIT);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('payment_intent.succeeded records the deposit collection once', () => {
  it('1. the first successful payment confirms the booking and records the collection once', async () => {
    const { service, attempt, appointments, deposit, depositUpdates } = setUp();
    await succeedAt(service, COLLECTED_AT);
    expect(appointments()).toEqual(['appointment-1']);
    expect(attempt()).toMatchObject({ status: 'confirmed', appointment_id: 'appointment-1' });
    expect(deposit()).toMatchObject({ status: 'paid', paid_at: COLLECTED_AT, appointment_id: 'appointment-1', provider_charge_id: 'ch_1', refunded_at: null });
    expect(depositUpdates().map((update) => update.changed)).toEqual([1]);
  });

  it('2. a repeated success is idempotent: no second collection, no new paid_at, no second appointment', async () => {
    const { store, service, appointments, deposit, depositUpdates } = setUp();
    await succeedAt(service, COLLECTED_AT);
    const recorded = deposit();
    await succeedAt(service, '2026-09-14T09:00:05.000Z');
    await succeedAt(service, REPEATED_AT);
    expect(deposit()).toEqual(recorded);
    expect(appointments()).toEqual(['appointment-1']);
    expect(store.rows('booking.deposits')).toHaveLength(1);
    // The repeats matched no row: nothing was written.
    expect(depositUpdates().map((update) => update.changed)).toEqual([1, 0, 0]);
  });

  it('3. success → refund → repeated success: the deposit stays refunded', async () => {
    const { store, service, deposit } = setUp();
    await succeedAt(service, COLLECTED_AT);
    await refundInApp(store, REFUNDED_AT);
    await succeedAt(service, REPEATED_AT);
    expect(deposit()).toMatchObject({ status: 'refunded', paid_at: COLLECTED_AT, refunded_at: REFUNDED_AT });
  });

  it('4. success → partial refund → repeated success: the partial refund state is preserved', async () => {
    const { store, service, deposit } = setUp();
    await succeedAt(service, COLLECTED_AT);
    // No QLOOQO path writes a partial refund today; the state must still survive a repeat.
    Object.assign(store.rows('booking.deposits')[0], { status: 'partially_refunded', refunded_at: REFUNDED_AT });
    await succeedAt(service, REPEATED_AT);
    expect(deposit()).toMatchObject({ status: 'partially_refunded', paid_at: COLLECTED_AT, refunded_at: REFUNDED_AT });
  });

  it('5. paid_at remains the original collection instant, however late and however often the repeat arrives', async () => {
    const { service, deposit } = setUp();
    await succeedAt(service, COLLECTED_AT);
    for (const later of ['2026-09-14T09:01:00.000Z', '2026-09-15T00:30:00.000Z', '2026-09-17T09:00:00.000Z']) {
      await succeedAt(service, later);
      expect(deposit().paid_at).toBe(COLLECTED_AT);
    }
  });

  it('a retry after the first delivery failed to record the deposit still records it, once', async () => {
    const { store, service, appointments, deposit } = setUp();
    store.failDepositUpdates = 1;
    jest.setSystemTime(new Date(COLLECTED_AT));
    // The booking was confirmed but the deposit write failed, so Stripe gets a 500 and retries.
    await expect(service.handlePaymentIntentSucceeded(intent())).rejects.toThrow('Unable to mark deposit paid');
    expect(deposit()).toMatchObject({ status: 'pending', paid_at: null });
    await succeedAt(service, '2026-09-14T09:05:00.000Z');
    expect(deposit()).toMatchObject({ status: 'paid', paid_at: '2026-09-14T09:05:00.000Z' });
    await succeedAt(service, REPEATED_AT);
    expect(deposit().paid_at).toBe('2026-09-14T09:05:00.000Z');
    expect(appointments()).toEqual(['appointment-1']);
  });
});

describe('a declined card, then a successful payment on the same PaymentIntent', () => {
  it('failure → later success: the booking is confirmed and the collection recorded, once', async () => {
    const { service, attempt, deposit, appointments } = setUp();
    await declineAt(service, DECLINED_AT);
    expect(attempt().status).toBe('payment_failed');
    expect(deposit()).toMatchObject({ status: 'failed', failure_reason: 'Your card was declined.', paid_at: null });

    await succeedAt(service, COLLECTED_AT);
    expect(attempt()).toMatchObject({ status: 'confirmed', appointment_id: 'appointment-1' });
    expect(deposit()).toMatchObject({ status: 'paid', paid_at: COLLECTED_AT, appointment_id: 'appointment-1' });
    expect(appointments()).toEqual(['appointment-1']);
  });

  it('failure → success → duplicate success: one appointment, one deposit, paid_at unchanged', async () => {
    const { store, service, deposit, appointments, depositUpdates } = setUp();
    await declineAt(service, DECLINED_AT);
    await succeedAt(service, COLLECTED_AT);
    const recorded = deposit();
    await succeedAt(service, REPEATED_AT);
    expect(deposit()).toEqual(recorded);
    expect(appointments()).toEqual(['appointment-1']);
    expect(store.rows('booking.deposits')).toHaveLength(1);
    // failed, paid, then the repeat changes nothing.
    expect(depositUpdates().map((update) => [update.patch.status, update.changed])).toEqual([
      ['failed', 1],
      ['paid', 1],
      ['paid', 0],
    ]);
  });

  it('failure → success → refund → duplicate success: the deposit stays refunded', async () => {
    const { store, service, deposit, appointments } = setUp();
    await declineAt(service, DECLINED_AT);
    await succeedAt(service, COLLECTED_AT);
    await refundInApp(store, REFUNDED_AT);
    await succeedAt(service, REPEATED_AT);
    expect(deposit()).toMatchObject({ status: 'refunded', paid_at: COLLECTED_AT, refunded_at: REFUNDED_AT });
    expect(appointments()).toEqual(['appointment-1']);
  });

  it('a failure delivered after the success never reverses the booking or the collection', async () => {
    const { service, attempt, deposit } = setUp();
    await succeedAt(service, COLLECTED_AT);
    await declineAt(service, '2026-09-14T09:00:30.000Z');
    expect(attempt().status).toBe('confirmed');
    expect(deposit()).toMatchObject({ status: 'paid', paid_at: COLLECTED_AT, failure_reason: null });
  });

  it('race: the failure is processed while the success is confirming the booking — it still completes once', async () => {
    const { service, attempt, deposit, appointments, pauseInsideFinalize } = setUp();
    const paused = pauseInsideFinalize();
    jest.setSystemTime(new Date(COLLECTED_AT));
    const success = service.handlePaymentIntentSucceeded(intent());
    await paused.reached;
    // The appointment row exists; the attempt is not yet confirmed. The earlier decline lands now.
    await service.handlePaymentIntentFailed(intent('pi_1', 'Your card was declined.'));
    expect(attempt().status).toBe('payment_failed');
    paused.release();
    await success;
    expect(attempt()).toMatchObject({ status: 'confirmed', appointment_id: 'appointment-1' });
    expect(deposit()).toMatchObject({ status: 'paid', paid_at: COLLECTED_AT });
    expect(appointments()).toEqual(['appointment-1']);
  });

  it('race: a failure that read the attempt before the success completed cannot overwrite the collection', async () => {
    const { store, service, attempt, deposit } = setUp();
    const paused = store.pauseNext('booking.booking_attempts', 'update');
    jest.setSystemTime(new Date(DECLINED_AT));
    const failure = service.handlePaymentIntentFailed(intent('pi_1', 'Your card was declined.'));
    await paused.reached;
    // The failure saw a pending attempt; the success now completes in full.
    await succeedAt(service, COLLECTED_AT);
    paused.release();
    await failure;
    expect(attempt().status).toBe('confirmed');
    expect(deposit()).toMatchObject({ status: 'paid', paid_at: COLLECTED_AT, failure_reason: null });
  });

  it('a success for a different PaymentIntent does not complete a declined attempt', async () => {
    const { service, attempt, deposit, appointments } = setUp();
    await declineAt(service, DECLINED_AT);
    await succeedAt(service, COLLECTED_AT, intent('pi_other'));
    expect(attempt().status).toBe('payment_failed');
    expect(deposit()).toMatchObject({ status: 'failed', paid_at: null });
    expect(appointments()).toEqual([]);
  });
});

describe('6. R1 Money deposit reporting is stable after repeated events', () => {
  const day = (date: string): ReportFilter => ({ preset: 'custom', from: date, to: date, locationIds: [], staffProfileIds: [], view: 'summary' });

  function ledgerDeposits(store: FakeTables): LedgerDeposit[] {
    return store.rows('booking.deposits').map((row) => ({
      id: String(row.id),
      businessId: String(row.business_id),
      locationId: String(row.location_id),
      amountCents: poundsToCents(row.amount),
      status: row.status as DepositEventStatus,
      paidAt: row.paid_at === null ? null : instantKey(row.paid_at),
      refundedAt: row.refunded_at === null ? null : instantKey(row.refunded_at),
      currencyCode: String(row.currency_code),
    }));
  }

  /** Deposits collected and refunded on each London day, as R1 reports them. */
  async function depositsByDay(store: FakeTables) {
    const source = new MemoryMoneySource({
      bills: [],
      lines: [],
      payments: [],
      retail: [],
      deposits: ledgerDeposits(store),
      locations: [{ id: LOCATION.id, businessId: BIZ, currencyCode: 'GBP' }],
    });
    const out: Record<string, [unknown, unknown]> = {};
    for (const date of ['2026-09-14', '2026-09-15', '2026-09-18']) {
      const scope = moneyScope(BIZ, [LOCATION], day(date), new Date('2026-09-20T12:00:00Z'));
      const { summary } = firstPage(await new MoneyReportService(source).build(scope, { cursor: null }));
      out[date] = [summary.deposits.collected, summary.deposits.refunded];
    }
    return out;
  }

  const pounds = (cents: number) => ({ availability: 'available', cents });
  const EXPECTED = {
    '2026-09-14': [pounds(2500), pounds(0)],
    '2026-09-15': [pounds(0), pounds(2500)],
    '2026-09-18': [pounds(0), pounds(0)],
  };

  it('collections stay on the day they happened and refunds on theirs, whatever is re-delivered', async () => {
    const { store, service } = setUp();
    await succeedAt(service, COLLECTED_AT);
    await refundInApp(store, REFUNDED_AT);
    expect(await depositsByDay(store)).toEqual(EXPECTED);
    await succeedAt(service, REPEATED_AT);
    await succeedAt(service, '2026-09-18T20:00:30.000Z');
    expect(await depositsByDay(store)).toEqual(EXPECTED);
  });

  it('a decline before the successful payment adds no collection and moves none', async () => {
    const { store, service } = setUp();
    await declineAt(service, DECLINED_AT);
    await succeedAt(service, COLLECTED_AT);
    await refundInApp(store, REFUNDED_AT);
    await succeedAt(service, REPEATED_AT);
    expect(await depositsByDay(store)).toEqual(EXPECTED);
  });
});
