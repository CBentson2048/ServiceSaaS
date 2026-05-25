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
  ListStaffBookingsResponse,
  StaffBookingPatchTestSummary,
  StaffBookingDetail,
  StaffBookingSummary,
} from '@sheer/domain';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';

interface AppointmentServiceRow {
  service_name_snapshot: string;
  duration_minutes: number;
  deposit_required_amount: number | string;
}

interface DepositRow {
  status: string;
  amount: number | string;
}

interface ClientProfileRow {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
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
  communication_preference?: string | null;
  client_note: string | null;
  internal_note?: string | null;
  appointment_services: AppointmentServiceRow[] | AppointmentServiceRow | null;
  deposits?: DepositRow[] | DepositRow | null;
}

interface PatchTestRow {
  client_profile_id: string;
  status: 'pending' | 'passed' | 'failed' | 'expired';
  performed_at: string;
  expires_at: string | null;
}

interface ScopedAppointmentQuery<TQuery> {
  eq: (column: string, value: unknown) => TQuery;
  in: (column: string, values: readonly unknown[]) => TQuery;
}

const ACTIVE_BOOKING_STATUSES: AppointmentStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
];

const LIST_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,client_note,appointment_services(service_name_snapshot,duration_minutes,deposit_required_amount),deposits(status,amount)';

const DETAIL_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,communication_preference,client_note,internal_note,appointment_services(service_name_snapshot,duration_minutes,deposit_required_amount),deposits(status,amount)';

