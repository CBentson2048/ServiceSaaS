import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  DashboardLocationSummary,
  StylistKpiListResponse,
  StylistKpiResponse,
  StylistKpiResult,
} from '@sheer/domain';
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import {
  aggregateStylistKpi,
  resolveKpiWindow,
  computeNetWorkedHours,
  type ResolvedKpiWindow,
  type StylistKpiInputs,
  type TimeInterval,
} from './kpi.calc';
import type { KpiQueryDto } from './dto';

// --- Row shapes (snake_case, straight from Supabase) ------------------------

interface LocationRow {
  id: string;
  name: string;
  code: string | null;
  address_line_1: string | null;
  city: string | null;
}

interface StaffProfileRow {
  id: string;
  display_name: string | null;
  hourly_rate: number | string;
  contracted_hours: number | string;
  average_bill_benchmark: number | string;
  primary_location_id: string;
  user_profile_id: string;
  employment_status: string;
  termination_date: string | null;
  user_profiles?: { full_name: string | null }[] | { full_name: string | null } | null;
}

interface ShiftBreakRow {
  started_at: string;
  ended_at: string;
  is_paid: boolean;
}

interface ShiftRow {
  id: string;
  staff_profile_id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  shift_breaks?: ShiftBreakRow[] | ShiftBreakRow | null;
}

interface LeaveRow {
  staff_profile_id: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface AbsenceRow {
  staff_profile_id: string;
  starts_at: string;
  ends_at: string | null;
}

interface VisitLineItemRow {
  visit_id: string;
  line_type: string;
  amount_cents: number | string | null;
  currency_code?: string | null;
}

interface RebookingOutcomeRow {
  rebook_source: 'stylist' | 'client';
  rebooked_appointment_id: string;
}

interface VisitRow {
  id: string;
  primary_staff_profile_id: string | null;
  status: string;
  completed_at: string | null;
  visit_line_items?: VisitLineItemRow[] | VisitLineItemRow | null;
  rebooking_outcomes?: RebookingOutcomeRow[] | RebookingOutcomeRow | null;
}

interface RetailSaleAmountRow {
  staff_profile_id: string | null;
  total_amount_cents: number | string | null;
}

interface KpiScope {
  scope: 'owner' | 'manager';
  requestedLocationId?: string;
  locationIds: string[];
  locations: DashboardLocationSummary[];
}

const LOCATION_COLUMNS = 'id,name,code,address_line_1,city';
const STAFF_COLUMNS =
  'id,display_name,hourly_rate,contracted_hours,average_bill_benchmark,primary_location_id,user_profile_id,employment_status,termination_date,user_profiles(full_name)';
const SHIFT_COLUMNS = 'id,staff_profile_id,status,scheduled_start_at,scheduled_end_at,shift_breaks(started_at,ended_at,is_paid)';
// `visit_line_items` lives in the `billing` schema, not `booking`, so it cannot be
// embedded here — PostgREST only resolves embedded resources within the request's
// schema. It is fetched separately (see fetchVisitLineItems) and stitched by visit id.
// `rebooking_outcomes` is in `booking` alongside `visits`, so embedding it is fine.
const VISIT_COLUMNS =
  'id,primary_staff_profile_id,status,completed_at,rebooking_outcomes(rebook_source,rebooked_appointment_id)';
const VISIT_LINE_ITEM_COLUMNS = 'visit_id,line_type,amount_cents,currency_code';

// A visit that has reached service completion is a valid rebooking "source".
const COMPLETED_VISIT_STATUSES = new Set(['awaiting_payment', 'paid', 'completed']);
const MS_PER_DAY = 86_400_000;

@Injectable()
export class KpiService {
  private readonly logger = new Logger(KpiService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /** Owner / manager view: every in-scope stylist's KPI for the period. */
  async stylistList(actor: AuthUser, query: KpiQueryDto): Promise<StylistKpiListResponse> {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('KPI summaries are limited to owners and managers');
    }
    const window = this.resolveWindow(query);
    const scope = await this.resolveScope(actor, query.locationId);
    const staffRows = await this.fetchStaff(actor.businessId, scope.locationIds);
    const stylists = await this.computeForStaff(actor.businessId, scope, staffRows, window);

    return {
      periodStart: window.fromIso,
      periodEnd: window.toIso,
      period: window.period,
      scope: scope.scope,
      selectedLocationId: scope.requestedLocationId,
      locations: scope.locations,
      stylists,
      commissionReadyCount: stylists.filter((s) => s.allKpisMet).length,
    };
  }

