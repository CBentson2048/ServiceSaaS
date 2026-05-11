import {
  BadRequestException,
  ConflictException,
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
  PublicBookingAppointmentSummary,
  PublicBookingAttemptResponse,
  PublicBookingAttemptStatus,
  PublicBookingAttemptSummary,
  PublicBookingAvailabilityResponse,
  PublicBookingAvailabilitySlot,
  PublicBookingLocationsResponse,
  PublicBookingLocationSummary,
  PublicBookingServiceSelectionResponse,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  PublicBookingStylistsResponse,
  StartPublicBookingCheckoutRequest,
  StartPublicBookingCheckoutResponse,
} from '@sheer/domain';
import { StripeService, type StripePaymentIntent } from '../stripe/stripe.service';
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

interface BookingAttemptBusyRow {
  id: string;
  stylist_profile_id: string;
  selected_start_at: string;
  selected_end_at: string;
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

interface BookingAttemptRow {
  id: string;
  business_id: string;
  location_id: string;
  service_id: string;
  stylist_profile_id: string;
  client_profile_id: string;
  user_profile_id: string;
  appointment_id: string | null;
  staff_request_mode: 'specific_staff' | 'next_available';
  selected_start_at: string;
  selected_end_at: string;
  communication_preference: 'whatsapp' | 'sms' | 'email';
  client_note: string | null;
  deposit_amount: number | string;
  currency_code: string;
  stripe_payment_intent_id: string | null;
  status: PublicBookingAttemptStatus;
  expires_at: string;
  metadata: Record<string, unknown>;
}

interface DepositRow {
  id: string;
  status: 'pending' | 'requires_action' | 'authorized' | 'paid' | 'failed' | 'cancelled';
}

const LOCATION_COLUMNS =
  'id,business_id,name,slug,timezone,is_active,businesses!inner(slug,default_currency_code),location_settings(online_booking_enabled,allow_next_available,appointment_slot_minutes,same_day_booking_cutoff_minutes,cancellation_notice_hours,currency_code)';
const SERVICE_COLUMNS =
  'id,business_id,location_id,name,description,category,estimated_duration_minutes,base_price,deposit_type,deposit_value,is_active,sort_order';
const STAFF_COLUMNS = 'id,display_name,color_hex,bio';
const SHIFT_COLUMNS = 'id,staff_profile_id,scheduled_start_at,scheduled_end_at';
const BREAK_COLUMNS = 'shift_id,started_at,ended_at';
const APPOINTMENT_COLUMNS = 'assigned_staff_profile_id,scheduled_start_at,scheduled_end_at';
const BOOKING_ATTEMPT_BUSY_COLUMNS = 'id,stylist_profile_id,selected_start_at,selected_end_at';
const BOOKING_ATTEMPT_COLUMNS =
  'id,business_id,location_id,service_id,stylist_profile_id,client_profile_id,user_profile_id,appointment_id,staff_request_mode,selected_start_at,selected_end_at,communication_preference,client_note,deposit_amount,currency_code,stripe_payment_intent_id,status,expires_at,metadata';
const LEAVE_COLUMNS = 'staff_profile_id,start_date,end_date';
const ABSENCE_COLUMNS = 'staff_profile_id,starts_at,ends_at';
const LOOKAHEAD_DAYS = 28;
const BOOKING_ATTEMPT_TTL_MINUTES = 15;

@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly stripe: StripeService,
  ) {
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

  async createAppointment(_input: CreatePublicBookingRequest): Promise<CreatePublicBookingResponse> {
    throw new BadRequestException('Use /public/booking/start-checkout to create payment-backed bookings');
  }

  async startCheckout(
    input: StartPublicBookingCheckoutRequest,
  ): Promise<StartPublicBookingCheckoutResponse> {
    const context = await this.resolveBookingContext(input);
    const client = await this.resolveAuthenticatedClient(
      context.location.businessId,
      context.location.id,
      input.clientProfileId,
      input.bookedByUserProfileId,
      input.client,
      input.communicationPreference,
    );
    await this.syncUserProfilePhone(input.bookedByUserProfileId, input.client.phone);

    const depositAmount = calculateDepositAmount(context.service);
    if (depositAmount <= 0) {
      throw new BadRequestException('This service does not have a deposit configured');
    }

    const attempt = await this.createPendingBookingAttempt({
      input,
      client,
      location: context.location,
      service: context.service,
      stylist: context.stylist,
      selectedStart: context.selectedStart,
      selectedEnd: context.selectedEnd,
      depositAmount,
    });

    const paymentIntent = await this.stripe.createPaymentIntentForBookingAttempt({
      amount: depositAmount,
      currency: context.location.currencyCode,
      bookingAttemptId: attempt.id,
      locationId: context.location.id,
      serviceId: context.service.id,
      stylistProfileId: context.stylist.id,
      clientProfileId: client.id,
      userProfileId: input.bookedByUserProfileId,
      existingPaymentIntentId: attempt.stripe_payment_intent_id,
    });

    if (!paymentIntent.client_secret) {
      throw new InternalServerErrorException('Stripe did not return a client secret');
    }

    const updatedAttempt = await this.attachPaymentIntentToAttempt(attempt, paymentIntent.id);
    await this.upsertPendingDeposit(updatedAttempt, paymentIntent.id);

    return {
      bookingAttempt: await this.toBookingAttemptSummary(updatedAttempt),
      bookingAttemptId: updatedAttempt.id,
      clientSecret: paymentIntent.client_secret,
      depositAmount,
      currencyCode: context.location.currencyCode,
    };
  }

  async getBookingAttempt(id: string): Promise<PublicBookingAttemptResponse> {
    const attempt = await this.fetchBookingAttemptById(id);
    return { bookingAttempt: await this.toBookingAttemptSummary(attempt) };
  }

  async handlePaymentIntentSucceeded(paymentIntent: StripePaymentIntent): Promise<void> {
    const attempt = await this.fetchBookingAttemptForPaymentIntent(paymentIntent);
    if (attempt.status === 'confirmed' && attempt.appointment_id) {
      await this.markDepositPaid(attempt, paymentIntent);
      return;
    }
    if (attempt.status !== 'pending_payment') return;

    const appointment = await this.finalizePaidBookingAttempt(attempt, paymentIntent);
    await this.markDepositPaid({ ...attempt, appointment_id: appointment.id }, paymentIntent);
  }

  async handlePaymentIntentFailed(paymentIntent: StripePaymentIntent): Promise<void> {
    const attempt = await this.fetchBookingAttemptForPaymentIntent(paymentIntent);
    if (attempt.status === 'confirmed') return;

    const failureReason = paymentIntent.last_payment_error?.message ?? 'Payment failed';
    const { error: attemptError } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .update({ status: 'payment_failed' })
      .eq('id', attempt.id)
      .eq('status', 'pending_payment');

    if (attemptError) {
      this.logger.error(`handlePaymentIntentFailed update attempt failed: ${attemptError.message}`);
      throw new InternalServerErrorException('Unable to update booking attempt');
    }

    const { error: depositError } = await this.admin
      .schema('booking')
      .from('deposits')
      .update({
        status: 'failed',
        failure_reason: failureReason,
        metadata: { stripe_status: paymentIntent.status },
      })
      .eq('booking_attempt_id', attempt.id);

    if (depositError) {
      this.logger.error(`handlePaymentIntentFailed update deposit failed: ${depositError.message}`);
      throw new InternalServerErrorException('Unable to update deposit');
    }
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
      excludeBookingAttemptId?: string;
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
      { data: attempts, error: attemptError },
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
          .schema('booking')
          .from('booking_attempts')
          .select(BOOKING_ATTEMPT_BUSY_COLUMNS)
          .eq('business_id', businessId)
          .eq('location_id', locationId)
          .in('stylist_profile_id', staffIds)
          .eq('status', 'pending_payment')
          .gt('expires_at', now.toISOString())
          .gte('selected_end_at', searchStart.toISOString())
          .lt('selected_start_at', searchEnd.toISOString())
          .returns<BookingAttemptBusyRow[]>(),
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
    if (attemptError) {
      this.logger.error(`fetchNextAvailableByStaff attempts failed: ${attemptError.message}`);
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
    for (const attempt of attempts ?? []) {
      if (attempt.id === options.excludeBookingAttemptId) continue;
      const rows = appointmentsByStaff.get(attempt.stylist_profile_id) ?? [];
      rows.push({
        assigned_staff_profile_id: attempt.stylist_profile_id,
        scheduled_start_at: attempt.selected_start_at,
        scheduled_end_at: attempt.selected_end_at,
      });
      appointmentsByStaff.set(attempt.stylist_profile_id, rows);
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

  private async resolveBookingContext(
    input: StartPublicBookingCheckoutRequest,
    excludeBookingAttemptId?: string,
  ): Promise<{
    location: PublicBookingLocationSummary;
    service: PublicBookingServiceSummary;
    stylist: StaffRow;
    selectedStart: Date;
    selectedEnd: Date;
  }> {
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
    if (input.staffRequestMode === 'next_available' && !location.allowNextAvailable) {
      throw new BadRequestException('Next available booking is not enabled for this location');
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
        excludeBookingAttemptId,
      },
    );
    const selectedStillAvailable = (availability.get(input.staffProfileId) ?? []).some(
      (slot) => slot === selectedStartIso,
    );
    if (!selectedStillAvailable) {
      throw new BadRequestException('Selected slot is no longer available');
    }

    return { location, service, stylist, selectedStart, selectedEnd };
  }

  private async createPendingBookingAttempt(input: {
    input: StartPublicBookingCheckoutRequest;
    client: ClientProfileRow;
    location: PublicBookingLocationSummary;
    service: PublicBookingServiceSummary;
    stylist: StaffRow;
    selectedStart: Date;
    selectedEnd: Date;
    depositAmount: number;
  }): Promise<BookingAttemptRow> {
    const expiresAt = new Date(Date.now() + BOOKING_ATTEMPT_TTL_MINUTES * 60_000).toISOString();
    const { data, error } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .insert({
        business_id: input.location.businessId,
        location_id: input.location.id,
        service_id: input.service.id,
        stylist_profile_id: input.stylist.id,
        client_profile_id: input.client.id,
        user_profile_id: input.input.bookedByUserProfileId,
        staff_request_mode: input.input.staffRequestMode,
        selected_start_at: input.selectedStart.toISOString(),
        selected_end_at: input.selectedEnd.toISOString(),
        communication_preference: input.input.communicationPreference,
        client_note: input.input.clientNote?.trim() || null,
        deposit_amount: input.depositAmount,
        currency_code: input.location.currencyCode,
        status: 'pending_payment',
        expires_at: expiresAt,
        metadata: {
          source: 'public_booking_flow',
          service_name: input.service.name,
          stylist_name: input.stylist.display_name,
          client_display_name: `${input.client.first_name} ${input.client.last_name}`.trim(),
        },
      })
      .select(BOOKING_ATTEMPT_COLUMNS)
      .single<BookingAttemptRow>();

    if (error || !data) {
      const message = error?.message ?? 'no booking attempt row';
      if (message.toLowerCase().includes('booking_attempts_pending_staff_no_overlap')) {
        throw new ConflictException('Selected slot is being checked out by another client');
      }
      this.logger.error(`createPendingBookingAttempt failed: ${message}`);
      throw new InternalServerErrorException('Unable to start booking checkout');
    }

    return data;
  }

  private async attachPaymentIntentToAttempt(
    attempt: BookingAttemptRow,
    paymentIntentId: string,
  ): Promise<BookingAttemptRow> {
    if (attempt.stripe_payment_intent_id === paymentIntentId) return attempt;
    const { data, error } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .update({ stripe_payment_intent_id: paymentIntentId })
      .eq('id', attempt.id)
      .select(BOOKING_ATTEMPT_COLUMNS)
      .single<BookingAttemptRow>();

    if (error || !data) {
      this.logger.error(`attachPaymentIntentToAttempt failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to attach payment intent');
    }

    return data;
  }

  private async upsertPendingDeposit(
    attempt: BookingAttemptRow,
    paymentIntentId: string,
  ): Promise<void> {
    const { error } = await this.admin.schema('booking').from('deposits').upsert(
      {
        business_id: attempt.business_id,
        location_id: attempt.location_id,
        booking_attempt_id: attempt.id,
        appointment_id: attempt.appointment_id,
        client_profile_id: attempt.client_profile_id,
        provider: 'stripe',
        provider_payment_intent_id: paymentIntentId,
        status: 'pending',
        amount: Number(attempt.deposit_amount),
        currency_code: attempt.currency_code,
        metadata: { source: 'public_booking_flow' },
      },
      { onConflict: 'provider_payment_intent_id' },
    );

    if (error) {
      this.logger.error(`upsertPendingDeposit failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to persist deposit');
    }
  }

  private async fetchBookingAttemptById(id: string): Promise<BookingAttemptRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .select(BOOKING_ATTEMPT_COLUMNS)
      .eq('id', id)
      .maybeSingle<BookingAttemptRow>();

    if (error) {
      this.logger.error(`fetchBookingAttemptById failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking attempt');
    }
    if (!data) throw new NotFoundException('Booking attempt not found');
    return data;
  }

  private async fetchBookingAttemptForPaymentIntent(
    paymentIntent: StripePaymentIntent,
  ): Promise<BookingAttemptRow> {
    const metadataAttemptId = paymentIntent.metadata.booking_attempt_id;
    let request = this.admin.schema('booking').from('booking_attempts').select(BOOKING_ATTEMPT_COLUMNS);
    request = metadataAttemptId
      ? request.eq('id', metadataAttemptId)
      : request.eq('stripe_payment_intent_id', paymentIntent.id);

    const { data, error } = await request.maybeSingle<BookingAttemptRow>();
    if (error) {
      this.logger.error(`fetchBookingAttemptForPaymentIntent failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking attempt');
    }
    if (!data) throw new NotFoundException('Booking attempt not found');
    return data;
  }

  private async finalizePaidBookingAttempt(
    attempt: BookingAttemptRow,
    paymentIntent: StripePaymentIntent,
  ): Promise<AppointmentInsertRow> {
    if (attempt.appointment_id) {
      return this.fetchAppointmentInsertRow(attempt.appointment_id);
    }

    const context = await this.resolveBookingContext(
      {
        locationId: attempt.location_id,
        serviceId: attempt.service_id,
        staffProfileId: attempt.stylist_profile_id,
        selectedStartAt: attempt.selected_start_at,
        staffRequestMode: attempt.staff_request_mode,
        client: await this.clientDetailsForAttempt(attempt),
        communicationPreference: attempt.communication_preference,
        clientProfileId: attempt.client_profile_id,
        bookedByUserProfileId: attempt.user_profile_id,
        clientNote: attempt.client_note ?? undefined,
      },
      attempt.id,
    );

    const appointment = await this.insertAppointmentForAttempt(attempt, context, paymentIntent.id);
    await this.insertAppointmentServiceForAttempt(attempt, context, appointment.id);

    const { error } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .update({ status: 'confirmed', appointment_id: appointment.id })
      .eq('id', attempt.id)
      .eq('status', 'pending_payment');

    if (error) {
      this.logger.error(`finalizePaidBookingAttempt update attempt failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to confirm booking attempt');
    }

    return appointment;
  }

  private async insertAppointmentForAttempt(
    attempt: BookingAttemptRow,
    context: {
      location: PublicBookingLocationSummary;
      service: PublicBookingServiceSummary;
      stylist: StaffRow;
      selectedStart: Date;
      selectedEnd: Date;
    },
    paymentIntentId: string,
  ): Promise<AppointmentInsertRow> {
    const { data: appointment, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .insert({
        business_id: attempt.business_id,
        location_id: attempt.location_id,
        client_profile_id: attempt.client_profile_id,
        booked_by_user_profile_id: attempt.user_profile_id,
        assigned_staff_profile_id: attempt.stylist_profile_id,
        requested_staff_profile_id:
          attempt.staff_request_mode === 'specific_staff' ? attempt.stylist_profile_id : null,
        staff_request_mode: attempt.staff_request_mode,
        status: 'confirmed',
        booking_channel: 'api',
        scheduled_start_at: context.selectedStart.toISOString(),
        scheduled_end_at: context.selectedEnd.toISOString(),
        communication_preference: attempt.communication_preference,
        client_note: attempt.client_note,
        metadata: {
          source: 'public_booking_flow',
          booking_attempt_id: attempt.id,
          stripe_payment_intent_id: paymentIntentId,
        },
      })
      .select('id,status,scheduled_start_at,scheduled_end_at')
      .single<AppointmentInsertRow>();

    if (error || !appointment) {
      const message = error?.message ?? 'no appointment row';
      if (message.toLowerCase().includes('booking_appointments_staff_no_overlap')) {
        throw new BadRequestException('Selected slot is no longer available');
      }
      this.logger.error(`insertAppointmentForAttempt failed: ${message}`);
      throw new InternalServerErrorException('Unable to create appointment');
    }

    return appointment;
  }

  private async insertAppointmentServiceForAttempt(
    attempt: BookingAttemptRow,
    context: {
      service: PublicBookingServiceSummary;
      selectedStart: Date;
      selectedEnd: Date;
    },
    appointmentId: string,
  ): Promise<void> {
    const { error } = await this.admin.schema('booking').from('appointment_services').insert({
      business_id: attempt.business_id,
      location_id: attempt.location_id,
      appointment_id: appointmentId,
      service_id: context.service.id,
      assigned_staff_profile_id: attempt.stylist_profile_id,
      sequence_no: 1,
      service_name_snapshot: context.service.name,
      duration_minutes: context.service.estimatedDurationMinutes,
      price_amount: context.service.startingPriceAmount,
      deposit_required_amount: Number(attempt.deposit_amount),
      status: 'scheduled',
      scheduled_start_at: context.selectedStart.toISOString(),
      scheduled_end_at: context.selectedEnd.toISOString(),
    });

    if (error) {
      this.logger.error(`insertAppointmentServiceForAttempt failed: ${error.message}`);
      await this.admin
        .schema('booking')
        .from('appointments')
        .delete()
        .eq('id', appointmentId)
        .eq('business_id', attempt.business_id);
      throw new InternalServerErrorException('Unable to create appointment service');
    }
  }

  private async markDepositPaid(
    attempt: BookingAttemptRow,
    paymentIntent: StripePaymentIntent,
  ): Promise<void> {
    const chargeId =
      typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
    const { error } = await this.admin
      .schema('booking')
      .from('deposits')
      .update({
        appointment_id: attempt.appointment_id,
        provider_charge_id: chargeId ?? null,
        status: 'paid',
        paid_at: new Date().toISOString(),
        metadata: { stripe_status: paymentIntent.status },
      })
      .eq('booking_attempt_id', attempt.id);

    if (error) {
      this.logger.error(`markDepositPaid failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to mark deposit paid');
    }
  }

  private async fetchAppointmentInsertRow(appointmentId: string): Promise<AppointmentInsertRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,status,scheduled_start_at,scheduled_end_at')
      .eq('id', appointmentId)
      .single<AppointmentInsertRow>();

    if (error || !data) {
      throw new InternalServerErrorException('Unable to load appointment');
    }
    return data;
  }

  private async clientDetailsForAttempt(attempt: BookingAttemptRow): Promise<CreatePublicBookingRequest['client']> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('first_name,last_name,email,phone')
      .eq('id', attempt.client_profile_id)
      .single<ClientProfileRow>();

    if (error || !data) {
      throw new InternalServerErrorException('Unable to load booking client');
    }
    return {
      firstName: data.first_name,
      lastName: data.last_name,
      email: data.email ?? undefined,
      phone: data.phone ?? undefined,
    };
  }

  private async syncUserProfilePhone(userProfileId: string, phone?: string): Promise<void> {
    const trimmed = phone?.trim();
    if (!trimmed) return;
    const { error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .update({ phone: trimmed })
      .eq('id', userProfileId);

    if (error) {
      this.logger.error(`syncUserProfilePhone failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update user profile phone');
    }
  }

  private async toBookingAttemptSummary(
    attempt: BookingAttemptRow,
  ): Promise<PublicBookingAttemptSummary> {
    const [location, service, stylist, client, deposit, appointment] = await Promise.all([
      this.resolveLocation({ locationId: attempt.location_id }),
      this.fetchService(attempt.business_id, attempt.location_id, attempt.service_id, attempt.currency_code),
      this.fetchStaffById(attempt.business_id, attempt.location_id, attempt.stylist_profile_id),
      this.fetchClientById(attempt.business_id, attempt.client_profile_id),
      this.fetchDepositForAttempt(attempt.id),
      attempt.appointment_id ? this.fetchAppointmentInsertRow(attempt.appointment_id) : Promise.resolve(undefined),
    ]);

    return {
      id: attempt.id,
      status: attempt.status,
      locationId: location.id,
      serviceId: service.id,
      serviceName: service.name,
      staffProfileId: stylist.id,
      stylistName: stylist.display_name,
      selectedStartAt: attempt.selected_start_at,
      selectedEndAt: attempt.selected_end_at,
      clientDisplayName: `${client.first_name} ${client.last_name}`.trim(),
      communicationPreference: attempt.communication_preference,
      depositAmount: Number(attempt.deposit_amount),
      currencyCode: attempt.currency_code,
      paymentStatus: toPaymentStatus(deposit?.status, attempt.status),
      appointment: appointment
        ? toAppointmentSummary({
            appointment,
            location,
            service,
            stylist,
            client,
            communicationPreference: attempt.communication_preference,
            depositAmount: Number(attempt.deposit_amount),
          })
        : undefined,
    };
  }

  private async fetchStaffById(
    businessId: string,
    locationId: string,
    staffProfileId: string,
  ): Promise<StaffRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('id', staffProfileId)
      .eq('business_id', businessId)
      .eq('primary_location_id', locationId)
      .single<StaffRow>();

    if (error || !data) {
      throw new InternalServerErrorException('Unable to load stylist');
    }
    return data;
  }

  private async fetchClientById(businessId: string, clientProfileId: string): Promise<ClientProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,first_name,last_name,email,phone,communication_preference')
      .eq('id', clientProfileId)
      .eq('business_id', businessId)
      .single<ClientProfileRow>();

    if (error || !data) {
      throw new InternalServerErrorException('Unable to load client');
    }
    return data;
  }

  private async fetchDepositForAttempt(attemptId: string): Promise<DepositRow | undefined> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('deposits')
      .select('id,status')
      .eq('booking_attempt_id', attemptId)
      .maybeSingle<DepositRow>();

    if (error) {
      throw new InternalServerErrorException('Unable to load deposit');
    }
    return data ?? undefined;
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

function toAppointmentSummary(input: {
  appointment: AppointmentInsertRow;
  location: PublicBookingLocationSummary;
  service: PublicBookingServiceSummary;
  stylist: StaffRow;
  client: ClientProfileRow;
  communicationPreference: string;
  depositAmount: number;
}): PublicBookingAppointmentSummary {
  return {
    id: input.appointment.id,
    locationId: input.location.id,
    serviceId: input.service.id,
    serviceName: input.service.name,
    staffProfileId: input.stylist.id,
    stylistName: input.stylist.display_name,
    scheduledStartAt: input.appointment.scheduled_start_at,
    scheduledEndAt: input.appointment.scheduled_end_at,
    status: input.appointment.status,
    clientDisplayName: `${input.client.first_name} ${input.client.last_name}`.trim(),
    communicationPreference: input.communicationPreference,
    depositRequiredAmount: input.depositAmount,
    currencyCode: input.location.currencyCode,
  };
}

function toPaymentStatus(
  depositStatus: DepositRow['status'] | undefined,
  attemptStatus: PublicBookingAttemptStatus,
): PublicBookingAttemptSummary['paymentStatus'] {
  if (depositStatus === 'paid') return 'paid';
  if (depositStatus === 'failed' || attemptStatus === 'payment_failed') return 'failed';
  if (depositStatus === 'cancelled' || attemptStatus === 'cancelled') return 'cancelled';
  return 'pending';
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
