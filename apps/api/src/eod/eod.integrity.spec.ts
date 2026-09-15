/**
 * End of Day source integrity (QLOOQO V1.1 Week 8, R7 pre-G5 fixes; decision
 * record docs/V1.1/week-8-r7-cash-up.md §9).
 *
 * - D-2: a new day is stored in the location's own currency, never the column's
 *   GBP default; historical days keep theirs, and R7 still refuses to compare a
 *   day stored in another currency.
 * - D-5: a failed petty cash read never becomes a recorded £0.00.
 * - D-6: every actor, owners included, is held to their own business's locations.
 * - D-8: a day that has not started at the location (by its own timezone) can't
 *   be opened or signed off.
 *
 * The routes run over real HTTP with the real guards and EodService. The Supabase
 * client is an in-memory table store applying the filters PostgREST would, so a
 * test can prove what was, and was not, read or written. Only `Date` is faked.
 */
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, ReportFilter } from '@sheer/domain';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CashUpReportService } from '../reports/cash-up/cash-up-report.service';
import { SupabaseCashUpSource } from '../reports/cash-up/cash-up-source';
import { MONEY_SOURCE, SupabaseMoneySource } from '../reports/money/money-source';
import { MemoryMoneySource } from '../reports/money/testing/memory-money-source';
import { moneyScope } from '../reports/money/testing/money-scope';
import { EodController } from './eod.controller';
import { EodService } from './eod.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

type Row = Record<string, unknown>;
type Op = 'read' | 'insert' | 'update';
type Result = { data: unknown; error: { message: string } | null };

const BIZ_A = 'a0000000-0000-4000-8000-000000000001';
const BIZ_B = 'b0000000-0000-4000-8000-000000000001';
const LONDON = 'a1000000-0000-4000-8000-000000000001';
const NEW_YORK = 'a1000000-0000-4000-8000-000000000002';
const TOKYO = 'a1000000-0000-4000-8000-000000000003';
const EURO_DESK = 'a1000000-0000-4000-8000-000000000004';
const NO_CURRENCY = 'a1000000-0000-4000-8000-000000000005';
const BAD_ZONE = 'a1000000-0000-4000-8000-000000000006';
const FOREIGN = 'b1000000-0000-4000-8000-000000000001';
const UNKNOWN = 'c1000000-0000-4000-8000-000000000001';

const OWNER_A = 'a9000000-0000-4000-8000-000000000001';
const MANAGER_A = 'a9000000-0000-4000-8000-000000000002';
const OWNER_B = 'b9000000-0000-4000-8000-000000000001';

const EOD_PERMISSIONS = ['eod.manage', 'eod.sign_off'];
const users: Record<string, Partial<AuthUser>> = {
  'owner-a': {
    id: OWNER_A,
    businessId: BIZ_A,
    roles: ['owner'],
    permissions: EOD_PERMISSIONS as AuthUser['permissions'],
    allowedLocationIds: [LONDON, NEW_YORK, TOKYO, EURO_DESK, NO_CURRENCY, BAD_ZONE],
  },
  'manager-a': {
    id: MANAGER_A,
    businessId: BIZ_A,
    roles: ['manager'],
    permissions: EOD_PERMISSIONS as AuthUser['permissions'],
    allowedLocationIds: [LONDON],
  },
  // A membership row that points at another business's location.
  'manager-a-with-foreign-membership': {
    id: MANAGER_A,
    businessId: BIZ_A,
    roles: ['manager'],
    permissions: EOD_PERMISSIONS as AuthUser['permissions'],
    allowedLocationIds: [LONDON, FOREIGN],
  },
  'owner-b': {
    id: OWNER_B,
    businessId: BIZ_B,
    roles: ['owner'],
    permissions: EOD_PERMISSIONS as AuthUser['permissions'],
    allowedLocationIds: [FOREIGN],
  },
};

