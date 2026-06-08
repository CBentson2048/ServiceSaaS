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
  AppointmentCompletionLineItem,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
  AppointmentPaymentRecord,
  AppointmentStatus,
  AuthUser,
  CreateStylistRebookingRequest,
  CrmVisitSummary,
  ListStaffBookingsResponse,
  ProductBillingRule,
  StaffBookingPatchTestSummary,
  StaffBookingDetail,
  StaffBookingSummary,
} from '@sheer/domain';
import { calculateAppointmentBillingTax, type LocationTaxSettings } from '@sheer/domain';
import { buildProductBillingSnapshot } from '../common/product-billing.helper';
import { BookingNotificationService } from '../communications/booking-notification.service';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';
import { OwnerTaxSettingsService } from '../owner-tax-settings/owner-tax-settings.service';
import { RebookingService } from '../rebooking/rebooking.service';

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
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'awaiting_payment',
  'paid',
];
const COMPLETABLE_BOOKING_STATUSES: AppointmentStatus[] = ['confirmed', 'checked_in', 'in_progress'];
const PAYABLE_BOOKING_STATUSES: AppointmentStatus[] = ['awaiting_payment'];

const LIST_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,client_note,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,appointment_services(service_name_snapshot,duration_minutes,deposit_required_amount,price_amount),deposits(status,amount,currency_code)';

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
  }): Promise<void> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id')
      .eq('business_id', input.businessId)
      .eq('location_id', input.locationId)
      .eq('assigned_staff_profile_id', input.staffProfileId)
      .in('status', ACTIVE_BOOKING_STATUSES)
      .lt('scheduled_start_at', input.selectedEnd.toISOString())
      .gt('scheduled_end_at', input.selectedStart.toISOString())
      .limit(1)
      .returns<Array<{ id: string }>>();

    if (error) {
      this.logger.error(`assertStaffAvailableForRebooking failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate rebooking slot');
    }
    if ((data ?? []).length > 0) {
      throw new ConflictException('Selected rebooking time overlaps an existing appointment');
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
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConflictException('Rebooking time must be a valid date');
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ConflictException('Rebooking time must be in the future');
  }
  return parsed;
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

function buildBillingSummary(
  appointment: AppointmentRow,
  lineItems: AppointmentCompletionLineItem[],
  taxSettings: LocationTaxSettings,
): AppointmentCompletionResponse['billing'] {
  const currencyCode = lineItems[0]?.currencyCode ?? first(arrayOf(appointment.deposits))?.currency_code ?? 'GBP';
  const serviceTotalCents = lineItems
    .filter((item) => item.lineType === 'service')
    .reduce((sum, item) => sum + item.amountCents, 0);
  const productUsageTotalCents = lineItems
    .filter((item) => item.lineType === 'product_usage')
    .reduce((sum, item) => sum + item.amountCents, 0);
  // Gross total is the sum of the billable components shown in the breakdown
  // (services + product usage), not a blanket sum of every visit line item, so
  // stray/legacy rows (e.g. retired formula_colour) can never inflate the total.
  const totalCents = serviceTotalCents + productUsageTotalCents;
  const depositPaidCents = arrayOf(appointment.deposits)
    .filter((deposit) => deposit.status === 'paid')
    .reduce((sum, deposit) => sum + toCents(deposit.amount), 0);
  // Tax rollup via the single shared tax layer. serviceTotalCents/productUsageTotalCents
  // are gated by the location's appliesTo rule (services / retail / both). Existing
  // totals stay tax-exclusive for backward compatibility; clients read `tax` to render
  // inc/ex figures per the configured display mode.
  const tax = calculateAppointmentBillingTax(
    { serviceTotalCents, productUsageTotalCents },
    taxSettings,
  );
  return {
    lineItems,
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