  /** Stylist-facing view: the caller's own KPI for the period. */
  async myKpi(actor: AuthUser, query: KpiQueryDto): Promise<StylistKpiResponse> {
    if (!actor.staffProfileId) {
      throw new ForbiddenException('Only stylists with a staff profile have KPI results');
    }
    const window = this.resolveWindow(query);
    const staffRows = await this.fetchStaff(actor.businessId, undefined, actor.staffProfileId);
    const staff = staffRows[0];
    if (!staff) throw new BadRequestException('Staff profile not found for this business');

    const locations = await this.fetchLocations(actor.businessId, [staff.primary_location_id]);
    const scope: KpiScope = {
      scope: userHasRole(actor, 'owner') ? 'owner' : 'manager',
      locationIds: [staff.primary_location_id],
      locations,
    };
    const [stylist] = await this.computeForStaff(actor.businessId, scope, [staff], window);

    return {
      periodStart: window.fromIso,
      periodEnd: window.toIso,
      period: window.period,
      scope: 'stylist',
      selectedLocationId: staff.primary_location_id,
      stylist,
    };
  }

  // --- Core computation -----------------------------------------------------

  private async computeForStaff(
    businessId: string,
    scope: KpiScope,
    staffRows: StaffProfileRow[],
    window: ResolvedKpiWindow,
  ): Promise<StylistKpiResult[]> {
    if (staffRows.length === 0) return [];

    // Only consider stylists who were not terminated before the period started.
    const activeStaff = staffRows.filter(
      (s) => !s.termination_date || Date.parse(`${s.termination_date}T00:00:00.000Z`) >= window.fromMs,
    );
    if (activeStaff.length === 0) return [];

    const staffIds = activeStaff.map((s) => s.id);
    const locationIds = scope.locationIds;
    const locationNames = new Map(scope.locations.map((l) => [l.id, l.name]));

    const [shifts, leave, absences, visits, retail] = await Promise.all([
      this.fetchShifts(businessId, locationIds, staffIds, window),
      this.fetchApprovedLeave(businessId, locationIds, staffIds, window),
      this.fetchAbsences(businessId, locationIds, staffIds, window),
      this.fetchCompletedVisits(businessId, locationIds, staffIds, window),
      this.fetchRetailByStaff(businessId, locationIds, activeStaff, window),
    ]);

    const validRebookedAppointmentIds = await this.fetchValidRebookedAppointmentIds(businessId, visits);

    const shiftsByStaff = groupBy(shifts, (s) => s.staff_profile_id);
    const leaveByStaff = groupBy(leave, (l) => l.staff_profile_id);
    const absenceByStaff = groupBy(absences, (a) => a.staff_profile_id);
    const visitsByStaff = groupBy(
      visits.filter((v) => v.primary_staff_profile_id),
      (v) => v.primary_staff_profile_id as string,
    );

    return activeStaff.map((staff) => {
      const hoursWorked = computeNetWorkedHours({
        windowStartMs: window.fromMs,
        windowEndMs: window.toMs,
        shifts: (shiftsByStaff.get(staff.id) ?? []).map((s) => ({
          startMs: Date.parse(s.scheduled_start_at),
          endMs: Date.parse(s.scheduled_end_at),
          status: s.status,
        })),
        breaks: (shiftsByStaff.get(staff.id) ?? []).flatMap((s) =>
          arrayOf(s.shift_breaks).map((b) => ({
            startMs: Date.parse(b.started_at),
            endMs: Date.parse(b.ended_at),
            isPaid: Boolean(b.is_paid),
          })),
        ),
        unavailable: [
          ...(leaveByStaff.get(staff.id) ?? []).map((l) => leaveToInterval(l)),
          ...(absenceByStaff.get(staff.id) ?? []).map((a) => absenceToInterval(a, window.toMs)),
        ],
      });

      const staffVisits = visitsByStaff.get(staff.id) ?? [];
      const rebooking = summarizeRebooking(staffVisits, validRebookedAppointmentIds);
      const revenue = summarizeRevenue(staffVisits);
      const retailForStaff = retail.get(staff.id) ?? { cents: 0, hadMovements: false };

      const inputs: StylistKpiInputs = {
        staffProfileId: staff.id,
        stylistName: staffDisplayName(staff),
        locationId: staff.primary_location_id,
        locationName: locationNames.get(staff.primary_location_id) ?? 'Unknown location',
        currencyCode: revenue.currencyCode,
        hourlyRate: Number(staff.hourly_rate),
        averageBillBenchmark: Number(staff.average_bill_benchmark),
        hoursWorked,
        completedVisits: rebooking.completedVisits,
        rebookedVisits: rebooking.rebookedVisits,
        stylistRebookedVisits: rebooking.stylistRebookedVisits,
        clientRebookedVisits: rebooking.clientRebookedVisits,
        serviceRevenueCents: revenue.serviceCents,
        productUsageRevenueCents: revenue.productUsageCents,
        paidVisits: revenue.paidVisits,
        retailSalesCents: retailForStaff.cents,
        hadRetailMovements: retailForStaff.hadMovements,
      };

      return aggregateStylistKpi(inputs);
    });
  }