function seed(): Map<string, Row[]> {
  return new Map<string, Row[]>([
    ['businesses', [
      { id: BIZ_A, default_currency_code: 'USD' },
      { id: BIZ_B, default_currency_code: 'GBP' },
    ]],
    ['locations', [
      { id: LONDON, business_id: BIZ_A, timezone: 'Europe/London' },
      { id: NEW_YORK, business_id: BIZ_A, timezone: 'America/New_York' },
      { id: TOKYO, business_id: BIZ_A, timezone: 'Asia/Tokyo' },
      { id: EURO_DESK, business_id: BIZ_A, timezone: 'Europe/London' },
      { id: NO_CURRENCY, business_id: BIZ_A, timezone: 'Europe/London' },
      { id: BAD_ZONE, business_id: BIZ_A, timezone: 'Mars/Olympus_Mons' },
      { id: FOREIGN, business_id: BIZ_B, timezone: 'Europe/London' },
    ]],
    ['location_settings', [
      { business_id: BIZ_A, location_id: LONDON, currency_code: 'GBP', cash_variance_threshold_amount: 5 },
      { business_id: BIZ_A, location_id: TOKYO, currency_code: 'JPY', cash_variance_threshold_amount: 5 },
      { business_id: BIZ_A, location_id: EURO_DESK, currency_code: 'EUR', cash_variance_threshold_amount: 5 },
      // A settings row whose code is unusable: R1's rule never replaces it with a guess.
      { business_id: BIZ_A, location_id: NO_CURRENCY, currency_code: '   ', cash_variance_threshold_amount: 5 },
      { business_id: BIZ_A, location_id: BAD_ZONE, currency_code: 'GBP', cash_variance_threshold_amount: 5 },
      { business_id: BIZ_B, location_id: FOREIGN, currency_code: 'GBP', cash_variance_threshold_amount: 9 },
      // New York has no settings row: the business default (USD) applies.
    ]],
    ['user_profiles', [
      { id: OWNER_A, full_name: 'Avery Owner' },
      { id: MANAGER_A, full_name: 'Morgan Manager' },
      { id: OWNER_B, full_name: 'Blake Owner' },
    ]],
    ['eod_reconciliations', []],
    ['eod_petty_cash_entries', []],
    ['salon_payments', []],
  ]);
}

/** An in-memory PostgREST: filters narrow what a read returns or an update changes. */
class FakeDb {
  tables = seed();
  readonly reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
  readonly writes: Array<{ table: string; op: Op; filters: Array<[string, string, unknown]>; payload: unknown }> = [];
  readonly rpcs: Row[] = [];
  private failures: Array<{ table: string; op: Op }> = [];
  private serial = 0;

  reset() {
    this.tables = seed();
    this.reads.length = 0;
    this.writes.length = 0;
    this.rpcs.length = 0;
    this.failures = [];
  }

  failNext(table: string, op: Op) {
    this.failures.push({ table, op });
  }

  rows(table: string): Row[] {
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`no table ${table}`);
    return rows;
  }

  snapshot(table: string): Row[] {
    return JSON.parse(JSON.stringify(this.rows(table))) as Row[];
  }

  client() {
    return {
      schema: () => ({
        from: (table: string) => new FakeQuery(this, table),
        rpc: async (fn: string, args: Row): Promise<Result> => this.rpc(fn, args),
      }),
    };
  }

  takeFailure(table: string, op: Op): boolean {
    const index = this.failures.findIndex((f) => f.table === table && f.op === op);
    if (index === -1) return false;
    this.failures.splice(index, 1);
    return true;
  }

  nextId(): string {
    this.serial += 1;
    return `e0000000-0000-4000-8000-${this.serial.toString(16).padStart(12, '0')}`;
  }

  private rpc(fn: string, args: Row): Result {
    if (fn !== 'eod_expected_figures') throw new Error(`unexpected rpc ${fn}`);
    this.rpcs.push(args);
    const sum = (method: string) =>
      this.rows('salon_payments')
        .filter(
          (p) =>
            p.business_id === args.p_business_id &&
            p.location_id === args.p_location_id &&
            p.payment_method === method &&
            Date.parse(p.paid_at as string) >= Date.parse(args.p_day_start as string) &&
            Date.parse(p.paid_at as string) < Date.parse(args.p_day_end as string),
        )
        .reduce((total, p) => total + (p.amount_cents as number), 0);
    return {
      data: [
        {
          expected_cash_cents: sum('cash'),
          expected_card_cents: sum('card_reader'),
          unclassified_retail_cents: 0,
          deposits_collected_cents: 0,
          deposits_redeemed_cents: 0,
          open_visits: 0,
        },
      ],
      error: null,
    };
  }
}

