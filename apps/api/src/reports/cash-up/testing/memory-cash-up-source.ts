/**
 * In-memory CashUpSource for tests. It applies the same predicates as
 * SupabaseCashUpSource — business, locations, business-date range, id keyset — so
 * a hand-built ledger can be reconciled against the report. The adapter's query
 * shapes are pinned separately in cash-up-source.spec.ts.
 *
 * `serverCap` imitates PostgREST's max-rows.
 */
import type { CashUpRecordRow, CashUpSource } from '../cash-up-source';

export interface LedgerCashUp extends CashUpRecordRow {
  businessId: string;
}

export interface CashUpLedger {
  records: LedgerCashUp[];
  users: Record<string, string>;
  thresholds: Array<{ businessId: string; locationId: string; cents: number }>;
}

export interface CashUpReadLog {
  method: keyof CashUpSource;
  businessId?: string;
  ids?: readonly string[];
  fromDate?: string;
  toDate?: string;
}

export class MemoryCashUpSource implements CashUpSource {
  readonly reads: CashUpReadLog[] = [];

  constructor(
    private readonly ledger: CashUpLedger,
    private readonly serverCap = Number.POSITIVE_INFINITY,
  ) {}

  async records(
    businessId: string,
    locationIds: readonly string[],
    fromDate: string,
    toDate: string,
    afterId: string | null,
    limit: number,
  ): Promise<CashUpRecordRow[]> {
    this.reads.push({ method: 'records', businessId, ids: locationIds, fromDate, toDate });
    return this.ledger.records
      .filter(
        (r) =>
          r.businessId === businessId &&
          locationIds.includes(r.locationId) &&
          r.businessDate >= fromDate &&
          r.businessDate <= toDate &&
          (afterId === null || r.id > afterId),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, Math.min(limit, this.serverCap))
      .map(({ businessId: _b, ...row }) => row);
  }

  async userNames(userProfileIds: readonly string[]): Promise<Map<string, string>> {
    this.reads.push({ method: 'userNames', ids: userProfileIds });
    return new Map(userProfileIds.filter((id) => id in this.ledger.users).map((id) => [id, this.ledger.users[id]]));
  }

  async thresholds(businessId: string, locationIds: readonly string[]): Promise<Map<string, number>> {
    this.reads.push({ method: 'thresholds', businessId, ids: locationIds });
    return new Map(
      this.ledger.thresholds.filter((t) => t.businessId === businessId && locationIds.includes(t.locationId)).map((t) => [t.locationId, t.cents]),
    );
  }
}
