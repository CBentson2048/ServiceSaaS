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
  DashboardInventoryAlert,
  DashboardInventoryAlertsResponse,
  DashboardKpiSummary,
  DashboardKpisResponse,
  DashboardLocationKpiSummary,
  DashboardLocationSummary,
  DashboardStylistPerformance,
  DashboardStylistPerformanceResponse,
  DashboardTopService,
  DashboardTopServicesResponse,
} from '@sheer/domain';
import { userHasAnyRole, userHasRole } from '@sheer/domain';
import type { DashboardDateRangeQueryDto, DashboardInventoryAlertsQueryDto } from './dto';

type AppointmentStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'checked_in'
  | 'awaiting_payment'
  | 'paid'
  | 'cancelled'
  | 'no_show';

interface AppointmentServiceRow {
  service_name_snapshot: string | null;
  price_amount: number | string | null;
  /** 0110: 'cancelled' = removed after check-in, not performed. */
  status?: string | null;
}

interface VisitLineItemRow {
  visit_id: string;
  amount_cents: number | string | null;
}

interface DepositRow {
  status: string;
  amount: number | string | null;
}

interface SalonPaymentRow {
  appointment_id: string;
  amount_cents: number | string | null;
}

interface AppointmentRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  status: AppointmentStatus;
  scheduled_start_at: string;
  appointment_services?: AppointmentServiceRow[] | AppointmentServiceRow | null;
  deposits?: DepositRow[] | DepositRow | null;
  salon_payments?: SalonPaymentRow[] | SalonPaymentRow | null;
  visits?:
    | {
        id: string;
        billing_visit_line_items?: VisitLineItemRow[] | VisitLineItemRow | null;
        rebooking_outcomes?: RebookingOutcomeRow[] | RebookingOutcomeRow | null;
      }
    | Array<{
        id: string;
        billing_visit_line_items?: VisitLineItemRow[] | VisitLineItemRow | null;
        rebooking_outcomes?: RebookingOutcomeRow[] | RebookingOutcomeRow | null;
      }>
    | null;
}

interface RebookingOutcomeRow {
  id: string;
  rebooked_appointment_id: string;
  rebook_source: 'stylist' | 'client';
  source_staff_profile_id: string | null;
}

interface ClientFirstAppointmentRow {
  client_profile_id: string;
  scheduled_start_at: string;
}

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
  user_profiles?: { full_name: string | null }[] | { full_name: string | null } | null;
}

interface InventoryStockRow {
  location_id: string;
  product_id: string;
  quantity_on_hand_grams: number | string;
  low_stock_threshold_grams: number | string | null;
}

interface ProductRelation {
  id: string;
  name: string;
  brand: string | null;
  low_stock_threshold_grams: number | string | null;
}

interface DashboardScope {
  scope: 'owner' | 'manager';
  requestedLocationId?: string;
  locationIds: string[];
  locations: DashboardLocationSummary[];
}

interface RevenueSummary {
  revenueCents: number;
  paidBookingIds: Set<string>;
  currencyCode: string;
}

interface KpiAccumulator extends DashboardKpiSummary {
  totalRevenueCents: number;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  noShowBookings: number;
  newClients: number;
  repeatClients: number;
  completedPaidBookings: number;
  lowStockProducts: number;
  currencyCode: string;
}

// `salon_payments` and `visit_line_items` live in the `billing` schema and cannot be
// embedded through booking relations — PostgREST only resolves embeds within the
// request's schema. They are fetched separately from `billing` and stitched back (see
// fetchSalonPayments / fetchVisitLineItems); the visit `id` is selected so line items
// can be matched to their visit.
const APPOINTMENT_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,appointment_services(service_name_snapshot,price_amount,status),deposits(status,amount),visits(id,rebooking_outcomes(id,rebooked_appointment_id,rebook_source,source_staff_profile_id))';
const LOCATION_COLUMNS = 'id,name,code,address_line_1,city';
const STAFF_COLUMNS = 'id,display_name,hourly_rate,contracted_hours,average_bill_benchmark,user_profiles(full_name)';
const STOCK_COLUMNS =
  'location_id,product_id,quantity_on_hand_grams,low_stock_threshold_grams';