  // --- Window / scope -------------------------------------------------------

  private resolveWindow(query: KpiQueryDto): ResolvedKpiWindow {
    try {
      return resolveKpiWindow({ period: query.period, from: query.from, to: query.to }, Date.now());
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid KPI period');
    }
  }

  private async resolveScope(actor: AuthUser, requestedLocationId?: string): Promise<KpiScope> {
    if (userHasRole(actor, 'manager') && !userHasRole(actor, 'owner')) {
      if (requestedLocationId && !actor.allowedLocationIds.includes(requestedLocationId)) {
        throw new ForbiddenException('Location is outside your scope');
      }
      const locationIds = requestedLocationId ? [requestedLocationId] : actor.allowedLocationIds;
      return {
        scope: 'manager',
        requestedLocationId,
        locationIds,
        locations: await this.fetchLocations(actor.businessId, locationIds),
      };
    }

    if (requestedLocationId) {
      const locations = await this.fetchLocations(actor.businessId, [requestedLocationId]);
      if (locations.length === 0) throw new BadRequestException('locationId is not valid for this business');
      return { scope: 'owner', requestedLocationId, locationIds: [requestedLocationId], locations };
    }

    const locations = await this.fetchLocations(actor.businessId);
    return { scope: 'owner', locationIds: locations.map((l) => l.id), locations };
  }

  // --- Fetchers -------------------------------------------------------------

