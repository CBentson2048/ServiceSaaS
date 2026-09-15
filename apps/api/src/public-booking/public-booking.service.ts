import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  type OccupancyService,
  type OffsetInterval,
  type TimeInterval,
  occupiedOffsets,
  occupiedIntervalsFrom,
  parseMultirange,
  toMultirangeLiteral,
} from '../common/occupied-ranges';
import type {
  AppointmentStatus,
  AuthUser,
  CreatePublicBookingRequest,
  CreatePublicBookingResponse,
  CreateStaffBookingRequest,
  CreateStaffBookingResponse,
  MobileBookingConfirmRequest,
  MobileBookingStartCheckoutRequest,
  PublicBookingAppointmentSummary,
  PublicBookingAttemptResponse,
  PublicBookingAttemptStatus,
  PublicBookingAttemptSummary,
  PublicBookingAvailabilityResponse,
  PublicBookingAvailabilitySlot,
  PublicBookingFinishingRequirement,
  PublicBookingLocationsResponse,
  PublicBookingLocationSummary,
  PublicBookingServiceSelectionResponse,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  PublicBookingStylistsResponse,
  PublicBookingUpgradeSuggestion,
  StaffBookingSource,
  StartPublicBookingCheckoutRequest,
  StartPublicBookingCheckoutResponse,
} from '@sheer/domain';
import { depositForServicePrice, userHasRole } from '@sheer/domain';
import { AuthService } from '../auth/auth.service';
import { BookingNotificationService } from '../communications/booking-notification.service';
import { RebookingService } from '../rebooking/rebooking.service';
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
  public_code: string | null;
  timezone: string;
  is_active: boolean;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
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

interface ServiceCategoryEmbed {
  id: string;
  name: string;
  color_hex: string | null;
  sort_order: number;
}

interface ServiceSegmentEmbed {
  name: string;
  duration_minutes: number;
  is_stylist_free: boolean;
  sort_order: number;
}

interface ServiceRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  description: string | null;
  service_category_id: string | null;
  // Managed category embedded via the service_category_id FK (booking schema).
  service_categories: ServiceCategoryEmbed | ServiceCategoryEmbed[] | null;
  // Ordered segment breakdown embedded via the service_id FK (booking schema).
  service_segments: ServiceSegmentEmbed | ServiceSegmentEmbed[] | null;
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
  photo_url: string | null;
}

interface ServiceRequirementRuleRow {
  id: string;
  trigger_service_id: string;
  title: string;
  description: string | null;
  service_requirement_options:
    | Array<{ service_id: string; services: ServiceRow | ServiceRow[] | null }>
    | { service_id: string; services: ServiceRow | ServiceRow[] | null }
    | null;
}

interface ServiceUpgradeSuggestionRow {
  id: string;
  trigger_service_id: string;
  suggested_service_id: string;
  title: string;
  description: string;
  suggested_service: ServiceRow | ServiceRow[] | null;
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
  // tstzmultirange of the stylist-occupied sub-windows (PostgREST returns it as text).
  occupied_ranges: string | null;
}