const PRODUCT_COLUMNS = 'id,name,brand,low_stock_threshold_grams';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async kpis(actor: AuthUser, query: DashboardDateRangeQueryDto): Promise<DashboardKpisResponse> {
    const range = parseDateRange(query);
    const scope = await this.resolveScope(actor, query.locationId);
    const [appointments, lowStockRows] = await Promise.all([
      this.fetchAppointments(actor.businessId, scope.locationIds, range.from, range.to),
      this.fetchInventoryStock(actor.businessId, scope.locationIds),
    ]);
    const inventoryProducts = await this.fetchProducts(lowStockRows.map((row) => row.product_id));
    const lowStockAlerts = lowStockRows.filter((row) => isLowStock(row, inventoryProducts));

    const clientIds = unique(appointments.map((appointment) => appointment.client_profile_id));
    const firstAppointments = await this.fetchClientFirstAppointments(actor.businessId, scope.locationIds, clientIds);
    const firstAppointmentByClient = new Map(
      firstAppointments.map((row) => [row.client_profile_id, row.scheduled_start_at]),
    );
    const lowStockCountByLocation = countLowStockByLocation(lowStockAlerts, scope.locations);
    const byLocation = scope.locations.map((location) =>
      buildKpiSummary(
        appointments.filter((appointment) => appointment.location_id === location.id),
        firstAppointmentByClient,
        range.from,
        lowStockCountByLocation.get(location.id) ?? 0,
        location,
      ),
    );

    return {
      rangeStart: range.from,
      rangeEnd: range.to,
      scope: scope.scope,
      selectedLocationId: scope.requestedLocationId,
      locations: scope.locations,
      summary: summarizeLocationKpis(byLocation),
      byLocation,
    };
  }

  async topServices(
    actor: AuthUser,
    query: DashboardDateRangeQueryDto,
  ): Promise<DashboardTopServicesResponse> {
    const range = parseDateRange(query);
    const scope = await this.resolveScope(actor, query.locationId);
    const appointments = await this.fetchAppointments(actor.businessId, scope.locationIds, range.from, range.to);
    const services = buildTopServices(appointments).slice(0, 5);

    return {
      rangeStart: range.from,
      rangeEnd: range.to,
      scope: scope.scope,
      selectedLocationId: scope.requestedLocationId,
      services,
    };
  }

  async stylistPerformance(
    actor: AuthUser,
    query: DashboardDateRangeQueryDto,
  ): Promise<DashboardStylistPerformanceResponse> {
    const range = parseDateRange(query);
    const scope = await this.resolveScope(actor, query.locationId);
    const appointments = await this.fetchAppointments(actor.businessId, scope.locationIds, range.from, range.to);
    const staffIds = unique(appointments.map((appointment) => appointment.assigned_staff_profile_id).filter(isString));
    const staffProfiles = await this.fetchStaffProfiles(staffIds);
    const locationNames = new Map(scope.locations.map((location) => [location.id, location.name]));
    const stylists = buildStylistPerformance(appointments, staffProfiles, locationNames).slice(0, 8);

    return {
      rangeStart: range.from,
      rangeEnd: range.to,
      scope: scope.scope,
      selectedLocationId: scope.requestedLocationId,
      stylists,
    };
  }

  async inventoryAlerts(
    actor: AuthUser,
    query: DashboardInventoryAlertsQueryDto,
  ): Promise<DashboardInventoryAlertsResponse> {
    const scope = await this.resolveScope(actor, query.locationId);
    const rows = await this.fetchInventoryStock(actor.businessId, scope.locationIds);
    const products = await this.fetchProducts(rows.map((row) => row.product_id));
    const locationNames = new Map(scope.locations.map((location) => [location.id, location.name]));
    const alerts = rows
      .filter((row) => isLowStock(row, products))
      .map((row) => toInventoryAlert(row, locationNames, products))
      .filter(isDefined);

    return {
      scope: scope.scope,
      selectedLocationId: scope.requestedLocationId,
      count: alerts.length,
      alerts,
    };
  }

  private async resolveScope(actor: AuthUser, requestedLocationId?: string): Promise<DashboardScope> {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Dashboard KPIs are limited to owners and managers');
    }

    if (!userHasRole(actor, 'owner')) {
      if (requestedLocationId && !actor.allowedLocationIds.includes(requestedLocationId)) {
        throw new ForbiddenException('Location is outside your dashboard scope');
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
    return {
      scope: 'owner',
      requestedLocationId,
      locationIds: locations.map((location) => location.id),
      locations,
    };
  }

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
    if (error) this.throwQueryError('fetchLocations', error.message);

    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code ?? undefined,
      addressLine1: row.address_line_1 ?? undefined,
      city: row.city ?? undefined,
    }));
  }

  private async fetchAppointments(
    businessId: string,
    locationIds: string[],
    from: string,
    to: string,
  ): Promise<AppointmentRow[]> {
    if (locationIds.length === 0) return [];

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .gte('scheduled_start_at', from)
      .lt('scheduled_start_at', to)
      .returns<AppointmentRow[]>();
    if (error) this.throwQueryError('fetchAppointments', error.message);

    const appointments = data ?? [];

    // salon_payments and visit_line_items live in the `billing` schema, so they can't be
    // embedded through booking relations. Fetch them separately and stitch back by id.
    const visits = appointments.flatMap((appointment) => arrayOf(appointment.visits));
    const [lineItemsByVisit, paymentsByAppointment] = await Promise.all([
      this.fetchVisitLineItems(businessId, unique(visits.map((visit) => visit.id).filter(Boolean))),
      this.fetchSalonPayments(businessId, appointments.map((appointment) => appointment.id)),
    ]);
    for (const visit of visits) {
      visit.billing_visit_line_items = lineItemsByVisit.get(visit.id) ?? [];
    }
    for (const appointment of appointments) {
      appointment.salon_payments = paymentsByAppointment.get(appointment.id) ?? [];
    }

    return appointments;
  }

  /** Visit line items live in `billing`; fetch them by visit id and group for stitching. */
  private async fetchVisitLineItems(
    businessId: string,
    visitIds: string[],
  ): Promise<Map<string, VisitLineItemRow[]>> {
    const grouped = new Map<string, VisitLineItemRow[]>();
    if (visitIds.length === 0) return grouped;

    const { data, error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .select('visit_id,amount_cents')
      .eq('business_id', businessId)
      .in('visit_id', visitIds)
      .returns<VisitLineItemRow[]>();
    if (error) this.throwQueryError('fetchVisitLineItems', error.message);

    for (const item of data ?? []) {
      const list = grouped.get(item.visit_id);
      if (list) list.push(item);
      else grouped.set(item.visit_id, [item]);
    }
    return grouped;
  }

  /** Salon payments live in `billing`; fetch them by appointment id and group for stitching. */
  private async fetchSalonPayments(
    businessId: string,
    appointmentIds: string[],
  ): Promise<Map<string, SalonPaymentRow[]>> {
    const grouped = new Map<string, SalonPaymentRow[]>();
    if (appointmentIds.length === 0) return grouped;

    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .select('appointment_id,amount_cents')
      .eq('business_id', businessId)
      .in('appointment_id', appointmentIds)
      .returns<SalonPaymentRow[]>();
    if (error) this.throwQueryError('fetchSalonPayments', error.message);

    for (const payment of data ?? []) {
      const list = grouped.get(payment.appointment_id);
      if (list) list.push(payment);
      else grouped.set(payment.appointment_id, [payment]);
    }
    return grouped;
  }

  private async fetchClientFirstAppointments(
    businessId: string,
    locationIds: string[],
    clientIds: string[],
  ): Promise<ClientFirstAppointmentRow[]> {
    if (locationIds.length === 0 || clientIds.length === 0) return [];

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('client_profile_id,scheduled_start_at')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .in('client_profile_id', clientIds)
      .order('scheduled_start_at', { ascending: true })
      .returns<ClientFirstAppointmentRow[]>();
    if (error) this.throwQueryError('fetchClientFirstAppointments', error.message);

    const firstByClient = new Map<string, ClientFirstAppointmentRow>();
    for (const row of data ?? []) {
      if (!firstByClient.has(row.client_profile_id)) firstByClient.set(row.client_profile_id, row);
    }
    return Array.from(firstByClient.values());
  }

  private async fetchStaffProfiles(staffIds: string[]): Promise<Map<string, StaffProfileRow>> {
    if (staffIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .in('id', staffIds)
      .returns<StaffProfileRow[]>();
    if (error) this.throwQueryError('fetchStaffProfiles', error.message);

    return new Map((data ?? []).map((row) => [row.id, row]));
  }

  private async fetchInventoryStock(businessId: string, locationIds: string[]): Promise<InventoryStockRow[]> {
    if (locationIds.length === 0) return [];

    const { data, error } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .select(STOCK_COLUMNS)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .in('location_id', locationIds)
      .returns<InventoryStockRow[]>();
    if (error) this.throwQueryError('fetchInventoryStock', error.message);

    return data ?? [];
  }

  private async fetchProducts(productIds: string[]): Promise<Map<string, ProductRelation>> {
    const uniqueProductIds = unique(productIds);
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
    throw new InternalServerErrorException('Unable to load dashboard data');
  }
}

function parseDateRange(query: DashboardDateRangeQueryDto): { from: string; to: string } {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new BadRequestException('from must be before to');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function buildKpiSummary(
  appointments: AppointmentRow[],
  firstAppointmentByClient: Map<string, string>,
  rangeStart: string,
  lowStockProducts: number,
  location: DashboardLocationSummary,
): DashboardLocationKpiSummary {
  const revenue = paidRevenue(appointments);
  const clientsInRange = unique(appointments.map((appointment) => appointment.client_profile_id));
  const newClients = clientsInRange.filter((clientId) => {
    const firstAppointment = firstAppointmentByClient.get(clientId);
    return firstAppointment !== undefined && firstAppointment >= rangeStart;
  }).length;
  const repeatClients = clientsInRange.filter((clientId) => {
    const firstAppointment = firstAppointmentByClient.get(clientId);
    return firstAppointment !== undefined && firstAppointment < rangeStart;
  }).length;
  const completedBookings = appointments.filter(isCompletedAppointment).length;
  const rebooking = rebookingSummary(appointments);

  return {
    locationId: location.id,
    locationName: location.name,
    totalRevenueCents: revenue.revenueCents,
    totalBookings: appointments.length,
    completedBookings,
    cancelledBookings: appointments.filter((appointment) => appointment.status === 'cancelled').length,
    noShowBookings: appointments.filter((appointment) => appointment.status === 'no_show').length,
    newClients,
    repeatClients,
    rebookedVisits: rebooking.total,
    rebookingRatePercent: completedBookings > 0 ? Math.round((rebooking.total / completedBookings) * 100) : 0,
    stylistRebookedVisits: rebooking.stylist,
    clientRebookedVisits: rebooking.client,
    completedPaidBookings: revenue.paidBookingIds.size,
    averageBookingValueCents:
      revenue.paidBookingIds.size > 0
        ? Math.round(revenue.revenueCents / revenue.paidBookingIds.size)
        : 0,
    lowStockProducts,
    currencyCode: revenue.currencyCode,
  };
}

function summarizeLocationKpis(locations: DashboardLocationKpiSummary[]): DashboardKpiSummary {
  const totals = locations.reduce<KpiAccumulator>(
    (acc, location) => ({
      totalRevenueCents: acc.totalRevenueCents + location.totalRevenueCents,
      totalBookings: acc.totalBookings + location.totalBookings,
      completedBookings: acc.completedBookings + location.completedBookings,
      cancelledBookings: acc.cancelledBookings + location.cancelledBookings,
      noShowBookings: acc.noShowBookings + location.noShowBookings,
      newClients: acc.newClients + location.newClients,
      repeatClients: acc.repeatClients + location.repeatClients,
      rebookedVisits: acc.rebookedVisits + location.rebookedVisits,
      rebookingRatePercent: 0,
      stylistRebookedVisits: acc.stylistRebookedVisits + location.stylistRebookedVisits,
      clientRebookedVisits: acc.clientRebookedVisits + location.clientRebookedVisits,
      completedPaidBookings: acc.completedPaidBookings + location.completedPaidBookings,
      averageBookingValueCents: 0,
      lowStockProducts: acc.lowStockProducts + location.lowStockProducts,
      currencyCode: acc.currencyCode || location.currencyCode,
    }),
    zeroKpis(),
  );

  return {
    ...totals,
    rebookingRatePercent:
      totals.completedBookings > 0 ? Math.round((totals.rebookedVisits / totals.completedBookings) * 100) : 0,
    averageBookingValueCents:
      totals.completedPaidBookings > 0 ? Math.round(totals.totalRevenueCents / totals.completedPaidBookings) : 0,
  };
}

function zeroKpis(): KpiAccumulator {
  return {
    totalRevenueCents: 0,
    totalBookings: 0,
    completedBookings: 0,
    cancelledBookings: 0,
    noShowBookings: 0,
    newClients: 0,
    repeatClients: 0,
    rebookedVisits: 0,
    rebookingRatePercent: 0,
    stylistRebookedVisits: 0,
    clientRebookedVisits: 0,
    completedPaidBookings: 0,
    averageBookingValueCents: 0,
    lowStockProducts: 0,
    currencyCode: 'GBP',
  };
}

function paidRevenue(appointments: AppointmentRow[]): RevenueSummary {
  const paidBookingIds = new Set<string>();
  const revenueCents = appointments.reduce((sum, appointment) => {
    if (appointment.status !== 'paid') return sum;
    const reconciledVisitTotalCents = visitLineItemsTotalCents(appointment);
    if (reconciledVisitTotalCents > 0) {
      paidBookingIds.add(appointment.id);
      return sum + reconciledVisitTotalCents;
    }
    const collectedCents = collectedTakingsCents(appointment);
    if (collectedCents === 0) return sum;
    paidBookingIds.add(appointment.id);
    return sum + collectedCents;
  }, 0);

  return { revenueCents, paidBookingIds, currencyCode: 'GBP' };
}

function isCompletedAppointment(appointment: AppointmentRow): boolean {
  return appointment.status === 'awaiting_payment' || appointment.status === 'paid';
}

function rebookingSummary(appointments: AppointmentRow[]): {
  total: number;
  stylist: number;
  client: number;
} {
  const outcomes = appointments.flatMap(rebookingOutcomes);
  return {
    total: outcomes.length,
    stylist: outcomes.filter((outcome) => outcome.rebook_source === 'stylist').length,
    client: outcomes.filter((outcome) => outcome.rebook_source === 'client').length,
  };
}

function hasRebookingOutcome(appointment: AppointmentRow): boolean {
  return rebookingOutcomes(appointment).length > 0;
}

function rebookingOutcomes(appointment: AppointmentRow): RebookingOutcomeRow[] {
  return arrayOf(appointment.visits).flatMap((visit) => arrayOf(visit.rebooking_outcomes));
}

function collectedTakingsCents(appointment: AppointmentRow): number {
  const deposits = arrayOf(appointment.deposits)
    .filter((deposit) => deposit.status === 'paid')
    .reduce((sum, deposit) => sum + toCents(deposit.amount), 0);
  const salonPayments = arrayOf(appointment.salon_payments).reduce(
    (sum, payment) => sum + Number(payment.amount_cents ?? 0),
    0,
  );
  return deposits + salonPayments;
}

function visitLineItemsTotalCents(appointment: AppointmentRow): number {
  return arrayOf(appointment.visits).reduce(
    (visitSum, visit) =>
      visitSum +
      arrayOf(visit.billing_visit_line_items).reduce(
        (lineSum, item) => lineSum + Number(item.amount_cents ?? 0),
        0,
      ),
    0,
  );
}

function buildTopServices(appointments: AppointmentRow[]): DashboardTopService[] {
  const services = new Map<string, DashboardTopService>();
  for (const appointment of appointments) {
    for (const service of arrayOf(appointment.appointment_services)) {
      // 0110: service mix is what was PERFORMED — a line removed after
      // check-in was neither delivered nor charged.
      if (service.status === 'cancelled') continue;
      const name = service.service_name_snapshot?.trim() || 'Unspecified service';
      const current = services.get(name) ?? {
        serviceName: name,
        bookingCount: 0,
        revenueCents: 0,
        currencyCode: 'GBP',
      };
      services.set(name, {
        ...current,
        bookingCount: current.bookingCount + 1,
        revenueCents: current.revenueCents + (appointment.status === 'paid' ? toCents(service.price_amount) : 0),
      });
    }
  }
  return Array.from(services.values()).sort((a, b) => b.bookingCount - a.bookingCount || b.revenueCents - a.revenueCents);
}

function buildStylistPerformance(
  appointments: AppointmentRow[],
  staffProfiles: Map<string, StaffProfileRow>,
  locationNames: Map<string, string>,
): DashboardStylistPerformance[] {
  const byStylist = new Map<string, AppointmentRow[]>();
  for (const appointment of appointments) {
    const staffId = appointment.assigned_staff_profile_id ?? 'unassigned';
    const key = `${staffId}:${appointment.location_id}`;
    byStylist.set(key, [...(byStylist.get(key) ?? []), appointment]);
  }

  return Array.from(byStylist.entries())
    .map(([key, rows]) => {
      const [staffId, locationId] = key.split(':');
      const revenue = paidRevenue(rows);
      const staff = staffId === 'unassigned' ? undefined : staffProfiles.get(staffId);
      const completedBookings = rows.filter(isCompletedAppointment).length;
      const rebookedVisits = rows.filter(hasRebookingOutcome).length;
      return {
        staffProfileId: staffId === 'unassigned' ? undefined : staffId,
        stylistName: staff ? staffDisplayName(staff) : staffId === 'unassigned' ? 'Unassigned' : 'Unknown stylist',
        locationId,
        locationName: locationNames.get(locationId) ?? 'Unknown location',
        hourlyRate: staff ? Number(staff.hourly_rate) : undefined,
        contractedHours: staff ? Number(staff.contracted_hours) : undefined,
        averageBillBenchmark: staff ? Number(staff.average_bill_benchmark) : undefined,
        totalBookings: rows.length,
        completedBookings,
        cancelledBookings: rows.filter((row) => row.status === 'cancelled').length,
        noShowBookings: rows.filter((row) => row.status === 'no_show').length,
        rebookedVisits,
        rebookingRatePercent:
          completedBookings > 0 ? Math.round((rebookedVisits / completedBookings) * 100) : 0,
        revenueCents: revenue.revenueCents,
        averageBookingValueCents:
          revenue.paidBookingIds.size > 0
            ? Math.round(revenue.revenueCents / revenue.paidBookingIds.size)
            : 0,
        currencyCode: revenue.currencyCode,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents || b.completedBookings - a.completedBookings);
}

function countLowStockByLocation(
  alerts: InventoryStockRow[],
  locations: DashboardLocationSummary[],
): Map<string, number> {
  const counts = new Map(locations.map((location) => [location.id, 0]));
  for (const alert of alerts) counts.set(alert.location_id, (counts.get(alert.location_id) ?? 0) + 1);
  return counts;
}

function toInventoryAlert(
  row: InventoryStockRow,
  locationNames: Map<string, string>,
  productsById: Map<string, ProductRelation>,
): DashboardInventoryAlert | undefined {
  const product = productsById.get(row.product_id);
  if (!product) return undefined;
  const threshold = effectiveThreshold(row, productsById);
  return {
    locationId: row.location_id,
    locationName: locationNames.get(row.location_id) ?? 'Unknown location',
    productId: row.product_id,
    productName: product.name,
    brand: product.brand ?? undefined,
    quantityOnHandGrams: Number(row.quantity_on_hand_grams),
    thresholdGrams: threshold,
  };
}

function isLowStock(row: InventoryStockRow, productsById: Map<string, ProductRelation>): boolean {
  const threshold = effectiveThreshold(row, productsById);
  return threshold > 0 && Number(row.quantity_on_hand_grams) <= threshold;
}

function effectiveThreshold(row: InventoryStockRow, productsById: Map<string, ProductRelation>): number {
  const product = productsById.get(row.product_id);
  return Number(row.low_stock_threshold_grams ?? product?.low_stock_threshold_grams ?? 0);
}

function staffDisplayName(row: StaffProfileRow): string {
  return row.display_name?.trim() || first(row.user_profiles)?.full_name?.trim() || 'Unknown stylist';
}

function toCents(amount: number | string | null | undefined): number {
  const parsed = Number(amount ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
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

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
