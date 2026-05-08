import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AppointmentStatus,
  CreatePublicBookingRequest,
  CreatePublicBookingResponse,
  PublicBookingAvailabilityResponse,
  PublicBookingAvailabilitySlot,
  PublicBookingLocationsResponse,
  PublicBookingLocationSummary,
  PublicBookingServiceSelectionResponse,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  PublicBookingStylistsResponse,
} from '@sheer/domain';
import type {
  PublicBookingAvailabilityQueryDto,
  PublicBookingSelectionQueryDto,
  PublicBookingStylistsQueryDto,
} from './dto';

interface LocationRow {
  id: string;
  business_id: string;
  name: string;
  slug: string;
  timezone: string;
  is_active: boolean;
  businesses: { slug: string; default_currency_code: string } | { slug: string; default_currency_code: string }[] | null;
  location_settings: {
    online_booking_enabled: boolean;
    allow_next_available: boolean;
    appointment_slot_minutes: number;
    same_day_booking_cutoff_minutes: number;
    cancellation_notice_hours: number;
    currency_code: string;
  } | {
    online_booking_enabled: boolean;
    allow_next_available: boolean;
    appointment_slot_minutes: number;
    same_day_booking_cutoff_minutes: number;
    cancellation_notice_hours: number;
    currency_code: string;
  }[] | null;
}

interface ServiceRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  description: string | null;
  category: string | null;
  estimated_duration_minutes: number;
  base_price: number | string;
  deposit_type: 'none' | 'fixed_amount' | 'percentage';
  deposit_value: number | string;
  is_active: boolean;
  sort_order: number;
}

interface StaffRow {
  id: string;
  display_name: string;
  color_hex: string | null;
  bio: string | null;
}

interface ShiftRow {
  id: string;
  staff_profile_id: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
}

interface BreakRow {
  shift_id: string;
  started_at: string;
  ended_at: string;
}

interface AppointmentRow {
  assigned_staff_profile_id: string | null;
  scheduled_start_at: string;
  scheduled_end_at: string;
}

interface LeaveRow {
  staff_profile_id: string;
  start_date: string;
  end_date: string;
}

interface AbsenceRow {
  staff_profile_id: string;
  starts_at: string;
  ends_at: string | null;
}

interface ClientProfileRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  communication_preference?: string | null;
}

interface AppointmentInsertRow {
  id: string;
  status: AppointmentStatus;
  scheduled_start_at: string;
  scheduled_end_at: string;
}

const LOCATION_COLUMNS =
  'id,business_id,name,slug,timezone,is_active,businesses!inner(slug,default_currency_code),location_settings(online_booking_enabled,allow_next_available,appointment_slot_minutes,same_day_booking_cutoff_minutes,cancellation_notice_hours,currency_code)';
const SERVICE_COLUMNS =
  'id,business_id,location_id,name,description,category,estimated_duration_minutes,base_price,deposit_type,deposit_value,is_active,sort_order';
const STAFF_COLUMNS = 'id,display_name,color_hex,bio';
const SHIFT_COLUMNS = 'id,staff_profile_id,scheduled_start_at,scheduled_end_at';
const BREAK_COLUMNS = 'shift_id,started_at,ended_at';
const APPOINTMENT_COLUMNS = 'assigned_staff_profile_id,scheduled_start_at,scheduled_end_at';
const LEAVE_COLUMNS = 'staff_profile_id,start_date,end_date';
const ABSENCE_COLUMNS = 'staff_profile_id,starts_at,ends_at';
const LOOKAHEAD_DAYS = 28;

