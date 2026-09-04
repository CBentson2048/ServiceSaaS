import { ForbiddenException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  SheerLabAnalyticsRange,
  SheerLabAnalyticsResponse,
  SheerLabLocationMetric,
  SheerLabLowStockAlert,
  SheerLabProductUsageMetric,
  SheerLabServiceTypeMetric,
  SheerLabStylistMetric,
} from '@sheer/domain';
import { userHasAnyRole, userHasRole } from '@sheer/domain';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';

interface FormulaAnalyticsRow {
  id: string;
  business_id: string;
  location_id: string;
  appointment_id: string | null;
  visit_id: string | null;
  actual_cost_cents: number;
  waste_cost_cents: number;
  billable_charge_cents: number;
  currency_code: string;
  saved_at: string;
  metadata: Record<string, unknown> | null;
}

interface FormulaItemAnalyticsRow {
  formula_id: string;
  product_id: string | null;
  product_name: string;
  brand: string | null;
  captured_grams: number | string;
  cost_cents: number;
}

interface LocationRow {
  id: string;
  name: string;
}

interface VisitRow {
  id: string;
  primary_staff_profile_id: string | null;
  service_summary: string | null;
  appointments?: AppointmentRelation | AppointmentRelation[] | null;
}

interface AppointmentRelation {
  assigned_staff_profile_id: string | null;
  appointment_services?: AppointmentServiceRelation[] | AppointmentServiceRelation | null;
}

interface AppointmentServiceRelation {
  service_name_snapshot: string | null;
  /** 0110: 'cancelled' = removed after check-in. */
  status?: string | null;
}

interface StaffProfileRow {
  id: string;
  display_name: string | null;
  hourly_rate: number | string;
  contracted_hours: number | string;
  average_bill_benchmark: number | string;
  user_profiles?: { full_name: string | null }[] | { full_name: string | null } | null;
}

interface LowStockAlertRow {
  id: string;
  location_id: string;
  product_id: string;
  remaining_quantity_grams: number | string;
  threshold_quantity_grams: number | string;
  status: 'open' | 'acknowledged' | 'resolved';
  last_triggered_at: string;
}

interface ProductRelation {
  id: string;
  name: string;
  brand: string | null;
}

const FORMULA_COLUMNS =
  'id,business_id,location_id,appointment_id,visit_id,actual_cost_cents,waste_cost_cents,billable_charge_cents,currency_code,saved_at,metadata';
const FORMULA_ITEM_COLUMNS = 'formula_id,product_id,product_name,brand,captured_grams,cost_cents';
const VISIT_COLUMNS =
  'id,primary_staff_profile_id,service_summary,appointments(assigned_staff_profile_id,appointment_services(service_name_snapshot,status))';
const STAFF_COLUMNS = 'id,display_name,hourly_rate,contracted_hours,average_bill_benchmark,user_profiles(full_name)';
const LOW_STOCK_COLUMNS =
  'id,location_id,product_id,remaining_quantity_grams,threshold_quantity_grams,status,last_triggered_at';
const PRODUCT_COLUMNS = 'id,name,brand';

