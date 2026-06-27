import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AppointmentStatus,
  AuthUser,
  ClientVisitColourFormula,
  ClientVisitDetail,
  ClientVisitServiceLine,
  CrmVisitSummary,
  LocationTaxSettings,
  MobileClientDashboardResponse,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  MobileStylistDashboardResponse,
  StaffBookingSummary,
} from '@sheer/domain';
import { calculateTaxForCategory, userHasRole } from '@sheer/domain';
import { OwnerTaxSettingsService } from '../owner-tax-settings/owner-tax-settings.service';

interface AppointmentServiceRow {
  service_id?: string | null;
  service_name_snapshot: string;
  duration_minutes: number;
  deposit_required_amount: number | string;
}

interface DepositRow {
  status: string;
  amount: number | string;
}

interface AppointmentRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  requested_staff_profile_id: string | null;
  status: AppointmentStatus;
  scheduled_start_at: string;
  scheduled_end_at: string;
  client_note: string | null;
  appointment_services?: AppointmentServiceRow[] | AppointmentServiceRow | null;
  deposits?: DepositRow[] | DepositRow | null;
}

interface ClientProfileRow {
  id: string;
  first_name: string;
  last_name: string;
  communication_preference: 'whatsapp' | 'sms' | 'email' | null;
}

interface VisitRow {
  id: string;
  business_id: string;
  location_id: string;
  appointment_id: string | null;
  client_profile_id: string;
  primary_staff_profile_id: string | null;
  status: string;
  checked_in_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  service_summary: string | null;
  client_visible_summary: string | null;
  created_at: string;
}

interface StaffNameRow {
  id: string;
  display_name: string;
}

interface AppointmentServiceDetailRow {
  service_name_snapshot: string;
  price_amount: number | string;
  duration_minutes: number;
  sequence_no: number;
}

interface SalonPaymentRow {
  amount_cents: number;
  currency_code: string;
  payment_method: string;
  paid_at: string;
}

interface FormulaRow {
  id: string;
  saved_at: string | null;
  billable_charge_cents: number | null;
}

interface FormulaItemRow {
  formula_id: string;
  product_name: string;
  brand: string | null;
  shade: string | null;
  developer: string | null;
  ratio: string | null;
  processing_time_minutes: number | null;
  captured_grams: number | string | null;
  cost_cents: number | null;
}

/** Pre-tax service line read from the appointment, before the price policy is applied. */
interface RawServiceLine {
  name: string;
  priceNetCents?: number;
  durationMinutes?: number;
}

/** Pre-tax colour item; `costCents` is the weight used to split the formula charge. */
interface RawColourItem {
  productName: string;
  brand?: string;
  shade?: string;
  developer?: string;
  ratio?: string;
  processingTimeMinutes?: number;
  grams?: number;
  costCents: number;
}

interface RawColourFormula {
  id: string;
  savedAt?: string;
  /** Net customer charge for the whole formula (cost + the location's markup rule). */
  billableChargeCents: number;
  items: RawColourItem[];
}

interface ShiftRow {
  staff_profile_id: string;
}

interface StockRow {
  id: string;
}

const APPOINTMENT_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,client_note,appointment_services(service_id,service_name_snapshot,duration_minutes,deposit_required_amount),deposits(status,amount)';
const CLIENT_COLUMNS = 'id,first_name,last_name,communication_preference';
const VISIT_COLUMNS =
  'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,service_summary,client_visible_summary,created_at';