interface BookingAttemptBusyRow {
  id: string;
  stylist_profile_id: string;
  selected_start_at: string;
  selected_end_at: string;
  occupied_ranges: string | null;
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
  book_out_type_id: string | null;
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

interface BookingAttemptServiceRow {
  service_id: string;
  sequence_no: number;
  service_name_snapshot: string;
  duration_minutes: number;
  price_amount: number | string;
  deposit_required_amount: number | string;
}

interface DepositRow {
  id: string;
  status: 'pending' | 'requires_action' | 'authorized' | 'paid' | 'failed' | 'cancelled';
}

const LOCATION_COLUMNS =
  'id,business_id,name,slug,public_code,timezone,is_active,address_line_1,address_line_2,city,region,postal_code,country_code,phone,businesses!inner(slug,default_currency_code),location_settings(online_booking_enabled,allow_next_available,appointment_slot_minutes,same_day_booking_cutoff_minutes,cancellation_notice_hours,currency_code)';
// Services embed their managed category (booking.service_categories) via the
// service_category_id FK so the booking flow can group + colour by category.
// Same-schema embed (booking → booking), so PostgREST resolves it inline.
const SERVICE_FIELDS =
  'id,business_id,location_id,name,description,service_category_id,estimated_duration_minutes,base_price,deposit_type,deposit_value,is_active,sort_order,service_categories(id,name,color_hex,sort_order),service_segments(name,duration_minutes,is_stylist_free,sort_order)';
const SERVICE_COLUMNS = SERVICE_FIELDS;
const STAFF_COLUMNS = 'id,display_name,color_hex,bio,photo_url';
const REQUIREMENT_RULE_COLUMNS = `id,trigger_service_id,title,description,service_requirement_options(service_id,services(${SERVICE_FIELDS}))`;
const UPGRADE_SUGGESTION_COLUMNS = `id,trigger_service_id,suggested_service_id,title,description,suggested_service:services!service_upgrade_suggestions_suggested_service_id_fkey(${SERVICE_FIELDS})`;
const SHIFT_COLUMNS = 'id,staff_profile_id,scheduled_start_at,scheduled_end_at';
const BREAK_COLUMNS = 'shift_id,started_at,ended_at';
const APPOINTMENT_COLUMNS = 'assigned_staff_profile_id,scheduled_start_at,scheduled_end_at,occupied_ranges';
const BOOKING_ATTEMPT_BUSY_COLUMNS = 'id,stylist_profile_id,selected_start_at,selected_end_at,occupied_ranges';
/**
 * `booking.deposit_status_enum` values that precede a collection. A successful
 * payment is recorded only from one of these; `paid`, `partially_refunded`,
 * `refunded` and `cancelled` are never overwritten by a payment webhook.
 */
const DEPOSIT_AWAITING_PAYMENT_STATUSES = ['pending', 'requires_action', 'authorized', 'failed'];
/**
 * Attempt statuses a successful payment may finalize. A declined card leaves the
 * PaymentIntent reusable (`requires_payment_method`), and the booking page keeps
 * it: the client can pay the same intent after `payment_intent.payment_failed`
 * has already marked the attempt `payment_failed`.
 */
const BOOKING_ATTEMPT_PAYABLE_STATUSES = ['pending_payment', 'payment_failed'];
const BOOKING_ATTEMPT_COLUMNS =
  'id,business_id,location_id,service_id,stylist_profile_id,client_profile_id,user_profile_id,appointment_id,staff_request_mode,selected_start_at,selected_end_at,communication_preference,client_note,deposit_amount,currency_code,stripe_payment_intent_id,status,expires_at,metadata';
const BOOKING_ATTEMPT_SERVICE_COLUMNS =
  'service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,deposit_required_amount';
const LEAVE_COLUMNS = 'staff_profile_id,start_date,end_date';
const ABSENCE_COLUMNS = 'staff_profile_id,starts_at,ends_at,book_out_type_id';
const LOOKAHEAD_DAYS = 28;
// Earliest same-day booking: now + this many minutes. Fixed (not the slot
// size) so changing a location's diary granularity never changes how soon a
// client may book — see the comment at the searchStart computation.
const MIN_SAME_DAY_LEAD_MINUTES = 15;
const BOOKING_ATTEMPT_TTL_MINUTES = 15;

@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly stripe: StripeService,
    private readonly rebooking: RebookingService,
    private readonly bookingNotifications: BookingNotificationService,
    private readonly auth: AuthService,
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
    options: { allowOfflineBooking?: boolean } = {},
  ): Promise<PublicBookingServiceSelectionResponse> {
    const location = await this.resolveLocation(query, options);
    const services = await this.fetchServices(location.businessId, location.id, location.currencyCode);
    const [finishingRequirements, upgradeSuggestions] = await Promise.all([
      this.fetchFinishingRequirements(location.businessId, location.id, location.currencyCode),
      this.fetchUpgradeSuggestions(location.businessId, location.id, location.currencyCode),
    ]);
    return { location, services, finishingRequirements, upgradeSuggestions };
  }

  async getStylists(
    query: PublicBookingStylistsQueryDto,
    options: { allowOfflineBooking?: boolean } = {},
  ): Promise<PublicBookingStylistsResponse> {
    const location = await this.resolveLocation(query, options);
    const serviceIds = parseServiceIds(query.serviceIds);
    const services = await this.fetchServicesByIds(
      location.businessId,
      location.id,
      serviceIds,
      location.currencyCode,
    );
    await this.assertServiceRulesSatisfied(location.businessId, location.id, services, location.currencyCode);
    const totalDurationMinutes = totalDuration(services);
    const staff = await this.fetchBookableStaff(location.businessId, location.id, serviceIds);
    const nextAvailableByStaff = await this.fetchNextAvailableByStaff(
      location.businessId,
      location.id,
      staff.map((row) => row.id),
      totalDurationMinutes,
      location.appointmentSlotMinutes,
      { firstOnly: true, candidateOccupied: occupiedOffsets(toOccupancyServices(services)) },
    );

    const pricesByStaff = await this.fetchStylistServicePrices(
      location.businessId,
      staff.map((row) => row.id),
      services,
    );

    const stylists = staff.map<PublicBookingStylistSummary>((row) => {
      const servicePrices = pricesByStaff.get(row.id) ?? [];
      return {
        staffProfileId: row.id,
        displayName: row.display_name,
        colorHex: row.color_hex ?? undefined,
        bio: row.bio ?? undefined,
        photoUrl: row.photo_url ?? undefined,
        nextAvailableAt: nextAvailableByStaff.get(row.id)?.[0],
        servicePrices,
        totalPriceAmount: servicePrices.reduce((sum, price) => sum + price.priceAmount, 0),
      };
    });

    return {
      location,
      services,
      totalDurationMinutes,
      // Top-level totals stay at base price — the "from" estimate shown before a
      // stylist is picked. Per-stylist totals live on each stylist entry.
      totalPriceAmount: totalPrice(services),
      totalDepositRequiredAmount: calculateDepositAmount(services),
      stylists,
      nextAvailableAt: earliest(Array.from(nextAvailableByStaff.values()).flat()),
    };
  }

  async getAvailability(
    query: PublicBookingAvailabilityQueryDto,
    options: { allowOfflineBooking?: boolean } = {},
  ): Promise<PublicBookingAvailabilityResponse> {
    const location = await this.resolveLocation(query, options);
    const serviceIds = parseServiceIds(query.serviceIds);
    const services = await this.fetchServicesByIds(
      location.businessId,
      location.id,
      serviceIds,
      location.currencyCode,
    );
    await this.assertServiceRulesSatisfied(location.businessId, location.id, services, location.currencyCode);
    const totalDurationMinutes = totalDuration(services);
    const staff = await this.fetchBookableStaff(location.businessId, location.id, serviceIds);
    const requestedStaffIds = query.stylistId
      ? staff.filter((row) => row.id === query.stylistId).map((row) => row.id)
      : staff.map((row) => row.id);

    if (query.stylistId && requestedStaffIds.length === 0) {
      throw new NotFoundException('Stylist is not available for online booking at this location');
    }

    // Per-stylist effective prices for every bookable stylist behind the slots,
    // so a next-available selection can show + charge the stylist actually
    // resolved for the chosen slot. Computed from base prices BEFORE the
    // specific-stylist override below so per-service fallbacks stay at base.
    const pricesByStaff = await this.fetchStylistServicePrices(location.businessId, requestedStaffIds, services);

    // A specific stylist is targeted: switch the estimate to that stylist's
    // per-service prices so the displayed total matches what they will be
    // charged. With no stylist (any/next-available) prices stay at base.
    if (query.stylistId) {
      await this.applyStylistServicePricing(location.businessId, query.stylistId, services);
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
      totalDurationMinutes,
      location.appointmentSlotMinutes,
      {
        dateFrom,
        dateTo,
        firstOnly: query.nextAvailable === 'true',
        candidateOccupied: occupiedOffsets(toOccupancyServices(services)),
      },
    );

    const staffById = new Map(staff.map((row) => [row.id, row]));
    const slots = Array.from(slotsByStaff.entries())
      .flatMap(([staffProfileId, starts]) => {
        const stylist = staffById.get(staffProfileId);
        if (!stylist) return [];
        return starts.map<PublicBookingAvailabilitySlot>((startAt) => {
          const endAt = new Date(
            new Date(startAt).getTime() + totalDurationMinutes * 60_000,
          ).toISOString();
          return {
            startAt,
            endAt,
            startTime: startAt,
            endTime: endAt,
            date: toIsoDate(new Date(startAt)),
            locationId: location.id,
            staffProfileId,
            stylistId: staffProfileId,
            stylistName: stylist.display_name,
            totalDurationMinutes,
          };
        });
      })
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

    const stylists = requestedStaffIds
      .map<PublicBookingStylistSummary | null>((staffProfileId) => {
        const staffRow = staffById.get(staffProfileId);
        if (!staffRow) return null;
        const servicePrices = pricesByStaff.get(staffProfileId) ?? [];
        return {
          staffProfileId,
          displayName: staffRow.display_name,
          colorHex: staffRow.color_hex ?? undefined,
          bio: staffRow.bio ?? undefined,
          photoUrl: staffRow.photo_url ?? undefined,
          servicePrices,
          totalPriceAmount: servicePrices.reduce((sum, price) => sum + price.priceAmount, 0),
        };
      })
      .filter((stylist): stylist is PublicBookingStylistSummary => stylist !== null);

    return {
      location,
      services,
      totalDurationMinutes,
      totalPriceAmount: totalPrice(services),
      totalDepositRequiredAmount: calculateDepositAmount(services),
      slots,
      stylists,
    };
  }

  async createAppointment(input: CreatePublicBookingRequest): Promise<CreatePublicBookingResponse> {
    return this.confirmDepositFreeBooking({
      ...input,
      source: input.source ?? 'public_booking_flow',
    });
  }

  async createMobileAppointment(
    actor: AuthUser,
    input: MobileBookingConfirmRequest,
  ): Promise<CreatePublicBookingResponse> {
    const request = await this.toAuthenticatedBookingRequest(actor, input);
    return this.confirmDepositFreeBooking(request);
  }

  /**
   * Confirms a booking directly, without a Stripe payment step. Only valid when none of the
   * requested services require an upfront deposit — callers that may carry a deposit must use
   * the start-checkout flow instead. Shared by the public web flow and the mobile app.
   */
  private async confirmDepositFreeBooking(
    request: CreatePublicBookingRequest,
  ): Promise<CreatePublicBookingResponse> {
    const context = await this.resolveBookingContext(request);
    const depositAmount = calculateDepositAmount(context.services);
    if (depositAmount > 0) {
      throw new BadRequestException('This booking requires a deposit before it can be confirmed');
    }

    const client = await this.resolveAuthenticatedClient(
      context.location.businessId,
      context.location.id,
      request.clientProfileId,
      request.bookedByUserProfileId,
      request.client,
      request.communicationPreference,
    );
    await this.syncUserProfilePhone(request.bookedByUserProfileId, request.client.phone);

    const appointment = await this.insertMobileAppointment(request, client, context);
    await this.insertMobileAppointmentServices(appointment.id, context);

    // The booking is 'pending' — do NOT confirm to the client or link
    // a rebooking outcome yet. Client confirmation + reminders + rebooking credit
    // are scheduled when an owner/manager accepts the request (LabAppointmentsService.accept).

    return {
      appointment: toAppointmentSummary({
        appointment,
        location: context.location,
        attemptServices: toAttemptServices(context.services),
        stylist: context.stylist,
        client,
        communicationPreference: request.communicationPreference,
        depositAmount: 0,
      }),
      depositRequired: false,
      depositPlaceholder: false,
    };
  }

  async startMobileCheckout(
    actor: AuthUser,
    input: MobileBookingStartCheckoutRequest,
  ): Promise<StartPublicBookingCheckoutResponse> {
    return this.startCheckout(await this.toAuthenticatedBookingRequest(actor, input));
  }

  async getMobileBookingAttempt(actor: AuthUser, id: string): Promise<PublicBookingAttemptResponse> {
    this.assertClientUser(actor);
    const response = await this.getBookingAttempt(id);
    if (response.bookingAttempt.clientDisplayName !== actor.profile.fullName) {
      const attempt = await this.fetchBookingAttemptById(id);
      // Scope by the owning user account — a customer's client_profile differs
      // per salon, so ownership is the user_profile that started the attempt.
      if (attempt.user_profile_id !== actor.id) {
        throw new ForbiddenException('Booking attempt is outside your account scope');
      }
    }
    return response;
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

    const depositAmount = calculateDepositAmount(context.services);
    if (depositAmount <= 0) {
      throw new BadRequestException('This service does not have a deposit configured');
    }

    const attempt = await this.createPendingBookingAttempt({
      input,
      client,
      location: context.location,
      services: context.services,
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
      serviceIds: context.services.map((service) => service.id),
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
    this.logger.log(
      `Stripe payment_intent.succeeded received for attempt=${attempt.id} paymentIntent=${paymentIntent.id} status=${attempt.status}`,
    );
    if (attempt.status === 'confirmed' && attempt.appointment_id) {
      await this.markDepositPaid(attempt, paymentIntent);
      return;
    }
    if (!BOOKING_ATTEMPT_PAYABLE_STATUSES.includes(attempt.status)) return;
    // A success after a decline completes the attempt only through its own intent.
    if (attempt.status === 'payment_failed' && attempt.stripe_payment_intent_id !== paymentIntent.id) {
      this.logger.warn(
        `Stripe payment_intent.succeeded for attempt=${attempt.id} paymentIntent=${paymentIntent.id} does not match the attempt's intent; ignored`,
      );
      return;
    }

    const appointment = await this.finalizePaidBookingAttempt(attempt, paymentIntent);
    await this.markDepositPaid({ ...attempt, appointment_id: appointment.id }, paymentIntent);
    // Rebooking credit is linked on owner/manager acceptance, not at payment time.
  }

  async handlePaymentIntentFailed(paymentIntent: StripePaymentIntent): Promise<void> {
    const attempt = await this.fetchBookingAttemptForPaymentIntent(paymentIntent);
    if (attempt.status === 'confirmed') return;

    const failureReason = paymentIntent.last_payment_error?.message ?? 'Payment failed';
    this.logger.warn(
      `Stripe payment_intent.payment_failed received for attempt=${attempt.id} paymentIntent=${paymentIntent.id} reason=${failureReason}`,
    );
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

    // Never over a recorded collection: a retried payment on the same intent may
    // already have succeeded when this (earlier) failure is processed.
    const { error: depositError } = await this.admin
      .schema('booking')
      .from('deposits')
      .update({
        status: 'failed',
        failure_reason: failureReason,
        metadata: { stripe_status: paymentIntent.status },
      })
      .eq('booking_attempt_id', attempt.id)
      .is('paid_at', null)
      .in('status', DEPOSIT_AWAITING_PAYMENT_STATUSES);

    if (depositError) {
      this.logger.error(`handlePaymentIntentFailed update deposit failed: ${depositError.message}`);
      throw new InternalServerErrorException('Unable to update deposit');
    }
  }

  private async resolveLocation(
    query: PublicBookingSelectionQueryDto,
    options: { allowOfflineBooking?: boolean } = {},
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
    if (settings && !settings.online_booking_enabled && !options.allowOfflineBooking) {
      // Staff/internal bookings pass allowOfflineBooking so they keep working even
      // when public online booking is switched off for the location.
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

  private async fetchServicesByIds(
    businessId: string,
    locationId: string,
    serviceIds: string[],
    currencyCode: string,
  ): Promise<PublicBookingServiceSummary[]> {
    const uniqueIds = unique(serviceIds);
    if (uniqueIds.length === 0) throw new BadRequestException('At least one service is required');

    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .in('id', uniqueIds)
      .returns<ServiceRow[]>();

    if (error) {
      this.logger.error(`fetchServicesByIds failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }

    const byId = new Map((data ?? []).map((row) => [row.id, toServiceSummary(row, currencyCode)]));
    const ordered = uniqueIds.map((id) => byId.get(id)).filter((service): service is PublicBookingServiceSummary => Boolean(service));
    if (ordered.length !== uniqueIds.length) {
      throw new NotFoundException('One or more services were not found');
    }
    return ordered;
  }

  private async fetchFinishingRequirements(
    businessId: string,
    locationId: string,
    currencyCode: string,
  ): Promise<PublicBookingFinishingRequirement[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_requirement_rules')
      .select(REQUIREMENT_RULE_COLUMNS)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .returns<ServiceRequirementRuleRow[]>();

    if (error) {
      this.logger.error(`fetchFinishingRequirements failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service requirements');
    }

    return (data ?? []).map((row) => {
      const optionRows = arrayOf(row.service_requirement_options);
      const requiredServices = optionRows
        .map((option) => first(option.services))
        .filter((service): service is ServiceRow => Boolean(service?.is_active))
        .map((service) => toServiceSummary(service, currencyCode));
      return {
        id: row.id,
        triggerServiceId: row.trigger_service_id,
        title: row.title,
        description: row.description ?? undefined,
        requiredServiceIds: optionRows.map((option) => option.service_id),
        requiredServices,
      };
    });
  }

  private async fetchUpgradeSuggestions(
    businessId: string,
    locationId: string,
    currencyCode: string,
  ): Promise<PublicBookingUpgradeSuggestion[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('service_upgrade_suggestions')
      .select(UPGRADE_SUGGESTION_COLUMNS)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .order('sort_order', { ascending: true })
      .returns<ServiceUpgradeSuggestionRow[]>();

    if (error) {
      this.logger.error(`fetchUpgradeSuggestions failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load upgrade suggestions');
    }

    return (data ?? [])
      .map((row) => {
        const service = first(row.suggested_service);
        if (!service?.is_active) return undefined;
        return {
          id: row.id,
          triggerServiceId: row.trigger_service_id,
          suggestedServiceId: row.suggested_service_id,
          title: row.title,
          description: row.description,
          service: toServiceSummary(service, currencyCode),
        };
      })
      .filter((suggestion): suggestion is PublicBookingUpgradeSuggestion => Boolean(suggestion));
  }

  private async fetchBookableStaff(
    businessId: string,
    locationId: string,
    serviceIds: string[] = [],
  ): Promise<StaffRow[]> {
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
    const rows = data ?? [];

    // Restrict to stylists eligible for EVERY selected service. A service with no
    // eligibility rows has no eligible stylist, so it is effectively unbookable
    // until an owner assigns stylists (surfaced as a dashboard warning).
    const required = Array.from(new Set(serviceIds.filter(Boolean)));
    if (required.length === 0) return rows;
    const eligible = await this.fetchEligibleStaffIdsForServices(businessId, required);
    return rows.filter((row) => eligible.has(row.id));
  }

  /**
   * Returns the set of staff_profile_ids eligible to perform ALL of `serviceIds`.
   * Eligibility lives in booking.staff_service_eligibility (queried directly —
   * no PostgREST embed since staff live in the core schema).
   */
  private async fetchEligibleStaffIdsForServices(
    businessId: string,
    serviceIds: string[],
  ): Promise<Set<string>> {
    const required = Array.from(new Set(serviceIds.filter(Boolean)));
    if (required.length === 0) return new Set();

    const { data, error } = await this.admin
      .schema('booking')
      .from('staff_service_eligibility')
      .select('staff_profile_id,service_id')
      .eq('business_id', businessId)
      .in('service_id', required)
      .returns<{ staff_profile_id: string; service_id: string }[]>();
    if (error) {
      this.logger.error(`fetchEligibleStaffIdsForServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stylist eligibility');
    }

    const byStaff = new Map<string, Set<string>>();
    for (const row of data ?? []) {
      const set = byStaff.get(row.staff_profile_id) ?? new Set<string>();
      set.add(row.service_id);
      byStaff.set(row.staff_profile_id, set);
    }
    const eligible = new Set<string>();
    for (const [staffProfileId, services] of byStaff) {
      if (services.size === required.length) eligible.add(staffProfileId);
    }
    return eligible;
  }

  /**
   * Overrides each service's price with the chosen stylist's per-stylist price
   * (booking.staff_service_eligibility.price_amount) where one is set, and
   * recomputes a percentage deposit off that effective price so the deposit
   * charged/persisted matches the stylist's price. A NULL price leaves the
   * service base price + deposit untouched. Mutates `services` in place so totals
   * and the snapshotted appointment/attempt service prices + deposits follow.
   */
  private async applyStylistServicePricing(
    businessId: string,
    staffProfileId: string,
    services: PublicBookingServiceSummary[],
  ): Promise<void> {
    if (services.length === 0) return;
    const { data, error } = await this.admin
      .schema('booking')
      .from('staff_service_eligibility')
      .select('service_id,price_amount')
      .eq('business_id', businessId)
      .eq('staff_profile_id', staffProfileId)
      .in('service_id', services.map((service) => service.id))
      .returns<{ service_id: string; price_amount: number | string | null }[]>();
    if (error) {
      this.logger.error(`applyStylistServicePricing failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stylist pricing');
    }
    const priceByService = new Map<string, number>();
    for (const row of data ?? []) {
      if (row.price_amount !== null) priceByService.set(row.service_id, Number(row.price_amount));
    }
    for (const service of services) {
      const override = priceByService.get(service.id);
      if (override !== undefined) {
        service.startingPriceAmount = override;
        service.depositRequiredAmount = depositForServicePrice(service, override);
      }
    }
  }

  /**
   * Bulk per-stylist effective prices for the selection UI. For each stylist and
   * each selected service returns the per-stylist override where set, otherwise
   * the service base price — so the picker can show a stylist's price the moment
   * they are selected. One query across all the listed stylists.
   */
  private async fetchStylistServicePrices(
    businessId: string,
    staffProfileIds: string[],
    services: PublicBookingServiceSummary[],
  ): Promise<Map<string, { serviceId: string; priceAmount: number }[]>> {
    const result = new Map<string, { serviceId: string; priceAmount: number }[]>();
    if (staffProfileIds.length === 0 || services.length === 0) return result;
    const { data, error } = await this.admin
      .schema('booking')
      .from('staff_service_eligibility')
      .select('staff_profile_id,service_id,price_amount')
      .eq('business_id', businessId)
      .in('staff_profile_id', staffProfileIds)
      .in('service_id', services.map((service) => service.id))
      .returns<{ staff_profile_id: string; service_id: string; price_amount: number | string | null }[]>();
    if (error) {
      this.logger.error(`fetchStylistServicePrices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stylist pricing');
    }
    const overrideByStaffService = new Map<string, number>();
    for (const row of data ?? []) {
      if (row.price_amount !== null) {
        overrideByStaffService.set(`${row.staff_profile_id}:${row.service_id}`, Number(row.price_amount));
      }
    }
    for (const staffProfileId of staffProfileIds) {
      result.set(
        staffProfileId,
        services.map((service) => ({
          serviceId: service.id,
          priceAmount:
            overrideByStaffService.get(`${staffProfileId}:${service.id}`) ?? service.startingPriceAmount,
        })),
      );
    }
    return result;
  }

  private async assertStaffEligibleForServices(
    businessId: string,
    staffProfileId: string,
    serviceIds: string[],
  ): Promise<void> {
    const required = Array.from(new Set(serviceIds.filter(Boolean)));
    if (required.length === 0) return;
    const eligible = await this.fetchEligibleStaffIdsForServices(businessId, required);
    if (!eligible.has(staffProfileId)) {
      throw new BadRequestException(
        'Selected stylist cannot perform one or more of the selected services',
      );
    }
  }

  /**
   * Of the book-out types referenced by these absences, return the ids whose
   * type is configured NOT to block appointments. Those absences should not
   * remove availability. Returns an empty set when no typed absences exist.
   */
  private async fetchNonBlockingBookOutTypeIds(
    businessId: string,
    absences: AbsenceRow[],
  ): Promise<Set<string>> {
    const typeIds = Array.from(
      new Set(absences.map((row) => row.book_out_type_id).filter((id): id is string => Boolean(id))),
    );
    if (typeIds.length === 0) return new Set();
    const { data, error } = await this.admin
      .schema('rota')
      .from('book_out_types')
      .select('id,blocks_appointments')
      .eq('business_id', businessId)
      .in('id', typeIds)
      .eq('blocks_appointments', false)
      .returns<{ id: string; blocks_appointments: boolean }[]>();
    if (error) {
      this.logger.error(`fetchNonBlockingBookOutTypeIds failed: ${error.message}`);
      // Fail closed: treat everything as blocking (safer for availability).
      return new Set();
    }
    return new Set((data ?? []).map((row) => row.id));
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
      // The candidate booking's occupied sub-windows (offsets from its start).
      // Defaults to a single window spanning the whole duration (a plain,
      // segment-less service fully occupies the stylist — unchanged behaviour).
      candidateOccupied?: OffsetInterval[];
    } = {},
  ): Promise<Map<string, string[]>> {
    if (staffIds.length === 0) return new Map();
    // An explicit (possibly empty = all-free) candidate window set wins; otherwise
    // a plain service fully occupies the stylist for its whole duration.
    const candidateOccupied = options.candidateOccupied ?? [
      { startMs: 0, endMs: durationMinutes * 60_000 },
    ];
    const now = new Date();
    // Same-day lead time is a FIXED floor, deliberately not the slot size:
    // coupling them meant switching a location to 60-minute slots silently
    // quadrupled the earliest bookable time. 15 minutes preserves the
    // behaviour every location had before slot sizes became configurable.
    // (location_settings.same_day_booking_cutoff_minutes exists and is the
    // natural future owner of this value — wiring it is a product decision.)
    const searchStart = options.dateFrom
      ? new Date(Math.max(options.dateFrom.getTime(), now.getTime()))
      : new Date(now.getTime() + MIN_SAME_DAY_LEAD_MINUTES * 60_000);
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
          .in('status', ['pending', 'accepted', 'checked_in'])
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

    // The stylist's busy time is only their OCCUPIED sub-windows (parsed from each
    // appointment's/attempt's occupied_ranges multirange), NOT the whole span — so
    // another booking can slot into a booking's stylist-free development time.
    const occupiedByStaff = new Map<string, TimeInterval[]>();
    const addOccupied = (staffId: string, ranges: string | null) => {
      const intervals = parseMultirange(ranges);
      if (intervals.length === 0) return;
      const list = occupiedByStaff.get(staffId) ?? [];
      list.push(...intervals);
      occupiedByStaff.set(staffId, list);
    };
    for (const appointment of appointments ?? []) {
      if (!appointment.assigned_staff_profile_id) continue;
      addOccupied(appointment.assigned_staff_profile_id, appointment.occupied_ranges);
    }
    for (const attempt of attempts ?? []) {
      if (attempt.id === options.excludeBookingAttemptId) continue;
      addOccupied(attempt.stylist_profile_id, attempt.occupied_ranges);
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
    // Book-out types flagged "does not block appointments" must NOT make the
    // stylist unavailable — clients can still be booked over them. Legacy
    // absences (no type) always block, preserving historical behaviour.
    const nonBlockingTypeIds = await this.fetchNonBlockingBookOutTypeIds(businessId, absences ?? []);
    const absencesByStaff = new Map<string, AbsenceRow[]>();
    for (const absence of (absences ?? []).filter((row) => !row.ends_at || new Date(row.ends_at) > searchStart)) {
      if (absence.book_out_type_id && nonBlockingTypeIds.has(absence.book_out_type_id)) continue;
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
        occupiedByStaff.get(shift.staff_profile_id) ?? [],
        leaveByStaff.get(shift.staff_profile_id) ?? [],
        absencesByStaff.get(shift.staff_profile_id) ?? [],
        durationMinutes,
        candidateOccupied,
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

  private async toAuthenticatedBookingRequest(
    actor: AuthUser,
    input: MobileBookingConfirmRequest,
  ): Promise<CreatePublicBookingRequest> {
    this.assertClientUser(actor);

    // A customer books against a specific salon (the location), which may not be
    // one they belong to yet — their account is salon-agnostic. Resolve that
    // salon's business and lazily create the client membership + profile there
    // (assigning a fresh client code) so they "join" the salon on first booking.
    const location = await this.resolveLocation({ locationId: input.locationId });
    const firstName = actor.profile.firstName?.trim() || firstNameFromFullName(actor.profile.fullName);
    const lastName = actor.profile.lastName?.trim() || lastNameFromFullName(actor.profile.fullName);
    const communicationPreference =
      input.communicationPreference ?? actor.clientCommunicationPreference ?? 'email';

    const client = await this.auth.ensureClientForBusiness(location.businessId, location.id, actor.id, {
      firstName,
      lastName,
      email: actor.profile.email,
      phone: actor.profile.phone,
      communicationPreference,
    });

    return {
      ...input,
      client: {
        firstName,
        lastName,
        email: actor.profile.email,
        phone: actor.profile.phone,
      },
      communicationPreference,
      clientProfileId: client.id,
      bookedByUserProfileId: actor.id,
      source: 'mobile_app',
    };
  }

  private assertClientUser(actor: AuthUser): void {
    if (!userHasRole(actor, 'client')) {
      throw new ForbiddenException('Mobile booking requires a signed-in client account');
    }
  }

  private async resolveBookingContext(
    input: StartPublicBookingCheckoutRequest,
    excludeBookingAttemptId?: string,
    options: { allowOfflineBooking?: boolean } = {},
  ): Promise<{
    location: PublicBookingLocationSummary;
    services: PublicBookingServiceSummary[];
    stylist: StaffRow;
    selectedStart: Date;
    selectedEnd: Date;
  }> {
    const location = await this.resolveLocation({ locationId: input.locationId }, options);
    const services = await this.fetchServicesByIds(
      location.businessId,
      location.id,
      input.serviceIds,
      location.currencyCode,
    );
    await this.assertServiceRulesSatisfied(location.businessId, location.id, services, location.currencyCode);
    const totalDurationMinutes = totalDuration(services);
    // Fetch WITHOUT the service-eligibility filter on purpose: this lets us tell
    // "stylist not bookable at this location" apart from "stylist can't perform
    // the service" and return the precise error for each. The eligibility
    // hard-block below is the actual gate (the public/staff stylist lists are
    // already eligibility-filtered upstream in getStylists/getAvailability).
    const staff = await this.fetchBookableStaff(location.businessId, location.id);
    const stylist = staff.find((row) => row.id === input.staffProfileId);
    if (!stylist) {
      throw new BadRequestException('Selected stylist is not available for this location');
    }
    // Hard-block: the stylist must be eligible for every selected service.
    await this.assertStaffEligibleForServices(location.businessId, input.staffProfileId, input.serviceIds);
    // Now that a specific stylist is locked in, apply their per-stylist prices so
    // every downstream charge (totals + appointment/attempt service rows) uses the
    // stylist's price instead of the service base price.
    await this.applyStylistServicePricing(location.businessId, input.staffProfileId, services);
    if (input.staffRequestMode === 'next_available' && !location.allowNextAvailable) {
      throw new BadRequestException('Next available booking is not enabled for this location');
    }

    const selectedStart = parseDate(input.selectedStartAt, 'selectedStartAt');
    const selectedEnd = new Date(
      selectedStart.getTime() + totalDurationMinutes * 60_000,
    );
    const selectedStartIso = selectedStart.toISOString();
    const availability = await this.fetchNextAvailableByStaff(
      location.businessId,
      location.id,
      [input.staffProfileId],
      totalDurationMinutes,
      location.appointmentSlotMinutes,
      {
        dateFrom: new Date(selectedStart.getTime() - location.appointmentSlotMinutes * 60_000),
        dateTo: new Date(selectedEnd.getTime() + location.appointmentSlotMinutes * 60_000),
        firstOnly: false,
        excludeBookingAttemptId,
        candidateOccupied: occupiedOffsets(toOccupancyServices(services)),
      },
    );
    const selectedStillAvailable = (availability.get(input.staffProfileId) ?? []).some(
      (slot) => slot === selectedStartIso,
    );
    if (!selectedStillAvailable) {
      throw new BadRequestException('Selected slot is no longer available');
    }

    return { location, services, stylist, selectedStart, selectedEnd };
  }

  private async assertServiceRulesSatisfied(
    businessId: string,
    locationId: string,
    services: PublicBookingServiceSummary[],
    currencyCode: string,
  ): Promise<void> {
    const selectedIds = new Set(services.map((service) => service.id));
    const requirements = await this.fetchFinishingRequirements(businessId, locationId, currencyCode);
    const missing = requirements.find(
      (rule) =>
        selectedIds.has(rule.triggerServiceId) &&
        !rule.requiredServiceIds.some((serviceId) => selectedIds.has(serviceId)),
    );
    if (missing) {
      const options = missing.requiredServices.map((service) => service.name).join(' or ');
      throw new BadRequestException(`${missing.title}: add ${options || 'a required finishing service'} to continue`);
    }
  }

  private async createPendingBookingAttempt(input: {
    input: StartPublicBookingCheckoutRequest;
    client: ClientProfileRow;
    location: PublicBookingLocationSummary;
    services: PublicBookingServiceSummary[];
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
        service_id: input.services[0].id,
        stylist_profile_id: input.stylist.id,
        client_profile_id: input.client.id,
        user_profile_id: input.input.bookedByUserProfileId,
        staff_request_mode: input.input.staffRequestMode,
        selected_start_at: input.selectedStart.toISOString(),
        selected_end_at: input.selectedEnd.toISOString(),
        occupied_ranges: occupiedRangesLiteral(input.services, input.selectedStart),
        communication_preference: input.input.communicationPreference,
        client_note: input.input.clientNote?.trim() || null,
        deposit_amount: input.depositAmount,
        currency_code: input.location.currencyCode,
        status: 'pending_payment',
        expires_at: expiresAt,
        metadata: {
          source: input.input.source ?? 'public_booking_flow',
          service_ids: input.services.map((service) => service.id),
          service_names: input.services.map((service) => service.name),
          stylist_name: input.stylist.display_name,
          client_display_name: `${input.client.first_name} ${input.client.last_name}`.trim(),
          total_duration_minutes: totalDuration(input.services),
          total_price_amount: totalPrice(input.services),
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

    await this.insertBookingAttemptServices(data.id, {
      businessId: input.location.businessId,
      locationId: input.location.id,
      staffProfileId: input.stylist.id,
      services: input.services,
      selectedStart: input.selectedStart,
      depositAmount: input.depositAmount,
    });

    return data;
  }

  private async insertMobileAppointment(
    input: CreatePublicBookingRequest,
    client: ClientProfileRow,
    context: {
      location: PublicBookingLocationSummary;
      services: PublicBookingServiceSummary[];
      stylist: StaffRow;
      selectedStart: Date;
      selectedEnd: Date;
    },
  ): Promise<AppointmentInsertRow> {
    return this.insertAppointmentRecord({
      businessId: context.location.businessId,
      locationId: context.location.id,
      clientId: client.id,
      bookedByUserProfileId: input.bookedByUserProfileId,
      assignedStaffProfileId: context.stylist.id,
      requestedStaffProfileId: input.staffRequestMode === 'specific_staff' ? context.stylist.id : null,
      staffRequestMode: input.staffRequestMode,
      bookingChannel: 'client_app',
      // Client-initiated bookings await owner/manager acceptance before they are accepted.
      status: 'pending',
      scheduledStart: context.selectedStart,
      scheduledEnd: context.selectedEnd,
      occupiedRanges: occupiedRangesLiteral(context.services, context.selectedStart),
      communicationPreference: input.communicationPreference,
      clientNote: input.clientNote?.trim() || null,
      internalNote: null,
      metadata: {
        source: 'mobile_app',
        service_ids: context.services.map((service) => service.id),
        service_names: context.services.map((service) => service.name),
        stylist_name: context.stylist.display_name,
        client_display_name: `${client.first_name} ${client.last_name}`.trim(),
        total_duration_minutes: totalDuration(context.services),
        total_price_amount: totalPrice(context.services),
        payment_status: 'not_required',
      },
    });
  }

  /**
   * Shared appointment-header writer. Both the deposit-free public/mobile flow
   * and the internal staff-booking flow insert a `confirmed` appointment through
   * here so the DB no-overlap guard, error mapping, and column shape stay in one
   * place. Callers vary only the channel, who booked it, the notes, and metadata.
   */
  private async insertAppointmentRecord(params: {
    businessId: string;
    locationId: string;
    clientId: string;
    bookedByUserProfileId: string | null;
    assignedStaffProfileId: string;
    requestedStaffProfileId: string | null;
    staffRequestMode: 'specific_staff' | 'next_available';
    bookingChannel: 'client_app' | 'staff_app' | 'web_dashboard' | 'phone' | 'walk_in' | 'api';
    /** Initial status. Client bookings open as 'pending'; staff bookings as 'accepted' (default). */
    status?: AppointmentStatus;
    scheduledStart: Date;
    scheduledEnd: Date;
    /** tstzmultirange literal of the stylist-occupied windows (keys the no-overlap guard). */
    occupiedRanges: string;
    communicationPreference: string;
    clientNote: string | null;
    internalNote: string | null;
    metadata: Record<string, unknown>;
  }): Promise<AppointmentInsertRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .insert({
        business_id: params.businessId,
        location_id: params.locationId,
        client_profile_id: params.clientId,
        booked_by_user_profile_id: params.bookedByUserProfileId,
        assigned_staff_profile_id: params.assignedStaffProfileId,
        requested_staff_profile_id: params.requestedStaffProfileId,
        staff_request_mode: params.staffRequestMode,
        status: params.status ?? 'accepted',
        booking_channel: params.bookingChannel,
        scheduled_start_at: params.scheduledStart.toISOString(),
        scheduled_end_at: params.scheduledEnd.toISOString(),
        occupied_ranges: params.occupiedRanges,
        communication_preference: params.communicationPreference,
        client_note: params.clientNote,
        internal_note: params.internalNote,
        metadata: params.metadata,
      })
      .select('id,status,scheduled_start_at,scheduled_end_at')
      .single<AppointmentInsertRow>();

    if (error || !data) {
      const message = error?.message ?? 'no appointment row';
      if (message.toLowerCase().includes('booking_appointments_staff_no_overlap')) {
        throw new BadRequestException('Selected slot is no longer available');
      }
      this.logger.error(`insertAppointmentRecord failed: ${message}`);
      throw new InternalServerErrorException('Unable to create appointment');
    }
    return data;
  }

  /**
   * Creates an appointment on behalf of a client from inside the salon (staff
   * booking). Reuses the public availability engine via {@link resolveBookingContext}
   * — same rota/leave/break/conflict checks, same multi-service duration stacking,
   * and the DB no-overlap guard as a backstop — so it is NOT a second booking
   * engine. It differs from the public flow only in that it: is initiated by a
   * staff user, never forces the Stripe deposit path (payment is recorded via
   * {@link StaffBookingPaymentMode}), records the booking source/channel, and
   * supports an internal staff-only note.
   *
   * Permission + client-scope checks are enforced by the staff-booking module
   * before this is called; `businessId`/`bookedByUserProfileId` come from the
   * authenticated staff actor.
   */
  async createInternalBooking(params: {
    businessId: string;
    bookedByUserProfileId: string;
    request: CreateStaffBookingRequest;
  }): Promise<CreateStaffBookingResponse> {
    const { request } = params;
    const client = await this.fetchClientById(params.businessId, request.clientProfileId);

    const context = await this.resolveBookingContext({
      locationId: request.locationId,
      serviceIds: request.serviceIds,
      staffProfileId: request.staffProfileId,
      selectedStartAt: request.selectedStartAt,
      staffRequestMode: request.staffRequestMode,
      client: {
        firstName: client.first_name,
        lastName: client.last_name,
        email: client.email ?? undefined,
        phone: client.phone ?? undefined,
      },
      communicationPreference: request.communicationPreference,
      clientProfileId: request.clientProfileId,
      bookedByUserProfileId: params.bookedByUserProfileId,
      clientNote: request.clientNote,
    }, undefined, { allowOfflineBooking: true });

    // Defence in depth: the resolved location must belong to the actor's business.
    if (context.location.businessId !== params.businessId) {
      throw new ForbiddenException('Location is outside your business');
    }

    const depositRequiredAmount = calculateDepositAmount(context.services);
    const bookingChannel = staffBookingChannel(request.bookingSource);

    const appointment = await this.insertAppointmentRecord({
      businessId: context.location.businessId,
      locationId: context.location.id,
      clientId: client.id,
      bookedByUserProfileId: params.bookedByUserProfileId,
      assignedStaffProfileId: context.stylist.id,
      requestedStaffProfileId: request.staffRequestMode === 'specific_staff' ? context.stylist.id : null,
      staffRequestMode: request.staffRequestMode,
      bookingChannel,
      scheduledStart: context.selectedStart,
      scheduledEnd: context.selectedEnd,
      occupiedRanges: occupiedRangesLiteral(context.services, context.selectedStart),
      communicationPreference: request.communicationPreference,
      clientNote: request.clientNote?.trim() || null,
      internalNote: request.internalNote?.trim() || null,
      metadata: {
        source: request.bookingSource,
        booking_origin: 'staff_booking',
        booking_channel: bookingChannel,
        created_by_user_profile_id: params.bookedByUserProfileId,
        payment_mode: request.paymentMode,
        deposit_required_amount: depositRequiredAmount,
        deposit_collected: request.paymentMode === 'paid_in_full',
        service_ids: context.services.map((service) => service.id),
        service_names: context.services.map((service) => service.name),
        stylist_name: context.stylist.display_name,
        client_display_name: `${client.first_name} ${client.last_name}`.trim(),
        total_duration_minutes: totalDuration(context.services),
        total_price_amount: totalPrice(context.services),
      },
    });

    await this.insertMobileAppointmentServices(appointment.id, context);

    // Soft-link to the client's latest eligible completed visit so stylist
    // rebooking KPIs still credit in-salon rebookings. No-op when none exists.
    await this.linkClientRebookingOutcome({
      businessId: context.location.businessId,
      clientProfileId: client.id,
      appointmentId: appointment.id,
      bookedByUserProfileId: params.bookedByUserProfileId,
      bookingSource: request.bookingSource,
    });

    // Reuse the same notification pipeline (channel resolution + comms logging).
    // Fail-soft: scheduling must never roll back a confirmed booking.
    let confirmationScheduled = false;
    if (request.sendConfirmation !== false) {
      await this.bookingNotifications.syncBookingNotificationsSafe(appointment.id);
      confirmationScheduled = true;
    }

    return {
      appointment: toAppointmentSummary({
        appointment,
        location: context.location,
        attemptServices: toAttemptServices(context.services),
        stylist: context.stylist,
        client,
        communicationPreference: request.communicationPreference,
        depositAmount: depositRequiredAmount,
      }),
      bookingSource: request.bookingSource,
      paymentMode: request.paymentMode,
      depositRequiredAmount,
      confirmationScheduled,
    };
  }

  private async insertMobileAppointmentServices(
    appointmentId: string,
    context: {
      location: PublicBookingLocationSummary;
      services: PublicBookingServiceSummary[];
      stylist: StaffRow;
      selectedStart: Date;
    },
  ): Promise<void> {
    let cursor = context.selectedStart;
    const rows = context.services.map((service, index) => {
      const start = cursor;
      const end = new Date(start.getTime() + service.estimatedDurationMinutes * 60_000);
      cursor = end;
      return {
        business_id: context.location.businessId,
        location_id: context.location.id,
        appointment_id: appointmentId,
        service_id: service.id,
        assigned_staff_profile_id: context.stylist.id,
        sequence_no: index + 1,
        service_name_snapshot: service.name,
        duration_minutes: service.estimatedDurationMinutes,
        price_amount: service.startingPriceAmount,
        deposit_required_amount: service.depositRequiredAmount,
        status: 'scheduled',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
        segments: service.segments ?? [],
      };
    });
    const { error } = await this.admin.schema('booking').from('appointment_services').insert(rows);
    if (error) {
      this.logger.error(`insertMobileAppointmentServices failed: ${error.message}`);
      await this.admin
        .schema('booking')
        .from('appointments')
        .delete()
        .eq('id', appointmentId)
        .eq('business_id', context.location.businessId);
      throw new InternalServerErrorException('Unable to create appointment services');
    }
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

    this.logger.log(`Attached Stripe PaymentIntent ${paymentIntentId} to booking attempt ${attempt.id}`);
    return data;
  }

  private async insertBookingAttemptServices(
    bookingAttemptId: string,
    input: {
      businessId: string;
      locationId: string;
      staffProfileId: string;
      services: PublicBookingServiceSummary[];
      selectedStart: Date;
      depositAmount: number;
    },
  ): Promise<void> {
    let cursor = input.selectedStart;
    const rows = input.services.map((service, index) => {
      const start = cursor;
      const end = new Date(start.getTime() + service.estimatedDurationMinutes * 60_000);
      cursor = end;
      return {
        business_id: input.businessId,
        location_id: input.locationId,
        booking_attempt_id: bookingAttemptId,
        service_id: service.id,
        assigned_staff_profile_id: input.staffProfileId,
        sequence_no: index + 1,
        service_name_snapshot: service.name,
        duration_minutes: service.estimatedDurationMinutes,
        price_amount: service.startingPriceAmount,
        deposit_required_amount: service.depositRequiredAmount,
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
        segments: service.segments ?? [],
      };
    });

    const { error } = await this.admin.schema('booking').from('booking_attempt_services').insert(rows);
    if (error) {
      this.logger.error(`insertBookingAttemptServices failed: ${error.message}`);
      await this.admin.schema('booking').from('booking_attempts').delete().eq('id', bookingAttemptId);
      throw new InternalServerErrorException('Unable to persist booking services');
    }
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

  private async fetchServiceIdsForAttempt(attempt: BookingAttemptRow): Promise<string[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('booking_attempt_services')
      .select('service_id,sequence_no')
      .eq('booking_attempt_id', attempt.id)
      .order('sequence_no', { ascending: true })
      .returns<Array<{ service_id: string; sequence_no: number }>>();

    if (error) {
      this.logger.error(`fetchServiceIdsForAttempt failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking services');
    }
    const serviceIds = (data ?? []).map((row) => row.service_id);
    return serviceIds.length > 0 ? serviceIds : [attempt.service_id];
  }

  private async finalizePaidBookingAttempt(
    attempt: BookingAttemptRow,
    paymentIntent: StripePaymentIntent,
  ): Promise<AppointmentInsertRow> {
    const latestAttempt = await this.fetchBookingAttemptById(attempt.id);
    if (latestAttempt.appointment_id) return this.fetchAppointmentInsertRow(latestAttempt.appointment_id);
    if (!BOOKING_ATTEMPT_PAYABLE_STATUSES.includes(latestAttempt.status)) {
      throw new ConflictException('Booking attempt is no longer pending payment');
    }

    const context = await this.resolveBookingContext(
      {
        locationId: latestAttempt.location_id,
        serviceIds: await this.fetchServiceIdsForAttempt(latestAttempt),
        staffProfileId: latestAttempt.stylist_profile_id,
        selectedStartAt: latestAttempt.selected_start_at,
        staffRequestMode: latestAttempt.staff_request_mode,
        client: await this.clientDetailsForAttempt(latestAttempt),
        communicationPreference: latestAttempt.communication_preference,
        clientProfileId: latestAttempt.client_profile_id,
        bookedByUserProfileId: latestAttempt.user_profile_id,
        clientNote: latestAttempt.client_note ?? undefined,
      },
      latestAttempt.id,
    );

    const appointment = await this.insertAppointmentForAttempt(latestAttempt, context, paymentIntent.id);
    await this.insertAppointmentServicesForAttempt(latestAttempt, context, appointment.id);

    const { data: confirmedAttempt, error } = await this.admin
      .schema('booking')
      .from('booking_attempts')
      .update({ status: 'confirmed', appointment_id: appointment.id })
      .eq('id', latestAttempt.id)
      .in('status', BOOKING_ATTEMPT_PAYABLE_STATUSES)
      .is('appointment_id', null)
      .select(BOOKING_ATTEMPT_COLUMNS)
      .maybeSingle<BookingAttemptRow>();

    if (error) {
      this.logger.error(`finalizePaidBookingAttempt update attempt failed: ${error.message}`);
      await this.deleteAppointmentAfterFailedFinalization(latestAttempt, appointment.id);
      throw new InternalServerErrorException('Unable to confirm booking attempt');
    }
    if (!confirmedAttempt) {
      await this.deleteAppointmentAfterFailedFinalization(latestAttempt, appointment.id);
      const replayedAttempt = await this.fetchBookingAttemptById(latestAttempt.id);
      if (replayedAttempt.appointment_id) return this.fetchAppointmentInsertRow(replayedAttempt.appointment_id);
      throw new ConflictException('Booking attempt was finalized by another webhook worker');
    }

    this.logger.log(
      `Finalized booking attempt ${confirmedAttempt.id} into appointment ${appointment.id} for PaymentIntent ${paymentIntent.id}`,
    );

    // The paid booking is 'pending' — client confirmation + reminders are
    // scheduled when an owner/manager accepts it, not here.

    return appointment;
  }

  private async insertAppointmentForAttempt(
    attempt: BookingAttemptRow,
    context: {
      location: PublicBookingLocationSummary;
      services: PublicBookingServiceSummary[];
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
        // Client paid the deposit, but the booking still awaits owner/manager acceptance.
        status: 'pending',
        booking_channel: 'api',
        scheduled_start_at: context.selectedStart.toISOString(),
        scheduled_end_at: context.selectedEnd.toISOString(),
        occupied_ranges: occupiedRangesLiteral(context.services, context.selectedStart),
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

  private async insertAppointmentServicesForAttempt(
    attempt: BookingAttemptRow,
    context: {
      services: PublicBookingServiceSummary[];
      selectedStart: Date;
    },
    appointmentId: string,
  ): Promise<void> {
    let cursor = context.selectedStart;
    const rows = context.services.map((service, index) => {
      const start = cursor;
      const end = new Date(start.getTime() + service.estimatedDurationMinutes * 60_000);
      cursor = end;
      return {
        business_id: attempt.business_id,
        location_id: attempt.location_id,
        appointment_id: appointmentId,
        service_id: service.id,
        assigned_staff_profile_id: attempt.stylist_profile_id,
        sequence_no: index + 1,
        service_name_snapshot: service.name,
        duration_minutes: service.estimatedDurationMinutes,
        price_amount: service.startingPriceAmount,
        deposit_required_amount: service.depositRequiredAmount,
        status: 'scheduled',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
        segments: service.segments ?? [],
      };
    });
    const { error } = await this.admin.schema('booking').from('appointment_services').insert(rows);

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

  private async deleteAppointmentAfterFailedFinalization(
    attempt: BookingAttemptRow,
    appointmentId: string,
  ): Promise<void> {
    const { error } = await this.admin
      .schema('booking')
      .from('appointments')
      .delete()
      .eq('id', appointmentId)
      .eq('business_id', attempt.business_id)
      .eq('location_id', attempt.location_id);

    if (error) {
      this.logger.error(
        `deleteAppointmentAfterFailedFinalization failed for appointment=${appointmentId}: ${error.message}`,
      );
    }
  }

  /**
   * Records the deposit's collection exactly once.
   *
   * Stripe re-delivers `payment_intent.succeeded` until it gets a 2xx, and may
   * deliver an event more than once, so this runs again for an attempt that is
   * already confirmed. The update only applies while no collection is recorded
   * (`paid_at` is null and the deposit is still awaiting payment): a repeat never
   * moves `paid_at`, never records a second collection, and never turns a
   * refunded or partially refunded deposit back into `paid`. Financial reporting
   * (R1 Money) reads the collection by `paid_at` and refunds by `refunded_at`.
   */
  private async markDepositPaid(
    attempt: BookingAttemptRow,
    paymentIntent: StripePaymentIntent,
  ): Promise<void> {
    const chargeId =
      typeof paymentIntent.latest_charge === 'string' ? paymentIntent.latest_charge : paymentIntent.latest_charge?.id;
    const { data, error } = await this.admin
      .schema('booking')
      .from('deposits')
      .update({
        appointment_id: attempt.appointment_id,
        provider_charge_id: chargeId ?? null,
        status: 'paid',
        paid_at: new Date().toISOString(),
        metadata: { stripe_status: paymentIntent.status },
      })
      .eq('booking_attempt_id', attempt.id)
      .is('paid_at', null)
      .in('status', DEPOSIT_AWAITING_PAYMENT_STATUSES)
      .select('id');

    if (error) {
      this.logger.error(`markDepositPaid failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to mark deposit paid');
    }
    if (!data || data.length === 0) {
      this.logger.log(
        `Deposit collection already recorded for attempt=${attempt.id} paymentIntent=${paymentIntent.id}; repeated payment_intent.succeeded left it unchanged`,
      );
      return;
    }
    this.logger.log(
      `Marked booking deposit paid for attempt=${attempt.id} appointment=${attempt.appointment_id ?? 'pending'} paymentIntent=${paymentIntent.id}`,
    );
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

  private async linkClientRebookingOutcome(input: {
    businessId: string;
    clientProfileId: string;
    appointmentId: string;
    bookedByUserProfileId?: string | null;
    bookingSource: string;
    bookingAttemptId?: string;
  }): Promise<void> {
    await this.rebooking.linkLatestEligibleClientVisit({
      businessId: input.businessId,
      clientProfileId: input.clientProfileId,
      rebookedAppointmentId: input.appointmentId,
      rebookedByUserProfileId: input.bookedByUserProfileId,
      source: 'client',
      metadata: {
        booking_source: input.bookingSource,
        booking_attempt_id: input.bookingAttemptId,
      },
    });
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
    const [location, attemptServices, stylist, client, deposit, appointment] = await Promise.all([
      this.resolveLocation({ locationId: attempt.location_id }),
      this.fetchBookingAttemptServices(attempt),
      this.fetchStaffById(attempt.business_id, attempt.location_id, attempt.stylist_profile_id),
      this.fetchClientById(attempt.business_id, attempt.client_profile_id),
      this.fetchDepositForAttempt(attempt.id),
      attempt.appointment_id ? this.fetchAppointmentInsertRow(attempt.appointment_id) : Promise.resolve(undefined),
    ]);
    const serviceIds = attemptServices.map((service) => service.service_id);
    const serviceNames = attemptServices.map((service) => service.service_name_snapshot);
    const totalDurationMinutes = attemptServices.reduce((sum, service) => sum + Number(service.duration_minutes), 0);
    const totalPriceAmount = attemptServices.reduce((sum, service) => sum + Number(service.price_amount), 0);

    return {
      id: attempt.id,
      status: attempt.status,
      locationId: location.id,
      serviceIds,
      serviceNames,
      totalDurationMinutes,
      totalPriceAmount,
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
            attemptServices,
            stylist,
            client,
            communicationPreference: attempt.communication_preference,
            depositAmount: Number(attempt.deposit_amount),
          })
        : undefined,
    };
  }

  private async fetchBookingAttemptServices(attempt: BookingAttemptRow): Promise<BookingAttemptServiceRow[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('booking_attempt_services')
      .select(BOOKING_ATTEMPT_SERVICE_COLUMNS)
      .eq('booking_attempt_id', attempt.id)
      .order('sequence_no', { ascending: true })
      .returns<BookingAttemptServiceRow[]>();

    if (error) {
      this.logger.error(`fetchBookingAttemptServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking services');
    }
    if (data && data.length > 0) return data;

    const service = await this.fetchService(
      attempt.business_id,
      attempt.location_id,
      attempt.service_id,
      attempt.currency_code,
    );
    return [
      {
        service_id: service.id,
        sequence_no: 1,
        service_name_snapshot: service.name,
        duration_minutes: service.estimatedDurationMinutes,
        price_amount: service.startingPriceAmount,
        deposit_required_amount: service.depositRequiredAmount,
      },
    ];
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
  const category = first(row.service_categories);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    serviceCategoryId: row.service_category_id ?? undefined,
    category: category?.name ?? undefined,
    categoryColorHex: category?.color_hex ?? undefined,
    categorySortOrder: category?.sort_order ?? undefined,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    startingPriceAmount: Number(row.base_price),
    depositRequiredAmount: calculateServiceDeposit(row),
    // Carried so a per-stylist price override can recompute a percentage deposit
    // off the effective price (depositForServicePrice / applyStylistServicePricing).
    depositType: row.deposit_type,
    depositValue: Number(row.deposit_value),
    currencyCode,
    segments: toSegmentSummaries(row.service_segments),
  };
}

/** Adapts booking services to the minimal shape the occupancy maths needs. */
function toOccupancyServices(services: PublicBookingServiceSummary[]): OccupancyService[] {
  return services.map((service) => ({
    durationMinutes: service.estimatedDurationMinutes,
    segments: (service.segments ?? []).map((segment) => ({
      durationMinutes: segment.durationMinutes,
      isStylistFree: segment.isStylistFree,
    })),
  }));
}

/**
 * The tstzmultirange literal of a booking's stylist-occupied windows, for the
 * appointment/attempt header. Snapshots the occupied time at write-time so a
 * later catalogue edit never moves an existing booking's windows.
 */
function occupiedRangesLiteral(services: PublicBookingServiceSummary[], start: Date): string {
  return toMultirangeLiteral(occupiedIntervalsFrom(toOccupancyServices(services), start));
}

/** Orders the embedded segments and maps to the client-facing summary shape. */
function toSegmentSummaries(
  embed: ServiceSegmentEmbed | ServiceSegmentEmbed[] | null,
): { name: string; durationMinutes: number; isStylistFree: boolean }[] {
  return arrayOf(embed)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((segment) => ({
      name: segment.name,
      durationMinutes: segment.duration_minutes,
      isStylistFree: segment.is_stylist_free ?? false,
    }));
}

function toLocationSummary(row: LocationRow): PublicBookingLocationSummary {
  const settings = first(row.location_settings);
  const business = first(row.businesses);
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    slug: row.slug,
    salonCode: row.public_code ?? undefined,
    timezone: row.timezone,
    currencyCode: settings?.currency_code ?? business?.default_currency_code ?? 'GBP',
    appointmentSlotMinutes: settings?.appointment_slot_minutes ?? 15,
    allowNextAvailable: settings?.allow_next_available ?? true,
    cancellationNoticeHours: settings?.cancellation_notice_hours,
    addressLine1: row.address_line_1 ?? undefined,
    addressLine2: row.address_line_2 ?? undefined,
    city: row.city ?? undefined,
    region: row.region ?? undefined,
    postalCode: row.postal_code ?? undefined,
    countryCode: row.country_code ?? undefined,
    phone: row.phone ?? undefined,
  };
}

// Exported for direct unit testing of the slot-stepping/anchoring behaviour —
// the service's data fetching is not involved at this level.
export function availableSlotsInShift(
  start: Date,
  end: Date,
  shift: ShiftRow,
  breaks: BreakRow[],
  // Stylist-occupied windows of OTHER bookings/attempts (not their whole spans),
  // so a candidate may overlap another booking's stylist-free development time.
  occupiedIntervals: TimeInterval[],
  leave: LeaveRow[],
  absences: AbsenceRow[],
  durationMinutes: number,
  // The candidate booking's OWN occupied sub-windows, as offsets from its start.
  candidateOccupied: OffsetInterval[],
  slotMinutes: number,
  firstOnly: boolean,
): Date[] {
  const slotMs = slotMinutes * 60_000;
  const durationMs = durationMinutes * 60_000;
  // Anchor the slot grid to the SHIFT start, not the Unix epoch: an epoch
  // anchor only coincides with clock hours by luck — at 60-minute slots a
  // 09:15 shift would have offered 10:00 first (45 bookable minutes lost) and
  // half-hour-offset timezones would misalign with the diary grid entirely.
  let cursor = roundUpToAnchor(start, new Date(shift.scheduled_start_at), slotMs);
  const busy = [
    ...breaks.map((row) => ({ start: new Date(row.started_at), end: new Date(row.ended_at) })),
    ...occupiedIntervals,
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

  // The client occupies the chair for the WHOLE appointment, so the full span
  // must fit inside the shift. But only the booking's OCCUPIED sub-windows have
  // to avoid other bookings' occupied time — its stylist-free (development)
  // windows may overlap anything, which is what lets bookings interleave.
  while (cursor.getTime() + durationMs <= end.getTime()) {
    const cursorMs = cursor.getTime();
    const conflict = candidateOccupied.some((occ) => {
      const occStart = cursorMs + occ.startMs;
      const occEnd = cursorMs + occ.endMs;
      return busy.some((range) => occStart < range.end.getTime() && occEnd > range.start.getTime());
    });
    if (!conflict) {
      slots.push(cursor);
      if (firstOnly) return slots;
    }
    // Single-slot step: with interleaving the booking is no longer one solid
    // block, so jumping past a conflict's end could skip a valid start where the
    // clash falls inside one of the booking's free windows.
    cursor = new Date(cursor.getTime() + slotMs);
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

function calculateDepositAmount(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.depositRequiredAmount, 0);
}

/** Maps a staff booking source onto the booking.booking_channel_enum value persisted on the appointment. */
export function staffBookingChannel(source: StaffBookingSource): 'staff_app' | 'phone' | 'walk_in' {
  switch (source) {
    case 'walk_in':
      return 'walk_in';
    case 'phone_booking':
      return 'phone';
    case 'staff_booking':
    default:
      return 'staff_app';
  }
}

function totalDuration(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0);
}

function totalPrice(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.startingPriceAmount, 0);
}

function calculateServiceDeposit(row: ServiceRow): number {
  const price = Number(row.base_price);
  const value = Number(row.deposit_value);
  if (row.deposit_type === 'fixed_amount') return Math.max(0, value);
  if (row.deposit_type === 'percentage') return Math.max(0, Math.round((price * value) / 100));
  return 0;
}

function toAttemptServices(services: PublicBookingServiceSummary[]): BookingAttemptServiceRow[] {
  return services.map((service, index) => ({
    service_id: service.id,
    sequence_no: index + 1,
    service_name_snapshot: service.name,
    duration_minutes: service.estimatedDurationMinutes,
    price_amount: service.startingPriceAmount,
    deposit_required_amount: service.depositRequiredAmount,
  }));
}

function toAppointmentSummary(input: {
  appointment: AppointmentInsertRow;
  location: PublicBookingLocationSummary;
  attemptServices: BookingAttemptServiceRow[];
  stylist: StaffRow;
  client: ClientProfileRow;
  communicationPreference: string;
  depositAmount: number;
}): PublicBookingAppointmentSummary {
  const serviceIds = input.attemptServices.map((service) => service.service_id);
  const serviceNames = input.attemptServices.map((service) => service.service_name_snapshot);
  return {
    id: input.appointment.id,
    locationId: input.location.id,
    serviceIds,
    serviceNames,
    totalDurationMinutes: input.attemptServices.reduce((sum, service) => sum + Number(service.duration_minutes), 0),
    totalPriceAmount: input.attemptServices.reduce((sum, service) => sum + Number(service.price_amount), 0),
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

function parseServiceIds(value: string): string[] {
  return unique(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The first instant at or after `date` that sits on the grid defined by
 * `anchor + n × incrementMs`. `date` at or before the anchor returns the
 * anchor itself (slot stepping never starts before the shift does).
 */
function roundUpToAnchor(date: Date, anchor: Date, incrementMs: number): Date {
  const offsetMs = Math.max(0, date.getTime() - anchor.getTime());
  return new Date(anchor.getTime() + Math.ceil(offsetMs / incrementMs) * incrementMs);
}

function earliest(values: string[]): string | undefined {
  return values.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
}

function first<T>(value: T | T[] | null): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function arrayOf<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// Fallbacks for deriving first/last name from a stored full name, used only when
// a customer's profile somehow lacks the (normally NOT-NULL) split name columns.
function firstNameFromFullName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'Client';
  return trimmed.split(/\s+/)[0] ?? 'Client';
}

function lastNameFromFullName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return 'Client';
  return parts.slice(1).join(' ');
}