@Injectable()
export class LabAnalyticsService {
  private readonly logger = new Logger(LabAnalyticsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async summary(
    actor: AuthUser,
    range: SheerLabAnalyticsRange,
    requestedLocationId?: string,
    from?: string,
    to?: string,
  ): Promise<SheerLabAnalyticsResponse> {
    const customWindow = resolveCustomWindow(from, to);
    const normalizedRange: SheerLabAnalyticsRange = customWindow ? 'custom' : normalizeRange(range);
    const { rangeStart, rangeEnd } = customWindow ?? rangeWindow(normalizedRange);
    const locationIds = this.resolveLocationScope(actor, requestedLocationId);
    const scope: 'owner' | 'manager' = userHasRole(actor, 'owner') ? 'owner' : 'manager';

    return this.buildAnalyticsResponse(actor.businessId, locationIds, scope, normalizedRange, rangeStart, rangeEnd);
  }

  // Lab-session-scoped variant: the active station's location is fixed by the
  // session, so there is no caller-supplied location scope. Gated to owner /
  // manager sessions to mirror the JWT analytics permission.
  async summaryForLabSession(
    session: LabRuntimeSession,
    range: SheerLabAnalyticsRange,
    from?: string,
    to?: string,
  ): Promise<SheerLabAnalyticsResponse> {
    if (!session.permissions.includes('report.lab_analytics.view')) {
      throw new ForbiddenException('You do not have permission to view Qlooqo Lab analytics');
    }
    const customWindow = resolveCustomWindow(from, to);
    const normalizedRange: SheerLabAnalyticsRange = customWindow ? 'custom' : normalizeRange(range);
    const { rangeStart, rangeEnd } = customWindow ?? rangeWindow(normalizedRange);
    const scope: 'owner' | 'manager' = session.role === 'owner' ? 'owner' : 'manager';

    return this.buildAnalyticsResponse(
      session.businessId,
      [session.locationId],
      scope,
      normalizedRange,
      rangeStart,
      rangeEnd,
    );
  }

  private async buildAnalyticsResponse(
    businessId: string,
    locationIds: string[],
    scope: 'owner' | 'manager',
    normalizedRange: SheerLabAnalyticsRange,
    rangeStart: string,
    rangeEnd: string,
  ): Promise<SheerLabAnalyticsResponse> {
    const [locations, formulas, lowStockAlerts] = await Promise.all([
      this.fetchLocations(businessId, locationIds),
      this.fetchFormulas(businessId, locationIds, rangeStart, rangeEnd),
      this.fetchLowStockAlerts(businessId, locationIds),
    ]);
    const locationNames = new Map(locations.map((location) => [location.id, location.name]));
    const formulaIds = formulas.map((formula) => formula.id);
    const [items, visits] = await Promise.all([
      this.fetchFormulaItems(formulaIds),
      this.fetchVisits(formulas.map((formula) => formula.visit_id).filter(isString)),
    ]);
    const staffProfiles = await this.fetchStaffProfiles(
      Array.from(new Set(Array.from(visits.values()).map(resolveStaffProfileId).filter(isString))),
    );

    const byLocation = buildLocationMetrics(formulas, locationNames);
    const byStylist = buildStylistMetrics(formulas, visits, staffProfiles, locationNames);
    const serviceTypes = buildServiceTypeMetrics(formulas, visits);
    const productMetrics = buildProductUsageMetrics(items, formulas);
    const summary = buildSummary(formulas, byLocation);

    const productsById = await this.fetchProducts(lowStockAlerts.map((alert) => alert.product_id));

    return {
      range: normalizedRange,
      rangeStart,
      rangeEnd,
      scope,
      summary,
      byLocation,
      byStylist,
      averageFormulaCostByServiceType: serviceTypes,
      mostUsedProductsByWeight: [...productMetrics].sort((a, b) => b.totalWeightGrams - a.totalWeightGrams).slice(0, 8),
      mostUsedProductsByCost: [...productMetrics].sort((a, b) => b.totalCostCents - a.totalCostCents).slice(0, 8),
      lowStockAlerts: lowStockAlerts.map((alert) => toLowStockAlert(alert, locationNames, productsById)),
    };
  }

  private resolveLocationScope(actor: AuthUser, requestedLocationId?: string): string[] {
    // Gate by the roles the caller HAS, not the roles they lack: a single user
    // can be owner AND stylist at once (an owner who also works a chair), so an
    // exclusion check on ['stylist','client'] wrongly 403s a legitimate owner.
    // Mirror the dashboard's inclusion check instead.
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Qlooqo Lab analytics are limited to owners and managers');
    }

    if (!userHasRole(actor, 'owner') && requestedLocationId && !actor.allowedLocationIds.includes(requestedLocationId)) {
      throw new ForbiddenException('Location is outside your dashboard scope');
    }

    if (userHasRole(actor, 'manager')) {
      return requestedLocationId ? [requestedLocationId] : actor.allowedLocationIds;
    }

    return requestedLocationId ? [requestedLocationId] : actor.allowedLocationIds;
  }