@Injectable()
export class MobileDashboardService {
  private readonly logger = new Logger(MobileDashboardService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly taxSettings: OwnerTaxSettingsService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async client(actor: AuthUser): Promise<MobileClientDashboardResponse> {
    if (!userHasRole(actor, 'client') || !actor.clientProfileId) {
      throw new ForbiddenException('Client dashboard requires a client account');
    }

    const now = new Date().toISOString();
    const [profile, upcomingAppointments, visitHistory] = await Promise.all([
      this.fetchClientProfile(actor.businessId, actor.clientProfileId),
      this.fetchClientUpcomingAppointments(actor.businessId, actor.clientProfileId, now),
      this.fetchClientVisitHistory(actor.businessId, actor.clientProfileId),
    ]);

    return {
      role: 'client',
      profile: {
        id: profile.id,
        displayName: clientName(profile),
        communicationPreference: profile.communication_preference ?? undefined,
      },
      nextAppointment: upcomingAppointments[0],
      upcomingAppointments: upcomingAppointments.slice(0, 5),
      visitHistory: visitHistory.slice(0, 5),
    };
  }

  async stylist(actor: AuthUser): Promise<MobileStylistDashboardResponse> {
    if (!userHasRole(actor, 'stylist') || !actor.staffProfileId) {
      throw new ForbiddenException('Stylist dashboard requires a stylist account');
    }

    const { rangeStart, rangeEnd } = todayRange();
    const appointments = await this.fetchStaffTodayAppointments(
      actor.businessId,
      actor.staffProfileId,
      actor.allowedLocationIds,
      rangeStart,
      rangeEnd,
    );
    const upcoming = appointments.filter((appointment) => new Date(appointment.startsAt).getTime() >= Date.now());

    return {
      role: 'stylist',
      displayName: actor.profile.fullName,
      today: {
        rangeStart,
        rangeEnd,
        totalAppointments: appointments.length,
        nextAppointment: upcoming[0] ?? appointments[0],
        appointments,
      },
    };
  }

  async manager(actor: AuthUser): Promise<MobileManagerDashboardResponse> {
    if (!userHasRole(actor, 'manager')) {
      throw new ForbiddenException('Manager dashboard requires a manager account');
    }
    const location = actor.locations[0];
    if (!location || !actor.allowedLocationIds.includes(location.id)) {
      throw new ForbiddenException('No assigned manager location is available');
    }

    const { rangeStart, rangeEnd } = todayRange();
    const [appointments, stylistsWorkingToday, lowStockAlertCount] = await Promise.all([
      this.fetchLocationTodayAppointments(actor.businessId, location.id, rangeStart, rangeEnd),
      this.countStylistsWorkingToday(actor.businessId, location.id, rangeStart, rangeEnd),
      this.countLowStockAlerts(actor.businessId, location.id),
    ]);
    const nowMs = Date.now();

    return {
      role: 'manager',
      location,
      today: {
        rangeStart,
        rangeEnd,
        bookingsCount: appointments.length,
        completedBookingsCount: appointments.filter(
          (appointment) => appointment.status === 'awaiting_payment' || appointment.status === 'paid',
        ).length,
        upcomingBookingsCount: appointments.filter((appointment) => new Date(appointment.startsAt).getTime() >= nowMs)
          .length,
        stylistsWorkingToday,
        lowStockAlertCount,
        recentAppointments: appointments.slice(0, 5),
      },
    };
  }

  owner(actor: AuthUser): MobileOwnerDashboardResponse {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Owner dashboard requires an owner account');
    }

    return {
      role: 'owner',
      displayName: actor.profile.fullName,
      message: 'Use the web dashboard for full business management. Mobile owner tools will stay operational-only for now.',
      locations: actor.locations,
    };
  }