@Injectable()
export class LabAppointmentsService {
  private readonly logger = new Logger(LabAppointmentsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async list(actor: AuthUser, rawLocationId?: string): Promise<ListStaffBookingsResponse> {
    let query = this.admin
      .schema('booking')
      .from('appointments')
      .select(LIST_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('scheduled_start_at', { ascending: false });

    query = this.applyActorScope(query, actor, rawLocationId);

    const { data, error } = await query.returns<AppointmentRow[]>();
    if (error) {
      this.logger.error(`list failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load bookings');
    }

    const rows = data ?? [];
    const clientsById = await this.fetchClientProfiles(
      actor.businessId,
      rows.map((row) => row.client_profile_id),
    );

    return {
      bookings: rows.map((row) => toBookingSummary(row, clientsById.get(row.client_profile_id))),
      scope: actor.role === 'owner' ? 'owner' : actor.role === 'manager' ? 'manager' : 'stylist',
      rangeStart: rows.at(-1)?.scheduled_start_at ?? '',
      rangeEnd: rows[0]?.scheduled_start_at ?? '',
    };
  }

  async today(actor: AuthUser, rawLocationId?: string): Promise<ListStaffBookingsResponse> {
    const { rangeStart, rangeEnd } = todayRange();
    let query = this.admin
      .schema('booking')
      .from('appointments')
      .select(LIST_COLUMNS)
      .eq('business_id', actor.businessId)
      .gte('scheduled_start_at', rangeStart)
      .lt('scheduled_start_at', rangeEnd)
      .in('status', ACTIVE_BOOKING_STATUSES)
      .order('scheduled_start_at', { ascending: true });

    query = this.applyActorScope(query, actor, rawLocationId);

    const { data, error } = await query.returns<AppointmentRow[]>();
    if (error) {
      this.logger.error(`today failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load bookings');
    }

    const rows = data ?? [];
    const clientsById = await this.fetchClientProfiles(
      actor.businessId,
      rows.map((row) => row.client_profile_id),
    );

    return {
      bookings: rows.map((row) => toBookingSummary(row, clientsById.get(row.client_profile_id))),
      scope: actor.role === 'owner' ? 'owner' : actor.role === 'manager' ? 'manager' : 'stylist',
      rangeStart,
      rangeEnd,
    };
  }

  async todayForLabSession(session: LabRuntimeSession): Promise<ListStaffBookingsResponse> {
    const { rangeStart, rangeEnd } = todayRange();
    const staffProfileId = await this.fetchStaffProfileIdForSession(session);
    const query = this.admin
      .schema('booking')
      .from('appointments')
      .select(LIST_COLUMNS)
      .eq('business_id', session.businessId)
      .eq('location_id', session.locationId)
      .eq('assigned_staff_profile_id', staffProfileId)
      .gte('scheduled_start_at', rangeStart)
      .lt('scheduled_start_at', rangeEnd)
      .in('status', ACTIVE_BOOKING_STATUSES)
      .order('scheduled_start_at', { ascending: true });

    const { data, error } = await query.returns<AppointmentRow[]>();
    if (error) {
      this.logger.error(`todayForLabSession failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load scheduled clients');
    }

    const rows = data ?? [];
    const clientIds = rows.map((row) => row.client_profile_id);
    const [clientsById, patchTestsByClient] = await Promise.all([
      this.fetchClientProfiles(session.businessId, clientIds),
      this.fetchLatestPatchTests(session.businessId, session.locationId, clientIds),
    ]);

    return {
      bookings: rows.map((row) =>
        toBookingSummary(row, clientsById.get(row.client_profile_id), patchTestsByClient.get(row.client_profile_id)),
      ),
      scope: 'stylist',
      rangeStart,
      rangeEnd,
    };
  }

  private applyActorScope<TQuery extends ScopedAppointmentQuery<TQuery>>(
    query: TQuery,
    actor: AuthUser,
    rawLocationId?: string,
  ): TQuery {
    const locationId = this.resolveLocationForActor(actor, rawLocationId);
    if (actor.role === 'stylist') {
      if (!actor.staffProfileId) {
        throw new ForbiddenException('Stylist profile could not be resolved');
      }
      if (actor.allowedLocationIds.length === 0) {
        throw new ForbiddenException('Stylist location scope could not be resolved');
      }
      if (locationId) query = query.eq('location_id', locationId);
      query = query
        .eq('assigned_staff_profile_id', actor.staffProfileId)
        .in('location_id', actor.allowedLocationIds);
    } else if (locationId) {
      query = query.eq('location_id', locationId);
    } else if (actor.role === 'manager') {
      if (actor.allowedLocationIds.length === 0) {
        throw new ForbiddenException('No location scope is assigned');
      }
      query = query.in('location_id', actor.allowedLocationIds);
    }
    return query;
  }

  async detail(actor: AuthUser, id: string): Promise<StaffBookingDetail> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .eq('business_id', actor.businessId)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`detail failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking');
    }
    if (!data) throw new NotFoundException('Booking not found');
    this.assertCanAccessAppointment(actor, data);

    const clientsById = await this.fetchClientProfiles(actor.businessId, [data.client_profile_id]);

    return toBookingDetail(data, clientsById.get(data.client_profile_id));
  }

  async detailForLabSession(session: LabRuntimeSession, id: string): Promise<StaffBookingDetail> {
    const staffProfileId = await this.fetchStaffProfileIdForSession(session);
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .eq('business_id', session.businessId)
      .eq('location_id', session.locationId)
      .eq('assigned_staff_profile_id', staffProfileId)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`detailForLabSession failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load scheduled client');
    }
    if (!data) throw new NotFoundException('Scheduled client not found for this Lab session');

    const [clientsById, patchTestsByClient] = await Promise.all([
      this.fetchClientProfiles(session.businessId, [data.client_profile_id]),
      this.fetchLatestPatchTests(session.businessId, session.locationId, [data.client_profile_id]),
    ]);

    return toBookingDetail(
      data,
      clientsById.get(data.client_profile_id),
      patchTestsByClient.get(data.client_profile_id),
    );
  }

  private async fetchClientProfiles(
    businessId: string,
    clientProfileIds: string[],
  ): Promise<Map<string, ClientProfileRow>> {
    const uniqueIds = [...new Set(clientProfileIds)];
    if (uniqueIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,first_name,last_name')
      .eq('business_id', businessId)
      .in('id', uniqueIds)
      .returns<ClientProfileRow[]>();

    if (error) {
      this.logger.error(`fetchClientProfiles failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking clients');
    }

    return new Map((data ?? []).map((client) => [client.id, client]));
  }

  private async fetchLatestPatchTests(
    businessId: string,
    locationId: string,
    clientProfileIds: string[],
  ): Promise<Map<string, StaffBookingPatchTestSummary>> {
    const uniqueIds = [...new Set(clientProfileIds)];
    if (uniqueIds.length === 0) return new Map();

    const { data, error } = await this.admin
      .schema('crm')
      .from('patch_tests')
      .select('client_profile_id,status,performed_at,expires_at')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .in('client_profile_id', uniqueIds)
      .order('performed_at', { ascending: false })
      .returns<PatchTestRow[]>();

    if (error) {
      this.logger.error(`fetchLatestPatchTests failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load patch test alerts');
    }

    const byClient = new Map<string, StaffBookingPatchTestSummary>();
    for (const row of data ?? []) {
      if (byClient.has(row.client_profile_id)) continue;
      byClient.set(row.client_profile_id, toPatchTestSummary(row));
    }
    return byClient;
  }

  private async fetchStaffProfileIdForSession(session: LabRuntimeSession): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id')
      .eq('business_id', session.businessId)
      .eq('user_profile_id', session.userProfileId)
      .eq('primary_location_id', session.locationId)
      .maybeSingle<{ id: string }>();

    if (error) {
      this.logger.error(`fetchStaffProfileIdForSession failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate stylist session');
    }
    if (!data) throw new ForbiddenException('Stylist profile is not valid for this Lab session location');
    return data.id;
  }

  private resolveLocationForActor(actor: AuthUser, locationId?: string): string | undefined {
    if (!locationId) return undefined;
    if (actor.role === 'owner' || actor.allowedLocationIds.includes(locationId)) return locationId;
    throw new ForbiddenException('Location is outside the signed-in user scope');
  }

  private assertCanAccessAppointment(actor: AuthUser, appointment: AppointmentRow): void {
    if (actor.role === 'owner') return;
    if (!actor.allowedLocationIds.includes(appointment.location_id)) {
      throw new ForbiddenException('Booking is outside your location scope');
    }
    if (actor.role === 'manager') return;
    if (actor.role === 'stylist' && appointment.assigned_staff_profile_id === actor.staffProfileId) return;
    throw new ForbiddenException('Booking is outside your stylist scope');
  }
}

function todayRange(): { rangeStart: string; rangeEnd: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

function toBookingSummary(
  row: AppointmentRow,
  client?: ClientProfileRow,
  patchTest?: StaffBookingPatchTestSummary,
): StaffBookingSummary {
  const services = arrayOf(row.appointment_services);
  const deposits = arrayOf(row.deposits);
  const depositRequiredAmount = services.reduce(
    (sum, service) => sum + Number(service.deposit_required_amount ?? 0),
    0,
  );
  const durationMinutes = services.reduce(
    (sum, service) => sum + Number(service.duration_minutes ?? 0),
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
    clientDisplayName: clientName(client),
    serviceNames: services.map((service) => service.service_name_snapshot),
    durationMinutes: durationMinutes || minutesBetween(row.scheduled_start_at, row.scheduled_end_at),
    depositRequiredAmount: depositRequiredAmount || undefined,
    depositStatus: deposits[0]?.status,
    clientNote: row.client_note ?? undefined,
    patchTest,
  };
}

function toBookingDetail(
  row: AppointmentRow,
  client?: ClientProfileRow,
  patchTest?: StaffBookingPatchTestSummary,
): StaffBookingDetail {
  return {
    ...toBookingSummary(row, client, patchTest),
    communicationPreference: row.communication_preference ?? undefined,
    internalNote: row.internal_note ?? undefined,
  };
}

function toPatchTestSummary(row: PatchTestRow): StaffBookingPatchTestSummary {
  const expiredByDate = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
  return {
    status: row.status === 'passed' && expiredByDate ? 'expired' : row.status,
    performedAt: row.performed_at,
    expiresAt: row.expires_at ?? undefined,
  };
}

function arrayOf<T>(value: T[] | T | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function clientName(client?: ClientProfileRow): string {
  if (!client) return 'Client';
  const fullName = `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim();
  return fullName || 'Client';
}

function minutesBetween(startIso: string, endIso: string): number | undefined {
  const minutes = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}
