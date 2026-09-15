/**
 * Read access to the facts R1 Money reports (V1.1 Week 8, Ticket B).
 *
 * Every windowed read filters `business_id` and binds EACH location to its own
 * Ticket A window — `(location_id = L AND at >= from AND at < to)` for every
 * location, OR-ed — so there is no envelope. Results are ordered by
 * (instant, id) and read with a keyset, never an offset.
 * docs/V1.1/week-8-ticket-b-r1-money.md §2.
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MoneyRetailMethodKey } from '@sheer/domain';
import {
  MoneySourceShapeError,
  currencyCodeOf,
  instantKey,
  integerCents,
  integerValue,
  isInstantKey,
  isUuid,
  isWindowBound,
  poundsToCents,
} from './money-values';

/** One location's report window. */
export interface MoneyWindow {
  locationId: string;
  /** Inclusive. */
  fromUtc: string;
  /** Exclusive. */
  toUtcExclusive: string;
}

/**
 * Where a keyset page starts. `{ key, id }` continues after the row (key, id);
 * `{ key, op }` starts strictly after (`gt`) or at (`gte`) an instant, whatever
 * the id — used when a page of one row kind follows a row of another kind.
 */
export type MoneyAfter = { key: string; id: string } | { key: string; op: 'gt' | 'gte' };

export type BillLineType = 'service' | 'product_usage' | 'adjustment' | 'retail' | 'deposit_credit' | 'discount';
export type TillMethod = 'cash' | 'card_reader';
/** `booking.deposit_status_enum`. */
export type DepositEventStatus =
  | 'pending'
  | 'requires_action'
  | 'authorized'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'failed'
  | 'cancelled';

export interface PaidBillRow {
  id: string;
  visitId: string;
  locationId: string;
  /** `occurred_at` as an instant key. */
  at: string;
  billNumber: number;
  grossCents: number;
  netCents: number;
  taxCents: number;
  depositAppliedCents: number;
  currencyCode: string;
}

export interface BillLineRow {
  id: string;
  billId: string;
  lineType: BillLineType;
  grossCents: number;
  netCents: number;
  taxCents: number;
}

export interface TillPaymentRow {
  id: string;
  visitId: string;
  method: TillMethod;
  amountCents: number;
  currencyCode: string;
}

export interface WindowTillPaymentRow extends TillPaymentRow {
  locationId: string;
  /** `paid_at` as an instant key. */
  at: string;
}

export interface RetailSaleRow {
  id: string;
  locationId: string;
  /** `sold_at` as an instant key. */
  at: string;
  totalCents: number;
  quantity: number;
  method: MoneyRetailMethodKey;
  currencyCode: string;
}

export interface DepositEventRow {
  id: string;
  locationId: string;
  /** `paid_at` (collections) or `refunded_at` (refunds) as an instant key. */
  at: string;
  amountCents: number;
  status: DepositEventStatus;
  currencyCode: string;
}

