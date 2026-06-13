import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AcceptBookingResponse,
  AppointmentCompletionLineItem,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
  AppointmentPaymentRecord,
  AppointmentStatus,
  AuthUser,
  CancelAppointmentResponse,
  CheckInAppointmentResponse,
  CreateStylistRebookingRequest,
  CrmVisitSummary,
  ListStaffBookingsResponse,
  ProductBillingRule,
  RejectBookingResponse,
  RescheduleAppointmentRequest,
  RescheduleAppointmentResponse,
  StaffBookingPatchTestSummary,
  StaffBookingDetail,
  StaffBookingSummary,
} from '@sheer/domain';
import {
  calculateAppointmentBillingTax,
  calculateTaxForCategory,
  type LocationTaxSettings,
  type TaxableCategory,
} from '@sheer/domain';
import { buildProductBillingSnapshot } from '../common/product-billing.helper';
import { BookingNotificationService } from '../communications/booking-notification.service';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';
import { OwnerTaxSettingsService } from '../owner-tax-settings/owner-tax-settings.service';
import { RebookingService } from '../rebooking/rebooking.service';
import { StripeService } from '../stripe/stripe.service';

interface AppointmentServiceRow {
  id?: string;
  service_id?: string;
  service_name_snapshot: string;
  duration_minutes: number;
  deposit_required_amount: number | string;
  price_amount?: number | string | null;
}

interface DepositRow {
  status: string;
  amount: number | string;
  currency_code?: string | null;
}

// A row from the booking.services catalogue, used when editing an appointment's
// services. Mirrors the columns the booking flow reads to snapshot price/duration.
interface ServiceCatalogRow {
  id: string;
  name: string;
  estimated_duration_minutes: number;
  base_price: number | string;
  deposit_type: 'none' | 'fixed_amount' | 'percentage';
  deposit_value: number | string;
  is_active?: boolean | null;
  location_id?: string | null;
}

// A catalogue service resolved into the figures we snapshot onto appointment_services.
interface ResolvedCatalogService {
  id: string;
  name: string;
  durationMinutes: number;
  priceAmount: number;
  depositAmount: number;
}

interface StaffProfileRow {
  id: string;
  display_name: string | null;
  is_bookable?: boolean | null;
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
  check_in_at?: string | null;
  communication_preference?: string | null;
  client_note: string | null;
  internal_note?: string | null;
  completed_at?: string | null;
  completed_by_user_profile_id?: string | null;
  completed_by_staff_profile_id?: string | null;
  appointment_services: AppointmentServiceRow[] | AppointmentServiceRow | null;
  deposits?: DepositRow[] | DepositRow | null;
}

interface VisitRow {
  id: string;
  business_id: string;
  location_id: string;
  appointment_id: string | null;
  client_profile_id: string;
  primary_staff_profile_id: string | null;
  status: 'checked_in' | 'in_progress' | 'completed' | 'awaiting_payment' | 'paid' | 'cancelled';
  checked_in_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  completed_by_user_profile_id?: string | null;
  completed_by_staff_profile_id?: string | null;
  checkout_status?: 'not_ready' | 'awaiting_payment' | 'paid' | 'voided';
  checkout_ready_at?: string | null;
  paid_at?: string | null;
  paid_by_user_profile_id?: string | null;
  paid_by_staff_profile_id?: string | null;
  service_summary: string | null;
  client_visible_summary: string | null;
  created_at: string;
  rebooking_outcomes?: RebookingOutcomeRelation[] | RebookingOutcomeRelation | null;
}

interface RebookingOutcomeRelation {
  id: string;
  rebooked_appointment_id: string;
  rebook_source: 'stylist' | 'client';
  rebooked_at: string;
}

interface VisitLineItemRow {
  line_type: string;
  description: string;
  amount_cents: number;
  currency_code: string;
}

interface FormulaBillingRow {
  external_formula_id: string | null;
  actual_cost_cents: number;
  billable_charge_cents: number;
  currency_code: string;
  saved_at: string | null;
}

interface ProductBillingRulesRow {
  product_billing_enabled: boolean;
  product_billing_rule: string;
  product_markup_percent: number | null;
  product_fixed_uplift_amount: number | null;
  product_round_up_enabled: boolean | null;
  product_round_up_increment: number | null;
}

interface SalonPaymentRow {
  id: string;
  appointment_id: string;
  visit_id: string;
  payment_method: 'cash' | 'card_reader';
  amount_cents: number;
  currency_code: string;
  paid_at: string;
  confirmed_by_user_profile_id: string | null;
  confirmed_by_staff_profile_id: string | null;
  notes: string | null;
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
  'awaiting_acceptance',
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'awaiting_payment',
  'paid',
];
const COMPLETABLE_BOOKING_STATUSES: AppointmentStatus[] = ['confirmed', 'checked_in', 'in_progress'];
const PAYABLE_BOOKING_STATUSES: AppointmentStatus[] = ['awaiting_payment'];
// A confirmed booking checks in to 'checked_in'. These statuses mean the client
// has already arrived (or moved past arrival), so a check-in is a no-op.
const CHECKED_IN_OR_LATER_STATUSES: AppointmentStatus[] = [
  'checked_in',
  'in_progress',
  'awaiting_payment',
  'paid',
  'completed',
];
// Statuses a booking can be cancelled from via the book. 'awaiting_acceptance'
// is handled by reject; 'awaiting_payment'/'paid'/'completed' already have a visit
// in flight; 'cancelled'/'no_show' are terminal. (DB-enum-valid values only.)
const CANCELLABLE_BOOKING_STATUSES: AppointmentStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
];
// Statuses a booking can be moved/reassigned from. Once a visit exists
// (awaiting_payment onwards) the time is locked. (DB-enum-valid values only.)
const RESCHEDULABLE_BOOKING_STATUSES: AppointmentStatus[] = ['pending', 'confirmed', 'checked_in'];

const LIST_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,client_note,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,appointment_services(service_id,service_name_snapshot,duration_minutes,deposit_required_amount,price_amount),deposits(status,amount,currency_code)';

const DETAIL_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,communication_preference,client_note,internal_note,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,appointment_services(id,service_id,service_name_snapshot,duration_minutes,deposit_required_amount,price_amount),deposits(status,amount,currency_code)';
const VISIT_COLUMNS =
  'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,checkout_status,checkout_ready_at,paid_at,paid_by_user_profile_id,paid_by_staff_profile_id,service_summary,client_visible_summary,created_at';
const REBOOKING_VISIT_COLUMNS = `${VISIT_COLUMNS},rebooking_outcomes(id,rebooked_appointment_id,rebook_source,rebooked_at)`;

