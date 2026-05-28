import { ForbiddenException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AppointmentStatus,
  AuthUser,
  CrmVisitSummary,
  MobileClientDashboardResponse,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  MobileStylistDashboardResponse,
  StaffBookingSummary,
} from '@sheer/domain';

interface AppointmentServiceRow {
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

interface ShiftRow {
  staff_profile_id: string;
}

interface StockRow {
  id: string;
}

const APPOINTMENT_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,client_note,appointment_services(service_name_snapshot,duration_minutes,deposit_required_amount),deposits(status,amount)';
const CLIENT_COLUMNS = 'id,first_name,last_name,communication_preference';
const VISIT_COLUMNS =
  'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,service_summary,client_visible_summary,created_at';

@Injectable()
export class MobileDashboardService {
  private readonly logger = new Logger(MobileDashboardService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async client(actor: AuthUser): Promise<MobileClientDashboardResponse> {
    if (actor.role !== 'client' || !actor.clientProfileId) {
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
    if (actor.role !== 'stylist' || !actor.staffProfileId) {
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
    if (actor.role !== 'manager') {
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
    if (actor.role !== 'owner') {
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
      .not('status', 'in', '("cancelled","no_show")')
      .order('scheduled_start_at', { ascending: true })
      .limit(8)
      .returns<AppointmentRow[]>();
    if (error) this.throwQueryError('fetchClientUpcomingAppointments', error.message);

    const client = await this.fetchClientProfile(businessId, clientProfileId);
    return (data ?? []).map((row) => toBookingSummary(row, client));
  }

  private async fetchClientVisitHistory(businessId: string, clientProfileId: string): Promise<CrmVisitSummary[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('business_id', businessId)
      .eq('client_profile_id', clientProfileId)
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<VisitRow[]>();
    if (error) this.throwQueryError('fetchClientVisitHistory', error.message);

    return (data ?? []).map(toVisitSummary);
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

function toBookingSummary(row: AppointmentRow, client?: ClientProfileRow): StaffBookingSummary {
  const services = arrayOf(row.appointment_services);
  const deposits = arrayOf(row.deposits);
  const durationMinutes = services.reduce((sum, service) => sum + Number(service.duration_minutes ?? 0), 0);
  const depositRequiredAmount = services.reduce(
    (sum, service) => sum + Number(service.deposit_required_amount ?? 0),
    0,
  );

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
    durationMinutes: durationMinutes || minutesBetween(row.scheduled_start_at, row.scheduled_end_at),
    depositRequiredAmount: depositRequiredAmount || undefined,
    depositStatus: deposits[0]?.status,
    clientNote: row.client_note ?? undefined,
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