  private async fetchLocations(businessId: string, locationIds?: string[]): Promise<DashboardLocationSummary[]> {
    if (locationIds && locationIds.length === 0) return [];
    let query = this.admin
      .schema('core')
      .from('locations')
      .select(LOCATION_COLUMNS)
      .eq('business_id', businessId)
      .order('name', { ascending: true });
    if (locationIds) query = query.in('id', locationIds);
    const { data, error } = await query.returns<LocationRow[]>();
    if (error) this.fail('fetchLocations', error.message);
    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code ?? undefined,
      addressLine1: row.address_line_1 ?? undefined,
      city: row.city ?? undefined,
    }));
  }

  private async fetchStaff(
    businessId: string,
    locationIds?: string[],
    staffProfileId?: string,
  ): Promise<StaffProfileRow[]> {
    if (locationIds && locationIds.length === 0) return [];
    let query = this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('business_id', businessId)
      // KPI / commission readiness is for bookable stylists only. Managers converted
      // from a stylist keep a residual (is_bookable = false) staff_profile, so without
      // this filter they leak into the dashboard stylist list.
      .eq('is_bookable', true);
    if (staffProfileId) query = query.eq('id', staffProfileId);
    if (locationIds) query = query.in('primary_location_id', locationIds);
    const { data, error } = await query.returns<StaffProfileRow[]>();
    if (error) this.fail('fetchStaff', error.message);
    return data ?? [];
  }

  private async fetchShifts(
    businessId: string,
    locationIds: string[],
    staffIds: string[],
    window: ResolvedKpiWindow,
  ): Promise<ShiftRow[]> {
    if (locationIds.length === 0 || staffIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select(SHIFT_COLUMNS)
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .in('staff_profile_id', staffIds)
      .lt('scheduled_start_at', window.toIso)
      .gt('scheduled_end_at', window.fromIso)
      .returns<ShiftRow[]>();
    if (error) this.fail('fetchShifts', error.message);
    return data ?? [];
  }

  private async fetchApprovedLeave(
    businessId: string,
    locationIds: string[],
    staffIds: string[],
    window: ResolvedKpiWindow,
  ): Promise<LeaveRow[]> {
    if (locationIds.length === 0 || staffIds.length === 0) return [];
    const fromDate = isoDate(window.fromMs);
    const toDate = isoDate(window.toMs);
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select('staff_profile_id,start_date,end_date,status')
      .eq('business_id', businessId)
      .eq('status', 'approved')
      .in('location_id', locationIds)
      .in('staff_profile_id', staffIds)
      .lte('start_date', toDate)
      .gte('end_date', fromDate)
      .returns<LeaveRow[]>();
    if (error) this.fail('fetchApprovedLeave', error.message);
    return data ?? [];
  }

  private async fetchAbsences(
    businessId: string,
    locationIds: string[],
    staffIds: string[],
    window: ResolvedKpiWindow,
  ): Promise<AbsenceRow[]> {
    if (locationIds.length === 0 || staffIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .select('staff_profile_id,starts_at,ends_at')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .in('staff_profile_id', staffIds)
      .lt('starts_at', window.toIso)
      .or(`ends_at.is.null,ends_at.gt.${window.fromIso}`)
      .returns<AbsenceRow[]>();
    if (error) this.fail('fetchAbsences', error.message);
    return data ?? [];
  }

  private async fetchCompletedVisits(
    businessId: string,
    locationIds: string[],
    staffIds: string[],
    window: ResolvedKpiWindow,
  ): Promise<VisitRow[]> {
    if (locationIds.length === 0 || staffIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .in('primary_staff_profile_id', staffIds)
      .not('completed_at', 'is', null)
      .gte('completed_at', window.fromIso)
      .lt('completed_at', window.toIso)
      .returns<VisitRow[]>();
    if (error) this.fail('fetchCompletedVisits', error.message);
    const visits = (data ?? []).filter((v) => COMPLETED_VISIT_STATUSES.has(v.status));

    // Attach billing line items (separate schema → separate query, grouped by visit).
    const lineItemsByVisit = await this.fetchVisitLineItems(
      businessId,
      visits.map((v) => v.id),
    );
    for (const visit of visits) {
      visit.visit_line_items = lineItemsByVisit.get(visit.id) ?? [];
    }
    return visits;
  }

  /** Visit line items live in `billing`; fetch them by visit id and group for stitching. */
  private async fetchVisitLineItems(
    businessId: string,
    visitIds: string[],
  ): Promise<Map<string, VisitLineItemRow[]>> {
    if (visitIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .select(VISIT_LINE_ITEM_COLUMNS)
      .eq('business_id', businessId)
      .in('visit_id', visitIds)
      .returns<VisitLineItemRow[]>();
    if (error) this.fail('fetchVisitLineItems', error.message);
    return groupBy(data ?? [], (item) => item.visit_id);
  }

  /** Of the rebooked follow-up appointments, which are real and not cancelled. */
  private async fetchValidRebookedAppointmentIds(businessId: string, visits: VisitRow[]): Promise<Set<string>> {
    const ids = unique(
      visits.flatMap((v) => arrayOf(v.rebooking_outcomes)).map((o) => o.rebooked_appointment_id),
    );
    if (ids.length === 0) return new Set();
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,status')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<{ id: string; status: string }[]>();
    if (error) this.fail('fetchValidRebookedAppointmentIds', error.message);
    return new Set((data ?? []).filter((a) => a.status !== 'cancelled').map((a) => a.id));
  }

  /**
   * Retail sales per stylist, from the first-class `billing.retail_sales`
   * table (real stylist attribution, real sale price, period-safe by sold_at).
   * Desk sales with no stylist are excluded from per-stylist credit. Degrades
   * to zero (rather than failing the whole KPI) if the table is unavailable —
   * e.g. before the 0031 migration has run.
   */
  private async fetchRetailByStaff(
    businessId: string,
    locationIds: string[],
    staff: StaffProfileRow[],
    window: ResolvedKpiWindow,
  ): Promise<Map<string, { cents: number; hadMovements: boolean }>> {
    const result = new Map<string, { cents: number; hadMovements: boolean }>();
    if (locationIds.length === 0 || staff.length === 0) return result;
    const staffIds = staff.map((s) => s.id);

    const { data, error } = await this.admin
      .schema('billing')
      .from('retail_sales')
      .select('staff_profile_id,total_amount_cents')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .in('staff_profile_id', staffIds)
      .gte('sold_at', window.fromIso)
      .lt('sold_at', window.toIso)
      .returns<RetailSaleAmountRow[]>();
    if (error) {
      this.logger.warn(`fetchRetailSales degraded retail KPI to 0: ${error.message}`);
      return result;
    }

    for (const row of data ?? []) {
      if (!row.staff_profile_id) continue;
      const entry = result.get(row.staff_profile_id) ?? { cents: 0, hadMovements: false };
      entry.cents += Number(row.total_amount_cents ?? 0);
      result.set(row.staff_profile_id, entry);
    }
    return result;
  }

  private fail(operation: string, message: string): never {
    this.logger.error(`${operation} failed: ${message}`);
    throw new InternalServerErrorException('Unable to load KPI data');
  }
}

// --- Pure row → input helpers -----------------------------------------------

function leaveToInterval(row: LeaveRow): TimeInterval {
  // Leave is whole-day and inclusive of end_date → expand to [start, end+1day).
  const startMs = Date.parse(`${row.start_date}T00:00:00.000Z`);
  const endMs = Date.parse(`${row.end_date}T00:00:00.000Z`) + MS_PER_DAY;
  return { startMs, endMs };
}

function absenceToInterval(row: AbsenceRow, windowEndMs: number): TimeInterval {
  const startMs = Date.parse(row.starts_at);
  const endMs = row.ends_at ? Date.parse(row.ends_at) : windowEndMs; // open-ended → to window end
  return { startMs, endMs };
}

function summarizeRebooking(
  visits: VisitRow[],
  validRebookedAppointmentIds: Set<string>,
): { completedVisits: number; rebookedVisits: number; stylistRebookedVisits: number; clientRebookedVisits: number } {
  let completedVisits = 0;
  let rebookedVisits = 0;
  let stylistRebookedVisits = 0;
  let clientRebookedVisits = 0;

  for (const visit of visits) {
    completedVisits += 1;
    const outcomes = arrayOf(visit.rebooking_outcomes).filter((o) =>
      validRebookedAppointmentIds.has(o.rebooked_appointment_id),
    );
    if (outcomes.length === 0) continue;
    rebookedVisits += 1;
    // A source visit is counted once; classify by its (first) valid outcome.
    if (outcomes.some((o) => o.rebook_source === 'stylist')) stylistRebookedVisits += 1;
    else clientRebookedVisits += 1;
  }

  return { completedVisits, rebookedVisits, stylistRebookedVisits, clientRebookedVisits };
}

function summarizeRevenue(visits: VisitRow[]): {
  serviceCents: number;
  productUsageCents: number;
  paidVisits: number;
  currencyCode: string;
} {
  let serviceCents = 0;
  let productUsageCents = 0;
  let paidVisits = 0;
  let currencyCode = 'GBP';

  for (const visit of visits) {
    if (visit.status !== 'paid') continue; // only realised revenue
    paidVisits += 1;
    for (const item of arrayOf(visit.visit_line_items)) {
      if (item.currency_code) currencyCode = item.currency_code;
      const cents = Number(item.amount_cents ?? 0);
      if (item.line_type === 'service') serviceCents += cents;
      else if (item.line_type === 'product_usage') productUsageCents += cents;
      // 'formula_colour' (legacy, removed in 0029) and any other types are ignored.
    }
  }

  return { serviceCents, productUsageCents, paidVisits, currencyCode };
}

function staffDisplayName(row: StaffProfileRow): string {
  return row.display_name?.trim() || first(row.user_profiles)?.full_name?.trim() || 'Unknown stylist';
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function arrayOf<T>(value: T[] | T | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function first<T>(value: T[] | T | null | undefined): T | undefined {
  return arrayOf(value)[0];
}