@Injectable()
export class LabAppointmentsService {
  private readonly logger = new Logger(LabAppointmentsService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly rebooking: RebookingService,
    private readonly taxSettings: OwnerTaxSettingsService,
    private readonly bookingNotifications: BookingNotificationService,
    private readonly stripe: StripeService,
  ) {
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

  /**
   * Owner/manager approves a client-requested booking. Moves it from
   * 'awaiting_acceptance' → 'confirmed' and only THEN schedules the client
   * confirmation + reminders and credits any eligible rebooking outcome (these
   * are deliberately not fired at booking time for client requests).
   */
  async accept(actor: AuthUser, id: string): Promise<AcceptBookingResponse> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);
    if (appointment.status !== 'awaiting_acceptance') {
      throw new ConflictException(`Booking cannot be accepted from ${appointment.status}`);
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'confirmed' })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .eq('status', 'awaiting_acceptance')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`accept failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to accept booking');
    }
    const confirmed = data ?? (await this.fetchAppointmentById(id, actor.businessId));
    if (confirmed.status !== 'confirmed') {
      throw new ConflictException('Booking was updated before it could be accepted');
    }

    // Now it is a real confirmed appointment → schedule the client confirmation +
    // reminders through the same fail-soft, idempotent engine the booking flow uses.
    await this.bookingNotifications.syncBookingNotificationsSafe(confirmed.id);
    // Credit a rebooking outcome if the client had an eligible recent visit. Fail-soft:
    // a rebooking edge must never block the acceptance.
    try {
      await this.rebooking.linkLatestEligibleClientVisit({
        businessId: confirmed.business_id,
        clientProfileId: confirmed.client_profile_id,
        rebookedAppointmentId: confirmed.id,
        rebookedByUserProfileId: actor.id,
        source: 'client',
        metadata: { booking_source: 'client_booking_acceptance' },
      });
    } catch (err) {
      this.logger.warn(`rebooking link on accept failed (non-fatal): ${(err as Error).message}`);
    }

    const clientsById = await this.fetchClientProfiles(actor.businessId, [confirmed.client_profile_id]);
    return { appointment: toBookingDetail(confirmed, clientsById.get(confirmed.client_profile_id)) };
  }

  /**
   * Owner/manager rejects a client-requested booking. Refunds any paid deposit via
   * Stripe (the client is made whole), then moves the appointment to 'cancelled'.
   * The refund is best-effort: a refund failure is surfaced but never blocks the
   * cancellation (the deposit stays 'paid' so it can be refunded manually).
   */
  async reject(actor: AuthUser, id: string, reason?: string): Promise<RejectBookingResponse> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);
    if (appointment.status !== 'awaiting_acceptance') {
      throw new ConflictException(`Booking cannot be rejected from ${appointment.status}`);
    }

    const refund = await this.refundPaidDeposit(appointment);

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason?.trim() || 'Rejected by salon',
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .eq('status', 'awaiting_acceptance')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`reject failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reject booking');
    }
    const cancelled = data ?? (await this.fetchAppointmentById(id, actor.businessId));
    if (cancelled.status !== 'cancelled') {
      throw new ConflictException('Booking was updated before it could be rejected');
    }

    const clientsById = await this.fetchClientProfiles(actor.businessId, [cancelled.client_profile_id]);
    return {
      appointment: toBookingDetail(cancelled, clientsById.get(cancelled.client_profile_id)),
      depositRefunded: refund.refunded,
      refundError: refund.error,
    };
  }

  /** Refund the appointment's paid deposit (if any) via Stripe. Best-effort, never throws. */
  private async refundPaidDeposit(appointment: AppointmentRow): Promise<{ refunded: boolean; error?: string }> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('deposits')
      .select('id,provider_payment_intent_id,status')
      .eq('appointment_id', appointment.id)
      .eq('status', 'paid')
      .maybeSingle<{ id: string; provider_payment_intent_id: string | null; status: string }>();
    if (error) {
      this.logger.error(`refundPaidDeposit lookup failed: ${error.message}`);
      return { refunded: false, error: 'Could not load the deposit to refund' };
    }
    if (!data?.provider_payment_intent_id) return { refunded: false };

    try {
      await this.stripe.refundPaymentIntent(data.provider_payment_intent_id);
    } catch (err) {
      const message = (err as Error).message ?? 'Stripe refund failed';
      this.logger.error(`refundPaidDeposit failed for deposit ${data.id}: ${message}`);
      // Leave the deposit 'paid' so it is clearly still owed back and can be refunded manually.
      return { refunded: false, error: message };
    }

    const { error: updateError } = await this.admin
      .schema('booking')
      .from('deposits')
      .update({ status: 'refunded', refunded_at: new Date().toISOString() })
      .eq('id', data.id);
    if (updateError) {
      this.logger.error(`mark deposit refunded failed for ${data.id}: ${updateError.message}`);
    }
    return { refunded: true };
  }

  private assertOwnerOrManager(actor: AuthUser): void {
    if (actor.role !== 'owner' && actor.role !== 'manager') {
      throw new ForbiddenException('Only an owner or manager can review booking requests');
    }
  }

  /**
   * Mark a confirmed appointment as arrived (client checked in at the desk).
   * Moves 'confirmed' → 'checked_in' and stamps check_in_at. The status change is
   * itself the in-app signal to the assigned stylist — their book shows the client
   * as arrived. Idempotent: a booking already arrived (or further along) is returned
   * unchanged so a double-tap never errors.
   */
  async checkIn(actor: AuthUser, id: string): Promise<CheckInAppointmentResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);

    if (CHECKED_IN_OR_LATER_STATUSES.includes(appointment.status)) {
      const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return { appointment: toBookingDetail(appointment, clientsById.get(appointment.client_profile_id)) };
    }
    if (appointment.status !== 'confirmed') {
      throw new ConflictException(`Appointment cannot be checked in from ${appointment.status}`);
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'checked_in', check_in_at: new Date().toISOString() })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .eq('status', 'confirmed')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`checkIn failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to check in appointment');
    }
    const checkedIn = data ?? (await this.fetchAppointmentById(id, actor.businessId));
    if (!CHECKED_IN_OR_LATER_STATUSES.includes(checkedIn.status)) {
      throw new ConflictException('Appointment was updated before it could be checked in');
    }

    const clientsById = await this.fetchClientProfiles(actor.businessId, [checkedIn.client_profile_id]);
    return { appointment: toBookingDetail(checkedIn, clientsById.get(checkedIn.client_profile_id)) };
  }

  /**
   * Cancel a confirmed/checked-in appointment straight from the book. Like reject,
   * this is an owner/manager decision because it refunds the client's paid deposit
   * via Stripe. It claims the 'cancelled' transition FIRST (a conditional update),
   * and only the request that wins that claim performs the refund + notification
   * re-sync — so concurrent front-desk cancels can never double-refund. 'reject'
   * stays the path for client requests still awaiting acceptance.
   */
  async cancel(actor: AuthUser, id: string, reason?: string): Promise<CancelAppointmentResponse> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);

    if (appointment.status === 'cancelled') {
      const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return {
        appointment: toBookingDetail(appointment, clientsById.get(appointment.client_profile_id)),
        depositRefunded: false,
      };
    }
    if (!CANCELLABLE_BOOKING_STATUSES.includes(appointment.status)) {
      throw new ConflictException(`Appointment cannot be cancelled from ${appointment.status}`);
    }

    // Claim the cancellation atomically. The `.in(status, CANCELLABLE)` guard means
    // only one of two racing requests gets a row back; the loser refunds nothing.
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason?.trim() || 'Cancelled by salon',
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', CANCELLABLE_BOOKING_STATUSES)
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`cancel failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to cancel appointment');
    }

    if (!data) {
      // Lost the race (someone else already cancelled it) — do NOT refund again.
      const replayed = await this.fetchAppointmentById(id, actor.businessId);
      if (replayed.status !== 'cancelled') {
        throw new ConflictException('Appointment was updated before it could be cancelled');
      }
      const clientsById = await this.fetchClientProfiles(actor.businessId, [replayed.client_profile_id]);
      return {
        appointment: toBookingDetail(replayed, clientsById.get(replayed.client_profile_id)),
        depositRefunded: false,
      };
    }

    // We own the cancellation → refund the paid deposit (best-effort; a failure
    // leaves the deposit 'paid' so it can be refunded manually) and stop the
    // client's pending confirmations/reminders. Fail-soft on the notification sync.
    const refund = await this.refundPaidDeposit(data);
    await this.bookingNotifications.syncBookingNotificationsSafe(data.id);

    const clientsById = await this.fetchClientProfiles(actor.businessId, [data.client_profile_id]);
    return {
      appointment: toBookingDetail(data, clientsById.get(data.client_profile_id)),
      depositRefunded: refund.refunded,
      refundError: refund.error,
    };
  }

  /**
   * Move a booking to a new time and/or reassign its stylist from the book, and
   * optionally replace the services on it. With no `serviceIds` the service list and
   * total duration are preserved and only the per-service times are re-sequenced.
   * With `serviceIds`, the services (and therefore price/deposit/duration) are
   * swapped for the new selection. Either way the client's reminders are re-synced.
   */
  async reschedule(
    actor: AuthUser,
    id: string,
    input: RescheduleAppointmentRequest,
  ): Promise<RescheduleAppointmentResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    if (!RESCHEDULABLE_BOOKING_STATUSES.includes(appointment.status)) {
      throw new ConflictException(`Appointment cannot be rescheduled from ${appointment.status}`);
    }

    // Edit Appointment is a day-of tool, so (unlike rebooking) it allows moving to
    // an earlier slot today — only the date itself must be valid, not in the future.
    const newStart = parseValidDate(input.scheduledStartAt);
    const currentServices = arrayOf(appointment.appointment_services);

    // Compare the requested services to the current set so a no-op resubmit (same
    // services) skips the catalogue lookup + row replacement and behaves exactly
    // like a plain time/stylist move. Order changes alone are not a service edit.
    const currentServiceIds = currentServices
      .map((service) => service.service_id)
      .filter((sid): sid is string => Boolean(sid));
    const requestedServiceIds = input.serviceIds
      ? Array.from(new Set(input.serviceIds.filter(Boolean)))
      : undefined;
    const servicesChanged =
      requestedServiceIds !== undefined && !sameStringSet(requestedServiceIds, currentServiceIds);

    // Resolve the assigned stylist first — both the eligibility check and the new
    // service rows hang off it.
    const staffProfileId =
      input.staffProfileId ?? appointment.assigned_staff_profile_id ?? actor.staffProfileId ?? undefined;
    const staffChanged = Boolean(staffProfileId) && staffProfileId !== appointment.assigned_staff_profile_id;
    if (staffProfileId && staffChanged) {
      this.assertCanAssignRebookingStaff(actor, staffProfileId, appointment.location_id);
      await this.assertStaffBookable(actor.businessId, appointment.location_id, staffProfileId);
    }

    // When the services change, load them from the catalogue (active + in scope),
    // and require the assigned stylist to be eligible for every one — mirroring the
    // hard block the booking flow enforces. Duration is then recomputed from them.
    let resolvedServices: ResolvedCatalogService[] | null = null;
    if (servicesChanged) {
      resolvedServices = await this.fetchCatalogServices(
        actor.businessId,
        appointment.location_id,
        requestedServiceIds as string[],
      );
      if (staffProfileId) {
        await this.assertStaffEligibleForServices(
          actor.businessId,
          staffProfileId,
          requestedServiceIds as string[],
        );
      }
    }

    const durationMinutes = resolvedServices
      ? resolvedServices.reduce((sum, service) => sum + service.durationMinutes, 0) || 30
      : currentServices.reduce((sum, service) => sum + Number(service.duration_minutes ?? 0), 0) ||
        minutesBetween(appointment.scheduled_start_at, appointment.scheduled_end_at) ||
        30;
    const newEnd = new Date(newStart.getTime() + durationMinutes * 60_000);

    if (staffProfileId) {
      await this.assertStaffAvailableForRebooking({
        businessId: actor.businessId,
        locationId: appointment.location_id,
        staffProfileId,
        selectedStart: newStart,
        selectedEnd: newEnd,
        excludeAppointmentId: appointment.id,
      });
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        scheduled_start_at: newStart.toISOString(),
        scheduled_end_at: newEnd.toISOString(),
        assigned_staff_profile_id: staffProfileId ?? appointment.assigned_staff_profile_id,
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', RESCHEDULABLE_BOOKING_STATUSES)
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      const message = error.message ?? '';
      if (message.toLowerCase().includes('booking_appointments_staff_no_overlap')) {
        throw new ConflictException('Selected time overlaps an existing appointment');
      }
      this.logger.error(`reschedule failed: ${message}`);
      throw new InternalServerErrorException('Unable to reschedule appointment');
    }
    const rescheduled = data ?? (await this.fetchAppointmentById(id, actor.businessId));

    // PostgREST has no multi-statement transaction here, so the header and its
    // service rows are written separately. If the service write fails, revert the
    // header to its prior time/stylist so the booking is never left half-moved
    // (header updated, per-service rows stale or missing).
    try {
      if (resolvedServices) {
        await this.replaceAppointmentServices(
          rescheduled,
          resolvedServices,
          newStart,
          staffProfileId ?? rescheduled.assigned_staff_profile_id,
        );
      } else {
        await this.rescheduleAppointmentServices(
          rescheduled,
          newStart,
          staffProfileId ?? rescheduled.assigned_staff_profile_id,
        );
      }
    } catch (err) {
      await this.revertAppointmentSchedule(appointment);
      throw err;
    }

    // The reminder schedule must follow the new time. Fail-soft.
    await this.bookingNotifications.syncBookingNotificationsSafe(rescheduled.id);

    // The header-update projection was captured before the services were replaced,
    // so it still carries the OLD nested service rows. Re-fetch when the services
    // changed so the response reflects the new services/price/duration.
    const finalRow = resolvedServices
      ? await this.fetchAppointmentById(id, actor.businessId)
      : rescheduled;

    const clientsById = await this.fetchClientProfiles(actor.businessId, [finalRow.client_profile_id]);
    return { appointment: toBookingDetail(finalRow, clientsById.get(finalRow.client_profile_id)) };
  }

  // Best-effort restore of the appointment (header + service rows) to its
  // pre-reschedule time/stylist, used to compensate when the per-service
  // re-sequencing fails partway. Never throws — the original failure is what the
  // caller should surface. Service times are rebuilt as a contiguous sequence from
  // the original start, matching how the booking flow lays them out.
  private async revertAppointmentSchedule(prior: AppointmentRow): Promise<void> {
    const { error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        scheduled_start_at: prior.scheduled_start_at,
        scheduled_end_at: prior.scheduled_end_at,
        assigned_staff_profile_id: prior.assigned_staff_profile_id,
      })
      .eq('id', prior.id)
      .eq('business_id', prior.business_id);
    if (error) {
      this.logger.error(`revertAppointmentSchedule header failed for ${prior.id}: ${error.message}`);
    }
    try {
      await this.rescheduleAppointmentServices(
        prior,
        new Date(prior.scheduled_start_at),
        prior.assigned_staff_profile_id,
      );
    } catch (err) {
      this.logger.error(`revertAppointmentSchedule services failed for ${prior.id}: ${(err as Error).message}`);
    }
  }

  // Re-sequence the appointment's service rows from the new start so per-service
  // scheduled times (and any reassigned stylist) stay consistent with the move.
  private async rescheduleAppointmentServices(
    appointment: AppointmentRow,
    newStart: Date,
    staffProfileId: string | null,
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('id,duration_minutes,sequence_no')
      .eq('appointment_id', appointment.id)
      .eq('business_id', appointment.business_id)
      .order('sequence_no', { ascending: true })
      .returns<Array<{ id: string; duration_minutes: number | null; sequence_no: number | null }>>();
    if (error) {
      this.logger.error(`rescheduleAppointmentServices load failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reschedule appointment services');
    }

    let cursor = newStart;
    for (const row of data ?? []) {
      const start = cursor;
      const end = new Date(start.getTime() + Number(row.duration_minutes ?? 0) * 60_000);
      cursor = end;
      const { error: updateError } = await this.admin
        .schema('booking')
        .from('appointment_services')
        .update({
          scheduled_start_at: start.toISOString(),
          scheduled_end_at: end.toISOString(),
          assigned_staff_profile_id: staffProfileId,
        })
        .eq('id', row.id)
        .eq('business_id', appointment.business_id);
      if (updateError) {
        this.logger.error(`rescheduleAppointmentServices update failed: ${updateError.message}`);
        throw new InternalServerErrorException('Unable to reschedule appointment services');
      }
    }
  }

  // Load the requested services from the catalogue, enforcing the same rules as the
  // booking flow: active, belonging to the business, and either salon-wide
  // (location_id IS NULL) or scoped to this appointment's location. Returns them in
  // the requested order and throws if any id doesn't resolve.
  private async fetchCatalogServices(
    businessId: string,
    locationId: string,
    serviceIds: string[],
  ): Promise<ResolvedCatalogService[]> {
    const uniqueIds = Array.from(new Set(serviceIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
      throw new ConflictException('An appointment needs at least one service');
    }
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select('id,name,estimated_duration_minutes,base_price,deposit_type,deposit_value,is_active,location_id')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .in('id', uniqueIds)
      .returns<ServiceCatalogRow[]>();
    if (error) {
      this.logger.error(`fetchCatalogServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }
    const byId = new Map((data ?? []).map((row) => [row.id, resolveCatalogService(row)]));
    const ordered = uniqueIds
      .map((sid) => byId.get(sid))
      .filter((service): service is ResolvedCatalogService => Boolean(service));
    if (ordered.length !== uniqueIds.length) {
      throw new NotFoundException('One or more selected services were not found');
    }
    return ordered;
  }

  // Hard-block: the assigned stylist must be eligible for every selected service
  // (a stylist is eligible only for services explicitly assigned to them in
  // booking.staff_service_eligibility). Mirrors the public booking flow.
  private async assertStaffEligibleForServices(
    businessId: string,
    staffProfileId: string,
    serviceIds: string[],
  ): Promise<void> {
    const required = Array.from(new Set(serviceIds.filter(Boolean)));
    if (required.length === 0) return;
    const { data, error } = await this.admin
      .schema('booking')
      .from('staff_service_eligibility')
      .select('staff_profile_id,service_id')
      .eq('business_id', businessId)
      .in('service_id', required)
      .returns<Array<{ staff_profile_id: string; service_id: string }>>();
    if (error) {
      this.logger.error(`assertStaffEligibleForServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load stylist eligibility');
    }
    const offered = new Set(
      (data ?? []).filter((row) => row.staff_profile_id === staffProfileId).map((row) => row.service_id),
    );
    if (!required.every((sid) => offered.has(sid))) {
      throw new ConflictException('Selected stylist cannot perform one or more of the selected services');
    }
  }

  // Swap the appointment's services for a new selection. PostgREST gives us no
  // transaction across the delete + insert, so we snapshot the prior rows and
  // re-insert them if the new insert fails, leaving the booking untouched. The new
  // rows mirror the booking flow's shape (price/duration/deposit snapshots) and are
  // sequenced contiguously from the new start.
  private async replaceAppointmentServices(
    appointment: AppointmentRow,
    services: ResolvedCatalogService[],
    newStart: Date,
    staffProfileId: string | null,
  ): Promise<void> {
    const { data: prior, error: loadError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('*')
      .eq('appointment_id', appointment.id)
      .eq('business_id', appointment.business_id)
      .returns<Array<Record<string, unknown>>>();
    if (loadError) {
      this.logger.error(`replaceAppointmentServices load failed: ${loadError.message}`);
      throw new InternalServerErrorException('Unable to update appointment services');
    }

    let cursor = newStart;
    const rows = services.map((service, index) => {
      const start = cursor;
      const end = new Date(start.getTime() + service.durationMinutes * 60_000);
      cursor = end;
      return {
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        appointment_id: appointment.id,
        service_id: service.id,
        assigned_staff_profile_id: staffProfileId,
        sequence_no: index + 1,
        service_name_snapshot: service.name,
        duration_minutes: service.durationMinutes,
        price_amount: service.priceAmount,
        deposit_required_amount: service.depositAmount,
        status: 'scheduled',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
      };
    });

    const { error: deleteError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .delete()
      .eq('appointment_id', appointment.id)
      .eq('business_id', appointment.business_id);
    if (deleteError) {
      this.logger.error(`replaceAppointmentServices delete failed: ${deleteError.message}`);
      throw new InternalServerErrorException('Unable to update appointment services');
    }

    const { error: insertError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .insert(rows);
    if (insertError) {
      this.logger.error(`replaceAppointmentServices insert failed: ${insertError.message}`);
      // Best-effort restore of the rows we just deleted so the booking isn't left
      // with no services. The outer caller still reverts the header time/stylist.
      if (prior && prior.length > 0) {
        const { error: restoreError } = await this.admin
          .schema('booking')
          .from('appointment_services')
          .insert(prior);
        if (restoreError) {
          this.logger.error(`replaceAppointmentServices restore failed: ${restoreError.message}`);
        }
      }
      throw new InternalServerErrorException('Unable to update appointment services');
    }
  }

  async complete(actor: AuthUser, id: string): Promise<AppointmentCompletionResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    this.assertCanCompleteAppointment(actor, appointment);

    const alreadyCompleted = appointment.status === 'awaiting_payment' || appointment.status === 'paid';
    if (!alreadyCompleted && !COMPLETABLE_BOOKING_STATUSES.includes(appointment.status)) {
      throw new ConflictException(`Appointment cannot be completed from ${appointment.status}`);
    }

    const completedAt = appointment.completed_at ?? new Date().toISOString();
    const completedByStaffProfileId = actor.staffProfileId ?? appointment.assigned_staff_profile_id ?? undefined;
    const completedAppointment = alreadyCompleted
      ? appointment
      : await this.markAppointmentCompleted(appointment, actor, completedAt, completedByStaffProfileId);

    await this.markAppointmentServicesCompleted(completedAppointment.id, completedAppointment.business_id);
    const visit = await this.ensureAwaitingPaymentVisit(completedAppointment, actor, completedAt, completedByStaffProfileId);
    await this.reconcileServiceLineItem(completedAppointment, visit.id);
    await this.reconcileProductUsageLineItem(completedAppointment, visit.id);
    const [lineItems, clientMap, taxSettings] = await Promise.all([
      this.fetchVisitLineItems(visit.id),
      this.fetchClientProfiles(actor.businessId, [completedAppointment.client_profile_id]),
      this.taxSettings.resolveLocationTaxSettings(
        completedAppointment.business_id,
        completedAppointment.location_id,
      ),
    ]);
    const billing = buildBillingSummary(completedAppointment, lineItems, taxSettings);

    return {
      appointment: toBookingDetail(completedAppointment, clientMap.get(completedAppointment.client_profile_id)),
      visit: toVisitSummary(visit, completedAppointment, clientMap.get(completedAppointment.client_profile_id)),
      checkout: {
        status: visit.checkout_status ?? 'awaiting_payment',
        readyAt: visit.checkout_ready_at ?? visit.completed_at ?? completedAt,
        route: `/checkout/visits/${visit.id}`,
        message: visit.checkout_status === 'paid'
          ? 'Visit is paid and settled.'
          : 'Service is complete. Collect the remaining balance in salon.',
      },
      billing,
      alreadyCompleted,
    };
  }

  async confirmPayment(
    actor: AuthUser,
    id: string,
    input: AppointmentPaymentConfirmationRequest,
  ): Promise<AppointmentPaymentConfirmationResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    this.assertCanConfirmPayment(actor, appointment);
    if (!PAYABLE_BOOKING_STATUSES.includes(appointment.status) && appointment.status !== 'paid') {
      throw new ConflictException(`Appointment cannot be paid from ${appointment.status}`);
    }

    const visit = await this.fetchVisitForAppointment(appointment.id);
    if (!visit) throw new ConflictException('Complete the appointment before confirming payment');

    const [lineItems, taxSettings] = await Promise.all([
      this.fetchVisitLineItems(visit.id),
      this.taxSettings.resolveLocationTaxSettings(appointment.business_id, appointment.location_id),
    ]);
    const billing = buildBillingSummary(appointment, lineItems, taxSettings);
    if (input.amountCents !== billing.balanceDueCents) {
      throw new ConflictException('Payment amount must match the remaining balance due');
    }

    const existingPayment = await this.fetchSalonPaymentForVisit(visit.id);
    const paidAt = existingPayment?.paid_at ?? new Date().toISOString();
    const confirmedByStaffProfileId = actor.staffProfileId ?? appointment.assigned_staff_profile_id ?? undefined;
    const payment = existingPayment ?? await this.insertSalonPayment(
      appointment,
      visit,
      actor,
      input,
      billing.currencyCode,
      paidAt,
      confirmedByStaffProfileId,
    );
    const paidAppointment = appointment.status === 'paid'
      ? appointment
      : await this.markAppointmentPaid(appointment, actor, paidAt, confirmedByStaffProfileId);
    const paidVisit = visit.status === 'paid'
      ? visit
      : await this.markVisitPaid(visit, appointment.business_id, actor, paidAt, confirmedByStaffProfileId);
    const clientsById = await this.fetchClientProfiles(actor.businessId, [paidAppointment.client_profile_id]);
    const responseBilling: AppointmentPaymentConfirmationResponse['billing'] = {
      ...billing,
      balanceDueCents: Math.max(0, billing.balanceDueCents - payment.amount_cents),
    };

    return {
      appointment: toBookingDetail(paidAppointment, clientsById.get(paidAppointment.client_profile_id)),
      visit: toVisitSummary(paidVisit, paidAppointment, clientsById.get(paidAppointment.client_profile_id)),
      checkout: {
        status: 'paid',
        readyAt: paidVisit.checkout_ready_at ?? paidVisit.completed_at ?? paidAt,
        route: `/checkout/visits/${paidVisit.id}`,
        message: 'In-salon payment confirmed. Visit is paid and settled.',
      },
      billing: responseBilling,
      payment: toPaymentRecord(payment),
      alreadyCompleted: true,
      alreadyPaid: Boolean(existingPayment),
    };
  }

  async linkStylistRebooking(
    actor: AuthUser,
    id: string,
    input: { sourceVisitId?: string; rebookedAppointmentId: string },
  ): Promise<AppointmentCompletionResponse> {
    const sourceVisit = input.sourceVisitId
      ? await this.fetchVisitForActor(actor, input.sourceVisitId)
      : await this.fetchVisitForAppointment(id, true);
    if (!sourceVisit) throw new ConflictException('Complete the source appointment before recording a rebooking');
    if (sourceVisit.appointment_id !== id) {
      throw new ConflictException('Source visit does not belong to this appointment');
    }
    this.assertCanAccessVisit(actor, sourceVisit);

    await this.rebooking.linkPersistedAppointment({
      businessId: actor.businessId,
      sourceVisitId: sourceVisit.id,
      rebookedAppointmentId: input.rebookedAppointmentId,
      source: 'stylist',
      rebookedByUserProfileId: actor.id,
      metadata: { source: 'stylist_checkout' },
    });

    const appointment = await this.fetchAppointmentForActor(actor, id);
    const visit = await this.fetchVisitForAppointment(appointment.id, true);
    if (!visit) throw new ConflictException('Rebooking was linked, but source visit could not be reloaded');
    const [lineItems, clientMap, taxSettings] = await Promise.all([
      this.fetchVisitLineItems(visit.id),
      this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]),
      this.taxSettings.resolveLocationTaxSettings(appointment.business_id, appointment.location_id),
    ]);
    const billing = buildBillingSummary(appointment, lineItems, taxSettings);

    return {
      appointment: toBookingDetail(appointment, clientMap.get(appointment.client_profile_id)),
      visit: toVisitSummary(visit, appointment, clientMap.get(appointment.client_profile_id)),
      checkout: {
        status: visit.checkout_status ?? 'awaiting_payment',
        readyAt: visit.checkout_ready_at ?? visit.completed_at ?? undefined,
        route: `/checkout/visits/${visit.id}`,
        message: visit.checkout_status === 'paid'
          ? 'Visit is paid and settled.'
          : 'Service is complete. Collect the remaining balance in salon.',
      },
      billing,
      alreadyCompleted: true,
    };
  }

  async createStylistRebooking(
    actor: AuthUser,
    id: string,
    input: CreateStylistRebookingRequest,
  ): Promise<AppointmentCompletionResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    this.assertCanAccessAppointment(actor, appointment);

    const sourceVisit = input.sourceVisitId
      ? await this.fetchVisitForActor(actor, input.sourceVisitId)
      : await this.fetchVisitForAppointment(id, true);
    if (!sourceVisit) throw new ConflictException('Complete the source appointment before rebooking');
    if (sourceVisit.appointment_id !== appointment.id) {
      throw new ConflictException('Source visit does not belong to this appointment');
    }
    this.assertCanAccessVisit(actor, sourceVisit);
    if (first(sourceVisit.rebooking_outcomes)) {
      throw new ConflictException('This visit already has a linked rebooking');
    }

    const selectedStart = parseFutureDate(input.selectedStartAt);
    const services = arrayOf(appointment.appointment_services);
    if (services.length === 0 || services.some((service) => !service.service_id)) {
      throw new ConflictException('Source appointment services are required before rebooking');
    }
    const durationMinutes =
      services.reduce((sum, service) => sum + Number(service.duration_minutes ?? 0), 0) ||
      minutesBetween(appointment.scheduled_start_at, appointment.scheduled_end_at) ||
      30;
    const selectedEnd = new Date(selectedStart.getTime() + durationMinutes * 60_000);
    const staffProfileId = input.staffProfileId ?? appointment.assigned_staff_profile_id ?? actor.staffProfileId;
    if (!staffProfileId) throw new ConflictException('A stylist is required for rebooking');
    this.assertCanAssignRebookingStaff(actor, staffProfileId, appointment.location_id);
    await this.assertStaffBookable(actor.businessId, appointment.location_id, staffProfileId);
    await this.assertStaffAvailableForRebooking({
      businessId: actor.businessId,
      locationId: appointment.location_id,
      staffProfileId,
      selectedStart,
      selectedEnd,
    });

    const followUp = await this.insertStylistRebookingAppointment({
      appointment,
      sourceVisit,
      actor,
      staffProfileId,
      selectedStart,
      selectedEnd,
      clientNote: input.clientNote,
    });
    await this.insertStylistRebookingAppointmentServices({
      appointment,
      followUpAppointmentId: followUp.id,
      staffProfileId,
      selectedStart,
    });

    // A rebooking is a real, valid (confirmed) appointment → schedule its confirmation + reminders
    // through the same idempotent, fail-soft engine the public booking flow uses. Never blocks the
    // rebooking (the appointment is already committed).
    await this.bookingNotifications.syncBookingNotificationsSafe(followUp.id);

    return this.linkStylistRebooking(actor, id, {
      sourceVisitId: sourceVisit.id,
      rebookedAppointmentId: followUp.id,
    });
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

  private async fetchVisitForActor(actor: AuthUser, visitId: string): Promise<VisitRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(REBOOKING_VISIT_COLUMNS)
      .eq('id', visitId)
      .eq('business_id', actor.businessId)
      .maybeSingle<VisitRow>();

    if (error) {
      this.logger.error(`fetchVisitForActor failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load visit');
    }
    if (!data) throw new NotFoundException('Visit not found');
    this.assertCanAccessVisit(actor, data);
    return data;
  }

  private async fetchAppointmentForActor(actor: AuthUser, id: string): Promise<AppointmentRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .eq('business_id', actor.businessId)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`fetchAppointmentForActor failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load booking');
    }
    if (!data) throw new NotFoundException('Booking not found');
    this.assertCanAccessAppointment(actor, data);
    return data;
  }

  private assertCanCompleteAppointment(actor: AuthUser, appointment: AppointmentRow): void {
    this.assertCanAccessAppointment(actor, appointment);
    if (actor.role === 'stylist') {
      if (!actor.staffProfileId) throw new ForbiddenException('Stylist profile could not be resolved');
      if (appointment.assigned_staff_profile_id !== actor.staffProfileId) {
        throw new ForbiddenException('Stylists can only complete appointments assigned to themselves');
      }
    }
  }

  private assertCanConfirmPayment(actor: AuthUser, appointment: AppointmentRow): void {
    this.assertCanAccessAppointment(actor, appointment);
    if (actor.role === 'stylist') {
      if (!actor.staffProfileId) throw new ForbiddenException('Stylist profile could not be resolved');
      if (appointment.assigned_staff_profile_id !== actor.staffProfileId) {
        throw new ForbiddenException('Stylists can only confirm payment for their own appointments');
      }
    }
  }

  private assertCanAccessVisit(actor: AuthUser, visit: VisitRow): void {
    if (actor.role === 'owner') return;
    if (!actor.allowedLocationIds.includes(visit.location_id)) {
      throw new ForbiddenException('Visit is outside your location scope');
    }
    if (actor.role === 'stylist' && actor.staffProfileId !== visit.primary_staff_profile_id) {
      throw new ForbiddenException('Stylists can only rebook their own completed visits');
    }
  }

  private assertCanAssignRebookingStaff(actor: AuthUser, staffProfileId: string, locationId: string): void {
    if (actor.role === 'owner') return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Rebooking location is outside your scope');
    }
    if (actor.role === 'stylist' && actor.staffProfileId !== staffProfileId) {
      throw new ForbiddenException('Stylists can only rebook to themselves');
    }
  }

  private async assertStaffBookable(
    businessId: string,
    locationId: string,
    staffProfileId: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name,is_bookable')
      .eq('id', staffProfileId)
      .eq('business_id', businessId)
      .maybeSingle<StaffProfileRow>();

    if (error) {
      this.logger.error(`assertStaffBookable failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate rebooking stylist');
    }
    if (!data || data.is_bookable === false) {
      throw new ConflictException('Selected stylist is not bookable for this location');
    }
  }

  private async assertStaffAvailableForRebooking(input: {
    businessId: string;
    locationId: string;
    staffProfileId: string;
    selectedStart: Date;
    selectedEnd: Date;
    /** When set (a reschedule), this appointment is excluded so it can't clash with itself. */
    excludeAppointmentId?: string;
  }): Promise<void> {
    let query = this.admin
      .schema('booking')
      .from('appointments')
      .select('id')
      .eq('business_id', input.businessId)
      .eq('location_id', input.locationId)
      .eq('assigned_staff_profile_id', input.staffProfileId)
      .in('status', ACTIVE_BOOKING_STATUSES)
      .lt('scheduled_start_at', input.selectedEnd.toISOString())
      .gt('scheduled_end_at', input.selectedStart.toISOString())
      .limit(1);
    if (input.excludeAppointmentId) {
      query = query.neq('id', input.excludeAppointmentId);
    }
    const { data, error } = await query.returns<Array<{ id: string }>>();

    if (error) {
      this.logger.error(`assertStaffAvailableForRebooking failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate rebooking slot');
    }
    if ((data ?? []).length > 0) {
      throw new ConflictException('Selected time overlaps an existing appointment');
    }
  }

  private async insertStylistRebookingAppointment(input: {
    appointment: AppointmentRow;
    sourceVisit: VisitRow;
    actor: AuthUser;
    staffProfileId: string;
    selectedStart: Date;
    selectedEnd: Date;
    clientNote?: string;
  }): Promise<{ id: string }> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .insert({
        business_id: input.appointment.business_id,
        location_id: input.appointment.location_id,
        client_profile_id: input.appointment.client_profile_id,
        booked_by_user_profile_id: input.actor.id,
        assigned_staff_profile_id: input.staffProfileId,
        requested_staff_profile_id: input.staffProfileId,
        staff_request_mode: 'specific_staff',
        status: 'confirmed',
        booking_channel: 'staff_app',
        scheduled_start_at: input.selectedStart.toISOString(),
        scheduled_end_at: input.selectedEnd.toISOString(),
        communication_preference: input.appointment.communication_preference ?? null,
        client_note: input.clientNote?.trim() || null,
        metadata: {
          source: 'stylist_checkout_rebooking',
          source_visit_id: input.sourceVisit.id,
          source_appointment_id: input.appointment.id,
          // Surfaced in the booking-notification message body (services line).
          service_names: arrayOf(input.appointment.appointment_services)
            .map((service) => service.service_name_snapshot)
            .filter(Boolean),
        },
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !data) {
      const message = error?.message ?? 'no appointment row';
      if (message.toLowerCase().includes('booking_appointments_staff_no_overlap')) {
        throw new ConflictException('Selected rebooking time overlaps an existing appointment');
      }
      this.logger.error(`insertStylistRebookingAppointment failed: ${message}`);
      throw new InternalServerErrorException('Unable to create rebooking appointment');
    }
    return data;
  }

  private async insertStylistRebookingAppointmentServices(input: {
    appointment: AppointmentRow;
    followUpAppointmentId: string;
    staffProfileId: string;
    selectedStart: Date;
  }): Promise<void> {
    let cursor = input.selectedStart;
    const rows = arrayOf(input.appointment.appointment_services).map((service, index) => {
      if (!service.service_id) throw new ConflictException('Source appointment service ids are required before rebooking');
      const start = cursor;
      const end = new Date(start.getTime() + Number(service.duration_minutes ?? 0) * 60_000);
      cursor = end;
      return {
        business_id: input.appointment.business_id,
        location_id: input.appointment.location_id,
        appointment_id: input.followUpAppointmentId,
        service_id: service.service_id,
        assigned_staff_profile_id: input.staffProfileId,
        sequence_no: index + 1,
        service_name_snapshot: service.service_name_snapshot,
        duration_minutes: service.duration_minutes,
        price_amount: service.price_amount ?? 0,
        deposit_required_amount: service.deposit_required_amount,
        status: 'scheduled',
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
      };
    });

    const { error } = await this.admin.schema('booking').from('appointment_services').insert(rows);
    if (error) {
      this.logger.error(`insertStylistRebookingAppointmentServices failed: ${error.message}`);
      await this.admin
        .schema('booking')
        .from('appointments')
        .delete()
        .eq('id', input.followUpAppointmentId)
        .eq('business_id', input.appointment.business_id);
      throw new InternalServerErrorException('Unable to create rebooking appointment services');
    }
  }

  private async markAppointmentCompleted(
    appointment: AppointmentRow,
    actor: AuthUser,
    completedAt: string,
    completedByStaffProfileId: string | undefined,
  ): Promise<AppointmentRow> {
    const patch = {
      status: 'awaiting_payment',
      completed_at: completedAt,
      completed_by_user_profile_id: actor.id,
      completed_by_staff_profile_id: completedByStaffProfileId ?? null,
    };
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update(patch)
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', COMPLETABLE_BOOKING_STATUSES)
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`markAppointmentCompleted failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to complete appointment');
    }
    if (data) return data;

    const replayed = await this.fetchAppointmentById(appointment.id, appointment.business_id);
    if (replayed.status === 'awaiting_payment' || replayed.status === 'paid') return replayed;
    throw new ConflictException('Appointment was updated before it could be completed');
  }

  private async fetchAppointmentById(id: string, businessId: string): Promise<AppointmentRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .eq('business_id', businessId)
      .maybeSingle<AppointmentRow>();
    if (error || !data) throw new InternalServerErrorException('Unable to reload appointment');
    return data;
  }

  private async markAppointmentServicesCompleted(appointmentId: string, businessId: string): Promise<void> {
    const { error } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .update({ status: 'completed' })
      .eq('appointment_id', appointmentId)
      .eq('business_id', businessId)
      .in('status', ['scheduled', 'in_progress']);
    if (error) {
      this.logger.error(`markAppointmentServicesCompleted failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to complete appointment services');
    }
  }

  private async ensureAwaitingPaymentVisit(
    appointment: AppointmentRow,
    actor: AuthUser,
    completedAt: string,
    completedByStaffProfileId: string | undefined,
  ): Promise<VisitRow> {
    const existing = await this.fetchVisitForAppointment(appointment.id);
    const visitPatch = {
      status: existing?.status === 'paid' ? 'paid' : 'awaiting_payment',
      started_at: existing?.started_at ?? appointment.check_in_at ?? appointment.scheduled_start_at,
      checked_in_at: existing?.checked_in_at ?? appointment.check_in_at ?? appointment.scheduled_start_at,
      completed_at: existing?.completed_at ?? completedAt,
      completed_by_user_profile_id: existing?.completed_by_user_profile_id ?? actor.id,
      completed_by_staff_profile_id:
        existing?.completed_by_staff_profile_id ?? completedByStaffProfileId ?? appointment.assigned_staff_profile_id,
      checkout_status: existing?.checkout_status === 'paid' ? 'paid' : 'awaiting_payment',
      checkout_ready_at: existing?.checkout_ready_at ?? completedAt,
      checkout_ready_by_user_profile_id: actor.id,
      service_summary: existing?.service_summary ?? summarizeServices(appointment.appointment_services),
      client_visible_summary:
        existing?.client_visible_summary ?? summarizeServices(appointment.appointment_services),
    };

    if (existing) {
      const { data, error } = await this.admin
        .schema('booking')
        .from('visits')
        .update(visitPatch)
        .eq('id', existing.id)
        .eq('business_id', appointment.business_id)
        .select(REBOOKING_VISIT_COLUMNS)
        .single<VisitRow>();
      if (error || !data) {
        this.logger.error(`ensureAwaitingPaymentVisit update failed: ${error?.message ?? 'no row'}`);
        throw new InternalServerErrorException('Unable to complete visit');
      }
      return data;
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .insert({
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        appointment_id: appointment.id,
        client_profile_id: appointment.client_profile_id,
        primary_staff_profile_id: appointment.assigned_staff_profile_id,
        source: 'appointment_completion',
        ...visitPatch,
      })
      .select(REBOOKING_VISIT_COLUMNS)
      .single<VisitRow>();
    if (error || !data) {
      this.logger.error(`ensureAwaitingPaymentVisit create failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create completed visit');
    }
    return data;
  }

  private async fetchVisitForAppointment(
    appointmentId: string,
    includeRebooking = false,
  ): Promise<VisitRow | undefined> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(includeRebooking ? REBOOKING_VISIT_COLUMNS : VISIT_COLUMNS)
      .eq('appointment_id', appointmentId)
      .maybeSingle<VisitRow>();
    if (error) {
      this.logger.error(`fetchVisitForAppointment failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load appointment visit');
    }
    return data ?? undefined;
  }

  private async reconcileServiceLineItem(appointment: AppointmentRow, visitId: string): Promise<void> {
    const services = arrayOf(appointment.appointment_services);
    const amountCents = services.reduce((sum, service) => sum + toCents(service.price_amount), 0);
    const { error } = await this.admin.schema('billing').from('visit_line_items').upsert(
      {
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        visit_id: visitId,
        line_type: 'service',
        description: summarizeServices(services) ?? 'Service charges',
        amount_cents: amountCents,
        currency_code: 'GBP',
        metadata: {
          source: 'appointment_completion',
          appointment_id: appointment.id,
          appointment_service_ids: services.map((service) => service.id).filter(Boolean),
        },
      },
      { onConflict: 'visit_id,line_type' },
    );
    if (error) {
      this.logger.error(`reconcileServiceLineItem failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reconcile service billing');
    }
  }

  private async reconcileProductUsageLineItem(appointment: AppointmentRow, visitId: string): Promise<void> {
    const formulas = await this.fetchSavedFormulasForAppointment(appointment.id);
    if (formulas.length === 0) return;

    const rules = await this.fetchProductBillingRules(appointment.business_id, appointment.location_id);
    if (!rules || !rules.product_billing_enabled) return;

    // Aggregate the actual product cost across every saved formula on the visit
    // before applying the rule, so multi-formula visits bill the full cost.
    const costAmountCents = formulas.reduce((sum, formula) => sum + Number(formula.actual_cost_cents ?? 0), 0);
    if (costAmountCents <= 0) return;
    const currencyCode = formulas[0]?.currency_code ?? 'GBP';

    const snapshot = buildProductBillingSnapshot(
      costAmountCents,
      rules.product_billing_rule as ProductBillingRule,
      rules.product_markup_percent,
      rules.product_fixed_uplift_amount,
      rules.product_round_up_enabled ?? false,
      rules.product_round_up_increment,
    );

    const { error } = await this.admin.schema('billing').from('visit_line_items').upsert(
      {
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        visit_id: visitId,
        line_type: 'product_usage',
        description: 'Product usage',
        amount_cents: snapshot.billableAmountCents,
        currency_code: currencyCode,
        cost_amount_cents: snapshot.costAmountCents,
        billable_amount_cents: snapshot.billableAmountCents,
        billing_rule_snapshot: snapshot.billingRuleSnapshot,
        markup_percent_snapshot: snapshot.markupPercentSnapshot,
        fixed_uplift_amount_snapshot: snapshot.fixedUpliftAmountSnapshot,
        round_up_enabled_snapshot: snapshot.roundUpEnabledSnapshot,
        round_up_increment_snapshot: snapshot.roundUpIncrementSnapshot,
        metadata: { source: 'appointment_completion', appointment_id: appointment.id },
      },
      { onConflict: 'visit_id,line_type' },
    );
    if (error) {
      this.logger.error(`reconcileProductUsageLineItem failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reconcile product usage billing');
    }
  }

  private async fetchProductBillingRules(
    businessId: string,
    locationId: string,
  ): Promise<ProductBillingRulesRow | null> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('billing_rules')
      .select(
        'product_billing_enabled,product_billing_rule,product_markup_percent,product_fixed_uplift_amount,product_round_up_enabled,product_round_up_increment',
      )
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<ProductBillingRulesRow>();

    if (error) {
      this.logger.warn(`fetchProductBillingRules failed: ${error.message} — skipping product billing`);
      return null;
    }
    return data;
  }

  private async fetchSavedFormulasForAppointment(appointmentId: string): Promise<FormulaBillingRow[]> {
    const { data, error } = await this.admin
      .schema('lab')
      .from('formulas')
      .select('external_formula_id,actual_cost_cents,billable_charge_cents,currency_code,saved_at')
      .eq('appointment_id', appointmentId)
      .eq('status', 'saved')
      .returns<FormulaBillingRow[]>();
    if (error) {
      this.logger.error(`fetchSavedFormulasForAppointment failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load formula billing');
    }
    return data ?? [];
  }

  private async fetchVisitLineItems(visitId: string): Promise<AppointmentCompletionLineItem[]> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .select('line_type,description,amount_cents,currency_code')
      .eq('visit_id', visitId)
      .returns<VisitLineItemRow[]>();
    if (error) {
      this.logger.error(`fetchVisitLineItems failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load checkout line items');
    }
    return (data ?? []).map((row) => ({
      lineType: row.line_type,
      description: row.description,
      amountCents: row.amount_cents,
      currencyCode: row.currency_code,
    }));
  }

  private async fetchSalonPaymentForVisit(visitId: string): Promise<SalonPaymentRow | undefined> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .select('id,appointment_id,visit_id,payment_method,amount_cents,currency_code,paid_at,confirmed_by_user_profile_id,confirmed_by_staff_profile_id,notes')
      .eq('visit_id', visitId)
      .maybeSingle<SalonPaymentRow>();
    if (error) {
      this.logger.error(`fetchSalonPaymentForVisit failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load salon payment');
    }
    return data ?? undefined;
  }

  private async insertSalonPayment(
    appointment: AppointmentRow,
    visit: VisitRow,
    actor: AuthUser,
    input: AppointmentPaymentConfirmationRequest,
    currencyCode: string,
    paidAt: string,
    confirmedByStaffProfileId: string | undefined,
  ): Promise<SalonPaymentRow> {
    if (input.paymentMethod !== 'cash' && input.paymentMethod !== 'card_reader') {
      throw new ConflictException('Payment method must be cash or card reader');
    }
    const notes = input.notes?.trim();
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .insert({
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        appointment_id: appointment.id,
        visit_id: visit.id,
        payment_method: input.paymentMethod,
        amount_cents: input.amountCents,
        currency_code: currencyCode,
        paid_at: paidAt,
        confirmed_by_user_profile_id: actor.id,
        confirmed_by_staff_profile_id: confirmedByStaffProfileId ?? null,
        notes: notes || null,
        metadata: { source: 'in_salon_checkout' },
      })
      .select('id,appointment_id,visit_id,payment_method,amount_cents,currency_code,paid_at,confirmed_by_user_profile_id,confirmed_by_staff_profile_id,notes')
      .single<SalonPaymentRow>();
    if (error || !data) {
      const replayed = await this.fetchSalonPaymentForVisit(visit.id);
      if (replayed) return replayed;
      this.logger.error(`insertSalonPayment failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to record salon payment');
    }
    return data;
  }

  private async markAppointmentPaid(
    appointment: AppointmentRow,
    actor: AuthUser,
    paidAt: string,
    paidByStaffProfileId: string | undefined,
  ): Promise<AppointmentRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        status: 'paid',
        completed_at: appointment.completed_at ?? paidAt,
        completed_by_user_profile_id: appointment.completed_by_user_profile_id ?? actor.id,
        completed_by_staff_profile_id:
          appointment.completed_by_staff_profile_id ?? paidByStaffProfileId ?? appointment.assigned_staff_profile_id,
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', PAYABLE_BOOKING_STATUSES)
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`markAppointmentPaid failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to mark appointment paid');
    }
    if (data) return data;
    const replayed = await this.fetchAppointmentById(appointment.id, appointment.business_id);
    if (replayed.status === 'paid') return replayed;
    throw new ConflictException('Appointment was updated before payment could be confirmed');
  }

  private async markVisitPaid(
    visit: VisitRow,
    businessId: string,
    actor: AuthUser,
    paidAt: string,
    paidByStaffProfileId: string | undefined,
  ): Promise<VisitRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .update({
        status: 'paid',
        checkout_status: 'paid',
        paid_at: visit.paid_at ?? paidAt,
        paid_by_user_profile_id: visit.paid_by_user_profile_id ?? actor.id,
        paid_by_staff_profile_id: visit.paid_by_staff_profile_id ?? paidByStaffProfileId ?? visit.primary_staff_profile_id,
      })
      .eq('id', visit.id)
      .eq('business_id', businessId)
      .eq('checkout_status', 'awaiting_payment')
      .select(VISIT_COLUMNS)
      .maybeSingle<VisitRow>();
    if (error) {
      this.logger.error(`markVisitPaid failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to mark visit paid');
    }
    if (data) return data;
    const replayed = await this.fetchVisitForAppointment(visit.appointment_id ?? '');
    if (replayed?.status === 'paid') return replayed;
    throw new ConflictException('Visit was updated before payment could be confirmed');
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

function parseFutureDate(value: string): Date {
  const parsed = parseValidDate(value);
  if (parsed.getTime() <= Date.now()) {
    throw new ConflictException('Selected time must be in the future');
  }
  return parsed;
}

function parseValidDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConflictException('Selected time must be a valid date');
  }
  return parsed;
}

// True when both lists contain the same ids (ignoring order and duplicates). Used
// to detect whether an edit actually changes the appointment's service list.
function sameStringSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const value of setA) {
    if (!setB.has(value)) return false;
  }
  return true;
}

function resolveCatalogService(row: ServiceCatalogRow): ResolvedCatalogService {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: Number(row.estimated_duration_minutes ?? 0),
    priceAmount: Number(row.base_price ?? 0),
    depositAmount: calculateServiceDeposit(row),
  };
}

// Deposit due for a service, derived the same way as the booking flow:
// a fixed amount, a percentage of the base price, or nothing.
function calculateServiceDeposit(row: ServiceCatalogRow): number {
  const price = Number(row.base_price);
  const value = Number(row.deposit_value);
  if (row.deposit_type === 'fixed_amount') return Math.max(0, value);
  if (row.deposit_type === 'percentage') return Math.max(0, Math.round((price * value) / 100));
  return 0;
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
    serviceIds: services
      .map((service) => service.service_id)
      .filter((id): id is string => Boolean(id)),
    durationMinutes: durationMinutes || minutesBetween(row.scheduled_start_at, row.scheduled_end_at),
    depositRequiredAmount: depositRequiredAmount || undefined,
    depositStatus: deposits[0]?.status,
    clientNote: row.client_note ?? undefined,
    patchTest,
    completedAt: row.completed_at ?? undefined,
    completedByUserProfileId: row.completed_by_user_profile_id ?? undefined,
    completedByStaffProfileId: row.completed_by_staff_profile_id ?? undefined,
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

function toVisitSummary(row: VisitRow, appointment: AppointmentRow, client?: ClientProfileRow): CrmVisitSummary {
  const lineServices = arrayOf(appointment.appointment_services);
  const serviceSummary = row.service_summary ?? summarizeServices(lineServices) ?? undefined;
  const priceAmount = lineServices.reduce((sum, service) => sum + Number(service.price_amount ?? 0), 0);
  const rebooking = first(row.rebooking_outcomes);
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    appointmentId: row.appointment_id ?? undefined,
    clientProfileId: row.client_profile_id,
    primaryStaffProfileId: row.primary_staff_profile_id ?? undefined,
    status: row.status,
    occurredAt: row.completed_at ?? row.started_at ?? row.checked_in_at ?? appointment.scheduled_start_at,
    serviceSummary,
    clientVisibleSummary: row.client_visible_summary ?? serviceSummary,
    priceAmount: priceAmount > 0 ? priceAmount : undefined,
    currencyCode: first(arrayOf(appointment.deposits))?.currency_code ?? 'GBP',
    stylistName: undefined,
    rebooked: Boolean(rebooking),
    rebookSource: rebooking?.rebook_source,
    rebookedAppointmentId: rebooking?.rebooked_appointment_id,
    rebookedAt: rebooking?.rebooked_at,
  };
}

function toPaymentRecord(row: SalonPaymentRow): AppointmentPaymentRecord {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    visitId: row.visit_id,
    paymentMethod: row.payment_method,
    amountCents: row.amount_cents,
    currencyCode: row.currency_code,
    paidAt: row.paid_at,
    confirmedByUserProfileId: row.confirmed_by_user_profile_id ?? undefined,
    confirmedByStaffProfileId: row.confirmed_by_staff_profile_id ?? undefined,
    notes: row.notes ?? undefined,
  };
}

// The service charge is persisted as a single rolled-up visit_line_items row
// (the table is uniquely keyed by visit_id + line_type), but checkout itemises
// each booked service with its own price. Expand that one row into per-service
// display lines from appointment_services — the per-service prices are exactly
// what the rolled-up amount was summed from. We only itemise when they reconcile
// to the penny, so every total (and the balance the till collects) is unchanged;
// otherwise the persisted line is kept so the bill always foots.
function expandServiceLineItems(
  appointment: AppointmentRow,
  lineItems: AppointmentCompletionLineItem[],
): AppointmentCompletionLineItem[] {
  const services = arrayOf(appointment.appointment_services);
  const serviceLines = lineItems.filter((item) => item.lineType === 'service');
  if (services.length === 0 || serviceLines.length === 0) return lineItems;

  const currencyCode = serviceLines[0].currencyCode;
  const perServiceLines: AppointmentCompletionLineItem[] = services.map((service) => ({
    lineType: 'service',
    description: service.service_name_snapshot || 'Service',
    amountCents: toCents(service.price_amount),
    currencyCode,
  }));

  const persistedTotal = serviceLines.reduce((sum, item) => sum + item.amountCents, 0);
  const perServiceTotal = perServiceLines.reduce((sum, item) => sum + item.amountCents, 0);
  if (perServiceTotal !== persistedTotal) return lineItems;

  const nonServiceLines = lineItems.filter((item) => item.lineType !== 'service');
  return [...perServiceLines, ...nonServiceLines];
}

// Map a visit line type to the tax category that gates it (services vs retail).
// Anything else (legacy/uncategorised rows) is left untaxed and untouched.
function taxCategoryForLineType(lineType: string): TaxableCategory | null {
  if (lineType === 'service') return 'service';
  if (lineType === 'product_usage') return 'retail';
  return null;
}

function sumLineItemsByType(items: AppointmentCompletionLineItem[], lineType: string): number {
  return items
    .filter((item) => item.lineType === lineType)
    .reduce((sum, item) => sum + item.amountCents, 0);
}

function buildBillingSummary(
  appointment: AppointmentRow,
  lineItems: AppointmentCompletionLineItem[],
  taxSettings: LocationTaxSettings,
): AppointmentCompletionResponse['billing'] {
  // Itemise services for display; totals are derived from the same set so they
  // always foot to the lines shown (see expandServiceLineItems).
  const itemisedLineItems = expandServiceLineItems(appointment, lineItems);
  const currencyCode =
    itemisedLineItems[0]?.currencyCode ?? first(arrayOf(appointment.deposits))?.currency_code ?? 'GBP';

  // Net (tax-exclusive) subtotals feed the tax rollup we keep for records.
  const netServiceTotalCents = sumLineItemsByType(itemisedLineItems, 'service');
  const netProductUsageTotalCents = sumLineItemsByType(itemisedLineItems, 'product_usage');

  // Every price shown and collected is tax-inclusive: convert each billable line
  // to its gross amount through the shared tax layer, honouring the location's rate
  // and appliesTo gating. VAT is baked into the price automatically and never shown
  // as its own line. Tax-disabled locations get gross == net, so this is a no-op
  // for them. Per-line gross figures sum to the totals below, so the bill always
  // foots and `balanceDueCents` (the only amount confirm-payment accepts) is the
  // tax-inclusive figure the till collects.
  const grossLineItems = itemisedLineItems.map((item) => {
    const category = taxCategoryForLineType(item.lineType);
    if (!category) return item;
    return { ...item, amountCents: calculateTaxForCategory(item.amountCents, category, taxSettings).grossCents };
  });

  const serviceTotalCents = sumLineItemsByType(grossLineItems, 'service');
  const productUsageTotalCents = sumLineItemsByType(grossLineItems, 'product_usage');
  // Total is the sum of the billable components shown in the breakdown (services +
  // product usage), not a blanket sum of every visit line item, so stray/legacy
  // rows (e.g. retired formula_colour) can never inflate the total.
  const totalCents = serviceTotalCents + productUsageTotalCents;
  const depositPaidCents = arrayOf(appointment.deposits)
    .filter((deposit) => deposit.status === 'paid')
    .reduce((sum, deposit) => sum + toCents(deposit.amount), 0);

  // Tax rollup retained for records/reporting (computed from the net subtotals);
  // the checkout itself no longer renders a separate VAT line.
  const tax = calculateAppointmentBillingTax(
    { serviceTotalCents: netServiceTotalCents, productUsageTotalCents: netProductUsageTotalCents },
    taxSettings,
  );
  return {
    lineItems: grossLineItems,
    serviceTotalCents,
    productUsageTotalCents,
    depositPaidCents,
    totalCents,
    balanceDueCents: Math.max(0, totalCents - depositPaidCents),
    currencyCode,
    tax,
  };
}

function summarizeServices(services: AppointmentRow['appointment_services'] | AppointmentServiceRow[]): string | null {
  const names = arrayOf(services)
    .map((service) => service.service_name_snapshot)
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : null;
}

function toCents(amount: number | string | null | undefined): number {
  const parsed = Number(amount ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
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

function first<T>(value: T[] | T | null | undefined): T | undefined {
  return arrayOf(value)[0];
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