  private async fetchClientProfile(businessId: string, clientProfileId: string): Promise<ClientProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('id', clientProfileId)
      .maybeSingle<ClientProfileRow>();
    if (error) this.throwQueryError('fetchClientProfile', error.message);
    if (!data) throw new ForbiddenException('Client profile is outside your account scope');
    return data;
  }

  private async fetchClientUpcomingAppointments(
    businessId: string,
    clientProfileId: string,
    now: string,
  ): Promise<StaffBookingSummary[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('client_profile_id', clientProfileId)
      .gte('scheduled_start_at', now)
      .not('status', 'in', '("cancelled","no_show","rejected")')
      .order('scheduled_start_at', { ascending: true })
      .limit(8)
      .returns<AppointmentRow[]>();
    if (error) this.throwQueryError('fetchClientUpcomingAppointments', error.message);

    const rows = data ?? [];
    const [client, windows] = await Promise.all([
      this.fetchClientProfile(businessId, clientProfileId),
      this.fetchCancellationWindows(rows.map((row) => row.location_id)),
    ]);
    return rows.map((row) => toBookingSummary(row, client, windows.get(row.location_id)));
  }

  /**
   * Per-location cancellation window (hours). Fetched separately because
   * core.location_settings can't be embedded from a booking.* query. Fail-soft: a
   * missing/failed lookup just omits the policy hints from the summary.
   */
  private async fetchCancellationWindows(locationIds: string[]): Promise<Map<string, number>> {
    const unique = Array.from(new Set(locationIds));
    if (unique.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('location_id,cancellation_notice_hours')
      .in('location_id', unique)
      .returns<Array<{ location_id: string; cancellation_notice_hours: number | null }>>();
    if (error) {
      this.logger.error(`fetchCancellationWindows failed: ${error.message}`);
      return new Map();
    }
    const map = new Map<string, number>();
    for (const row of data ?? []) {
      if (typeof row.cancellation_notice_hours === 'number' && row.cancellation_notice_hours >= 0) {
        map.set(row.location_id, row.cancellation_notice_hours);
      }
    }
    return map;
  }

  private async fetchClientVisitHistory(businessId: string, clientProfileId: string): Promise<CrmVisitSummary[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('business_id', businessId)
      .eq('client_profile_id', clientProfileId)
      // Visit history shows completed services only — exclude in-flight
      // (checked_in / in_progress) and cancelled visits. Matches the
      // "completed visit" definition used by KPI and rebooking services.
      .in('status', ['completed', 'awaiting_payment', 'paid'])
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<VisitRow[]>();
    if (error) this.throwQueryError('fetchClientVisitHistory', error.message);

    const visits = (data ?? []).map(toVisitSummary);
    const staffNames = await this.fetchStaffNames(
      businessId,
      visits.map((visit) => visit.primaryStaffProfileId).filter((id): id is string => Boolean(id)),
    );
    return visits.map((visit) =>
      visit.primaryStaffProfileId
        ? { ...visit, stylistName: staffNames.get(visit.primaryStaffProfileId) }
        : visit,
    );
  }

  async clientVisitDetail(actor: AuthUser, visitId: string): Promise<ClientVisitDetail> {
    if (!userHasRole(actor, 'client') || !actor.clientProfileId) {
      throw new ForbiddenException('Visit details require a client account');
    }

    const { data: visit, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('client_profile_id', actor.clientProfileId)
      .eq('id', visitId)
      .maybeSingle<VisitRow>();
    if (error) this.throwQueryError('clientVisitDetail', error.message);
    if (!visit) throw new NotFoundException('Visit not found');

    // billing.* and lab.* tables can't be embedded in a booking.* query, so the
    // services, stylist name, payment, colour formulas and tax policy are fetched
    // separately and stitched here.
    const [serviceLines, stylistName, payment, rawFormulas, taxSettings] = await Promise.all([
      visit.appointment_id ? this.fetchAppointmentServices(visit.appointment_id) : Promise.resolve([]),
      visit.primary_staff_profile_id
        ? this.fetchStaffName(actor.businessId, visit.primary_staff_profile_id)
        : Promise.resolve(undefined),
      this.fetchVisitPayment(visitId),
      this.fetchVisitColourFormulas(visitId),
      this.taxSettings.resolveLocationTaxSettings(actor.businessId, visit.location_id),
    ]);

    // Every displayed price is VAT-inclusive per the location's tax policy: net
    // service/charge amounts pass through the shared tax layer to their gross
    // figure (a no-op for tax-disabled locations). VAT is baked in, never a line.
    const services: ClientVisitServiceLine[] = serviceLines.map((line) => ({
      name: line.name,
      durationMinutes: line.durationMinutes,
      priceAmount:
        line.priceNetCents != null
          ? calculateTaxForCategory(line.priceNetCents, 'service', taxSettings).grossCents / 100
          : undefined,
    }));
    const colourFormulas = rawFormulas.map((formula) => toColourFormula(formula, taxSettings));

    const summary = toVisitSummary(visit);
    const colourCount = colourFormulas.reduce((total, formula) => total + formula.items.length, 0);
    const taxLabel =
      taxSettings.taxEnabled && taxSettings.taxRatePercent > 0
        ? taxSettings.taxLabel?.trim() || 'VAT'
        : undefined;

    // The bill total is the sum of the gross prices shown above. salon_payments
    // only records the balance collected at the till; the rest was a deposit
    // paid at booking. Deriving the deposit this way keeps the receipt footing
    // (total = deposit + balance) regardless of how the deposit was taken.
    const totalCents =
      sumGrossCents(services.map((service) => service.priceAmount)) +
      colourFormulas.reduce((sum, formula) => sum + sumGrossCents(formula.items.map((item) => item.priceAmount)), 0);
    const amountPaidCents = payment ? payment.amount_cents : undefined;
    const depositCents =
      amountPaidCents != null ? Math.max(0, totalCents - amountPaidCents) : undefined;

    return {
      id: summary.id,
      status: summary.status,
      occurredAt: summary.occurredAt,
      stylistName,
      serviceSummary: summary.serviceSummary,
      services,
      colourFormulas,
      colourCount,
      taxLabel,
      totalAmount: totalCents > 0 ? totalCents / 100 : undefined,
      depositAmount: depositCents ? depositCents / 100 : undefined,
      amountPaid: amountPaidCents != null ? amountPaidCents / 100 : undefined,
      currencyCode: payment?.currency_code ?? undefined,
      paymentMethod: payment?.payment_method ?? undefined,
      paidAt: payment?.paid_at ?? undefined,
    };
  }

  private async fetchAppointmentServices(appointmentId: string): Promise<RawServiceLine[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('service_name_snapshot,price_amount,duration_minutes,sequence_no')
      .eq('appointment_id', appointmentId)
      .order('sequence_no', { ascending: true })
      .returns<AppointmentServiceDetailRow[]>();
    if (error) this.throwQueryError('fetchAppointmentServices', error.message);
    return (data ?? []).map((row) => {
      const netCents = Math.round(Number(row.price_amount) * 100);
      return {
        name: row.service_name_snapshot,
        priceNetCents: Number.isFinite(netCents) ? netCents : undefined,
        durationMinutes: row.duration_minutes || undefined,
      };
    });
  }

  private async fetchStaffName(businessId: string, staffProfileId: string): Promise<string | undefined> {
    const names = await this.fetchStaffNames(businessId, [staffProfileId]);
    return names.get(staffProfileId);
  }

  private async fetchStaffNames(businessId: string, staffProfileIds: string[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(staffProfileIds.filter(Boolean)));
    if (ids.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<StaffNameRow[]>();
    if (error) this.throwQueryError('fetchStaffNames', error.message);
    return new Map((data ?? []).map((row) => [row.id, row.display_name]));
  }

  private async fetchVisitPayment(visitId: string): Promise<SalonPaymentRow | undefined> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .select('amount_cents,currency_code,payment_method,paid_at')
      .eq('visit_id', visitId)
      .maybeSingle<SalonPaymentRow>();
    if (error) this.throwQueryError('fetchVisitPayment', error.message);
    return data ?? undefined;
  }

  private async fetchVisitColourFormulas(visitId: string): Promise<RawColourFormula[]> {
    const { data: formulas, error: formulasError } = await this.admin
      .schema('lab')
      .from('formulas')
      .select('id,saved_at,billable_charge_cents')
      .eq('visit_id', visitId)
      .eq('status', 'saved')
      .order('saved_at', { ascending: false })
      .returns<FormulaRow[]>();
    if (formulasError) this.throwQueryError('fetchVisitColourFormulas', formulasError.message);

    const rows = formulas ?? [];
    if (rows.length === 0) return [];

    const { data: items, error: itemsError } = await this.admin
      .schema('lab')
      .from('formula_items')
      .select('formula_id,product_name,brand,shade,developer,ratio,processing_time_minutes,captured_grams,cost_cents')
      .in(
        'formula_id',
        rows.map((row) => row.id),
      )
      .returns<FormulaItemRow[]>();
    if (itemsError) this.throwQueryError('fetchVisitColourFormulas', itemsError.message);

    const itemsByFormula = new Map<string, RawColourItem[]>();
    for (const item of items ?? []) {
      const list = itemsByFormula.get(item.formula_id) ?? [];
      const grams = Number(item.captured_grams);
      list.push({
        productName: item.product_name,
        brand: item.brand ?? undefined,
        shade: item.shade ?? undefined,
        developer: item.developer ?? undefined,
        ratio: item.ratio ?? undefined,
        processingTimeMinutes: item.processing_time_minutes ?? undefined,
        grams: Number.isFinite(grams) && grams > 0 ? grams : undefined,
        costCents: Math.max(0, item.cost_cents ?? 0),
      });
      itemsByFormula.set(item.formula_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      savedAt: row.saved_at ?? undefined,
      billableChargeCents: Math.max(0, row.billable_charge_cents ?? 0),
      items: itemsByFormula.get(row.id) ?? [],
    }));
  }

  private async fetchStaffTodayAppointments(
    businessId: string,
    staffProfileId: string,
    allowedLocationIds: string[],
    rangeStart: string,
    rangeEnd: string,
  ): Promise<StaffBookingSummary[]> {
    if (allowedLocationIds.length === 0) return [];

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('assigned_staff_profile_id', staffProfileId)
      .in('location_id', allowedLocationIds)
      .gte('scheduled_start_at', rangeStart)
      .lt('scheduled_start_at', rangeEnd)
      .order('scheduled_start_at', { ascending: true })
      .returns<AppointmentRow[]>();
    if (error) this.throwQueryError('fetchStaffTodayAppointments', error.message);

    return this.withClientNames(businessId, data ?? []);
  }

  private async fetchLocationTodayAppointments(
    businessId: string,
    locationId: string,
    rangeStart: string,
    rangeEnd: string,
  ): Promise<StaffBookingSummary[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(APPOINTMENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .gte('scheduled_start_at', rangeStart)
      .lt('scheduled_start_at', rangeEnd)
      .order('scheduled_start_at', { ascending: true })
      .returns<AppointmentRow[]>();
    if (error) this.throwQueryError('fetchLocationTodayAppointments', error.message);

    return this.withClientNames(businessId, data ?? []);
  }

  private async withClientNames(businessId: string, appointments: AppointmentRow[]): Promise<StaffBookingSummary[]> {
    const clientIds = Array.from(new Set(appointments.map((appointment) => appointment.client_profile_id)));
    const clients = await this.fetchClientProfiles(businessId, clientIds);
    return appointments.map((row) => toBookingSummary(row, clients.get(row.client_profile_id)));
  }

  private async fetchClientProfiles(
    businessId: string,
    clientProfileIds: string[],
  ): Promise<Map<string, ClientProfileRow>> {
    if (clientProfileIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', businessId)
      .in('id', clientProfileIds)
      .returns<ClientProfileRow[]>();
    if (error) this.throwQueryError('fetchClientProfiles', error.message);

    return new Map((data ?? []).map((client) => [client.id, client]));
  }

  private async countStylistsWorkingToday(
    businessId: string,
    locationId: string,
    rangeStart: string,
    rangeEnd: string,
  ): Promise<number> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select('staff_profile_id')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .gte('scheduled_start_at', rangeStart)
      .lt('scheduled_start_at', rangeEnd)
      .neq('status', 'cancelled')
      .returns<ShiftRow[]>();
    if (error) this.throwQueryError('countStylistsWorkingToday', error.message);

    return new Set((data ?? []).map((row) => row.staff_profile_id)).size;
  }

  private async countLowStockAlerts(businessId: string, locationId: string): Promise<number> {
    const { count, error } = await this.admin
      .schema('inventory')
      .from('low_stock_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .eq('status', 'open')
      .returns<StockRow[]>();
    if (error) this.throwQueryError('countLowStockAlerts', error.message);

    return count ?? 0;
  }

  private throwQueryError(operation: string, message: string): never {
    this.logger.error(`${operation} failed: ${message}`);
    throw new InternalServerErrorException('Unable to load mobile dashboard');
  }
}

function todayRange(): { rangeStart: string; rangeEnd: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

function toBookingSummary(
  row: AppointmentRow,
  client?: ClientProfileRow,
  cancellationWindowHours?: number,
): StaffBookingSummary {
  const services = arrayOf(row.appointment_services);
  const deposits = arrayOf(row.deposits);
  const durationMinutes = services.reduce((sum, service) => sum + Number(service.duration_minutes ?? 0), 0);
  const depositRequiredAmount = services.reduce(
    (sum, service) => sum + Number(service.deposit_required_amount ?? 0),
    0,
  );
  const serviceIds = services
    .map((service) => service.service_id)
    .filter((id): id is string => Boolean(id));

  // The deadline a customer must cancel/rebook by to keep their deposit (only
  // surfaced when the location has a window — client dashboard path).
  const refundCutoffAt =
    cancellationWindowHours !== undefined
      ? new Date(new Date(row.scheduled_start_at).getTime() - cancellationWindowHours * 3_600_000).toISOString()
      : undefined;

  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    clientProfileId: row.client_profile_id,
    assignedStaffProfileId: row.assigned_staff_profile_id ?? undefined,
    requestedStaffProfileId: row.requested_staff_profile_id ?? undefined,
    status: row.status,
    startsAt: row.scheduled_start_at,
    endsAt: row.scheduled_end_at,
    clientDisplayName: client ? clientName(client) : 'Client',
    serviceNames: services.map((service) => service.service_name_snapshot),
    serviceIds: serviceIds.length ? serviceIds : undefined,
    durationMinutes: durationMinutes || minutesBetween(row.scheduled_start_at, row.scheduled_end_at),
    depositRequiredAmount: depositRequiredAmount || undefined,
    depositStatus: deposits[0]?.status,
    clientNote: row.client_note ?? undefined,
    cancellationWindowHours,
    refundCutoffAt,
  };
}

function toVisitSummary(row: VisitRow): CrmVisitSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    appointmentId: row.appointment_id ?? undefined,
    clientProfileId: row.client_profile_id,
    primaryStaffProfileId: row.primary_staff_profile_id ?? undefined,
    status: row.status,
    occurredAt: row.completed_at ?? row.started_at ?? row.checked_in_at ?? row.created_at,
    serviceSummary: row.service_summary ?? undefined,
    clientVisibleSummary: row.client_visible_summary ?? undefined,
  };
}