class FakeQuery implements PromiseLike<Result> {
  private op: Op = 'read';
  private payload: unknown = null;
  private readonly filters: Array<[string, string, unknown]> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select() {
    return this;
  }
  insert(payload: unknown) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push([column, 'eq', value]);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push([column, 'in', values]);
    return this;
  }
  gte(column: string, value: unknown) {
    this.filters.push([column, 'gte', value]);
    return this;
  }
  lte(column: string, value: unknown) {
    this.filters.push([column, 'lte', value]);
    return this;
  }
  gt(column: string, value: unknown) {
    this.filters.push([column, 'gt', value]);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  returns() {
    return this;
  }
  maybeSingle() {
    this.mode = 'maybeSingle';
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, op, value]) => {
      const actual = row[column];
      switch (op) {
        case 'eq':
          return actual === value;
        case 'in':
          return (value as unknown[]).includes(actual);
        case 'gte':
          return String(actual) >= String(value);
        case 'lte':
          return String(actual) <= String(value);
        case 'gt':
          return String(actual) > String(value);
        default:
          throw new Error(`unsupported filter ${op}`);
      }
    });
  }

  private execute(): Result {
    if (this.db.takeFailure(this.table, this.op)) {
      if (this.op !== 'read') this.db.writes.push({ table: this.table, op: this.op, filters: this.filters, payload: 'FAILED' });
      return { data: null, error: { message: `injected ${this.op} failure on ${this.table}` } };
    }
    const rows = this.db.rows(this.table);
    let affected: Row[];
    if (this.op === 'insert') {
      const inserted = { ...defaults(this.table, this.db.nextId()), ...(this.payload as Row) };
      if (
        this.table === 'eod_reconciliations' &&
        rows.some((r) => r.location_id === inserted.location_id && r.business_date === inserted.business_date)
      ) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(inserted);
      this.db.writes.push({ table: this.table, op: 'insert', filters: [], payload: this.payload });
      affected = [inserted];
    } else if (this.op === 'update') {
      affected = rows.filter((row) => this.matches(row));
      for (const row of affected) Object.assign(row, this.payload as Row, { updated_at: new Date().toISOString() });
      this.db.writes.push({ table: this.table, op: 'update', filters: this.filters, payload: this.payload });
    } else {
      this.db.reads.push({ table: this.table, filters: this.filters });
      affected = rows.filter((row) => this.matches(row));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        affected = [...affected].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      if (this.max !== null) affected = affected.slice(0, this.max);
    }
    const copies = affected.map((row) => ({ ...row }));
    if (this.mode === 'many') return { data: copies, error: null };
    if (this.mode === 'maybeSingle') {
      if (copies.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: copies[0] ?? null, error: null };
    }
    if (copies.length !== 1) return { data: null, error: { message: 'expected one row' } };
    return { data: copies[0], error: null };
  }
}

function defaults(table: string, id: string): Row {
  const now = new Date().toISOString();
  if (table === 'eod_petty_cash_entries') return { id, created_at: now };
  if (table !== 'eod_reconciliations') return { id };
  return {
    id,
    status: 'open',
    opening_float_cents: 0,
    expected_cash_cents: null,
    counted_cash_cents: null,
    expected_card_cents: null,
    counted_card_cents: null,
    unclassified_retail_cents: 0,
    deposits_collected_cents: 0,
    deposits_redeemed_cents: 0,
    voids_cents: 0,
    refunds_cents: 0,
    petty_cash_out_cents: 0,
    variance_cents: null,
    notes: null,
    opened_by_user_profile_id: null,
    signed_off_by_user_profile_id: null,
    signed_off_at: null,
    // The column default the old writer relied on.
    currency_code: 'GBP',
    created_at: now,
    updated_at: now,
  };
}

/** A stored day as an earlier writer left it. */
function storedDay(overrides: Row): Row {
  return { ...defaults('eod_reconciliations', overrides.id as string), ...overrides };
}

const db = new FakeDb();
(createClient as jest.Mock).mockImplementation(() => db.client());