  private async fetchLocations(businessId: string, locationIds: string[]): Promise<LocationRow[]> {
    let query = this.admin.schema('core').from('locations').select('id,name').eq('business_id', businessId);
    if (locationIds.length > 0) query = query.in('id', locationIds);

    const { data, error } = await query.returns<LocationRow[]>();
    if (error) this.throwQueryError('fetchLocations', error.message);

    return data ?? [];
  }

  private async fetchFormulas(
    businessId: string,
    locationIds: string[],
    rangeStart: string,
    rangeEnd: string,
  ): Promise<FormulaAnalyticsRow[]> {
    let query = this.admin
      .schema('lab')
      .from('formulas')
      .select(FORMULA_COLUMNS)
      .eq('business_id', businessId)
      .eq('status', 'saved')
      .gte('saved_at', rangeStart)
      .lt('saved_at', rangeEnd);
    if (locationIds.length > 0) query = query.in('location_id', locationIds);

    const { data, error } = await query.returns<FormulaAnalyticsRow[]>();
    if (error) this.throwQueryError('fetchFormulas', error.message);

    return data ?? [];
  }

  private async fetchFormulaItems(formulaIds: string[]): Promise<FormulaItemAnalyticsRow[]> {
    if (formulaIds.length === 0) return [];

    const { data, error } = await this.admin
      .schema('lab')
      .from('formula_items')
      .select(FORMULA_ITEM_COLUMNS)
      .in('formula_id', formulaIds)
      .returns<FormulaItemAnalyticsRow[]>();
    if (error) this.throwQueryError('fetchFormulaItems', error.message);

    return data ?? [];
  }