/** Sum already-gross major-unit amounts back into whole cents, ignoring gaps. */
function sumGrossCents(amounts: Array<number | undefined>): number {
  return amounts.reduce((sum: number, amount) => sum + (amount != null ? Math.round(amount * 100) : 0), 0);
}

function toColourFormula(formula: RawColourFormula, taxSettings: LocationTaxSettings): ClientVisitColourFormula {
  // The customer charge for the whole colour formula (product cost + the
  // location's markup rule) made VAT-inclusive, then split across products by
  // cost weight so each colour shows its share of the gross charge.
  const grossChargeCents = calculateTaxForCategory(formula.billableChargeCents, 'retail', taxSettings).grossCents;
  const allocations = allocateByWeight(
    grossChargeCents,
    formula.items.map((item) => item.costCents),
  );
  return {
    id: formula.id,
    savedAt: formula.savedAt,
    items: formula.items.map((item, idx) => ({
      productName: item.productName,
      brand: item.brand,
      shade: item.shade,
      developer: item.developer,
      ratio: item.ratio,
      processingTimeMinutes: item.processingTimeMinutes,
      grams: item.grams,
      priceAmount: allocations[idx] > 0 ? allocations[idx] / 100 : undefined,
    })),
  };
}

/**
 * Split a gross charge across line items proportionally to their weights, in
 * whole cents. The rounding remainder goes to the largest shares first so the
 * per-item prices always foot back to `totalCents`. Falls back to an even split
 * when there is no weight to go on (e.g. a fixed uplift on zero-cost products).
 */
function allocateByWeight(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (totalCents <= 0) return weights.map(() => 0);
  const weightSum = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  const effective = weightSum > 0 ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : n;
  const out = effective.map((w) => Math.floor((totalCents * w) / effectiveSum));
  let remainder = totalCents - out.reduce((sum, c) => sum + c, 0);
  const order = effective.map((_, i) => i).sort((a, b) => effective[b] - effective[a]);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    out[order[k]] += 1;
  }
  return out;
}

function arrayOf<T>(value: T[] | T | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function clientName(client: ClientProfileRow): string {
  return `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim() || 'Client';
}

function minutesBetween(startIso: string, endIso: string): number | undefined {
  const minutes = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}