// London 16 Sep 00:30 (BST) = New York 15 Sep 19:30 (EDT) = Tokyo 16 Sep 08:30 (JST).
const NOW = '2026-09-15T23:30:00.000Z';

let app: INestApplication;
const audit = { record: jest.fn(async () => undefined) };

beforeAll(async () => {
  jest.useFakeTimers({
    now: new Date(NOW),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [EodController],
    providers: [
      EodService,
      { provide: MONEY_SOURCE, useClass: SupabaseMoneySource },
      { provide: ConfigService, useValue: { getOrThrow: () => 'test' } },
      { provide: AuditService, useValue: audit },
      {
        provide: AuthService,
        useValue: {
          verifyAccessToken: async (token: string) => {
            const user = users[token];
            if (!user) throw new Error(`unknown token ${token}`);
            return user as AuthUser;
          },
        },
      },
      SupabaseAuthGuard,
      RolesGuard,
      PermissionsGuard,
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  await app.init();
});

afterAll(async () => {
  await app.close();
  jest.useRealTimers();
});

beforeEach(() => {
  db.reset();
  jest.setSystemTime(new Date(NOW));
  audit.record.mockClear();
});

const http = {
  open: (token: string, body: Row) => request(app.getHttpServer()).post('/api/eod/open').set('Authorization', `Bearer ${token}`).send(body),
  day: (token: string, query: Row) => request(app.getHttpServer()).get('/api/eod/day').query(query).set('Authorization', `Bearer ${token}`),
  days: (token: string, locationId: string) =>
    request(app.getHttpServer()).get('/api/eod/days').query({ locationId }).set('Authorization', `Bearer ${token}`),
  patch: (token: string, id: string, body: Row) => request(app.getHttpServer()).patch(`/api/eod/${id}`).set('Authorization', `Bearer ${token}`).send(body),
  refresh: (token: string, id: string) => request(app.getHttpServer()).post(`/api/eod/${id}/refresh`).set('Authorization', `Bearer ${token}`),
  petty: (token: string, id: string, body: Row) =>
    request(app.getHttpServer()).post(`/api/eod/${id}/petty-cash`).set('Authorization', `Bearer ${token}`).send(body),
  signOff: (token: string, id: string) => request(app.getHttpServer()).post(`/api/eod/${id}/sign-off`).set('Authorization', `Bearer ${token}`),
};

const dayRow = (locationId: string, businessDate: string) =>
  db.rows('eod_reconciliations').find((r) => r.location_id === locationId && r.business_date === businessDate);

/** Every read or write that named the location, by filter. */
const touching = (locationId: string) =>
  [...db.reads, ...db.writes].filter((entry) =>
    entry.filters.some(([, , value]) => value === locationId || (Array.isArray(value) && value.includes(locationId))),
  );

describe('D-6: End of Day holds every actor to their own business’s locations', () => {
  it('an owner opens, reads and signs off a day at their own business’s location', async () => {
    const opened = await http.open('owner-a', { locationId: LONDON, businessDate: '2026-09-15' });
    expect(opened.status).toBe(201);
    expect(dayRow(LONDON, '2026-09-15')).toMatchObject({ business_id: BIZ_A, status: 'open' });
    expect((await http.day('owner-a', { locationId: LONDON, businessDate: '2026-09-15' })).status).toBe(200);
    expect((await http.days('owner-a', LONDON)).body.days).toHaveLength(1);
    const id = opened.body.day.id as string;
    expect((await http.patch('owner-a', id, { countedCashCents: 0, countedCardCents: 0 })).status).toBe(200);
    expect((await http.signOff('owner-a', id)).status).toBe(201);
    expect(dayRow(LONDON, '2026-09-15')).toMatchObject({ status: 'signed_off', signed_off_by_user_profile_id: OWNER_A });
  });

  it('an owner is refused every route for another business’s location; no foreign row is created, read or changed', async () => {
    const foreignDay = storedDay({
      id: 'b2000000-0000-4000-8000-000000000001',
      business_id: BIZ_B,
      location_id: FOREIGN,
      business_date: '2026-09-15',
      counted_cash_cents: 4000,
      counted_card_cents: 6000,
      notes: 'Business B’s own count',
    });
    db.rows('eod_reconciliations').push(foreignDay);
    db.rows('eod_petty_cash_entries').push({ id: 'b3000000-0000-4000-8000-000000000001', eod_id: foreignDay.id, amount_cents: 250, reason: 'milk' });
    const before = { days: db.snapshot('eod_reconciliations'), petty: db.snapshot('eod_petty_cash_entries') };

    const refusals = [
      await http.open('owner-a', { locationId: FOREIGN, businessDate: '2026-09-15' }),
      await http.open('owner-a', { locationId: FOREIGN, businessDate: '2026-09-14' }),
      await http.open('owner-a', { locationId: FOREIGN }),
      await http.day('owner-a', { locationId: FOREIGN, businessDate: '2026-09-15' }),
      await http.days('owner-a', FOREIGN),
    ];
    expect(refusals.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    // A foreign location and an id that exists nowhere are indistinguishable.
    const unknown = await http.open('owner-a', { locationId: UNKNOWN, businessDate: '2026-09-15' });
    for (const refusal of refusals) expect(refusal.body).toEqual(unknown.body);

    const byId = [
      await http.patch('owner-a', foreignDay.id as string, { countedCashCents: 1 }),
      await http.refresh('owner-a', foreignDay.id as string),
      await http.petty('owner-a', foreignDay.id as string, { amountCents: 100, reason: 'x' }),
      await http.signOff('owner-a', foreignDay.id as string),
    ];
    expect(byId.map((r) => r.status)).toEqual([404, 404, 404, 404]);

    expect(db.snapshot('eod_reconciliations')).toEqual(before.days);
    expect(db.snapshot('eod_petty_cash_entries')).toEqual(before.petty);
    // Nothing about the foreign location was read beyond the boundary check itself,
    // and its takings, threshold and days were never queried.
    expect(touching(FOREIGN).map((entry) => ('op' in entry ? entry.op : entry.table))).toEqual(
      Array.from({ length: 5 }, () => 'locations'),
    );
    expect(db.rpcs.filter((args) => args.p_location_id === FOREIGN)).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a manager whose membership list carries another business’s location is refused too', async () => {
    const response = await http.open('manager-a-with-foreign-membership', { locationId: FOREIGN, businessDate: '2026-09-15' });
    expect(response.status).toBe(403);
    expect(db.rows('eod_reconciliations')).toEqual([]);
    expect((await http.open('manager-a', { locationId: FOREIGN, businessDate: '2026-09-15' })).status).toBe(403);
    expect((await http.open('manager-a', { locationId: NEW_YORK, businessDate: '2026-09-15' })).status).toBe(403);
    expect((await http.open('manager-a', { locationId: LONDON, businessDate: '2026-09-15' })).status).toBe(201);
  });

  it('a row the old defect wrote (this business, another business’s location) can no longer be read or changed', async () => {
    const strayDay = storedDay({
      id: 'a2000000-0000-4000-8000-00000000000f',
      business_id: BIZ_A,
      location_id: FOREIGN,
      business_date: '2026-09-14',
      counted_cash_cents: 100,
      counted_card_cents: 0,
    });
    db.rows('eod_reconciliations').push(strayDay);
    const before = db.snapshot('eod_reconciliations');
    const responses = [
      await http.patch('owner-a', strayDay.id as string, { notes: 'edit' }),
      await http.refresh('owner-a', strayDay.id as string),
      await http.petty('owner-a', strayDay.id as string, { amountCents: 100, reason: 'x' }),
      await http.signOff('owner-a', strayDay.id as string),
    ];
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(db.snapshot('eod_reconciliations')).toEqual(before);
    expect(db.rows('eod_petty_cash_entries')).toEqual([]);
  });

  it('the refused attempt no longer blocks the other business from cashing up its own location that day', async () => {
    expect((await http.open('owner-a', { locationId: FOREIGN, businessDate: '2026-09-14' })).status).toBe(403);
    const own = await http.open('owner-b', { locationId: FOREIGN, businessDate: '2026-09-14' });
    expect(own.status).toBe(201);
    expect(dayRow(FOREIGN, '2026-09-14')).toMatchObject({ business_id: BIZ_B });
  });
});

describe('D-8: a day that has not started at the location can’t be opened or signed off', () => {
  it('today and yesterday open; tomorrow is refused and nothing is written (London)', async () => {
    expect((await http.open('owner-a', { locationId: LONDON, businessDate: '2026-09-16' })).status).toBe(201); // today
    expect((await http.open('owner-a', { locationId: LONDON, businessDate: '2026-09-15' })).status).toBe(201); // yesterday
    const tomorrow = await http.open('owner-a', { locationId: LONDON, businessDate: '2026-09-17' });
    expect(tomorrow.status).toBe(400);
    expect(tomorrow.body.message).toBe('This trading day has not started yet at this location');
    expect(db.rows('eod_reconciliations').map((r) => r.business_date)).toEqual(['2026-09-16', '2026-09-15']);
  });

  it('at one instant, each location’s own date decides — not the server’s, the browser’s or London’s', async () => {
    const outcomes: Array<[string, string, number]> = [];
    for (const [name, locationId, date] of [
      ['New York', NEW_YORK, '2026-09-16'], // London's today, New York's tomorrow
      ['New York', NEW_YORK, '2026-09-15'], // New York's today
      ['New York', NEW_YORK, '2026-09-14'], // New York's yesterday
      ['Tokyo', TOKYO, '2026-09-16'], // Tokyo's today
      ['Tokyo', TOKYO, '2026-09-17'], // Tokyo's tomorrow
    ] as const) {
      outcomes.push([name, date, (await http.open('owner-a', { locationId, businessDate: date })).status]);
    }
    expect(outcomes).toEqual([
      ['New York', '2026-09-16', 400],
      ['New York', '2026-09-15', 201],
      ['New York', '2026-09-14', 201],
      ['Tokyo', '2026-09-16', 201],
      ['Tokyo', '2026-09-17', 400],
    ]);
    expect(dayRow(NEW_YORK, '2026-09-16')).toBeUndefined();
    expect(dayRow(TOKYO, '2026-09-17')).toBeUndefined();
  });

  it('with no date given, a day opens on the location’s own today', async () => {
    for (const locationId of [LONDON, NEW_YORK, TOKYO]) {
      expect((await http.open('owner-a', { locationId })).status).toBe(201);
    }
    expect(db.rows('eod_reconciliations').map((r) => [r.location_id, r.business_date])).toEqual([
      [LONDON, '2026-09-16'],
      [NEW_YORK, '2026-09-15'],
      [TOKYO, '2026-09-16'],
    ]);
  });

  it('sign-off: today and yesterday are allowed; a day not started at the location is refused and left unchanged until it starts', async () => {
    const counted = { counted_cash_cents: 1000, counted_card_cents: 2000 };
    const newYorkTomorrow = storedDay({ id: 'a2000000-0000-4000-8000-000000000001', business_id: BIZ_A, location_id: NEW_YORK, business_date: '2026-09-16', ...counted });
    const londonToday = storedDay({ id: 'a2000000-0000-4000-8000-000000000002', business_id: BIZ_A, location_id: LONDON, business_date: '2026-09-16', ...counted });
    const londonYesterday = storedDay({ id: 'a2000000-0000-4000-8000-000000000003', business_id: BIZ_A, location_id: LONDON, business_date: '2026-09-15', ...counted });
    db.rows('eod_reconciliations').push(newYorkTomorrow, londonToday, londonYesterday);
    const untouched = db.snapshot('eod_reconciliations')[0];

    const refused = await http.signOff('owner-a', newYorkTomorrow.id as string);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('This trading day has not started yet at this location, so it cannot be signed off');
    expect(dayRow(NEW_YORK, '2026-09-16')).toEqual(untouched);
    expect((await http.signOff('owner-a', londonToday.id as string)).status).toBe(201);
    expect((await http.signOff('owner-a', londonYesterday.id as string)).status).toBe(201);

    jest.setSystemTime(new Date('2026-09-16T05:00:00.000Z')); // New York 16 Sep 01:00
    expect((await http.signOff('owner-a', newYorkTomorrow.id as string)).status).toBe(201);
    expect(dayRow(NEW_YORK, '2026-09-16')).toMatchObject({ status: 'signed_off' });
  });

  it('a location whose timezone is not valid can’t open a day: its date is never guessed', async () => {
    const response = await http.open('owner-a', { locationId: BAD_ZONE, businessDate: '2026-09-15' });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('The location’s timezone is not valid. Fix it in location settings first.');
    expect(db.rows('eod_reconciliations')).toEqual([]);
  });
});

describe('D-2: a new day is stored in the location’s currency, never the GBP column default', () => {
  it('uses the location’s settings currency, or the business default when the location has no settings row', async () => {
    for (const locationId of [LONDON, EURO_DESK, NEW_YORK, TOKYO]) {
      expect((await http.open('owner-a', { locationId, businessDate: '2026-09-15' })).status).toBe(201);
    }
    expect(Object.fromEntries(db.rows('eod_reconciliations').map((r) => [r.location_id, r.currency_code]))).toEqual({
      [LONDON]: 'GBP',
      [EURO_DESK]: 'EUR',
      [NEW_YORK]: 'USD',
      [TOKYO]: 'JPY',
    });
    const insert = db.writes.find((w) => w.table === 'eod_reconciliations' && w.op === 'insert');
    expect(insert?.payload).toMatchObject({ currency_code: 'GBP' }); // written explicitly, not left to the default
  });

  it('a location with no usable currency can’t open a day, and nothing is written', async () => {
    const response = await http.open('owner-a', { locationId: NO_CURRENCY, businessDate: '2026-09-15' });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Set the location’s currency before opening a trading day');
    expect(db.rows('eod_reconciliations')).toEqual([]);
  });

  it('a historical day keeps the currency it was stored with: opening, editing and signing off never rewrite it', async () => {
    const historical = storedDay({
      id: 'a2000000-0000-4000-8000-000000000010',
      business_id: BIZ_A,
      location_id: EURO_DESK,
      business_date: '2026-09-14',
      currency_code: 'GBP',
    });
    db.rows('eod_reconciliations').push(historical);
    const reopened = await http.open('owner-a', { locationId: EURO_DESK, businessDate: '2026-09-14' });
    expect(reopened.body.day).toMatchObject({ id: historical.id, currencyCode: 'GBP' });
    await http.patch('owner-a', historical.id as string, { countedCashCents: 500, countedCardCents: 0 });
    expect((await http.signOff('owner-a', historical.id as string)).status).toBe(201);
    expect(dayRow(EURO_DESK, '2026-09-14')).toMatchObject({ status: 'signed_off', currency_code: 'GBP' });
    expect(db.writes.flatMap((w) => Object.keys((w.payload ?? {}) as Row))).not.toContain('currency_code');
  });

  it('R7 still refuses to compare the historical GBP day at a EUR location, and reports the new EUR day', async () => {
    db.rows('eod_reconciliations').push(
      storedDay({ id: 'a2000000-0000-4000-8000-000000000011', business_id: BIZ_A, location_id: EURO_DESK, business_date: '2026-09-14', currency_code: 'GBP' }),
    );
    const historicalId = 'a2000000-0000-4000-8000-000000000011';
    await http.patch('owner-a', historicalId, { countedCashCents: 700, countedCardCents: 0 });
    await http.signOff('owner-a', historicalId);
    const opened = await http.open('owner-a', { locationId: EURO_DESK, businessDate: '2026-09-15' });
    await http.patch('owner-a', opened.body.day.id as string, { countedCashCents: 1200, countedCardCents: 0 });
    expect((await http.signOff('owner-a', opened.body.day.id as string)).status).toBe(201);

    // R7 reads exactly what End of Day wrote, through its real adapter.
    const money = new MemoryMoneySource({
      bills: [],
      lines: [],
      payments: [],
      retail: [],
      deposits: [],
      locations: [{ id: EURO_DESK, businessId: BIZ_A, currencyCode: 'EUR' }],
    });
    const filter: ReportFilter = { preset: 'custom', from: '2026-09-14', to: '2026-09-15', locationIds: [], staffProfileIds: [], view: 'detail' };
    const scope = moneyScope(BIZ_A, [{ id: EURO_DESK, name: 'Euro desk', timezone: 'Europe/London' }], filter, new Date(NOW));
    const body = await new CashUpReportService(money, new SupabaseCashUpSource({ getOrThrow: () => 'test' } as unknown as ConfigService)).build(scope, { cursor: null });
    if (body.continuation) throw new Error('expected a first page');

    const byDate = Object.fromEntries(body.detail!.rows.map((row) => [row.localDate, row]));
    expect(byDate['2026-09-14'].record!.variance).toEqual({ availability: 'unavailable', reason: 'currency_mismatch' });
    expect(byDate['2026-09-15'].record!.variance).toEqual({ availability: 'available', cents: 1200 });
    expect(body.summary.recorded.variance).toEqual({ availability: 'available', cents: 1200 });
    expect(body.summary.recorded.daysUnavailable).toBe(1);
    expect(body.summary.recorded.unavailableReasons).toEqual(['currency_mismatch']);
  });
});

describe('D-5: a failed petty cash read never becomes a recorded £0.00', () => {
  const DAY_ID = 'a2000000-0000-4000-8000-000000000020';
  beforeEach(() => {
    db.rows('eod_reconciliations').push(
      storedDay({
        id: DAY_ID,
        business_id: BIZ_A,
        location_id: LONDON,
        business_date: '2026-09-15',
        counted_cash_cents: 5000,
        counted_card_cents: 0,
        petty_cash_out_cents: 700,
      }),
    );
    db.rows('eod_petty_cash_entries').push({ id: 'a3000000-0000-4000-8000-000000000001', eod_id: DAY_ID, amount_cents: 700, reason: 'window cleaner', created_at: '2026-09-15T10:00:00.000Z' });
  });

  it('a failed re-read after adding petty cash fails the request and leaves the day total as it was, never £0.00', async () => {
    db.failNext('eod_petty_cash_entries', 'read');
    const response = await http.petty('owner-a', DAY_ID, { amountCents: 300, reason: 'milk' });
    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Petty cash was recorded, but the day total could not be updated. Reload the day before adding it again.');
    expect(dayRow(LONDON, '2026-09-15')!.petty_cash_out_cents).toBe(700);
    expect(db.rows('eod_petty_cash_entries').map((e) => e.amount_cents)).toEqual([700, 300]);
    expect(db.writes.filter((w) => w.table === 'eod_reconciliations')).toEqual([]);
  });

  it('refresh and sign-off re-read the entries, so the stored total is always their sum', async () => {
    db.failNext('eod_petty_cash_entries', 'read');
    await http.petty('owner-a', DAY_ID, { amountCents: 300, reason: 'milk' });
    expect((await http.refresh('owner-a', DAY_ID)).status).toBe(201);
    expect(dayRow(LONDON, '2026-09-15')!.petty_cash_out_cents).toBe(1000);

    db.rows('eod_petty_cash_entries').push({ id: 'a3000000-0000-4000-8000-000000000003', eod_id: DAY_ID, amount_cents: 50, reason: 'stamps', created_at: '2026-09-15T12:00:00.000Z' });
    const signed = await http.signOff('owner-a', DAY_ID);
    expect(signed.status).toBe(201);
    expect(dayRow(LONDON, '2026-09-15')).toMatchObject({ status: 'signed_off', petty_cash_out_cents: 1050 });
  });

  it('a failed petty cash read at sign-off or refresh changes nothing', async () => {
    const before = db.snapshot('eod_reconciliations');
    db.failNext('eod_petty_cash_entries', 'read');
    expect((await http.signOff('owner-a', DAY_ID)).status).toBe(500);
    db.failNext('eod_petty_cash_entries', 'read');
    expect((await http.refresh('owner-a', DAY_ID)).status).toBe(500);
    expect(db.snapshot('eod_reconciliations')).toEqual(before);
    expect(db.writes).toEqual([]);
  });

  it('reading a day or the history when petty cash can’t be read is an error, not an empty list', async () => {
    db.failNext('eod_petty_cash_entries', 'read');
    expect((await http.day('owner-a', { locationId: LONDON, businessDate: '2026-09-15' })).status).toBe(500);
    db.failNext('eod_petty_cash_entries', 'read');
    expect((await http.days('owner-a', LONDON)).status).toBe(500);
    expect((await http.day('owner-a', { locationId: LONDON, businessDate: '2026-09-15' })).body.day.pettyCash).toHaveLength(1);
  });
});