  private async fetchVisits(visitIds: string[]): Promise<Map<string, VisitRow>> {
    if (visitIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(VISIT_COLUMNS)
      .in('id', visitIds)
      .returns<VisitRow[]>();
    if (error) this.throwQueryError('fetchVisits', error.message);

    return new Map((data ?? []).map((visit) => [visit.id, visit]));
  }

  private async fetchStaffProfiles(staffProfileIds: string[]): Promise<Map<string, StaffProfileRow>> {
    if (staffProfileIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .in('id', staffProfileIds)
      .returns<StaffProfileRow[]>();
    if (error) this.throwQueryError('fetchStaffProfiles', error.message);

    return new Map((data ?? []).map((staff) => [staff.id, staff]));
  }

  private async fetchLowStockAlerts(businessId: string, locationIds: string[]): Promise<LowStockAlertRow[]> {
    let query = this.admin
      .schema('inventory')
      .from('low_stock_alerts')
      .select(LOW_STOCK_COLUMNS)
      .eq('business_id', businessId)
      .eq('status', 'open')
      .order('last_triggered_at', { ascending: false });
    if (locationIds.length > 0) query = query.in('location_id', locationIds);

    const { data, error } = await query.returns<LowStockAlertRow[]>();
    if (error) this.throwQueryError('fetchLowStockAlerts', error.message);

    return data ?? [];
  }

  private async fetchProducts(productIds: string[]): Promise<Map<string, ProductRelation>> {
    const uniqueProductIds = Array.from(new Set(productIds));
    if (uniqueProductIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select(PRODUCT_COLUMNS)
      .in('id', uniqueProductIds)
      .returns<ProductRelation[]>();
    if (error) this.throwQueryError('fetchProducts', error.message);

    return new Map((data ?? []).map((product) => [product.id, product]));
  }

  private throwQueryError(operation: string, message: string): never {
    this.logger.error(`${operation} failed: ${message}`);
    throw new InternalServerErrorException('Unable to load Qlooqo Lab analytics');
  }
}

function normalizeRange(range: SheerLabAnalyticsRange | undefined): SheerLabAnalyticsRange {
  return range === 'week' || range === 'month' ? range : 'today';
}

/** Validate an explicit from/to pair into an ISO window, or null when unusable. */
function resolveCustomWindow(
  from: string | undefined,
  to: string | undefined,
): { rangeStart: string; rangeEnd: string } | null {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

function rangeWindow(range: SheerLabAnalyticsRange): { rangeStart: string; rangeEnd: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (range === 'week') {
    const day = start.getDay();
    const daysSinceMonday = (day + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  }

  if (range === 'month') {
    start.setDate(1);
  }

  const end = new Date(start);
  end.setDate(end.getDate() + (range === 'today' ? 1 : range === 'week' ? 7 : daysInMonth(start)));

  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function buildSummary(formulas: FormulaAnalyticsRow[], byLocation: SheerLabLocationMetric[]) {
  const colourRevenueCents = sum(formulas, (formula) => formula.billable_charge_cents);
  const formulaCostCents = sum(formulas, (formula) => formula.actual_cost_cents);
  const wasteCostCents = sum(formulas, (formula) => formula.waste_cost_cents);
  const grossMarginCents = colourRevenueCents - formulaCostCents;
  const worstLocation = [...byLocation].sort((a, b) => a.grossMarginPercent - b.grossMarginPercent)[0];

  return {
    colourRevenueCents,
    formulaCostCents,
    grossMarginCents,
    grossMarginPercent: percent(grossMarginCents, colourRevenueCents),
    wasteCostCents,
    wastePercentOfRevenue: percent(wasteCostCents, colourRevenueCents),
    formulasMixed: formulas.length,
    worstLocationName: worstLocation?.locationName,
    currencyCode: formulas[0]?.currency_code ?? 'GBP',
  };
}

function buildLocationMetrics(
  formulas: FormulaAnalyticsRow[],
  locationNames: Map<string, string>,
): SheerLabLocationMetric[] {
  const grouped = groupBy(formulas, (formula) => formula.location_id);

  return Array.from(grouped.entries())
    .map(([locationId, rows]) => {
      const colourRevenueCents = sum(rows, (formula) => formula.billable_charge_cents);
      const formulaCostCents = sum(rows, (formula) => formula.actual_cost_cents);
      const grossMarginCents = colourRevenueCents - formulaCostCents;

      return {
        locationId,
        locationName: locationNames.get(locationId) ?? 'Unknown location',
        colourRevenueCents,
        formulaCostCents,
        grossMarginCents,
        grossMarginPercent: percent(grossMarginCents, colourRevenueCents),
        wasteCostCents: sum(rows, (formula) => formula.waste_cost_cents),
        formulasMixed: rows.length,
        currencyCode: rows[0]?.currency_code ?? 'GBP',
      };
    })
    .sort((a, b) => b.colourRevenueCents - a.colourRevenueCents);
}

function buildStylistMetrics(
  formulas: FormulaAnalyticsRow[],
  visits: Map<string, VisitRow>,
  staffProfiles: Map<string, StaffProfileRow>,
  locationNames: Map<string, string>,
): SheerLabStylistMetric[] {
  const grouped = groupBy(formulas, (formula) => {
    const visit = formula.visit_id ? visits.get(formula.visit_id) : undefined;
    return resolveStaffProfileId(visit) ?? 'unassigned';
  });

  return Array.from(grouped.entries())
    .map(([staffProfileId, rows]) => {
      const staff = staffProfileId === 'unassigned' ? undefined : staffProfiles.get(staffProfileId);
      const colourRevenueCents = sum(rows, (formula) => formula.billable_charge_cents);
      const formulaCostCents = sum(rows, (formula) => formula.actual_cost_cents);
      const grossMarginCents = colourRevenueCents - formulaCostCents;

      return {
        stylistProfileId: staffProfileId === 'unassigned' ? undefined : staffProfileId,
        stylistName: staff ? staffDisplayName(staff) : 'Unassigned stylist',
        locationId: rows[0]?.location_id ?? '',
        locationName: locationNames.get(rows[0]?.location_id ?? '') ?? 'Unknown location',
        hourlyRate: staff ? Number(staff.hourly_rate) : undefined,
        contractedHours: staff ? Number(staff.contracted_hours) : undefined,
        averageBillBenchmark: staff ? Number(staff.average_bill_benchmark) : undefined,
        colourRevenueCents,
        formulaCostCents,
        grossMarginCents,
        grossMarginPercent: percent(grossMarginCents, colourRevenueCents),
        wasteCostCents: sum(rows, (formula) => formula.waste_cost_cents),
        formulasMixed: rows.length,
        currencyCode: rows[0]?.currency_code ?? 'GBP',
      };
    })
    .sort((a, b) => b.colourRevenueCents - a.colourRevenueCents);
}

function buildServiceTypeMetrics(
  formulas: FormulaAnalyticsRow[],
  visits: Map<string, VisitRow>,
): SheerLabServiceTypeMetric[] {
  const grouped = groupBy(formulas, (formula) => {
    const visit = formula.visit_id ? visits.get(formula.visit_id) : undefined;
    return resolveServiceType(visit, formula) ?? 'Unlinked service';
  });

  return Array.from(grouped.entries())
    .map(([serviceType, rows]) => ({
      serviceType,
      formulaCount: rows.length,
      averageFormulaCostCents: rows.length ? Math.round(sum(rows, (formula) => formula.actual_cost_cents) / rows.length) : 0,
      currencyCode: rows[0]?.currency_code ?? 'GBP',
    }))
    .sort((a, b) => b.formulaCount - a.formulaCount);
}

function buildProductUsageMetrics(
  items: FormulaItemAnalyticsRow[],
  formulas: FormulaAnalyticsRow[],
): SheerLabProductUsageMetric[] {
  const formulasById = new Map(formulas.map((formula) => [formula.id, formula]));
  const grouped = groupBy(items, (item) => item.product_id ?? item.product_name.toLowerCase());

  return Array.from(grouped.values()).map((rows) => ({
    productId: rows[0]?.product_id ?? undefined,
    productName: rows[0]?.product_name ?? 'Unknown product',
    brand: rows[0]?.brand ?? undefined,
    totalWeightGrams: sum(rows, (item) => Number(item.captured_grams ?? 0)),
    totalCostCents: sum(rows, (item) => item.cost_cents ?? 0),
    formulaCount: new Set(rows.map((item) => item.formula_id)).size,
    currencyCode: formulasById.get(rows[0]?.formula_id ?? '')?.currency_code ?? 'GBP',
  }));
}

function toLowStockAlert(
  alert: LowStockAlertRow,
  locationNames: Map<string, string>,
  productsById: Map<string, ProductRelation>,
): SheerLabLowStockAlert {
  const product = productsById.get(alert.product_id);
  return {
    id: alert.id,
    locationId: alert.location_id,
    locationName: locationNames.get(alert.location_id) ?? 'Unknown location',
    productId: alert.product_id,
    productName: product?.name ?? 'Unknown product',
    brand: product?.brand ?? undefined,
    remainingQuantityGrams: Number(alert.remaining_quantity_grams),
    thresholdQuantityGrams: Number(alert.threshold_quantity_grams),
    status: alert.status,
    lastTriggeredAt: alert.last_triggered_at,
  };
}

function resolveStaffProfileId(visit: VisitRow | undefined): string | undefined {
  if (!visit) return undefined;
  return visit.primary_staff_profile_id ?? firstRelation(visit.appointments)?.assigned_staff_profile_id ?? undefined;
}

function resolveServiceType(visit: VisitRow | undefined, formula: FormulaAnalyticsRow): string | undefined {
  const metadataVisit = formula.metadata?.visit as { serviceType?: string } | undefined;
  if (metadataVisit?.serviceType) return metadataVisit.serviceType;
  if (visit?.service_summary) return visit.service_summary;

  const lines = firstRelation(visit?.appointments)?.appointment_services;
  const performed = (Array.isArray(lines) ? lines : lines ? [lines] : []).filter(
    (line) => line.status !== 'cancelled',
  );
  return performed[0]?.service_name_snapshot ?? undefined;
}

function staffDisplayName(staff: StaffProfileRow): string {
  return staff.display_name ?? firstRelation(staff.user_profiles)?.full_name ?? 'Unknown stylist';
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
    return groups;
  }, new Map<string, T[]>());
}

function sum<T>(items: T[], valueFn: (item: T) => number): number {
  return items.reduce((total, item) => total + valueFn(item), 0);
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function firstRelation<T>(value: T[] | T | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