@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async listLocations(): Promise<PublicBookingLocationsResponse> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select(LOCATION_COLUMNS)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .returns<LocationRow[]>();

    if (error) {
      this.logger.error(`listLocations failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking locations');
    }

    const locations = (data ?? [])
      .filter((row) => {
        const settings = first(row.location_settings);
        return settings?.online_booking_enabled ?? true;
      })
      .map(toLocationSummary);

    return { locations };
  }

  async getServiceSelection(
    query: PublicBookingSelectionQueryDto,
  ): Promise<PublicBookingServiceSelectionResponse> {
    const location = await this.resolveLocation(query);
    const services = await this.fetchServices(location.businessId, location.id, location.currencyCode);
    return { location, services };
  }

  async getStylists(query: PublicBookingStylistsQueryDto): Promise<PublicBookingStylistsResponse> {
    const location = await this.resolveLocation(query);
    const service = await this.fetchService(
      location.businessId,
      location.id,
      query.serviceId,
      location.currencyCode,
    );
    const staff = await this.fetchBookableStaff(location.businessId, location.id);
    const nextAvailableByStaff = await this.fetchNextAvailableByStaff(
      location.businessId,
      location.id,
      staff.map((row) => row.id),
      service.estimatedDurationMinutes,
      location.appointmentSlotMinutes,
      { firstOnly: true },
    );

    const stylists = staff.map<PublicBookingStylistSummary>((row) => ({
      staffProfileId: row.id,
      displayName: row.display_name,
      colorHex: row.color_hex ?? undefined,
      bio: row.bio ?? undefined,
      nextAvailableAt: nextAvailableByStaff.get(row.id)?.[0],
    }));

    return {
      location,
      service,
      stylists,
      nextAvailableAt: earliest(Array.from(nextAvailableByStaff.values()).flat()),
    };
  }

  async getAvailability(
    query: PublicBookingAvailabilityQueryDto,
  ): Promise<PublicBookingAvailabilityResponse> {
    const location = await this.resolveLocation(query);
    const service = await this.fetchService(
      location.businessId,
      location.id,
      query.serviceId,
      location.currencyCode,
    );
    const staff = await this.fetchBookableStaff(location.businessId, location.id);
    const requestedStaffIds = query.stylistId
      ? staff.filter((row) => row.id === query.stylistId).map((row) => row.id)
      : staff.map((row) => row.id);

    if (query.stylistId && requestedStaffIds.length === 0) {
      throw new NotFoundException('Stylist is not available for online booking at this location');
    }

    const dateFrom = parseDate(query.dateFrom, 'dateFrom');
    const dateTo = parseDate(query.dateTo, 'dateTo');
    if (dateTo.getTime() <= dateFrom.getTime()) {
      throw new BadRequestException('dateTo must be after dateFrom');
    }

    const slotsByStaff = await this.fetchNextAvailableByStaff(
      location.businessId,
      location.id,
      requestedStaffIds,
      service.estimatedDurationMinutes,
      location.appointmentSlotMinutes,
      { dateFrom, dateTo, firstOnly: query.nextAvailable === 'true' },
    );

    const staffById = new Map(staff.map((row) => [row.id, row]));
    const slots = Array.from(slotsByStaff.entries())
      .flatMap(([staffProfileId, starts]) => {
        const stylist = staffById.get(staffProfileId);
        if (!stylist) return [];
        return starts.map<PublicBookingAvailabilitySlot>((startAt) => {
          const endAt = new Date(
            new Date(startAt).getTime() + service.estimatedDurationMinutes * 60_000,
          ).toISOString();
          return {
            startAt,
            endAt,
            date: toIsoDate(new Date(startAt)),
            locationId: location.id,
            staffProfileId,
            stylistName: stylist.display_name,
          };
        });
      })
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

    return { location, service, slots };
  }

  async createAppointment(input: CreatePublicBookingRequest): Promise<CreatePublicBookingResponse> {
    const location = await this.resolveLocation({ locationId: input.locationId });
    const service = await this.fetchService(
      location.businessId,
      location.id,
      input.serviceId,
      location.currencyCode,
    );
    const staff = await this.fetchBookableStaff(location.businessId, location.id);
    const stylist = staff.find((row) => row.id === input.staffProfileId);
    if (!stylist) {
      throw new BadRequestException('Selected stylist is not available for this location');
    }

    const selectedStart = parseDate(input.selectedStartAt, 'selectedStartAt');
    const selectedEnd = new Date(
      selectedStart.getTime() + service.estimatedDurationMinutes * 60_000,
    );
    const selectedStartIso = selectedStart.toISOString();
    const availability = await this.fetchNextAvailableByStaff(
      location.businessId,
      location.id,
      [input.staffProfileId],
      service.estimatedDurationMinutes,
      location.appointmentSlotMinutes,
      {
        dateFrom: new Date(selectedStart.getTime() - location.appointmentSlotMinutes * 60_000),
        dateTo: new Date(selectedEnd.getTime() + location.appointmentSlotMinutes * 60_000),
        firstOnly: false,
      },
    );
    const selectedStillAvailable = (availability.get(input.staffProfileId) ?? []).some(
      (slot) => slot === selectedStartIso,
    );
    if (!selectedStillAvailable) {
      throw new BadRequestException('Selected slot is no longer available');
    }

    const client = await this.resolveAuthenticatedClient(
      location.businessId,
      location.id,
      input.clientProfileId,
      input.bookedByUserProfileId,
      input.client,
      input.communicationPreference,
    );
    const depositRequiredAmount = calculateDepositAmount(service);
    const { data: appointment, error: appointmentError } = await this.admin
      .schema('booking')
      .from('appointments')
      .insert({
        business_id: location.businessId,
        location_id: location.id,
        client_profile_id: client.id,
        assigned_staff_profile_id: input.staffProfileId,
        requested_staff_profile_id:
          input.staffRequestMode === 'specific_staff' ? input.staffProfileId : null,
        staff_request_mode: input.staffRequestMode,
        status: 'pending',
        booking_channel: 'api',
        scheduled_start_at: selectedStartIso,
        scheduled_end_at: selectedEnd.toISOString(),
        communication_preference: input.communicationPreference,
        client_note: input.clientNote?.trim() || null,
        metadata: {
          source: 'public_booking_flow',
          guest_booking: false,
          booked_by_user_profile_id: input.bookedByUserProfileId,
          deposit_placeholder: depositRequiredAmount > 0,
        },
      })
      .select('id,status,scheduled_start_at,scheduled_end_at')
      .single<AppointmentInsertRow>();

    if (appointmentError || !appointment) {
      const message = appointmentError?.message ?? 'no appointment row';
      if (message.toLowerCase().includes('booking_appointments_staff_no_overlap')) {
        throw new BadRequestException('Selected slot is no longer available');
      }
      this.logger.error(`createAppointment insert appointment failed: ${message}`);
      throw new InternalServerErrorException('Unable to create appointment');
    }

    const { error: serviceError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .insert({
        business_id: location.businessId,
        location_id: location.id,
        appointment_id: appointment.id,
        service_id: service.id,
        assigned_staff_profile_id: input.staffProfileId,
        sequence_no: 1,
        service_name_snapshot: service.name,
        duration_minutes: service.estimatedDurationMinutes,
        price_amount: service.startingPriceAmount,
        deposit_required_amount: depositRequiredAmount,
        status: 'scheduled',
        scheduled_start_at: selectedStartIso,
        scheduled_end_at: selectedEnd.toISOString(),
      });

    if (serviceError) {
      this.logger.error(`createAppointment insert service failed: ${serviceError.message}`);
      await this.admin
        .schema('booking')
        .from('appointments')
        .delete()
        .eq('id', appointment.id)
        .eq('business_id', location.businessId);
      throw new InternalServerErrorException('Unable to create appointment service');
    }

    return {
      appointment: {
        id: appointment.id,
        locationId: location.id,
        serviceId: service.id,
        serviceName: service.name,
        staffProfileId: input.staffProfileId,
        stylistName: stylist.display_name,
        scheduledStartAt: appointment.scheduled_start_at,
        scheduledEndAt: appointment.scheduled_end_at,
        status: appointment.status,
        clientDisplayName: `${client.first_name} ${client.last_name}`.trim(),
        communicationPreference: input.communicationPreference,
        depositRequiredAmount,
        currencyCode: location.currencyCode,
      },
      depositRequired: depositRequiredAmount > 0,
      depositPlaceholder: depositRequiredAmount > 0,
    };
  }

  private async resolveLocation(
    query: PublicBookingSelectionQueryDto,
  ): Promise<PublicBookingLocationSummary> {
    if (!query.locationId && (!query.businessSlug || !query.locationSlug)) {
      throw new BadRequestException('locationId or businessSlug + locationSlug is required');
    }

    let request = this.admin
      .schema('core')
      .from('locations')
      .select(LOCATION_COLUMNS)
      .eq('is_active', true)
      .limit(1);

    if (query.locationId) {
      request = request.eq('id', query.locationId);
    } else {
      request = request
        .eq('slug', query.locationSlug)
        .eq('businesses.slug', query.businessSlug);
    }

    const { data, error } = await request.maybeSingle<LocationRow>();
    if (error) {
      this.logger.error(`resolveLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking location');
    }
    if (!data) throw new NotFoundException('Booking location not found');

    const settings = first(data.location_settings);
    if (settings && !settings.online_booking_enabled) {
      throw new NotFoundException('Online booking is not available for this location');
    }
    return toLocationSummary(data);
  }

  private async fetchServices(
    businessId: string,
    locationId: string,
    currencyCode: string,
  ): Promise<PublicBookingServiceSummary[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .returns<ServiceRow[]>();

    if (error) {
      this.logger.error(`fetchServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }

    return (data ?? []).map((row) => toServiceSummary(row, currencyCode));
  }

  private async fetchService(
    businessId: string,
    locationId: string,
    serviceId: string,
    currencyCode: string,
  ): Promise<PublicBookingServiceSummary> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .single<ServiceRow>();

    if (error || !data) {
      if (error?.code === 'PGRST116') throw new NotFoundException('Service not found');
      this.logger.error(`fetchService failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to load service');
    }
    return toServiceSummary(data, currencyCode);
  }

  private async fetchBookableStaff(businessId: string, locationId: string): Promise<StaffRow[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('business_id', businessId)
      .eq('primary_location_id', locationId)
      .eq('is_bookable', true)
      .neq('employment_status', 'terminated')
      .order('display_name', { ascending: true })
      .returns<StaffRow[]>();

    if (error) {
      this.logger.error(`fetchBookableStaff failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stylists');
    }
    return data ?? [];
  }

  private async fetchNextAvailableByStaff(
    businessId: string,
    locationId: string,
    staffIds: string[],
    durationMinutes: number,
    slotMinutes: number,
    options: {
      dateFrom?: Date;
      dateTo?: Date;
      firstOnly?: boolean;
    } = {},
  ): Promise<Map<string, string[]>> {
    if (staffIds.length === 0) return new Map();
    const now = new Date();
    const searchStart = options.dateFrom
      ? new Date(Math.max(options.dateFrom.getTime(), now.getTime()))
      : new Date(now.getTime() + slotMinutes * 60_000);
    const searchEnd =
      options.dateTo ?? new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60_000);

    const [
      { data: shifts, error: shiftError },
      { data: breaks, error: breakError },
      { data: appointments, error: appointmentError },
      { data: leave, error: leaveError },
      { data: absences, error: absenceError },
    ] = await Promise.all([
        this.admin
          .schema('rota')
          .from('shifts')
          .select(SHIFT_COLUMNS)
          .eq('business_id', businessId)
          .eq('location_id', locationId)
          .in('staff_profile_id', staffIds)
          .eq('status', 'published')
          .gte('scheduled_end_at', searchStart.toISOString())
          .lt('scheduled_start_at', searchEnd.toISOString())
          .order('scheduled_start_at', { ascending: true })
          .returns<ShiftRow[]>(),
        this.admin
          .schema('rota')
          .from('shift_breaks')
          .select(BREAK_COLUMNS)
          .eq('business_id', businessId)
          .eq('location_id', locationId)
          .gte('ended_at', searchStart.toISOString())
          .lt('started_at', searchEnd.toISOString())
          .returns<BreakRow[]>(),
        this.admin
          .schema('booking')
          .from('appointments')
          .select(APPOINTMENT_COLUMNS)
          .eq('business_id', businessId)
          .eq('location_id', locationId)
          .or(staffIds.map((id) => `assigned_staff_profile_id.eq.${id}`).join(','))
          .in('status', ['pending', 'confirmed', 'checked_in', 'in_progress'])
          .gte('scheduled_end_at', searchStart.toISOString())
          .lt('scheduled_start_at', searchEnd.toISOString())
          .returns<AppointmentRow[]>(),
        this.admin
          .schema('rota')
          .from('leave_requests')
          .select(LEAVE_COLUMNS)
          .eq('business_id', businessId)
          .eq('location_id', locationId)
          .in('staff_profile_id', staffIds)
          .eq('status', 'approved')
          .lte('start_date', toIsoDate(searchEnd))
          .gte('end_date', toIsoDate(searchStart))
          .returns<LeaveRow[]>(),
        this.admin
          .schema('rota')
          .from('absence_events')
          .select(ABSENCE_COLUMNS)
          .eq('business_id', businessId)
          .eq('location_id', locationId)
          .in('staff_profile_id', staffIds)
          .lt('starts_at', searchEnd.toISOString())
          .returns<AbsenceRow[]>(),
      ]);

    if (shiftError) {
      this.logger.error(`fetchNextAvailableByStaff shifts failed: ${shiftError.message}`);
      throw new InternalServerErrorException('Unable to load stylist availability');
    }
    if (breakError) {
      this.logger.error(`fetchNextAvailableByStaff breaks failed: ${breakError.message}`);
      throw new InternalServerErrorException('Unable to load stylist availability');
    }
    if (appointmentError) {
      this.logger.error(`fetchNextAvailableByStaff appointments failed: ${appointmentError.message}`);
      throw new InternalServerErrorException('Unable to load stylist availability');
    }
    if (leaveError) {
      this.logger.error(`fetchNextAvailableByStaff leave failed: ${leaveError.message}`);
      throw new InternalServerErrorException('Unable to load stylist availability');
    }
    if (absenceError) {
      this.logger.error(`fetchNextAvailableByStaff absences failed: ${absenceError.message}`);
      throw new InternalServerErrorException('Unable to load stylist availability');
    }

    const appointmentsByStaff = new Map<string, AppointmentRow[]>();
    for (const appointment of appointments ?? []) {
      if (!appointment.assigned_staff_profile_id) continue;
      const rows = appointmentsByStaff.get(appointment.assigned_staff_profile_id) ?? [];
      rows.push(appointment);
      appointmentsByStaff.set(appointment.assigned_staff_profile_id, rows);
    }
    const breaksByShift = new Map<string, BreakRow[]>();
    for (const breakRow of breaks ?? []) {
      const rows = breaksByShift.get(breakRow.shift_id) ?? [];
      rows.push(breakRow);
      breaksByShift.set(breakRow.shift_id, rows);
    }
    const leaveByStaff = new Map<string, LeaveRow[]>();
    for (const leaveRow of leave ?? []) {
      const rows = leaveByStaff.get(leaveRow.staff_profile_id) ?? [];
      rows.push(leaveRow);
      leaveByStaff.set(leaveRow.staff_profile_id, rows);
    }
    const absencesByStaff = new Map<string, AbsenceRow[]>();
    for (const absence of (absences ?? []).filter((row) => !row.ends_at || new Date(row.ends_at) > searchStart)) {
      const rows = absencesByStaff.get(absence.staff_profile_id) ?? [];
      rows.push(absence);
      absencesByStaff.set(absence.staff_profile_id, rows);
    }

    const result = new Map<string, string[]>();
    for (const shift of shifts ?? []) {
      if (options.firstOnly && result.has(shift.staff_profile_id)) continue;
      const slots = availableSlotsInShift(
        new Date(Math.max(new Date(shift.scheduled_start_at).getTime(), searchStart.getTime())),
        new Date(Math.min(new Date(shift.scheduled_end_at).getTime(), searchEnd.getTime())),
        shift,
        breaksByShift.get(shift.id) ?? [],
        appointmentsByStaff.get(shift.staff_profile_id) ?? [],
        leaveByStaff.get(shift.staff_profile_id) ?? [],
        absencesByStaff.get(shift.staff_profile_id) ?? [],
        durationMinutes,
        slotMinutes,
        Boolean(options.firstOnly),
      );
      if (slots.length > 0) {
        result.set(shift.staff_profile_id, [
          ...(result.get(shift.staff_profile_id) ?? []),
          ...slots.map((slot) => slot.toISOString()),
        ]);
      }
    }
    return result;
  }

  private async resolveAuthenticatedClient(
    businessId: string,
    locationId: string,
    clientProfileId: string,
    bookedByUserProfileId: string,
    input: CreatePublicBookingRequest['client'],
    communicationPreference: CreatePublicBookingRequest['communicationPreference'],
  ): Promise<ClientProfileRow> {
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    if (!firstName || !lastName) {
      throw new BadRequestException('Client first and last name are required');
    }
    const { data: client, error: lookupError } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,first_name,last_name,email,phone,communication_preference')
      .eq('id', clientProfileId)
      .eq('business_id', businessId)
      .eq('user_profile_id', bookedByUserProfileId)
      .maybeSingle<ClientProfileRow>();

    if (lookupError) {
      this.logger.error(`resolveAuthenticatedClient lookup failed: ${lookupError.message}`);
      throw new InternalServerErrorException('Unable to resolve client');
    }
    if (!client) {
      throw new BadRequestException('Sign in or create an account before confirming this booking');
    }

    const { error: updateError } = await this.admin
      .schema('core')
      .from('client_profiles')
      .update({
        primary_location_id: locationId,
        first_name: firstName,
        last_name: lastName,
        email: input.email?.trim().toLowerCase() || client.email,
        phone: input.phone?.trim() || client.phone,
        communication_preference: communicationPreference,
      })
      .eq('id', client.id);

    if (updateError) {
      this.logger.error(`resolveAuthenticatedClient update failed: ${updateError.message}`);
      throw new InternalServerErrorException('Unable to update client profile');
    }

    return {
      ...client,
      first_name: firstName,
      last_name: lastName,
      email: input.email?.trim().toLowerCase() || client.email,
      phone: input.phone?.trim() || client.phone,
      communication_preference: communicationPreference,
    };
  }
}

function toServiceSummary(row: ServiceRow, currencyCode: string): PublicBookingServiceSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    startingPriceAmount: Number(row.base_price),
    depositRequiredAmount: calculateServiceDeposit(row),
    currencyCode,
  };
}

function toLocationSummary(row: LocationRow): PublicBookingLocationSummary {
  const settings = first(row.location_settings);
  const business = first(row.businesses);
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    currencyCode: settings?.currency_code ?? business?.default_currency_code ?? 'GBP',
    appointmentSlotMinutes: settings?.appointment_slot_minutes ?? 15,
    allowNextAvailable: settings?.allow_next_available ?? true,
    cancellationNoticeHours: settings?.cancellation_notice_hours,
  };
}

function availableSlotsInShift(
  start: Date,
  end: Date,
  shift: ShiftRow,
  breaks: BreakRow[],
  appointments: AppointmentRow[],
  leave: LeaveRow[],
  absences: AbsenceRow[],
  durationMinutes: number,
  slotMinutes: number,
  firstOnly: boolean,
): Date[] {
  const slotMs = slotMinutes * 60_000;
  const durationMs = durationMinutes * 60_000;
  let cursor = roundUpToIncrement(start, slotMs);
  const busy = [
    ...breaks.map((row) => ({ start: new Date(row.started_at), end: new Date(row.ended_at) })),
    ...appointments.map((appointment) => ({
      start: new Date(appointment.scheduled_start_at),
      end: new Date(appointment.scheduled_end_at),
    })),
    ...leave.map((row) => dateRangeToBusy(row.start_date, row.end_date)),
    ...absences.map((row) => ({
      start: new Date(row.starts_at),
      end: row.ends_at ? new Date(row.ends_at) : end,
    })),
  ]
    .filter((range) => range.start < end && range.end > start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const slots: Date[] = [];

  if (leave.some((row) => dateRangeContains(row, start))) return slots;
  if (shift.staff_profile_id.length === 0) return slots;

  while (cursor.getTime() + durationMs <= end.getTime()) {
    const slotEnd = new Date(cursor.getTime() + durationMs);
    const conflict = busy.find((range) => cursor < range.end && slotEnd > range.start);
    if (!conflict) {
      slots.push(cursor);
      if (firstOnly) return slots;
      cursor = new Date(cursor.getTime() + slotMs);
      continue;
    }
    cursor = roundUpToIncrement(conflict.end, slotMs);
  }
  return slots;
}

function dateRangeToBusy(startDate: string, endDate: string): { start: Date; end: Date } {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function dateRangeContains(row: LeaveRow, date: Date): boolean {
  const range = dateRangeToBusy(row.start_date, row.end_date);
  return date >= range.start && date < range.end;
}

function calculateDepositAmount(service: PublicBookingServiceSummary): number {
  return service.depositRequiredAmount;
}

function calculateServiceDeposit(row: ServiceRow): number {
  const price = Number(row.base_price);
  const value = Number(row.deposit_value);
  if (row.deposit_type === 'fixed_amount') return Math.max(0, value);
  if (row.deposit_type === 'percentage') return Math.max(0, Math.round((price * value) / 100));
  return 0;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${label} must be a valid ISO date`);
  }
  return date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function roundUpToIncrement(date: Date, incrementMs: number): Date {
  return new Date(Math.ceil(date.getTime() / incrementMs) * incrementMs);
}

function earliest(values: string[]): string | undefined {
  return values.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
}

function first<T>(value: T | T[] | null): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}