export interface MoneySource {
  paidBills(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<PaidBillRow[]>;
  /** Lines of the given bills, ordered by id, after `afterId`. */
  billLines(billIds: readonly string[], afterId: string | null, limit: number): Promise<BillLineRow[]>;
  /** Till payments of the given visits, ordered by id, after `afterId`. */
  tillPaymentsForVisits(businessId: string, visitIds: readonly string[], afterId: string | null, limit: number): Promise<TillPaymentRow[]>;
  tillPaymentsInWindows(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<WindowTillPaymentRow[]>;
  /** Of the given visits, those that have a paid bill (any date). */
  visitsWithPaidBill(businessId: string, visitIds: readonly string[]): Promise<Set<string>>;
  retailSales(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<RetailSaleRow[]>;
  /** Deposits whose payment was recorded in the window (status paid, partially_refunded or refunded). */
  depositsCollected(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<DepositEventRow[]>;
  /**
   * Deposits whose `refunded_at` falls in the window, whatever their status now:
   * only an in-app full refund sets `refunded_at`, and a re-delivered Stripe
   * webhook can later put the status back to `paid` without clearing it.
   */
  depositsRefunded(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<DepositEventRow[]>;
  /**
   * Each location's own currency: `core.location_settings.currency_code`, or — for
   * a location with no settings row — `core.businesses.default_currency_code`,
   * which is what a location's settings are seeded from (the same precedence the
   * booking flow uses to charge deposits). A location missing from the map has no
   * determinable currency; there is never a default.
   */
  locationCurrencies(businessId: string, locationIds: readonly string[]): Promise<Map<string, string>>;
}

export const MONEY_SOURCE = Symbol('MONEY_SOURCE');

const BILL_LINE_TYPES: readonly BillLineType[] = ['service', 'product_usage', 'adjustment', 'retail', 'deposit_credit', 'discount'];
const TILL_METHODS: readonly TillMethod[] = ['cash', 'card_reader'];
const RETAIL_METHODS = ['cash', 'card_reader', 'other'] as const;
const DEPOSIT_EVENT_STATUSES: readonly DepositEventStatus[] = [
  'pending',
  'requires_action',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
];

/**
 * The PostgREST `or` filter binding each location to its own window, plus the
 * keyset start. Values are validated before they are interpolated, and instants
 * are quoted because they contain PostgREST's reserved `.` and `:`.
 */
export function windowFilter(column: string, windows: readonly MoneyWindow[], after: MoneyAfter | null): string {
  if (windows.length === 0) throw new Error('windowFilter needs at least one window');
  const keyset = after === null ? null : keysetCondition(column, after);
  return windows
    .map((window) => {
      if (!isUuid(window.locationId) || !isWindowBound(window.fromUtc) || !isWindowBound(window.toUtcExclusive)) {
        throw new Error('windowFilter received an invalid window');
      }
      const parts = [
        `location_id.eq.${window.locationId}`,
        `${column}.gte."${window.fromUtc}"`,
        `${column}.lt."${window.toUtcExclusive}"`,
      ];
      if (keyset) parts.push(keyset);
      return `and(${parts.join(',')})`;
    })
    .join(',');
}

function keysetCondition(column: string, after: MoneyAfter): string {
  if (!isInstantKey(after.key)) throw new Error('keyset received an invalid instant');
  if ('id' in after) {
    if (!isUuid(after.id)) throw new Error('keyset received an invalid id');
    return `or(${column}.gt."${after.key}",and(${column}.eq."${after.key}",id.gt.${after.id}))`;
  }
  return `${column}.${after.op}."${after.key}"`;
}

function assertUuids(ids: readonly string[]): void {
  if (ids.some((id) => !isUuid(id))) throw new Error('money source received an invalid id');
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new MoneySourceShapeError(what);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new MoneySourceShapeError(what);
  return value as T;
}

type Row = Record<string, unknown>;

@Injectable()
export class SupabaseMoneySource implements MoneySource {
  private readonly logger = new Logger(SupabaseMoneySource.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async paidBills(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<PaidBillRow[]> {
    const rows = await this.run('bills', () =>
      this.admin
        .schema('billing')
        .from('bills')
        .select('id,visit_id,location_id,occurred_at,bill_number,gross_cents,net_cents,tax_cents,deposit_applied_cents,currency_code')
        .eq('business_id', businessId)
        .eq('status', 'paid')
        .or(windowFilter('occurred_at', windows, after))
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
        .returns<Row[]>(),
    );
    return rows.map((row) => ({
      id: text(row.id, 'bill id'),
      visitId: text(row.visit_id, 'bill visit'),
      locationId: text(row.location_id, 'bill location'),
      at: instantKey(row.occurred_at),
      billNumber: integerValue(row.bill_number, 'bill number'),
      grossCents: integerCents(row.gross_cents, 'bill gross'),
      netCents: integerCents(row.net_cents, 'bill net'),
      taxCents: integerCents(row.tax_cents, 'bill tax'),
      depositAppliedCents: integerCents(row.deposit_applied_cents, 'bill deposit applied'),
      currencyCode: text(row.currency_code, 'bill currency'),
    }));
  }

  async billLines(billIds: readonly string[], afterId: string | null, limit: number): Promise<BillLineRow[]> {
    assertUuids(billIds);
    if (billIds.length === 0) return [];
    const rows = await this.run('bill_lines', () => {
      let query = this.admin
        .schema('billing')
        .from('bill_lines')
        .select('id,bill_id,line_type,gross_cents,net_cents,tax_cents')
        .in('bill_id', [...billIds]);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'line id'),
      billId: text(row.bill_id, 'line bill'),
      lineType: oneOf(row.line_type, BILL_LINE_TYPES, 'line type'),
      grossCents: integerCents(row.gross_cents, 'line gross'),
      netCents: integerCents(row.net_cents, 'line net'),
      taxCents: integerCents(row.tax_cents, 'line tax'),
    }));
  }

  async tillPaymentsForVisits(businessId: string, visitIds: readonly string[], afterId: string | null, limit: number): Promise<TillPaymentRow[]> {
    assertUuids(visitIds);
    if (visitIds.length === 0) return [];
    const rows = await this.run('salon_payments', () => {
      let query = this.admin
        .schema('billing')
        .from('salon_payments')
        .select('id,visit_id,payment_method,amount_cents,currency_code')
        .eq('business_id', businessId)
        .in('visit_id', [...visitIds]);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => this.tillPayment(row));
  }

  async tillPaymentsInWindows(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<WindowTillPaymentRow[]> {
    const rows = await this.run('salon_payments', () =>
      this.admin
        .schema('billing')
        .from('salon_payments')
        .select('id,visit_id,location_id,paid_at,payment_method,amount_cents,currency_code')
        .eq('business_id', businessId)
        .or(windowFilter('paid_at', windows, after))
        .order('paid_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
        .returns<Row[]>(),
    );
    return rows.map((row) => ({
      ...this.tillPayment(row),
      locationId: text(row.location_id, 'payment location'),
      at: instantKey(row.paid_at),
    }));
  }

  async visitsWithPaidBill(businessId: string, visitIds: readonly string[]): Promise<Set<string>> {
    assertUuids(visitIds);
    if (visitIds.length === 0) return new Set();
    // One bill per visit (unique), so a chunk of ids can never exceed its own size.
    const rows = await this.run('bills', () =>
      this.admin
        .schema('billing')
        .from('bills')
        .select('visit_id')
        .eq('business_id', businessId)
        .eq('status', 'paid')
        .in('visit_id', [...visitIds])
        .limit(visitIds.length)
        .returns<Row[]>(),
    );
    return new Set(rows.map((row) => text(row.visit_id, 'bill visit')));
  }

  async retailSales(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<RetailSaleRow[]> {
    const rows = await this.run('retail_sales', () =>
      this.admin
        .schema('billing')
        .from('retail_sales')
        .select('id,location_id,sold_at,total_amount_cents,quantity,payment_method,currency_code')
        .eq('business_id', businessId)
        .or(windowFilter('sold_at', windows, after))
        .order('sold_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
        .returns<Row[]>(),
    );
    return rows.map((row) => ({
      id: text(row.id, 'retail id'),
      locationId: text(row.location_id, 'retail location'),
      at: instantKey(row.sold_at),
      totalCents: integerCents(row.total_amount_cents, 'retail total'),
      quantity: integerValue(row.quantity, 'retail quantity'),
      method: row.payment_method === null ? 'not_recorded' : oneOf(row.payment_method, RETAIL_METHODS, 'retail method'),
      currencyCode: text(row.currency_code, 'retail currency'),
    }));
  }

  depositsCollected(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<DepositEventRow[]> {
    return this.depositEvents('paid_at', ['paid', 'partially_refunded', 'refunded'], businessId, windows, after, limit);
  }

  depositsRefunded(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<DepositEventRow[]> {
    return this.depositEvents('refunded_at', null, businessId, windows, after, limit);
  }

  private async depositEvents(
    column: 'paid_at' | 'refunded_at',
    statuses: DepositEventStatus[] | null,
    businessId: string,
    windows: readonly MoneyWindow[],
    after: MoneyAfter | null,
    limit: number,
  ): Promise<DepositEventRow[]> {
    const rows = await this.run('deposits', () => {
      let query = this.admin
        .schema('booking')
        .from('deposits')
        .select(`id,location_id,${column},amount,status,currency_code`)
        .eq('business_id', businessId);
      if (statuses !== null) query = query.in('status', statuses);
      return query
        .or(windowFilter(column, windows, after))
        .order(column, { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
        .returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'deposit id'),
      locationId: text(row.location_id, 'deposit location'),
      at: instantKey(row[column]),
      amountCents: poundsToCents(row.amount),
      status: oneOf(row.status, DEPOSIT_EVENT_STATUSES, 'deposit status'),
      currencyCode: text(row.currency_code, 'deposit currency'),
    }));
  }

  async locationCurrencies(businessId: string, locationIds: readonly string[]): Promise<Map<string, string>> {
    assertUuids(locationIds);
    const currencies = new Map<string, string>();
    if (locationIds.length === 0) return currencies;
    // One settings row per location (unique), so the chunk can never exceed its own size.
    const settings = await this.run('location_settings', () =>
      this.admin
        .schema('core')
        .from('location_settings')
        .select('location_id,currency_code')
        .eq('business_id', businessId)
        .in('location_id', [...locationIds])
        .limit(locationIds.length)
        .returns<Row[]>(),
    );
    const withSettings = new Set<string>();
    for (const row of settings) {
      const locationId = text(row.location_id, 'settings location');
      withSettings.add(locationId);
      // A settings row whose code is unusable is not replaced by a guess.
      const code = currencyCodeOf(row.currency_code);
      if (code !== null) currencies.set(locationId, code);
    }
    const withoutSettings = locationIds.filter((id) => !withSettings.has(id));
    if (withoutSettings.length === 0) return currencies;
    const business = await this.run('businesses', () =>
      this.admin.schema('core').from('businesses').select('default_currency_code').eq('id', businessId).limit(1).returns<Row[]>(),
    );
    const businessCode = business.length === 1 ? currencyCodeOf(business[0].default_currency_code) : null;
    if (businessCode !== null) for (const id of withoutSettings) currencies.set(id, businessCode);
    return currencies;
  }

  private tillPayment(row: Row): TillPaymentRow {
    return {
      id: text(row.id, 'payment id'),
      visitId: text(row.visit_id, 'payment visit'),
      method: oneOf(row.payment_method, TILL_METHODS, 'payment method'),
      amountCents: integerCents(row.amount_cents, 'payment amount'),
      currencyCode: text(row.currency_code, 'payment currency'),
    };
  }

  /** A database or shape failure is a 500, never an empty (zero) report. */
  private async run(table: string, query: () => PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
    const { data, error } = await query();
    if (error) {
      this.logger.error(`money source read of ${table} failed`, error instanceof Error ? error.stack : String(JSON.stringify(error)));
      throw new InternalServerErrorException();
    }
    if (!Array.isArray(data)) {
      this.logger.error(`money source read of ${table} returned no rows array`);
      throw new InternalServerErrorException();
    }
    return data;
  }
}
