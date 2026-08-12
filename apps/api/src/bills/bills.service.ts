import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser, BillFinderItem, CrmClientsPagination, ListBillsResponse } from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import type { ListBillsQueryDto } from './dto';

// Finder projection over billing.bills (0085). Lines are not fetched here —
// the row links to the visit's bill page, which loads the full itemisation.
interface BillFinderRow {
  id: string;
  business_id: string;
  location_id: string;
  visit_id: string;
  client_profile_id: string | null;
  staff_profile_id: string | null;
  bill_number: number;
  status: 'paid' | 'voided';
  gross_cents: number;
  deposit_applied_cents: number;
  balance_collected_cents: number;
  currency_code: string;
  occurred_at: string;
}

const FINDER_COLUMNS =
  'id,business_id,location_id,visit_id,client_profile_id,staff_profile_id,bill_number,status,gross_cents,deposit_applied_cents,balance_collected_cents,currency_code,occurred_at';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * The bill finder: filter stored bills by client, date range, stylist,
   * amount and bill number, scoped to the actor's business and permitted
   * locations. All filters hit the denormalised billing.bills header (indexed
   * by 0085), so no cross-schema joins are needed for the search itself —
   * client/stylist display names are stitched in afterwards for the page shown.
   */
  async list(actor: AuthUser, query: ListBillsQueryDto): Promise<ListBillsResponse> {
    if (query.locationId) this.assertLocationScope(actor, query.locationId);
    const locationIds = this.resolveReadableLocationIds(actor, query.locationId);

    const pageSize = clampInt(query.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    if (locationIds && locationIds.length === 0) {
      return { bills: [], pagination: buildPagination(0, page, pageSize) };
    }

    const from = (page - 1) * pageSize;
    let request = this.admin
      .schema('billing')
      .from('bills')
      .select(FINDER_COLUMNS, { count: 'exact' })
      .eq('business_id', actor.businessId)
      // Stable total order (occurred_at can tie on backfilled batches).
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + pageSize - 1);

    if (locationIds) request = request.in('location_id', locationIds);
    if (query.clientProfileId) request = request.eq('client_profile_id', query.clientProfileId);
    if (query.staffProfileId) request = request.eq('staff_profile_id', query.staffProfileId);
    if (query.billNumber !== undefined) request = request.eq('bill_number', query.billNumber);
    // Dates are inclusive whole days: [dateFrom 00:00Z, dateTo+1day 00:00Z).
    if (query.dateFrom) request = request.gte('occurred_at', `${query.dateFrom}T00:00:00.000Z`);
    if (query.dateTo) request = request.lt('occurred_at', nextDayIso(query.dateTo));
    if (query.amountMinCents !== undefined) request = request.gte('gross_cents', query.amountMinCents);
    if (query.amountMaxCents !== undefined) request = request.lte('gross_cents', query.amountMaxCents);

    const { data, error, count } = await request.returns<BillFinderRow[]>();
    if (error) {
      this.logger.error(`bills list failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to search bills');
    }
    const rows = data ?? [];

    const [clientNames, staffNames] = await Promise.all([
      this.fetchClientNames(
        actor.businessId,
        rows.map((row) => row.client_profile_id).filter((id): id is string => Boolean(id)),
      ),
      this.fetchStaffNames(
        actor.businessId,
        rows.map((row) => row.staff_profile_id).filter((id): id is string => Boolean(id)),
      ),
    ]);

    return {
      bills: rows.map((row) => toFinderItem(row, clientNames, staffNames)),
      pagination: buildPagination(count ?? rows.length, page, pageSize),
    };
  }

  private async fetchClientNames(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (clientIds.length === 0) return names;
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,first_name,last_name')
      .eq('business_id', businessId)
      .in('id', [...new Set(clientIds)])
      .returns<Array<{ id: string; first_name: string; last_name: string }>>();
    if (error) {
      // Display-name enrichment only — the finder still works without names.
      this.logger.error(`bill finder client names failed: ${error.message}`);
      return names;
    }
    for (const row of data ?? []) {
      names.set(row.id, `${row.first_name} ${row.last_name}`.trim());
    }
    return names;
  }

  private async fetchStaffNames(
    businessId: string,
    staffIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (staffIds.length === 0) return names;
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .in('id', [...new Set(staffIds)])
      .returns<Array<{ id: string; display_name: string }>>();
    if (error) {
      this.logger.error(`bill finder staff names failed: ${error.message}`);
      return names;
    }
    for (const row of data ?? []) names.set(row.id, row.display_name);
    return names;
  }

  private resolveReadableLocationIds(actor: AuthUser, requested?: string): string[] | undefined {
    if (userHasRole(actor, 'owner')) return requested ? [requested] : undefined;
    return requested ? [requested] : actor.allowedLocationIds;
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }
  }
}

function toFinderItem(
  row: BillFinderRow,
  clientNames: Map<string, string>,
  staffNames: Map<string, string>,
): BillFinderItem {
  return {
    id: row.id,
    billNumber: Number(row.bill_number),
    visitId: row.visit_id,
    locationId: row.location_id,
    clientProfileId: row.client_profile_id ?? undefined,
    clientName: row.client_profile_id ? clientNames.get(row.client_profile_id) : undefined,
    staffProfileId: row.staff_profile_id ?? undefined,
    staffName: row.staff_profile_id ? staffNames.get(row.staff_profile_id) : undefined,
    status: row.status,
    grossCents: row.gross_cents,
    depositAppliedCents: row.deposit_applied_cents,
    balanceCollectedCents: row.balance_collected_cents,
    currencyCode: row.currency_code,
    occurredAt: row.occurred_at,
  };
}

function nextDayIso(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function buildPagination(total: number, page: number, pageSize: number): CrmClientsPagination {
  const safeTotal = Math.max(0, total);
  return {
    total: safeTotal,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(safeTotal / pageSize)),
  };
}
