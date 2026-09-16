/**
 * Read access to the till cash-ups R7 Cash Up reports (QLOOQO V1.1 Week 8).
 *
 * Reads `billing.eod_reconciliations` as recorded — never the End of Day RPC or
 * service — plus the names of the people who signed days off and each location's
 * current variance threshold. Every record read filters `business_id` and the
 * requested locations; reads use an id keyset, never an offset. Till and retail
 * takings come from R1's MoneySource.
 * docs/V1.1/week-8-r7-cash-up.md §2.
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MoneySourceShapeError, currencyCodeOf, instantKey, integerCents, isUuid, poundsToCents } from '../money/money-values';

export type CashUpRecordStatus = 'open' | 'signed_off';

export interface CashUpRecordRow {
  id: string;
  locationId: string;
  /** The local trading date label chosen on End of Day. */
  businessDate: string;
  status: CashUpRecordStatus;
  openingFloatCents: number;
  expectedCashCents: number | null;
  countedCashCents: number | null;
  expectedCardCents: number | null;
  countedCardCents: number | null;
  pettyCashOutCents: number;
  refundsCents: number;
  voidsCents: number;
  varianceCents: number | null;
  notes: string | null;
  signedOffByUserProfileId: string | null;
  /** `signed_off_at` as an instant key. */
  signedOffAt: string | null;
  currencyCode: string;
}

export interface CashUpSource {
  /** Records of the given locations whose `business_date` is within [fromDate, toDate], ordered by id, after `afterId`. */
  records(
    businessId: string,
    locationIds: readonly string[],
    fromDate: string,
    toDate: string,
    afterId: string | null,
    limit: number,
  ): Promise<CashUpRecordRow[]>;
  /** Full names of the given user profiles (missing ids are absent). */
  userNames(userProfileIds: readonly string[]): Promise<Map<string, string>>;
  /** Each location's current variance threshold in pence (locations without a settings row are absent). */
  thresholds(businessId: string, locationIds: readonly string[]): Promise<Map<string, number>>;
}

export const CASH_UP_SOURCE = Symbol('CASH_UP_SOURCE');

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly CashUpRecordStatus[] = ['open', 'signed_off'];
const RECORD_COLUMNS =
  'id,location_id,business_date,status,opening_float_cents,expected_cash_cents,counted_cash_cents,expected_card_cents,counted_card_cents,petty_cash_out_cents,refunds_cents,voids_cents,variance_cents,notes,signed_off_by_user_profile_id,signed_off_at,currency_code';

type Row = Record<string, unknown>;

function assertUuids(ids: readonly string[]): void {
  if (ids.some((id) => !isUuid(id))) throw new Error('cash-up source received an invalid id');
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new MoneySourceShapeError(what);
  return value;
}

function nullableCents(value: unknown, what: string): number | null {
  return value === null ? null : integerCents(value, what);
}

function nullableText(value: unknown, what: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new MoneySourceShapeError(what);
  return value;
}

@Injectable()
export class SupabaseCashUpSource implements CashUpSource {
  private readonly logger = new Logger(SupabaseCashUpSource.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async records(
    businessId: string,
    locationIds: readonly string[],
    fromDate: string,
    toDate: string,
    afterId: string | null,
    limit: number,
  ): Promise<CashUpRecordRow[]> {
    assertUuids(locationIds);
    if (afterId !== null) assertUuids([afterId]);
    if (!LOCAL_DATE.test(fromDate) || !LOCAL_DATE.test(toDate)) throw new Error('cash-up source received an invalid date');
    if (locationIds.length === 0) return [];
    const rows = await this.run('eod_reconciliations', () => {
      let query = this.admin
        .schema('billing')
        .from('eod_reconciliations')
        .select(RECORD_COLUMNS)
        .eq('business_id', businessId)
        .in('location_id', [...locationIds])
        .gte('business_date', fromDate)
        .lte('business_date', toDate);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => {
      const businessDate = text(row.business_date, 'cash-up date');
      if (!LOCAL_DATE.test(businessDate)) throw new MoneySourceShapeError('cash-up date');
      const status = text(row.status, 'cash-up status');
      if (!(STATUSES as readonly string[]).includes(status)) throw new MoneySourceShapeError('cash-up status');
      const currencyCode = currencyCodeOf(row.currency_code);
      if (currencyCode === null) throw new MoneySourceShapeError('cash-up currency');
      return {
        id: text(row.id, 'cash-up id'),
        locationId: text(row.location_id, 'cash-up location'),
        businessDate,
        status: status as CashUpRecordStatus,
        openingFloatCents: integerCents(row.opening_float_cents, 'opening float'),
        expectedCashCents: nullableCents(row.expected_cash_cents, 'expected cash'),
        countedCashCents: nullableCents(row.counted_cash_cents, 'counted cash'),
        expectedCardCents: nullableCents(row.expected_card_cents, 'expected card'),
        countedCardCents: nullableCents(row.counted_card_cents, 'counted card'),
        pettyCashOutCents: integerCents(row.petty_cash_out_cents, 'petty cash out'),
        refundsCents: integerCents(row.refunds_cents, 'refunds entered'),
        voidsCents: integerCents(row.voids_cents, 'voids entered'),
        varianceCents: nullableCents(row.variance_cents, 'variance'),
        notes: nullableText(row.notes, 'cash-up notes'),
        signedOffByUserProfileId: nullableText(row.signed_off_by_user_profile_id, 'signed off by'),
        signedOffAt: row.signed_off_at === null ? null : instantKey(row.signed_off_at),
        currencyCode,
      };
    });
  }

  async userNames(userProfileIds: readonly string[]): Promise<Map<string, string>> {
    assertUuids(userProfileIds);
    const names = new Map<string, string>();
    if (userProfileIds.length === 0) return names;
    const rows = await this.run('user_profiles', () =>
      this.admin
        .schema('core')
        .from('user_profiles')
        .select('id,full_name')
        .in('id', [...userProfileIds])
        .limit(userProfileIds.length)
        .returns<Row[]>(),
    );
    for (const row of rows) names.set(text(row.id, 'user id'), text(row.full_name, 'user name'));
    return names;
  }

  async thresholds(businessId: string, locationIds: readonly string[]): Promise<Map<string, number>> {
    assertUuids(locationIds);
    const thresholds = new Map<string, number>();
    if (locationIds.length === 0) return thresholds;
    // One settings row per location (unique), so the chunk can never exceed its own size.
    const rows = await this.run('location_settings', () =>
      this.admin
        .schema('core')
        .from('location_settings')
        .select('location_id,cash_variance_threshold_amount')
        .eq('business_id', businessId)
        .in('location_id', [...locationIds])
        .limit(locationIds.length)
        .returns<Row[]>(),
    );
    for (const row of rows) {
      thresholds.set(text(row.location_id, 'threshold location'), poundsToCents(row.cash_variance_threshold_amount));
    }
    return thresholds;
  }

  /** A database or shape failure is a 500, never an empty (zero) report. */
  private async run(table: string, query: () => PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
    const { data, error } = await query();
    if (error) {
      this.logger.error(`cash-up source read of ${table} failed`, error instanceof Error ? error.stack : String(JSON.stringify(error)));
      throw new InternalServerErrorException();
    }
    if (!Array.isArray(data)) {
      this.logger.error(`cash-up source read of ${table} returned no rows array`);
      throw new InternalServerErrorException();
    }
    return data;
  }
}
