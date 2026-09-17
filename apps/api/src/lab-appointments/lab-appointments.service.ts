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
import type {
  AddAppointmentServiceRequest,
  AmendAppointmentServicesResponse,
  AppointmentServiceChange,
  AppointmentServiceChangeSnapshot,
  AppointmentServiceChangesResponse,
  AppointmentServiceLineSummary,
  AppointmentServiceOrigin,
  OriginalBookedService,
  ReassignAppointmentServiceRequest,
  RemoveAppointmentServiceRequest,
  AcceptBookingResponse,
  AppointmentCompletionLineItem,
  AppointmentCompletionResponse,
  AppointmentPaymentConfirmationRequest,
  AppointmentPaymentConfirmationResponse,
  AppointmentPaymentRecord,
  AppointmentPaymentTender,
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
  SheerLabAnalyticsRange,
  StaffBookingPatchTestSummary,
  StaffBookingDetail,
  StaffBookingServiceLine,
  StaffBookingSummary,
  BookingSegmentSummary,
  BillRecord,
  VisitBillResponse,
} from '@sheer/domain';
import {
  calculateAppointmentBillingTax,
  calculateTaxBreakdown,
  calculateTaxForCategory,
  taxAppliesToCategory,
  userHasAnyRole,
  userHasRole,
  type LocationTaxSettings,
  type TaxableCategory,
} from '@sheer/domain';
import { buildProductBillingSnapshot } from '../common/product-billing.helper';
import {
  type OccupancyService,
  type TimeInterval,
  occupiedIntervalsFrom,
  parseMultirange,
  toMultirangeLiteral,
} from '../common/occupied-ranges';
import { AuditService } from '../audit/audit.service';
import { ArrivalNotificationService } from '../notifications/arrival-notification.service';
import { BookingNotificationService } from '../communications/booking-notification.service';
import { RebookingNudgeService } from '../communications/rebooking-nudge.service';
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
  sequence_no?: number | null;
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  // Per-service segment snapshot [{name,durationMinutes,isStylistFree}] (jsonb).
  segments?: BookingSegmentSummary[] | null;
  // 0110 — booked vs performed. `status = 'cancelled'` means NOT performed (the
  // row is kept for history); `origin` says whether the line was booked or added
  // during the visit. Older projections may omit these, so they are optional and
  // read through performedServices()/lineOrigin().
  status?: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | null;
  origin?: AppointmentServiceOrigin | null;
  assigned_staff_profile_id?: string | null;
  added_at?: string | null;
  added_by_user_profile_id?: string | null;
  removed_at?: string | null;
  removed_by_user_profile_id?: string | null;
  removal_reason?: string | null;
  replaces_appointment_service_id?: string | null;
}

/** T0 (0110): one entry of booking.appointments.original_services_snapshot. */
interface OriginalServiceSnapshotRow {
  serviceId?: string | null;
  serviceName?: string | null;
  priceAmount?: number | string | null;
  durationMinutes?: number | string | null;
  staffProfileId?: string | null;
  sequenceNo?: number | string | null;
}

interface AppointmentServiceChangeRow {
  id: string;
  appointment_id: string;
  appointment_service_id: string | null;
  replaced_appointment_service_id: string | null;
  action: 'added' | 'removed' | 'replaced' | 'reassigned';
  appointment_status_at_change: AppointmentStatus;
  actor_user_profile_id: string | null;
  actor_staff_profile_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

interface DepositRow {
  status: string;
  amount: number | string;
  currency_code?: string | null;
}

// A row from the booking.services catalogue, used when editing an appointment's
// services. Mirrors the columns the booking flow reads to snapshot price/duration.
interface ServiceSegmentEmbedRow {
  name: string;
  duration_minutes: number;
  is_stylist_free: boolean;
  sort_order: number;
}

interface ServiceCatalogRow {
  id: string;
  name: string;
  estimated_duration_minutes: number;
  base_price: number | string;
  deposit_type: 'none' | 'fixed_amount' | 'percentage';
  deposit_value: number | string;
  is_active?: boolean | null;
  location_id?: string | null;
  service_segments?: ServiceSegmentEmbedRow[] | ServiceSegmentEmbedRow | null;
}

// A catalogue service resolved into the figures we snapshot onto appointment_services.
interface ResolvedCatalogService {
  id: string;
  name: string;
  durationMinutes: number;
  priceAmount: number;
  depositAmount: number;
  segments: BookingSegmentSummary[];
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
  /**
   * T0 (0110): the service selection this appointment was FIRST created with,
   * written once by a database trigger. Null on every appointment created before
   * 0110 — the original booking is then unknown, never assumed. Only the DETAIL
   * projection selects it.
   */
  original_services_snapshot?: OriginalServiceSnapshotRow[] | null;
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
  metadata?: Record<string, unknown> | null;
}

interface FormulaBillingRow {
  id: string;
  external_formula_id: string | null;
  actual_cost_cents: number;
  billable_charge_cents: number;
  currency_code: string;
  saved_at: string | null;
}

// A row read from lab.formula_items, used to itemise the colour charge per product.
interface FormulaItemBreakdownRow {
  product_name: string | null;
  brand: string | null;
  shade: string | null;
  cost_cents: number | null;
}

// One colour product's raw cost, aggregated across every saved formula on a visit.
// Persisted on the product_usage line (metadata.product_breakdown) so checkout can
// split the rolled-up colour charge back into per-product display lines.
interface ProductBreakdownEntry {
  description: string;
  costCents: number;
}

// A checkout line item carrying the per-product breakdown that backs it (only set
// for product_usage lines). The breakdown is internal plumbing for display
// itemisation and is stripped before the lines leave buildBillingSummary.
interface BillingLineItem extends AppointmentCompletionLineItem {
  productBreakdown?: ProductBreakdownEntry[];
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

// Stored bill snapshot rows (billing.bills / billing.bill_lines, 0085).
interface BillRow {
  id: string;
  business_id: string;
  location_id: string;
  visit_id: string;
  appointment_id: string | null;
  client_profile_id: string | null;
  staff_profile_id: string | null;
  bill_number: number;
  status: 'paid' | 'voided';
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  discount_cents: number;
  deposit_applied_cents: number;
  balance_collected_cents: number;
  currency_code: string;
  tax_label: string | null;
  tax_rate_percent: number | string;
  occurred_at: string;
  created_at: string;
}

interface BillLineRow {
  id: string;
  bill_id: string;
  sequence_no: number;
  line_type: string;
  description: string;
  staff_profile_id: string | null;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  tax_rate_percent: number | string;
}

interface ScopedAppointmentQuery<TQuery> {
  eq: (column: string, value: unknown) => TQuery;
  in: (column: string, values: readonly unknown[]) => TQuery;
}

const ACTIVE_BOOKING_STATUSES: AppointmentStatus[] = [
  'pending',
  'accepted',
  'checked_in',
  'awaiting_payment',
  'paid',
];
const COMPLETABLE_BOOKING_STATUSES: AppointmentStatus[] = ['accepted', 'checked_in'];
// Statuses whose service lines may be amended line-by-line (0110): the client has
// arrived and the bill is not yet frozen. Mirrors the guard inside
// booking.amend_appointment_services.
const AMENDABLE_BOOKING_STATUSES: AppointmentStatus[] = ['checked_in', 'awaiting_payment'];
const PAYABLE_BOOKING_STATUSES: AppointmentStatus[] = ['awaiting_payment'];
// An accepted booking checks in to 'checked_in'. These statuses mean the client
// has already arrived (or moved past arrival), so a check-in is a no-op.
const CHECKED_IN_OR_LATER_STATUSES: AppointmentStatus[] = [
  'checked_in',
  'awaiting_payment',
  'paid',
];
// Once a visit is checked out ('awaiting_payment' onwards) a bill exists, so undoing
// the arrival is a checkout correction, not a check-in one.
const CHECKED_OUT_STATUSES: AppointmentStatus[] = ['awaiting_payment', 'paid'];
const CHECK_IN_UNDO_BLOCKED_BY_SERVICE_CHANGES =
  'Services on this visit have been changed since check-in, so the check-in can no longer be undone.';
// Statuses a booking can be cancelled from via the book. 'pending' requests are
// handled by reject; 'awaiting_payment'/'paid' already have a visit in flight;
// 'rejected'/'cancelled'/'no_show' are terminal.
const CANCELLABLE_BOOKING_STATUSES: AppointmentStatus[] = ['pending', 'accepted', 'checked_in'];
// Statuses a booking can be moved/reassigned from. Once a visit exists
// (awaiting_payment onwards) the time is locked.
const RESCHEDULABLE_BOOKING_STATUSES: AppointmentStatus[] = ['pending', 'accepted', 'checked_in'];
/**
 * Statuses a booking can be marked as a NO-SHOW from.
 *
 * `pending` is excluded deliberately: a request the salon never accepted is not
 * an appointment the client failed to attend. `checked_in` is excluded because
 * the client demonstrably arrived. That leaves `accepted` — a confirmed booking
 * whose time has passed with nobody in the chair.
 */
const NO_SHOW_BOOKING_STATUSES: AppointmentStatus[] = ['accepted'];
/**
 * States a no-show correction may restore to. Both are pre-completion and carry
 * no money, so a correction can never have a financial side effect. `accepted`
 * is the only state the CURRENT flow marks a no-show from; `checked_in` is here
 * for legacy rows, whose prior state a manager may have to state explicitly.
 */
const NO_SHOW_RESTORABLE_STATUSES: AppointmentStatus[] = ['accepted', 'checked_in'];

// What a CUSTOMER may self-cancel / self-rebook from the mobile app. Narrower than
// the staff lists: once the client has arrived ('checked_in') the salon owns the
// booking, so self-service stops. A 'pending' (not-yet-accepted) request can still
// be withdrawn/rebooked by the client.
const CLIENT_CANCELLABLE_STATUSES: AppointmentStatus[] = ['pending', 'accepted'];
const CLIENT_RESCHEDULABLE_STATUSES: AppointmentStatus[] = ['pending', 'accepted'];

// Fallback when a location has no `cancellation_notice_hours` configured. Matches
// the core.location_settings column default.
const DEFAULT_CANCELLATION_NOTICE_HOURS = 24;

const LIST_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,client_note,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,appointment_services(id,service_id,service_name_snapshot,duration_minutes,deposit_required_amount,price_amount,sequence_no,scheduled_start_at,scheduled_end_at,segments,status,origin,assigned_staff_profile_id,added_at,added_by_user_profile_id,removed_at,removed_by_user_profile_id,removal_reason,replaces_appointment_service_id),deposits(status,amount,currency_code)';

const DETAIL_COLUMNS =
  'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,requested_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,communication_preference,client_note,internal_note,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,original_services_snapshot,appointment_services(id,service_id,service_name_snapshot,duration_minutes,deposit_required_amount,price_amount,sequence_no,scheduled_start_at,scheduled_end_at,segments,status,origin,assigned_staff_profile_id,added_at,added_by_user_profile_id,removed_at,removed_by_user_profile_id,removal_reason,replaces_appointment_service_id),deposits(status,amount,currency_code)';
const VISIT_COLUMNS =
  'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,completed_by_user_profile_id,completed_by_staff_profile_id,checkout_status,checkout_ready_at,paid_at,paid_by_user_profile_id,paid_by_staff_profile_id,service_summary,client_visible_summary,created_at';
const REBOOKING_VISIT_COLUMNS = `${VISIT_COLUMNS},rebooking_outcomes(id,rebooked_appointment_id,rebook_source,rebooked_at)`;
const SALON_PAYMENT_COLUMNS =
  'id,appointment_id,visit_id,payment_method,amount_cents,currency_code,paid_at,confirmed_by_user_profile_id,confirmed_by_staff_profile_id,notes';

const SERVICE_CHANGE_COLUMNS =
  'id,appointment_id,appointment_service_id,replaced_appointment_service_id,action,appointment_status_at_change,actor_user_profile_id,actor_staff_profile_id,before,after,reason,created_at';

const BILL_COLUMNS =
  'id,business_id,location_id,visit_id,appointment_id,client_profile_id,staff_profile_id,bill_number,status,net_cents,tax_cents,gross_cents,discount_cents,deposit_applied_cents,balance_collected_cents,currency_code,tax_label,tax_rate_percent,occurred_at,created_at';
const BILL_LINE_COLUMNS =
  'id,bill_id,sequence_no,line_type,description,staff_profile_id,net_cents,tax_cents,gross_cents,tax_rate_percent';

@Injectable()
export class LabAppointmentsService {
  private readonly logger = new Logger(LabAppointmentsService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly rebooking: RebookingService,
    private readonly taxSettings: OwnerTaxSettingsService,
    private readonly bookingNotifications: BookingNotificationService,
    private readonly rebookingNudges: RebookingNudgeService,
    private readonly stripe: StripeService,
    private readonly audit: AuditService,
    private readonly arrivalNotifications: ArrivalNotificationService,
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
      scope: userHasRole(actor, 'owner') ? 'owner' : userHasRole(actor, 'manager') ? 'manager' : 'stylist',
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
      scope: userHasRole(actor, 'owner') ? 'owner' : userHasRole(actor, 'manager') ? 'manager' : 'stylist',
      rangeStart,
      rangeEnd,
    };
  }

  async todayForLabSession(session: LabRuntimeSession): Promise<ListStaffBookingsResponse> {
    return this.appointmentsForLabSession(session, 'today');
  }

  // Formula-history feed for the active Lab station, scoped to the session's OWN
  // chair. `range` widens the window beyond the default single day (week / month),
  // and an explicit from/to pair drives a custom window. Per-chair scoping is
  // identical for every role — stylists, managers, and owners each see only their
  // own appointments; a session with no staff profile at this location is empty.
  async appointmentsForLabSession(
    session: LabRuntimeSession,
    range: SheerLabAnalyticsRange = 'today',
    from?: string,
    to?: string,
  ): Promise<ListStaffBookingsResponse> {
    const { rangeStart, rangeEnd } = labAppointmentRange(range, from, to);

    const staffProfileId = session.staffProfileId;
    if (!staffProfileId) {
      return { bookings: [], scope: session.role, rangeStart, rangeEnd };
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(LIST_COLUMNS)
      .eq('business_id', session.businessId)
      .eq('location_id', session.locationId)
      .eq('assigned_staff_profile_id', staffProfileId)
      .gte('scheduled_start_at', rangeStart)
      .lt('scheduled_start_at', rangeEnd)
      .in('status', ACTIVE_BOOKING_STATUSES)
      .order('scheduled_start_at', { ascending: true })
      .returns<AppointmentRow[]>();
    if (error) {
      this.logger.error(`appointmentsForLabSession failed: ${error.message}`);
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
      scope: session.role,
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
    // Privilege-tier scope: owner/manager moderation wins. The stylist-only
    // narrowing (own column) applies ONLY to a pure stylist — so an owner (or
    // manager) who ALSO holds the stylist role still moderates the whole book
    // instead of being trapped in their own column. See [[user-role-model]].
    const isModerator = userHasAnyRole(actor, ['owner', 'manager']);
    if (userHasRole(actor, 'stylist') && !isModerator) {
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
    } else if (userHasRole(actor, 'manager')) {
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
    // Every Lab session can only open an appointment assigned to its OWN chair,
    // matching the per-stylist scoping of the schedule list. A session with no
    // staff profile at this location owns no appointments.
    const staffProfileId = session.staffProfileId;
    if (!staffProfileId) {
      throw new NotFoundException('Scheduled client not found for this Lab session');
    }

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
   * 'pending' → 'accepted' and only THEN schedules the client
   * confirmation + reminders and credits any eligible rebooking outcome (these
   * are deliberately not fired at booking time for client requests).
   */
  async accept(actor: AuthUser, id: string): Promise<AcceptBookingResponse> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);
    if (appointment.status !== 'pending') {
      throw new ConflictException(`Booking cannot be accepted from ${appointment.status}`);
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'accepted' })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .eq('status', 'pending')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`accept failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to accept booking');
    }
    const confirmed = data ?? (await this.fetchAppointmentById(id, actor.businessId));
    if (confirmed.status !== 'accepted') {
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
   * Stripe (the client is made whole), then moves the appointment to the distinct
   * 'rejected' state (separate from a customer/salon 'cancelled'). The refund is
   * best-effort: a refund failure is surfaced but never blocks the rejection (the
   * deposit stays 'paid' so it can be refunded manually).
   */
  async reject(actor: AuthUser, id: string, reason?: string): Promise<RejectBookingResponse> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);
    if (appointment.status !== 'pending') {
      throw new ConflictException(`Booking cannot be rejected from ${appointment.status}`);
    }

    const refund = await this.refundPaidDeposit(appointment);

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        status: 'rejected',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason?.trim() || 'Rejected by salon',
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .eq('status', 'pending')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`reject failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to reject booking');
    }
    const cancelled = data ?? (await this.fetchAppointmentById(id, actor.businessId));
    if (cancelled.status !== 'rejected') {
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

  /**
   * Correct an accidental no-show (Week 7, manager-only, fully audited).
   *
   * A no-show is permanent attendance history and the risk signal reads it, so
   * a mis-click used to be uncorrectable — `markNoShow` says as much. This is
   * that path, and it is deliberately narrow:
   *
   *   - MANAGER AUTHORITY ONLY. Same guard as marking one; a pure stylist or
   *     receptionist cannot undo attendance history.
   *   - THE REAL PRIOR STATE. The status is restored from the `booking.no_show`
   *     audit entry's own `before.status`, not reset to a hardcoded 'accepted'.
   *     When no such evidence exists (a no-show recorded before that entry was
   *     written) the fallback is recorded as such in the correction's metadata,
   *     so the restore is never silently guessed.
   *   - THE ORIGINAL EVENT SURVIVES. This writes a NEW `booking.no_show_corrected`
   *     entry; the `booking.no_show` entry it refers to is never touched, so the
   *     history reads "marked, then corrected", which is what happened.
   *   - NO FINANCIAL SIDE EFFECTS. Deposits, bills and visits are untouched —
   *     a correction restores a status, and nothing else.
   */
  async correctNoShow(
    actor: AuthUser,
    id: string,
    reason?: string,
    restoreToStatus?: AppointmentStatus,
  ): Promise<{ appointment: StaffBookingDetail }> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);

    // Idempotent: correcting an appointment that is not a no-show is a no-op.
    // A double-click, or two managers reaching for it at once, changes nothing.
    if (appointment.status !== 'no_show') {
      const clients = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return { appointment: toBookingDetail(appointment, clients.get(appointment.client_profile_id)) };
    }

    const prior = await this.fetchStatusBeforeNoShow(appointment);

    // THE HISTORICAL STATE IS NEVER INVENTED. With audit evidence the record
    // decides and a manager cannot override it. Without evidence — a no-show
    // recorded before that entry was written — the only safe answers are to
    // refuse, or to let a manager state the prior status on the record. So:
    if (prior.status === null && !restoreToStatus) {
      throw new ConflictException(
        'There is no record of what this appointment was before it was marked a no-show, ' +
          'so it cannot be restored automatically. Re-send the correction specifying the status ' +
          'to restore it to (accepted or checked in).',
      );
    }
    if (restoreToStatus && !NO_SHOW_RESTORABLE_STATUSES.includes(restoreToStatus)) {
      throw new ConflictException('A no-show can only be corrected back to accepted or checked in');
    }
    const restoredStatus = prior.status ?? (restoreToStatus as AppointmentStatus);
    const restoreSource: 'audit' | 'manager_selected' = prior.status ? 'audit' : 'manager_selected';

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({ status: restoredStatus, cancellation_reason: null })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      // Concurrency: only the request that still sees a no-show may correct it.
      .eq('status', 'no_show')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`correctNoShow failed for ${id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to correct the no-show');
    }
    if (!data) {
      // Someone else corrected it first. Re-read and return their result rather
      // than failing a request whose intent has already been satisfied.
      const current = await this.fetchAppointmentById(appointment.id, appointment.business_id);
      const clients = await this.fetchClientProfiles(actor.businessId, [current.client_profile_id]);
      return { appointment: toBookingDetail(current, clients.get(current.client_profile_id)) };
    }

    await this.audit.record(actor, {
      action: 'booking.no_show_corrected',
      entityType: 'booking',
      entityId: appointment.id,
      locationId: appointment.location_id,
      before: { status: 'no_show' },
      after: { status: restoredStatus },
      metadata: {
        clientProfileId: appointment.client_profile_id,
        reason: reason?.trim() || null,
        // How the restored status was determined — never a silent guess.
        // `audit` = taken from the no-show entry's own before.status;
        // `manager_selected` = no evidence survived and a manager stated it.
        priorStatusSource: restoreSource,
        correctedNoShowAuditId: prior.auditId,
      },
    });

    return {
      appointment: toBookingDetail(
        data,
        (await this.fetchClientProfiles(actor.businessId, [data.client_profile_id])).get(
          data.client_profile_id,
        ),
      ),
    };
  }

  /**
   * The status this appointment held before it was marked a no-show, taken from
   * the audit entry that recorded the change.
   *
   * NULL means no usable evidence survives. It deliberately does NOT guess: the
   * caller refuses the correction unless a manager states the prior status, so
   * attendance history is never rewritten to a status nobody recorded.
   */
  private async fetchStatusBeforeNoShow(
    appointment: AppointmentRow,
  ): Promise<{ status: AppointmentStatus | null; auditId: string | null }> {
    const { data, error } = await this.admin
      .schema('audit')
      .from('activity_log')
      .select('id,before')
      .eq('business_id', appointment.business_id)
      .eq('entity_type', 'booking')
      .eq('entity_id', appointment.id)
      .eq('action', 'booking.no_show')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; before: Record<string, unknown> | null }>();

    if (error) {
      // A failed audit read is NOT evidence of anything. Treating it as "no
      // prior state" makes the correction ask for one, which is the safe answer.
      this.logger.warn(`no-show prior status lookup failed for ${appointment.id}: ${error.message}`);
      return { status: null, auditId: null };
    }

    const recorded = data?.before?.['status'];
    if (typeof recorded === 'string' && NO_SHOW_RESTORABLE_STATUSES.includes(recorded as AppointmentStatus)) {
      return { status: recorded as AppointmentStatus, auditId: data?.id ?? null };
    }
    return { status: null, auditId: data?.id ?? null };
  }

  private assertOwnerOrManager(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Only an owner or manager can review booking requests');
    }
  }

  /**
   * Mark an accepted appointment as arrived (client checked in at the desk).
   * Moves 'accepted' → 'checked_in' and stamps check_in_at. The status change shows
   * the client as arrived in the assigned stylist's book, and — since the in-app
   * notification foundation landed — also pushes them an arrival notification.
   * Idempotent: a booking already arrived (or further along) is returned unchanged
   * so a double-tap never errors.
   *
   * The notification is emitted ONLY on the branch that actually won the conditional
   * status update, and only after it has committed. Two consequences, both
   * deliberate: a double-tapped front-desk button does not re-notify (the early
   * return above never reaches the emit), and a notification failure cannot fail the
   * check-in — `notifyClientArrivedSafe` does not throw, matching how every other
   * side effect on this path (booking notifications, rebooking, audit) already
   * behaves. There is no transaction to join: PostgREST has no multi-statement
   * transaction.
   *
   * DELIVERY SEMANTICS, precisely: this is AT-MOST-ONCE, not at-least-once. The
   * single attempt is made by the winner of the transition; if it fails, the
   * notification is lost and re-tapping check-in will NOT recover it, because an
   * already-arrived booking returns early above. That is an accepted limit of the
   * foundation ticket — notifications are best-effort operational support, and
   * losing one must never cost a check-in. The `dedupeKey` is what makes it safe for
   * a future retry path (the durable dispatcher, per the ticket's §18 future scope)
   * to re-attempt without ever producing a duplicate.
   */
  async checkIn(actor: AuthUser, id: string): Promise<CheckInAppointmentResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);

    if (CHECKED_IN_OR_LATER_STATUSES.includes(appointment.status)) {
      const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return { appointment: toBookingDetail(appointment, clientsById.get(appointment.client_profile_id)) };
    }
    if (appointment.status !== 'accepted') {
      throw new ConflictException(`Appointment cannot be checked in from ${appointment.status}`);
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'checked_in', check_in_at: new Date().toISOString() })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .eq('status', 'accepted')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`checkIn failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to check in appointment');
    }
    // `data` is populated only for the request that won the `.eq('status','accepted')`
    // claim. A concurrent second check-in falls through to a re-read instead, and
    // must not emit a second arrival notification.
    //
    // `!= null` rather than `!== null`: the typed contract is `T | null`, but an
    // undefined here would read as "we won" under a strict comparison and produce a
    // duplicate notification on the losing request. Loose is the safe direction.
    const wonTheTransition = data != null;
    const checkedIn = data ?? (await this.fetchAppointmentById(id, actor.businessId));
    if (!CHECKED_IN_OR_LATER_STATUSES.includes(checkedIn.status)) {
      throw new ConflictException('Appointment was updated before it could be checked in');
    }

    if (wonTheTransition) {
      // Recorded only for the winner, so a double-tap writes one entry. This is the
      // "who checked this client in, and when" an undo is measured against.
      await this.audit.record(actor, {
        action: 'booking.checked_in',
        entityType: 'booking',
        entityId: checkedIn.id,
        locationId: checkedIn.location_id,
        before: { status: 'accepted' },
        after: { status: 'checked_in', checkInAt: checkedIn.check_in_at ?? null },
        metadata: { clientProfileId: checkedIn.client_profile_id },
      });

      // The status write is already committed. `notifyClientArrivedSafe` is
      // contractually non-throwing, and the trailing catch is deliberate belt-and-
      // braces at the boundary: if that contract is ever broken, the client is still
      // checked in — the desk must never see a 500 for an alert that did not send.
      await this.arrivalNotifications
        .notifyClientArrivedSafe(
          {
            id: checkedIn.id,
            business_id: checkedIn.business_id,
            location_id: checkedIn.location_id,
            client_profile_id: checkedIn.client_profile_id,
            assigned_staff_profile_id: checkedIn.assigned_staff_profile_id,
            check_in_at: checkedIn.check_in_at ?? null,
          },
          actor.id,
        )
        .catch((err: unknown) => {
          this.logger.error(
            `arrival notification threw for appointment ${checkedIn.id}: ${(err as Error)?.message ?? err}`,
          );
        });
    }

    const clientsById = await this.fetchClientProfiles(actor.businessId, [checkedIn.client_profile_id]);
    return { appointment: toBookingDetail(checkedIn, clientsById.get(checkedIn.client_profile_id)) };
  }

  /**
   * Undo a mistaken check-in: 'checked_in' → 'accepted', clearing check_in_at.
   *
   * Check-in carries no money, no visit and no risk signal, so an undo is a status
   * correction and nothing else. It is open to everyone who can check a client in —
   * the person most likely to fix a mis-tap is the one who made it — and it is
   * deliberately narrow:
   *
   *   - ONLY FROM `checked_in`. Once checked out a bill exists; that is corrected
   *     through checkout, never by rewinding the arrival.
   *   - NOT ONCE THE VISIT HAS BEEN WORKED ON. A service added, removed or reassigned
   *     after check-in leaves post-check-in lines and append-only history (0110).
   *     Back in 'accepted', the pre-check-in editor replaces service lines wholesale,
   *     which that history forbids — the appointment could no longer be edited. So
   *     any recorded change refuses the undo. History is append-only, so this can
   *     never become undoable later.
   *   - CHECK_IN_AT IS CLEARED. Completion copies it into the visit's
   *     checked_in_at, which CRM, lapse and rebooking read as attendance time; a
   *     mistaken arrival must not survive into that. The value is kept in the audit
   *     entry instead.
   *   - THE STYLIST IS TOLD. The arrival alert cannot be recalled, so a second
   *     notice corrects it (best-effort, like the arrival itself).
   *
   * Idempotent: an appointment already back at 'accepted' is returned unchanged, so a
   * double-tap or two people undoing at once never errors.
   */
  async undoCheckIn(
    actor: AuthUser,
    id: string,
    reason?: string,
  ): Promise<{ appointment: StaffBookingDetail }> {
    const appointment = await this.fetchAppointmentForActor(actor, id);

    if (appointment.status === 'accepted') {
      const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return { appointment: toBookingDetail(appointment, clientsById.get(appointment.client_profile_id)) };
    }
    if (CHECKED_OUT_STATUSES.includes(appointment.status)) {
      throw new ConflictException(
        'This appointment has already been checked out, so its check-in cannot be undone.',
      );
    }
    if (appointment.status !== 'checked_in') {
      throw new ConflictException(`Check-in cannot be undone for an appointment that is ${appointment.status}`);
    }
    if (await this.hasPostCheckInServiceChanges(appointment)) {
      throw new ConflictException(CHECK_IN_UNDO_BLOCKED_BY_SERVICE_CHANGES);
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({ status: 'accepted', check_in_at: null })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      // Concurrency: only the request that still sees the arrival may undo it.
      .eq('status', 'checked_in')
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`undoCheckIn failed for ${id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to undo the check-in');
    }
    if (!data) {
      // Lost the claim. If someone else already undid it, their result satisfies this
      // request too; anything else (checked out, cancelled) moved on without us.
      const current = await this.fetchAppointmentById(appointment.id, appointment.business_id);
      if (current.status !== 'accepted') {
        throw new ConflictException('Appointment was updated before its check-in could be undone');
      }
      const clientsById = await this.fetchClientProfiles(actor.businessId, [current.client_profile_id]);
      return { appointment: toBookingDetail(current, clientsById.get(current.client_profile_id)) };
    }

    // CLOSE THE RACE. booking.amend_appointment_services locks the appointment and
    // refuses anything not checked_in, so a service change that starts after the
    // update above is refused. One that committed between the check and the update
    // is not — so look again now, and put the arrival back if one slipped in. Nothing
    // has been audited or notified yet, so the reversal leaves no trace to explain.
    if (await this.hasPostCheckInServiceChanges(appointment)) {
      const { error: restoreError } = await this.admin
        .schema('booking')
        .from('appointments')
        .update({ status: 'checked_in', check_in_at: appointment.check_in_at ?? null })
        .eq('id', appointment.id)
        .eq('business_id', appointment.business_id)
        .eq('status', 'accepted');
      if (restoreError) {
        this.logger.error(`undoCheckIn restore failed for ${id}: ${restoreError.message}`);
      }
      throw new ConflictException(CHECK_IN_UNDO_BLOCKED_BY_SERVICE_CHANGES);
    }

    await this.audit.record(actor, {
      action: 'booking.check_in_undone',
      entityType: 'booking',
      entityId: appointment.id,
      locationId: appointment.location_id,
      before: { status: 'checked_in', checkInAt: appointment.check_in_at ?? null },
      after: { status: 'accepted', checkInAt: null },
      metadata: {
        clientProfileId: appointment.client_profile_id,
        reason: reason?.trim() || null,
      },
    });

    // The pre-undo row, so the notice is keyed to the check-in it corrects. Never
    // throws by contract; the catch keeps a broken contract from failing the undo.
    await this.arrivalNotifications
      .notifyCheckInUndoneSafe(
        {
          id: appointment.id,
          business_id: appointment.business_id,
          location_id: appointment.location_id,
          client_profile_id: appointment.client_profile_id,
          assigned_staff_profile_id: appointment.assigned_staff_profile_id,
          check_in_at: appointment.check_in_at ?? null,
        },
        actor.id,
      )
      .catch((err: unknown) => {
        this.logger.error(
          `check-in undone notification threw for appointment ${appointment.id}: ${(err as Error)?.message ?? err}`,
        );
      });

    const clientsById = await this.fetchClientProfiles(actor.businessId, [data.client_profile_id]);
    return { appointment: toBookingDetail(data, clientsById.get(data.client_profile_id)) };
  }

  /**
   * Whether any service change has been recorded against this appointment since it
   * was checked in. Fails closed: an unreadable history refuses the undo rather than
   * risking an appointment that can no longer be edited.
   */
  private async hasPostCheckInServiceChanges(appointment: AppointmentRow): Promise<boolean> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointment_service_changes')
      .select('id')
      .eq('appointment_id', appointment.id)
      .eq('business_id', appointment.business_id)
      .limit(1)
      .returns<Array<{ id: string }>>();
    if (error) {
      this.logger.error(`service change lookup failed for ${appointment.id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to undo the check-in');
    }
    return (data ?? []).length > 0;
  }

  /**
   * Cancel a confirmed/checked-in appointment straight from the book. Like reject,
   * this is an owner/manager decision. The actor chooses at cancel time whether a
   * paid deposit is refunded (`refundDeposit`, default true) — refunding via Stripe
   * or keeping it (forfeited). It claims the 'cancelled' transition FIRST (a
   * conditional update), and only the request that wins that claim performs the
   * refund + notification re-sync — so concurrent front-desk cancels can never
   * double-refund. 'reject' stays the path for client requests still awaiting acceptance.
   */
  /**
   * Mark a confirmed appointment as a no-show.
   *
   * WHY THIS EXISTS. `no_show` has been in `booking.appointment_status_enum`
   * since 0004 and is read by the dashboard, the rebooking rules and the
   * communications guards — but until now NOTHING in the platform ever wrote it.
   * It was a dead value, which meant every no-show figure the product displayed
   * was structurally zero. Wrike 4507283793 asks for a no-show risk signal
   * "based on actual client appointment history", and that history cannot exist
   * without this transition.
   *
   * It is the missing sibling of accept / reject / check-in / cancel / complete
   * and follows their exact shape: owner-or-manager only, an atomic
   * `.in(status, ...)` claim so two racing requests cannot both apply it, and an
   * audit record. It deliberately does NOT touch deposits, billing or stock —
   * whether a no-show forfeits a deposit is a separate product decision, and
   * making it here would smuggle a charging policy into a status change.
   */
  async markNoShow(
    actor: AuthUser,
    id: string,
    reason?: string,
    now: Date = new Date(),
  ): Promise<{ appointment: StaffBookingDetail }> {
    this.assertOwnerOrManager(actor);
    const appointment = await this.fetchAppointmentForActor(actor, id);

    // Idempotent: re-marking an existing no-show is a no-op, not a conflict.
    if (appointment.status === 'no_show') {
      const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return { appointment: toBookingDetail(appointment, clientsById.get(appointment.client_profile_id)) };
    }
    if (!NO_SHOW_BOOKING_STATUSES.includes(appointment.status)) {
      throw new ConflictException(`Appointment cannot be marked as a no-show from ${appointment.status}`);
    }

    // A NO-SHOW IS AN OBSERVATION, NOT A PREDICTION. An appointment that has not
    // started yet cannot have been missed, so this refuses rather than recording
    // a fact nobody could know. Without the guard a mis-click on tomorrow's
    // column writes permanent attendance history for a client who has done
    // nothing wrong — and the no-show risk signal reads exactly this column, so
    // it would be scored against them. There is no correction path today, which
    // makes prevention the whole of the protection.
    const startsAt = new Date(appointment.scheduled_start_at);
    if (Number.isFinite(startsAt.getTime()) && startsAt.getTime() > now.getTime()) {
      throw new ConflictException(
        'This appointment has not started yet, so it cannot be marked as a no-show.',
      );
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        status: 'no_show',
        cancellation_reason: reason?.trim() || 'Marked as no-show',
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', NO_SHOW_BOOKING_STATUSES)
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`markNoShow failed for ${id}: ${error.message}`);
      throw new InternalServerErrorException('Unable to mark the appointment as a no-show');
    }
    if (!data) {
      // Lost the race — another request already moved it out of `accepted`.
      throw new ConflictException('Appointment status changed before it could be marked as a no-show');
    }

    await this.audit.record(actor, {
      action: 'booking.no_show',
      entityType: 'booking',
      entityId: appointment.id,
      locationId: appointment.location_id,
      before: { status: appointment.status },
      after: { status: 'no_show' },
      metadata: { clientProfileId: appointment.client_profile_id },
    });

    const clientsById = await this.fetchClientProfiles(actor.businessId, [data.client_profile_id]);
    return { appointment: toBookingDetail(data, clientsById.get(data.client_profile_id)) };
  }

  async cancel(
    actor: AuthUser,
    id: string,
    reason?: string,
    refundDeposit?: boolean,
  ): Promise<CancelAppointmentResponse> {
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

    // We own the cancellation. The actor decides whether the deposit is refunded:
    // refund (best-effort; a failure leaves the deposit 'paid' so it can be refunded
    // manually) or keep it — flagged forfeited so the book can tell the user the
    // deposit was retained. Either way, stop the client's pending confirmations/
    // reminders. Fail-soft on the notification sync.
    const shouldRefund = refundDeposit !== false;
    let depositRefunded = false;
    let depositForfeited = false;
    let refundError: string | undefined;
    if (shouldRefund) {
      const refund = await this.refundPaidDeposit(data);
      depositRefunded = refund.refunded;
      refundError = refund.error;
    } else {
      depositForfeited = arrayOf(data.deposits).some((deposit) => deposit.status === 'paid');
    }
    await this.bookingNotifications.syncBookingNotificationsSafe(data.id);

    await this.audit.record(actor, {
      action: 'booking.cancelled',
      entityType: 'booking',
      entityId: data.id,
      locationId: data.location_id,
      before: { status: appointment.status },
      after: { status: 'cancelled', cancellationReason: reason?.trim() || 'Cancelled by salon' },
      metadata: {
        clientProfileId: data.client_profile_id,
        depositRefunded,
        depositForfeited,
        cancelledBy: 'salon',
      },
    });

    const clientsById = await this.fetchClientProfiles(actor.businessId, [data.client_profile_id]);
    return {
      appointment: toBookingDetail(data, clientsById.get(data.client_profile_id)),
      depositRefunded,
      refundError,
      depositForfeited: depositForfeited || undefined,
    };
  }

  /**
   * Customer-initiated cancellation from the mobile app. The customer may always
   * cancel an upcoming booking, but the deposit is only refunded when they cancel
   * OUTSIDE the salon's configured cancellation window (`cancellation_notice_hours`
   * before the start). Inside the window the booking still cancels but a paid
   * deposit is forfeited (kept). Ownership is enforced via clientProfileId; the
   * 'cancelled' transition is claimed atomically so a double-tap never double-refunds.
   */
  async cancelForClient(actor: AuthUser, id: string, reason?: string): Promise<CancelAppointmentResponse> {
    const appointment = await this.fetchAppointmentForClient(actor, id);

    if (appointment.status === 'cancelled') {
      const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
      return {
        appointment: toBookingDetail(appointment, clientsById.get(appointment.client_profile_id)),
        depositRefunded: false,
      };
    }
    if (!CLIENT_CANCELLABLE_STATUSES.includes(appointment.status)) {
      throw new ConflictException('This appointment can no longer be cancelled online. Please contact the salon.');
    }

    const windowHours = await this.fetchCancellationWindowHours(appointment.location_id);
    const outsideWindow = isOutsideCancellationWindow(appointment.scheduled_start_at, windowHours);

    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason?.trim() || 'Cancelled by client',
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', CLIENT_CANCELLABLE_STATUSES)
      .select(DETAIL_COLUMNS)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`cancelForClient failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to cancel appointment');
    }

    if (!data) {
      // Lost the race (already cancelled elsewhere) — never refund twice.
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

    // Outside the window → refund the paid deposit (best-effort). Inside it → keep
    // the deposit; flag it forfeited so the app can tell the customer.
    let depositRefunded = false;
    let depositForfeited = false;
    let refundError: string | undefined;
    if (outsideWindow) {
      const refund = await this.refundPaidDeposit(data);
      depositRefunded = refund.refunded;
      refundError = refund.error;
    } else {
      depositForfeited = arrayOf(data.deposits).some((deposit) => deposit.status === 'paid');
    }
    await this.bookingNotifications.syncBookingNotificationsSafe(data.id);

    await this.audit.record(actor, {
      action: 'booking.cancelled',
      entityType: 'booking',
      entityId: data.id,
      locationId: data.location_id,
      before: { status: appointment.status },
      after: { status: 'cancelled', cancellationReason: reason?.trim() || 'Cancelled by client' },
      metadata: {
        clientProfileId: data.client_profile_id,
        depositRefunded,
        depositForfeited,
        cancelledBy: 'client',
      },
    });

    const clientsById = await this.fetchClientProfiles(actor.businessId, [data.client_profile_id]);
    return {
      appointment: toBookingDetail(data, clientsById.get(data.client_profile_id)),
      depositRefunded,
      refundError,
      depositForfeited: depositForfeited || undefined,
    };
  }

  /**
   * Customer-initiated rebooking (reschedule in place) from the mobile app. Only
   * allowed OUTSIDE the cancellation window; the deposit carries over untouched.
   * The customer can only move the time — the stylist and services are preserved.
   */
  async rescheduleForClient(
    actor: AuthUser,
    id: string,
    input: RescheduleAppointmentRequest,
  ): Promise<RescheduleAppointmentResponse> {
    const appointment = await this.fetchAppointmentForClient(actor, id);
    if (!CLIENT_RESCHEDULABLE_STATUSES.includes(appointment.status)) {
      throw new ConflictException('This appointment can no longer be rebooked online. Please contact the salon.');
    }

    const windowHours = await this.fetchCancellationWindowHours(appointment.location_id);
    if (!isOutsideCancellationWindow(appointment.scheduled_start_at, windowHours)) {
      throw new ConflictException('Rebooking is only available before the cancellation cut-off. Please contact the salon.');
    }

    // Customers never reassign staff or swap services — only the start time moves.
    return this.performReschedule(
      actor,
      appointment,
      { scheduledStartAt: input.scheduledStartAt },
      CLIENT_RESCHEDULABLE_STATUSES,
    );
  }

  /**
   * Load an appointment scoped to the calling CLIENT and assert they own it. The
   * staff-oriented `fetchAppointmentForActor` rejects clients outright, so the
   * mobile cancel/rebook flows use this instead.
   */
  private async fetchAppointmentForClient(actor: AuthUser, id: string): Promise<AppointmentRow> {
    if (!userHasRole(actor, 'client') || !actor.clientProfileId) {
      throw new ForbiddenException('A client account is required to manage this appointment');
    }
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .eq('business_id', actor.businessId)
      .maybeSingle<AppointmentRow>();
    if (error) {
      this.logger.error(`fetchAppointmentForClient failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load appointment');
    }
    if (!data) throw new NotFoundException('Appointment not found');
    if (data.client_profile_id !== actor.clientProfileId) {
      throw new ForbiddenException('You can only manage your own appointments');
    }
    return data;
  }

  /**
   * The location's cancellation-notice window in hours. `core.location_settings`
   * is in a different schema than `booking.appointments`, so it is fetched
   * separately (PostgREST can't embed across schemas). Falls back to the column
   * default on any miss.
   */
  private async fetchCancellationWindowHours(locationId: string): Promise<number> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('cancellation_notice_hours')
      .eq('location_id', locationId)
      .maybeSingle<{ cancellation_notice_hours: number | null }>();
    if (error) {
      this.logger.error(`fetchCancellationWindowHours failed: ${error.message}`);
      return DEFAULT_CANCELLATION_NOTICE_HOURS;
    }
    const hours = data?.cancellation_notice_hours;
    return typeof hours === 'number' && hours >= 0 ? hours : DEFAULT_CANCELLATION_NOTICE_HOURS;
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
    return this.performReschedule(actor, appointment, input, RESCHEDULABLE_BOOKING_STATUSES);
  }

  /**
   * Shared move/reassign logic for an already-loaded, status-validated appointment.
   * Both the staff `reschedule` and the customer-facing `rescheduleForClient` funnel
   * through here; they differ only in who is allowed in and which statuses guard the
   * conditional update (`allowedStatuses`).
   */
  private async performReschedule(
    actor: AuthUser,
    appointment: AppointmentRow,
    input: RescheduleAppointmentRequest,
    allowedStatuses: AppointmentStatus[],
  ): Promise<RescheduleAppointmentResponse> {
    const id = appointment.id;
    // Edit Appointment is a day-of tool, so (unlike rebooking) it allows moving to
    // an earlier slot today — only the date itself must be valid, not in the future.
    const newStart = parseValidDate(input.scheduledStartAt);
    // Only the BOOKED lines carry a diary window. Lines added after check-in have
    // no schedule of their own (the client is already in the chair), so they play
    // no part in moving, resizing or the double-booking guard (0110).
    const currentServices = scheduledServices(appointment);

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
    // After check-in the service list is NOT a replaceable array any more: a
    // delete-and-reinsert would erase the booked baseline and silently drop a
    // colleague's concurrent addition. Post-check-in changes go through the
    // line-level amend path (addService / removeService), which keeps history.
    if (servicesChanged && appointment.status === 'checked_in') {
      throw new ConflictException(
        'Services cannot be replaced after check-in — add or remove services on the visit instead',
      );
    }

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

    // Resize (services unchanged): either an explicit new total duration, which
    // grows or shrinks the LAST stylist-occupied segment, or one targeted service
    // line/segment, which pushes every later service along. Everything downstream
    // (total duration, occupied windows, per-service rows) then derives from these
    // resized rows, so the header, the double-booking guard and the calendar stay
    // consistent. A no-op resize returns null and the move behaves exactly as before.
    if (input.durationMinutes != null && input.resizeService) {
      throw new BadRequestException('Send either durationMinutes or resizeService, not both');
    }
    const resizeTarget: ResizeTarget | null = resolvedServices
      ? null
      : input.resizeService
        ? { kind: 'line', ...input.resizeService }
        : input.durationMinutes != null
          ? { kind: 'total', durationMinutes: input.durationMinutes }
          : null;
    const resize = resizeTarget ? buildResizedServiceRows(currentServices, resizeTarget) : null;
    const effectiveServiceRows = resize?.rows ?? currentServices;

    const durationMinutes = resolvedServices
      ? resolvedServices.reduce((sum, service) => sum + service.durationMinutes, 0) || 30
      : effectiveServiceRows.reduce((sum, service) => sum + Number(service.duration_minutes ?? 0), 0) ||
        minutesBetween(appointment.scheduled_start_at, appointment.scheduled_end_at) ||
        30;
    const newEnd = new Date(newStart.getTime() + durationMinutes * 60_000);

    if (staffProfileId) {
      const candidateOccupied = occupiedIntervalsFrom(
        resolvedServices ? occupancyFromResolved(resolvedServices) : occupancyFromServiceRows(effectiveServiceRows),
        newStart,
      );
      await this.assertStaffAvailableForRebooking({
        businessId: actor.businessId,
        locationId: appointment.location_id,
        staffProfileId,
        selectedStart: newStart,
        selectedEnd: newEnd,
        candidateOccupied,
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
        // Refresh the stylist-occupied windows for the new time/services so the
        // no-overlap guard validates against the NEW position, not the old one.
        occupied_ranges: resolvedServices
          ? occupiedRangesLiteralForResolved(resolvedServices, newStart)
          : occupiedRangesLiteralForRows(effectiveServiceRows, newStart),
      })
      .eq('id', appointment.id)
      .eq('business_id', appointment.business_id)
      .in('status', allowedStatuses)
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
      } else if (resize) {
        // Persist the resized service rows (new duration + segments on the last
        // line) and re-sequence every row's window from the new start.
        await this.applyResizedServiceRows(
          rescheduled,
          resize.rows,
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

    // The header-update projection was captured before the per-service rows were
    // rewritten, so it still carries the OLD nested service rows. Re-fetch when the
    // services changed OR were resized so the response reflects the new
    // durations/segments/windows (a plain move only re-sequences and keeps them).
    const finalRow =
      resolvedServices || resize ? await this.fetchAppointmentById(id, actor.businessId) : rescheduled;

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
        occupied_ranges: occupiedRangesLiteralForRows(
          arrayOf(prior.appointment_services),
          new Date(prior.scheduled_start_at),
        ),
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
      // Post-check-in lines have no diary window and must never be given one.
      .eq('origin', 'booked')
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

  // Persist a resize: write each row's (possibly adjusted) duration + segments and
  // re-sequence its window from the new start. Rows are the resized copy built by
  // buildResizedServiceRows — only the last line's duration/segments differ, but we
  // rewrite every row's window so the whole appointment stays contiguous.
  private async applyResizedServiceRows(
    appointment: AppointmentRow,
    rows: AppointmentServiceRow[],
    newStart: Date,
    staffProfileId: string | null,
  ): Promise<void> {
    let cursor = newStart;
    for (const row of sortServiceRows(rows)) {
      if (!row.id) continue;
      const start = cursor;
      const end = new Date(start.getTime() + Number(row.duration_minutes ?? 0) * 60_000);
      cursor = end;
      const { error: updateError } = await this.admin
        .schema('booking')
        .from('appointment_services')
        .update({
          duration_minutes: Number(row.duration_minutes ?? 0),
          segments: normalizeSegments(row.segments),
          scheduled_start_at: start.toISOString(),
          scheduled_end_at: end.toISOString(),
          assigned_staff_profile_id: staffProfileId,
        })
        .eq('id', row.id)
        .eq('business_id', appointment.business_id);
      if (updateError) {
        this.logger.error(`applyResizedServiceRows update failed: ${updateError.message}`);
        throw new InternalServerErrorException('Unable to resize appointment services');
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
      .select(
        'id,name,estimated_duration_minutes,base_price,deposit_type,deposit_value,is_active,location_id,service_segments(name,duration_minutes,is_stylist_free,sort_order)',
      )
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
        segments: service.segments ?? [],
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


  // ---------------------------------------------------------------------------
  // Post-check-in service lifecycle (0110) — booked vs performed
  // ---------------------------------------------------------------------------
  //
  // One canonical mutation path for every way a service joins or leaves a visit
  // after the client has arrived: a consultation decision, a manual search, an
  // upsell suggestion the stylist accepts. All of them are line-level operations
  // on booking.appointment_services executed by booking.amend_appointment_services
  // under an appointment row lock, so concurrent staff both succeed and nothing
  // is ever overwritten. The booked baseline stays on the rows (origin/status);
  // the change history is written atomically with the line.

  /** Add a service to a checked-in / awaiting-payment appointment (or replace one). */
  async addService(
    actor: AuthUser,
    id: string,
    input: AddAppointmentServiceRequest,
  ): Promise<AmendAppointmentServicesResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    this.assertServicesAmendable(appointment);

    // Same catalogue rules as booking: active, this business, salon-wide or this
    // location. The function re-checks tenancy; this gives the desk a clear 404.
    const [service] = await this.fetchCatalogServices(actor.businessId, appointment.location_id, [
      input.serviceId,
    ]);

    // Attribution: the caller's choice, else the appointment's stylist. A pure
    // stylist may only attribute to themselves; anyone chosen must be bookable and
    // eligible for the service — the same hard block the booking flow applies.
    const staffProfileId = input.staffProfileId ?? appointment.assigned_staff_profile_id ?? undefined;
    if (staffProfileId) {
      if (staffProfileId !== appointment.assigned_staff_profile_id) {
        this.assertCanAssignRebookingStaff(actor, staffProfileId, appointment.location_id);
        await this.assertStaffBookable(actor.businessId, appointment.location_id, staffProfileId);
      }
      await this.assertStaffEligibleForServices(actor.businessId, staffProfileId, [service.id]);
    }

    const action = input.replacesAppointmentServiceId ? 'replace' : 'add';
    return this.amendServices(actor, appointment, {
      action,
      serviceId: service.id,
      lineId: input.replacesAppointmentServiceId,
      staffProfileId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Take a performed line off the visit. The row is kept, marked removed. */
  async removeService(
    actor: AuthUser,
    id: string,
    lineId: string,
    input: RemoveAppointmentServiceRequest,
  ): Promise<AmendAppointmentServicesResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    this.assertServicesAmendable(appointment);
    return this.amendServices(actor, appointment, {
      action: 'remove',
      lineId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Re-attribute a performed line to another stylist. */
  async reassignService(
    actor: AuthUser,
    id: string,
    lineId: string,
    input: ReassignAppointmentServiceRequest,
  ): Promise<AmendAppointmentServicesResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    this.assertServicesAmendable(appointment);
    const line = arrayOf(appointment.appointment_services).find((entry) => entry.id === lineId);
    if (!line) throw new NotFoundException('That service is not on this visit');
    this.assertCanAssignRebookingStaff(actor, input.staffProfileId, appointment.location_id);
    await this.assertStaffBookable(actor.businessId, appointment.location_id, input.staffProfileId);
    if (line.service_id) {
      await this.assertStaffEligibleForServices(actor.businessId, input.staffProfileId, [line.service_id]);
    }
    return this.amendServices(actor, appointment, {
      action: 'reassign',
      lineId,
      staffProfileId: input.staffProfileId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Booked vs performed, plus every recorded change — readable after payment. */
  async serviceChanges(actor: AuthUser, id: string): Promise<AppointmentServiceChangesResponse> {
    const appointment = await this.fetchAppointmentForActor(actor, id);
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointment_service_changes')
      .select(SERVICE_CHANGE_COLUMNS)
      .eq('appointment_id', appointment.id)
      .eq('business_id', appointment.business_id)
      .order('created_at', { ascending: true })
      .order('change_no', { ascending: true })
      .returns<AppointmentServiceChangeRow[]>();
    if (error) {
      this.logger.error(`serviceChanges failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load service history');
    }
    const rows = data ?? [];
    const names = await this.fetchChangeActorNames(appointment.business_id, rows, appointment);
    const lines = toServiceLineSummaries(appointment);
    // T0 / T1 / T2 side by side. The snapshot is absent on every appointment
    // created before 0110 — reported as unavailable, never faked from the
    // current set (which may already be a pre-check-in edit).
    const original = toOriginalBookedServices(appointment.original_services_snapshot);
    return {
      appointmentId: appointment.id,
      originalBookedServices: original ?? [],
      originalBookingAvailable: original !== null,
      bookedServices: lines.filter((line) => line.origin === 'booked'),
      performedServices: lines.filter((line) => line.performed),
      changes: rows.map((row) => toServiceChange(row, names)),
    };
  }

  /**
   * Only between arrival and payment. Before check-in the booking editor owns
   * the (replaceable) service list; after payment the bill is frozen (0085) and
   * corrections take the refund/adjustment path.
   */
  private assertServicesAmendable(appointment: AppointmentRow): void {
    if (AMENDABLE_BOOKING_STATUSES.includes(appointment.status)) return;
    if (appointment.status === 'paid') {
      throw new ConflictException(
        'This appointment is paid, so its services are final. Correct the bill with a refund or adjustment instead.',
      );
    }
    if (appointment.status === 'pending' || appointment.status === 'accepted') {
      throw new ConflictException('Check the client in first — before arrival, change services through Edit appointment');
    }
    throw new ConflictException(`Services cannot be changed on a ${appointment.status.replace('_', ' ')} appointment`);
  }

  private async amendServices(
    actor: AuthUser,
    appointment: AppointmentRow,
    input: {
      action: 'add' | 'remove' | 'replace' | 'reassign';
      serviceId?: string;
      lineId?: string;
      staffProfileId?: string;
      reason?: string;
      idempotencyKey?: string;
    },
  ): Promise<AmendAppointmentServicesResponse> {
    const { data, error } = await this.admin.schema('booking').rpc('amend_appointment_services', {
      p_payload: {
        appointmentId: appointment.id,
        businessId: appointment.business_id,
        action: input.action,
        serviceId: input.serviceId ?? null,
        lineId: input.lineId ?? null,
        staffProfileId: input.staffProfileId ?? null,
        reason: input.reason?.trim() || null,
        idempotencyKey: input.idempotencyKey?.trim() || null,
        // The actor is the authenticated identity — never anything a client sent.
        actorUserProfileId: actor.id,
        actorStaffProfileId: actor.staffProfileId ?? null,
        actorRole: actor.primaryRole,
      },
    });
    if (error) {
      const mapped = amendErrorToHttp(error.message ?? '');
      if (mapped instanceof InternalServerErrorException) {
        this.logger.error(`amend_appointment_services failed: ${error.message}`);
      }
      throw mapped;
    }
    const result = (data ?? {}) as {
      changeId?: string | null;
      lineId?: string | null;
      replayed?: boolean;
      alreadyApplied?: boolean;
    };
    const replayed = Boolean(result.replayed);
    const alreadyApplied = Boolean(result.alreadyApplied);

    // Re-read: the projection loaded before the lock is stale by definition.
    const amended = await this.fetchAppointmentById(appointment.id, appointment.business_id);

    // Once the visit exists the bill is live: re-reconcile the rolled-up service
    // line and the visit's summary so checkout, KPIs and the payroll cross-check
    // all see the performed set. Any failure here is surfaced — a service change
    // the bill does not reflect is exactly the silent loss this must not allow.
    let billing: AmendAppointmentServicesResponse['billing'];
    const visit = await this.fetchVisitForAppointment(amended.id);
    if (visit && amended.status === 'awaiting_payment') {
      await this.reconcileServiceLineItem(amended, visit.id);
      await this.refreshVisitServiceSummary(visit, amended);
      const [lineItems, taxSettings] = await Promise.all([
        this.fetchVisitLineItems(visit.id),
        this.taxSettings.resolveLocationTaxSettings(amended.business_id, amended.location_id),
      ]);
      billing = buildBillingSummary(amended, lineItems, taxSettings);
    }

    let change: AppointmentServiceChange | undefined;
    if (result.changeId) {
      const { data: changeRow } = await this.admin
        .schema('booking')
        .from('appointment_service_changes')
        .select(SERVICE_CHANGE_COLUMNS)
        .eq('id', result.changeId)
        .maybeSingle<AppointmentServiceChangeRow>();
      if (changeRow) {
        const names = await this.fetchChangeActorNames(amended.business_id, [changeRow], amended);
        change = toServiceChange(changeRow, names);
      }
    }

    if (!replayed && !alreadyApplied && change) {
      // The platform audit trail (fail-soft, for the audit page). The structured
      // history row above is the one the bill relies on.
      await this.audit.record(actor, {
        action: `booking.service.${change.action}`,
        entityType: 'booking',
        entityId: amended.id,
        locationId: amended.location_id,
        before: change.before ? { ...change.before } : null,
        after: change.after ? { ...change.after } : null,
        metadata: {
          appointmentId: amended.id,
          changeId: change.id,
          lineId: result.lineId ?? null,
          appointmentStatus: change.appointmentStatusAtChange,
          reason: change.reason ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });
    }

    const clientsById = await this.fetchClientProfiles(actor.businessId, [amended.client_profile_id]);
    return {
      appointment: toBookingDetail(amended, clientsById.get(amended.client_profile_id)),
      change,
      replayed,
      alreadyApplied,
      billing,
    };
  }

  // The visit's human summary follows the performed set; it is a label, not money.
  private async refreshVisitServiceSummary(visit: VisitRow, appointment: AppointmentRow): Promise<void> {
    const summary = summarizeServices(appointment.appointment_services);
    if (!summary) return;
    const { error } = await this.admin
      .schema('booking')
      .from('visits')
      .update({ service_summary: summary, client_visible_summary: summary })
      .eq('id', visit.id)
      .eq('business_id', appointment.business_id);
    if (error) this.logger.warn(`refreshVisitServiceSummary failed: ${error.message}`);
  }

  /** Display names for the actors and stylists a set of change rows mention. */
  private async fetchChangeActorNames(
    businessId: string,
    rows: AppointmentServiceChangeRow[],
    appointment: AppointmentRow,
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const staffIds = new Set<string>();
    const userIds = new Set<string>();
    for (const row of rows) {
      if (row.actor_staff_profile_id) staffIds.add(row.actor_staff_profile_id);
      if (row.actor_user_profile_id) userIds.add(row.actor_user_profile_id);
      for (const snapshot of [row.before, row.after]) {
        const staff = snapshot?.staffProfileId;
        if (typeof staff === 'string') staffIds.add(staff);
      }
    }
    for (const line of arrayOf(appointment.appointment_services)) {
      if (line.assigned_staff_profile_id) staffIds.add(line.assigned_staff_profile_id);
    }
    if (staffIds.size > 0) {
      const { data } = await this.admin
        .schema('core')
        .from('staff_profiles')
        .select('id,display_name')
        .eq('business_id', businessId)
        .in('id', Array.from(staffIds))
        .returns<StaffProfileRow[]>();
      for (const row of data ?? []) {
        if (row.display_name) names.set(`staff:${row.id}`, row.display_name);
      }
    }
    if (userIds.size > 0) {
      const { data } = await this.admin
        .schema('core')
        .from('user_profiles')
        .select('id,full_name,display_name')
        .in('id', Array.from(userIds))
        .returns<Array<{ id: string; full_name: string | null; display_name: string | null }>>();
      for (const row of data ?? []) {
        const name = row.display_name?.trim() || row.full_name?.trim();
        if (name) names.set(`user:${row.id}`, name);
      }
    }
    return names;
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

    // Schedule the per-service rebooking nudge (Wrike #4507281502). Best-effort:
    // never blocks or rolls back completion, and is idempotent on replays.
    await this.rebookingNudges.scheduleForCompletedAppointmentSafe(completedAppointment.id, completedAt);

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
    const tenders = normalizeTenders(input);
    const tenderTotalCents = tenders.reduce((sum, tender) => sum + tender.amountCents, 0);
    if (tenderTotalCents !== billing.balanceDueCents) {
      throw new ConflictException('Payment amounts must add up to the remaining balance due');
    }

    const existingPayments = await this.fetchSalonPaymentsForVisit(visit.id);
    const alreadyPaid = existingPayments.length > 0;
    const paidAt = existingPayments[0]?.paid_at ?? new Date().toISOString();
    const confirmedByStaffProfileId = actor.staffProfileId ?? appointment.assigned_staff_profile_id ?? undefined;
    const payments = alreadyPaid ? existingPayments : await this.insertSalonPayments(
      appointment,
      visit,
      actor,
      tenders,
      input.notes,
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
    if (!alreadyPaid) {
      for (const payment of payments) {
        await this.audit.record(actor, {
          action: 'payment.recorded',
          entityType: 'payment',
          entityId: payment.id,
          locationId: appointment.location_id,
          after: {
            amountCents: payment.amount_cents,
            currencyCode: billing.currencyCode,
            paymentMethod: payment.payment_method,
          },
          metadata: {
            appointmentId: appointment.id,
            visitId: visit.id,
            clientProfileId: appointment.client_profile_id,
            source: 'in_salon_checkout',
          },
        });
      }
    }

    // Freeze the itemised bill the moment the visit is settled (0085). Also
    // runs on an alreadyPaid replay so a visit whose earlier bill write failed
    // is repaired the next time its payment is confirmed — anchored to the
    // recorded payments, never to a possibly-drifted recomputation.
    const paidCents = payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
    const bill = await this.ensureBillForVisit(
      appointment,
      visit,
      billing,
      taxSettings,
      paidAt,
      paidCents,
      actor,
    );

    const clientsById = await this.fetchClientProfiles(actor.businessId, [paidAppointment.client_profile_id]);
    const responseBilling: AppointmentPaymentConfirmationResponse['billing'] = {
      ...billing,
      balanceDueCents: Math.max(0, billing.balanceDueCents - paidCents),
    };
    const paymentRecords = payments.map(toPaymentRecord);

    return {
      appointment: toBookingDetail(paidAppointment, clientsById.get(paidAppointment.client_profile_id)),
      visit: toVisitSummary(paidVisit, paidAppointment, clientsById.get(paidAppointment.client_profile_id)),
      checkout: {
        status: 'paid',
        readyAt: paidVisit.checkout_ready_at ?? paidVisit.completed_at ?? paidAt,
        route: `/checkout/visits/${paidVisit.id}`,
        message: 'In-salon payment confirmed. Visit is paid and settled.',
      },
      bill,
      billing: responseBilling,
      // Largest tender first for the legacy single-payment field; the full
      // list carries the split (one record per method).
      payment: paymentRecords.reduce((largest, record) =>
        record.amountCents > largest.amountCents ? record : largest,
      ),
      payments: paymentRecords,
      alreadyCompleted: true,
      alreadyPaid,
    };
  }

  /**
   * The retrievable bill for a visit: the same itemised billing breakdown the
   * till showed at checkout plus every payment taken against it. Backs the
   * /checkout/visits/:visitId page linked from the book and the CRM.
   */
  async visitBill(actor: AuthUser, visitId: string): Promise<VisitBillResponse> {
    const visit = await this.fetchVisitForActor(actor, visitId);
    if (!visit.appointment_id) throw new NotFoundException('Visit has no linked appointment');
    const appointment = await this.fetchAppointmentForActor(actor, visit.appointment_id);

    const [lineItems, taxSettings, payments] = await Promise.all([
      this.fetchVisitLineItems(visit.id),
      this.taxSettings.resolveLocationTaxSettings(appointment.business_id, appointment.location_id),
      this.fetchSalonPaymentsForVisit(visit.id),
    ]);
    const billing = buildBillingSummary(appointment, lineItems, taxSettings);
    const paidCents = payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
    const clientsById = await this.fetchClientProfiles(actor.businessId, [appointment.client_profile_id]);
    const client = clientsById.get(appointment.client_profile_id);

    // The stored bill is the immutable record; visits paid before 0085 get
    // theirs frozen lazily on first view (today's recomputation is the best
    // available snapshot for them, and it only ever happens once per visit).
    let bill = await this.fetchStoredBill(visit.id);
    if (!bill && visit.checkout_status === 'paid') {
      bill = await this.ensureBillForVisit(
        appointment,
        visit,
        billing,
        taxSettings,
        visit.paid_at ?? visit.completed_at ?? new Date().toISOString(),
        paidCents,
        actor,
      );
    }

    return {
      appointment: toBookingDetail(appointment, client),
      visit: toVisitSummary(visit, appointment, client),
      checkout: {
        status: visit.checkout_status ?? 'not_ready',
        readyAt: visit.checkout_ready_at ?? visit.completed_at ?? undefined,
        route: `/checkout/visits/${visit.id}`,
        message: visit.checkout_status === 'paid'
          ? 'Visit is paid and settled.'
          : 'Service is complete. Collect the remaining balance in salon.',
      },
      bill,
      billing: {
        ...billing,
        balanceDueCents: Math.max(0, billing.balanceDueCents - paidCents),
      },
      payments: payments.map(toPaymentRecord),
      alreadyCompleted: Boolean(visit.completed_at),
    };
  }

  /**
   * Freezes the bill for a paid visit into billing.bills (0085): the exact
   * itemised gross lines the till displayed, each split into net/tax at the
   * tax rate frozen with the bill, plus header totals that match the collected
   * figures to the penny. Idempotent per visit (the RPC hands back an existing
   * bill) and deliberately fail-soft — payment is already recorded by the time
   * this runs, so a bill-write failure logs loudly and is repaired on the next
   * read instead of failing the checkout.
   *
   * `ledgerPaidCents` is the sum of the visit's actual billing.salon_payments
   * rows — the ground truth a bill certifies. On the first-payment path it
   * always equals the recomputed balance due (the tender gate enforces it),
   * but bills written LATER (lazy repair, backfill, alreadyPaid replay) run
   * against a summary recomputed with today's prices/tax/deposit statuses,
   * which may have drifted since the money was taken. In that case the header
   * is anchored to the ledger and an explicit `adjustment` line reconciles the
   * itemisation — a bill must never certify takings that never happened.
   */
  private async ensureBillForVisit(
    appointment: AppointmentRow,
    visit: VisitRow,
    billing: AppointmentCompletionResponse['billing'],
    taxSettings: LocationTaxSettings,
    occurredAt: string,
    ledgerPaidCents: number,
    actor?: AuthUser,
  ): Promise<BillRecord | undefined> {
    try {
      // Only billable line types carry onto the bill: their gross amounts sum
      // to exactly billing.totalCents (stray/legacy types are excluded from
      // the totals, so they must not appear as lines either).
      const billableLines = billing.lineItems.filter(
        (item) => taxCategoryForLineType(item.lineType) !== null,
      );
      const lines: Array<{
        sequence_no: number;
        line_type: string;
        description: string;
        staff_profile_id: string | null;
        net_cents: number;
        tax_cents: number;
        gross_cents: number;
        tax_rate_percent: number;
        source_ref: Record<string, unknown>;
      }> = billableLines.map((item, index) => {
        const category = taxCategoryForLineType(item.lineType) as TaxableCategory;
        const rate =
          taxSettings.taxEnabled && taxAppliesToCategory(taxSettings.appliesTo, category)
            ? taxSettings.taxRatePercent
            : 0;
        // Display lines are always gross (tax-inclusive); splitting each at
        // the snapshot rate keeps net + tax == the till price per line.
        const breakdown = calculateTaxBreakdown(item.amountCents, rate, 'gross');
        return {
          sequence_no: index + 1,
          line_type: item.lineType,
          description: item.description,
          // Line-level attribution when the itemised service line carries one
          // (0110: a treatment performed by a second stylist is THEIR revenue);
          // the appointment's stylist otherwise, exactly as before.
          staff_profile_id: item.staffProfileId ?? appointment.assigned_staff_profile_id ?? null,
          net_cents: breakdown.netCents,
          tax_cents: breakdown.taxCents,
          gross_cents: item.amountCents,
          tax_rate_percent: rate,
          source_ref: {
            appointment_id: appointment.id,
            ...(item.appointmentServiceId
              ? { appointment_service_id: item.appointmentServiceId, origin: item.origin ?? 'booked' }
              : {}),
          },
        };
      });
      const depositAppliedCents = Math.min(billing.depositPaidCents, billing.totalCents);
      let grossCents = billing.totalCents;
      let balanceCollectedCents = billing.balanceDueCents;
      if (ledgerPaidCents !== billing.balanceDueCents) {
        // The recomputation no longer matches the money actually taken. Anchor
        // the header to the ledger and absorb the difference in one explicit
        // adjustment line so the stored lines still sum to the stored gross.
        balanceCollectedCents = ledgerPaidCents;
        grossCents = ledgerPaidCents + depositAppliedCents;
        const adjustmentCents = grossCents - billing.totalCents;
        if (adjustmentCents !== 0) {
          lines.push({
            sequence_no: lines.length + 1,
            line_type: 'adjustment',
            description: 'Adjustment — reconciled to payments taken',
            staff_profile_id: null,
            net_cents: adjustmentCents,
            tax_cents: 0,
            gross_cents: adjustmentCents,
            tax_rate_percent: 0,
            source_ref: {
              appointment_id: appointment.id,
              reason: 'ledger_reconciliation',
              recomputed_total_cents: billing.totalCents,
            },
          });
        }
      }
      const netCents = lines.reduce((sum, line) => sum + line.net_cents, 0);
      const taxCents = lines.reduce((sum, line) => sum + line.tax_cents, 0);

      const { data, error } = await this.admin.schema('billing').rpc('record_bill', {
        p_bill: {
          business_id: appointment.business_id,
          location_id: appointment.location_id,
          visit_id: visit.id,
          appointment_id: appointment.id,
          client_profile_id: appointment.client_profile_id,
          staff_profile_id: appointment.assigned_staff_profile_id ?? null,
          status: 'paid',
          net_cents: netCents,
          tax_cents: taxCents,
          gross_cents: grossCents,
          discount_cents: 0,
          deposit_applied_cents: depositAppliedCents,
          balance_collected_cents: balanceCollectedCents,
          currency_code: billing.currencyCode,
          tax_label: taxSettings.taxEnabled ? taxSettings.taxLabel ?? null : null,
          tax_rate_percent: taxSettings.taxEnabled ? taxSettings.taxRatePercent : 0,
          occurred_at: occurredAt,
          created_by_user_profile_id: actor?.id ?? null,
        },
        p_lines: lines,
      });
      if (error) {
        this.logger.error(`record_bill failed for visit ${visit.id}: ${error.message}`);
        return undefined;
      }
      const result = first(
        data as Array<{ id: string; bill_number: number; created: boolean }> | null,
      );
      if (!result) return undefined;
      if (result.created && actor) {
        await this.audit.record(actor, {
          action: 'bill.recorded',
          entityType: 'bill',
          entityId: result.id,
          locationId: appointment.location_id,
          after: {
            billNumber: result.bill_number,
            grossCents,
            depositAppliedCents,
            balanceCollectedCents,
          },
          metadata: {
            appointmentId: appointment.id,
            visitId: visit.id,
            clientProfileId: appointment.client_profile_id,
          },
        });
      }
      return await this.fetchStoredBill(visit.id);
    } catch (err: unknown) {
      this.logger.error(`ensureBillForVisit failed for visit ${visit.id}: ${String(err)}`);
      return undefined;
    }
  }

  private async fetchStoredBill(visitId: string): Promise<BillRecord | undefined> {
    const { data: billRow, error } = await this.admin
      .schema('billing')
      .from('bills')
      .select(BILL_COLUMNS)
      .eq('visit_id', visitId)
      .maybeSingle<BillRow>();
    if (error) {
      this.logger.error(`fetchStoredBill failed: ${error.message}`);
      return undefined;
    }
    if (!billRow) return undefined;
    const { data: lineRows, error: lineError } = await this.admin
      .schema('billing')
      .from('bill_lines')
      .select(BILL_LINE_COLUMNS)
      .eq('bill_id', billRow.id)
      .order('sequence_no', { ascending: true })
      .returns<BillLineRow[]>();
    if (lineError) {
      this.logger.error(`fetchStoredBill lines failed: ${lineError.message}`);
      return undefined;
    }
    return toBillRecord(billRow, lineRows ?? []);
  }

  /**
   * One-off backfill (scripts/backfill-bills.ts): freezes a stored bill for
   * every paid visit that predates 0085 through the same snapshot path as
   * checkout. Already-billed visits are skipped; failures are counted, logged
   * and left for the lazy per-view repair rather than aborting the run.
   */
  async backfillBills(): Promise<{ scanned: number; created: number; failed: number }> {
    // Paginate explicitly: PostgREST caps every response at the project's
    // max-rows (1000 by default), and supabase-js returns the capped page
    // WITHOUT an error — an unpaged query would silently skip every paid
    // visit past the cap while the script reports success.
    const PAGE_SIZE = 500;
    const visits: VisitRow[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.admin
        .schema('booking')
        .from('visits')
        .select(VISIT_COLUMNS)
        .eq('checkout_status', 'paid')
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
        .returns<VisitRow[]>();
      if (error) {
        throw new InternalServerErrorException(`backfillBills: unable to list paid visits: ${error.message}`);
      }
      const page = data ?? [];
      visits.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    let created = 0;
    let failed = 0;
    for (const visit of visits) {
      if (!visit.appointment_id) continue;
      const existing = await this.fetchStoredBill(visit.id);
      if (existing) continue;
      const { data: appointment, error: appointmentError } = await this.admin
        .schema('booking')
        .from('appointments')
        .select(DETAIL_COLUMNS)
        .eq('id', visit.appointment_id)
        .maybeSingle<AppointmentRow>();
      if (appointmentError || !appointment) {
        failed += 1;
        continue;
      }
      const [lineItems, taxSettings, payments] = await Promise.all([
        this.fetchVisitLineItems(visit.id),
        this.taxSettings.resolveLocationTaxSettings(appointment.business_id, appointment.location_id),
        this.fetchSalonPaymentsForVisit(visit.id),
      ]);
      const billing = buildBillingSummary(appointment, lineItems, taxSettings);
      const bill = await this.ensureBillForVisit(
        appointment,
        visit,
        billing,
        taxSettings,
        visit.paid_at ?? visit.completed_at ?? visit.created_at,
        payments.reduce((sum, payment) => sum + payment.amount_cents, 0),
      );
      if (bill) created += 1;
      else failed += 1;
    }
    return { scanned: visits.length, created, failed };
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
    // Rebook what was actually PERFORMED (0110): a toner added mid-visit comes
    // along, a booked service the client did not have does not.
    const services = performedServices(appointment);
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
      candidateOccupied: occupiedIntervalsFrom(occupancyFromServiceRows(services), selectedStart),
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
    // Owner/manager may complete any appointment they can access; the own-only
    // limit is for a pure stylist. An owner/manager who also styles is not capped
    // to their own column. See [[user-role-model]].
    if (userHasRole(actor, 'stylist') && !userHasAnyRole(actor, ['owner', 'manager'])) {
      if (!actor.staffProfileId) throw new ForbiddenException('Stylist profile could not be resolved');
      if (appointment.assigned_staff_profile_id !== actor.staffProfileId) {
        throw new ForbiddenException('Stylists can only complete appointments assigned to themselves');
      }
    }
  }

  private assertCanConfirmPayment(actor: AuthUser, appointment: AppointmentRow): void {
    this.assertCanAccessAppointment(actor, appointment);
    if (userHasRole(actor, 'stylist') && !userHasAnyRole(actor, ['owner', 'manager'])) {
      if (!actor.staffProfileId) throw new ForbiddenException('Stylist profile could not be resolved');
      if (appointment.assigned_staff_profile_id !== actor.staffProfileId) {
        throw new ForbiddenException('Stylists can only confirm payment for their own appointments');
      }
    }
  }

  private assertCanAccessVisit(actor: AuthUser, visit: VisitRow): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(visit.location_id)) {
      throw new ForbiddenException('Visit is outside your location scope');
    }
    if (userHasRole(actor, 'stylist') && actor.staffProfileId !== visit.primary_staff_profile_id) {
      throw new ForbiddenException('Stylists can only rebook their own completed visits');
    }
  }

  private assertCanAssignRebookingStaff(actor: AuthUser, staffProfileId: string, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Rebooking location is outside your scope');
    }
    // The own-only limit is for a PURE stylist. An owner or manager who also
    // styles is not capped to their own column — the same rule
    // assertCanCompleteAppointment applies. Without the second test, a manager
    // who happens to hold a stylist membership could not attribute a service to
    // a colleague, and was told "stylists can only rebook to themselves".
    if (userHasRole(actor, 'stylist') && !userHasAnyRole(actor, ['owner', 'manager'])) {
      if (actor.staffProfileId !== staffProfileId) {
        throw new ForbiddenException('Stylists can only assign services and rebookings to themselves');
      }
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
    /** The new booking's stylist-OCCUPIED windows (absolute times). Free/development
     * windows are omitted so the move may overlap another booking's free time. */
    candidateOccupied: TimeInterval[];
    /** When set (a reschedule), this appointment is excluded so it can't clash with itself. */
    excludeAppointmentId?: string;
  }): Promise<void> {
    // Nothing occupies the stylist (all-free service) → it can never clash.
    if (input.candidateOccupied.length === 0) return;

    // Pre-filter to appointments whose header span overlaps the candidate window
    // (an appointment's occupied time is always within its span, so anything that
    // could clash overlaps here); then refine on the occupied windows themselves.
    let query = this.admin
      .schema('booking')
      .from('appointments')
      .select('id,occupied_ranges')
      .eq('business_id', input.businessId)
      .eq('location_id', input.locationId)
      .eq('assigned_staff_profile_id', input.staffProfileId)
      .in('status', ACTIVE_BOOKING_STATUSES)
      .lt('scheduled_start_at', input.selectedEnd.toISOString())
      .gt('scheduled_end_at', input.selectedStart.toISOString());
    if (input.excludeAppointmentId) {
      query = query.neq('id', input.excludeAppointmentId);
    }
    const { data, error } = await query.returns<Array<{ id: string; occupied_ranges: string | null }>>();

    if (error) {
      this.logger.error(`assertStaffAvailableForRebooking failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate rebooking slot');
    }
    const busy = (data ?? []).flatMap((row) => parseMultirange(row.occupied_ranges));
    const clashes = input.candidateOccupied.some((occ) =>
      busy.some((range) => occ.start.getTime() < range.end.getTime() && occ.end.getTime() > range.start.getTime()),
    );
    if (clashes) {
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
        status: 'accepted',
        booking_channel: 'staff_app',
        scheduled_start_at: input.selectedStart.toISOString(),
        scheduled_end_at: input.selectedEnd.toISOString(),
        occupied_ranges: occupiedRangesLiteralForRows(
          arrayOf(input.appointment.appointment_services),
          input.selectedStart,
        ),
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
        segments: normalizeSegments(service.segments),
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
    // The bill is what was PERFORMED (0110): every line except the ones removed
    // after check-in. Re-run after every post-check-in change so the rolled-up
    // service line, and everything reading it (KPIs, payroll cross-check), never
    // carries a stale total.
    const services = performedServices(appointment);
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

    // Capture the per-product cost split so checkout can itemise the colour charge
    // back into one line per product. Stored as relative weights — the billable
    // (and tax-inclusive) total is distributed across them at display time, so the
    // bill always foots to the rolled-up charge regardless of the billing rule.
    const productBreakdown = await this.fetchFormulaProductBreakdown(formulas.map((formula) => formula.id));

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
        metadata: {
          source: 'appointment_completion',
          appointment_id: appointment.id,
          product_breakdown: productBreakdown.map((entry) => ({
            description: entry.description,
            cost_cents: entry.costCents,
          })),
        },
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
      .select('id,external_formula_id,actual_cost_cents,billable_charge_cents,currency_code,saved_at')
      .eq('appointment_id', appointmentId)
      .eq('status', 'saved')
      .returns<FormulaBillingRow[]>();
    if (error) {
      this.logger.error(`fetchSavedFormulasForAppointment failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load formula billing');
    }
    return data ?? [];
  }

  // The per-product cost split behind the colour charge, aggregated across every
  // saved formula on the appointment (one entry per product, sorted by cost desc).
  // A failure here degrades to an empty breakdown — checkout then falls back to a
  // single rolled-up "Product usage" line rather than failing the whole bill.
  private async fetchFormulaProductBreakdown(formulaIds: string[]): Promise<ProductBreakdownEntry[]> {
    const ids = formulaIds.filter(Boolean);
    if (ids.length === 0) return [];
    const { data, error } = await this.admin
      .schema('lab')
      .from('formula_items')
      .select('product_name,brand,shade,cost_cents')
      .in('formula_id', ids)
      .returns<FormulaItemBreakdownRow[]>();
    if (error) {
      this.logger.warn(`fetchFormulaProductBreakdown failed: ${error.message} — colour charge will not be itemised`);
      return [];
    }
    return aggregateProductCosts(data ?? []);
  }

  private async fetchVisitLineItems(visitId: string): Promise<BillingLineItem[]> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .select('line_type,description,amount_cents,currency_code,metadata')
      .eq('visit_id', visitId)
      .returns<VisitLineItemRow[]>();
    if (error) {
      this.logger.error(`fetchVisitLineItems failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load checkout line items');
    }
    return (data ?? []).map((row) => {
      const line: BillingLineItem = {
        lineType: row.line_type,
        description: row.description,
        amountCents: row.amount_cents,
        currencyCode: row.currency_code,
      };
      if (row.line_type === 'product_usage') {
        const breakdown = parseProductBreakdown(row.metadata);
        if (breakdown) line.productBreakdown = breakdown;
      }
      return line;
    });
  }

  private async fetchSalonPaymentsForVisit(visitId: string): Promise<SalonPaymentRow[]> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .select(SALON_PAYMENT_COLUMNS)
      .eq('visit_id', visitId)
      .order('amount_cents', { ascending: false })
      .returns<SalonPaymentRow[]>();
    if (error) {
      this.logger.error(`fetchSalonPaymentsForVisit failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load salon payments');
    }
    return data ?? [];
  }

  private async insertSalonPayments(
    appointment: AppointmentRow,
    visit: VisitRow,
    actor: AuthUser,
    tenders: AppointmentPaymentTender[],
    notes: string | undefined,
    currencyCode: string,
    paidAt: string,
    confirmedByStaffProfileId: string | undefined,
  ): Promise<SalonPaymentRow[]> {
    const trimmedNotes = notes?.trim();
    const rows = tenders.map((tender) => ({
      business_id: appointment.business_id,
      location_id: appointment.location_id,
      appointment_id: appointment.id,
      visit_id: visit.id,
      payment_method: tender.paymentMethod,
      amount_cents: tender.amountCents,
      currency_code: currencyCode,
      paid_at: paidAt,
      confirmed_by_user_profile_id: actor.id,
      confirmed_by_staff_profile_id: confirmedByStaffProfileId ?? null,
      notes: trimmedNotes || null,
      metadata: { source: 'in_salon_checkout' },
    }));
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .insert(rows)
      .select(SALON_PAYMENT_COLUMNS)
      .returns<SalonPaymentRow[]>();
    if (error || !data?.length) {
      // A concurrent confirmation already settled this visit — the per-method
      // unique key collides the duplicate insert; replay the recorded tenders.
      const replayed = await this.fetchSalonPaymentsForVisit(visit.id);
      if (replayed.length > 0) return replayed;
      this.logger.error(`insertSalonPayments failed: ${error?.message ?? 'no rows'}`);
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

  private resolveLocationForActor(actor: AuthUser, locationId?: string): string | undefined {
    if (!locationId) return undefined;
    if (userHasRole(actor, 'owner') || actor.allowedLocationIds.includes(locationId)) return locationId;
    throw new ForbiddenException('Location is outside the signed-in user scope');
  }

  private assertCanAccessAppointment(actor: AuthUser, appointment: AppointmentRow): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(appointment.location_id)) {
      throw new ForbiddenException('Booking is outside your location scope');
    }
    if (userHasRole(actor, 'manager')) return;
    if (userHasRole(actor, 'stylist') && appointment.assigned_staff_profile_id === actor.staffProfileId) return;
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

// Half-open [start, end) window for the Lab formula-history feed. Mirrors the
// lab-analytics window math so the appointment list and the summary cards agree:
// weeks start Monday, months run from the 1st. A valid explicit from/to pair wins.
function labAppointmentRange(
  range: SheerLabAnalyticsRange,
  from?: string,
  to?: string,
): { rangeStart: string; rangeEnd: string } {
  const custom = resolveCustomDateWindow(from, to);
  if (custom) return custom;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (range === 'week') {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  }
  if (range === 'month') {
    start.setDate(1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + (range === 'week' ? 7 : range === 'month' ? daysInMonth(start) : 1));
  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

function resolveCustomDateWindow(
  from: string | undefined,
  to: string | undefined,
): { rangeStart: string; rangeEnd: string } | null {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
  return { rangeStart: start.toISOString(), rangeEnd: end.toISOString() };
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
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

// True when "now" is at or before the cancellation cut-off (windowHours before the
// scheduled start) — i.e. the customer is still early enough to cancel-with-refund
// or rebook.
function isOutsideCancellationWindow(scheduledStartAt: string, windowHours: number): boolean {
  const cutoff = new Date(scheduledStartAt).getTime() - windowHours * 3_600_000;
  return Date.now() <= cutoff;
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
    segments: arrayOf(row.service_segments)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((segment) => ({
        name: segment.name,
        durationMinutes: segment.duration_minutes,
        isStylistFree: segment.is_stylist_free ?? false,
      })),
  };
}

/** Normalises a per-service segment jsonb snapshot for output/occupancy. */
function normalizeSegments(segments: BookingSegmentSummary[] | null | undefined): BookingSegmentSummary[] {
  return (segments ?? []).map((segment) => ({
    name: segment.name,
    durationMinutes: segment.durationMinutes,
    isStylistFree: Boolean(segment.isStylistFree),
  }));
}

/** Orders appointment service rows by their booking sequence. */
function sortServiceRows(rows: AppointmentServiceRow[]): AppointmentServiceRow[] {
  return rows.slice().sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0));
}

// The most a resize may grow an appointment to — mirrors the DTO bound on
// `durationMinutes`, so pushing one service can't make an unbounded booking.
const MAX_RESIZED_TOTAL_MINUTES = 720;

type ResizeTarget =
  | { kind: 'total'; durationMinutes: number }
  | { kind: 'line'; lineId: string; segmentIndex?: number; durationMinutes: number };

// Builds a resized copy of an appointment's service rows. Only ONE part changes
// length; the caller re-sequences every row's window from the start, so later
// services are pushed along and the total moves by the same amount.
//  - `total`: the delta versus the current total lands on the LAST stylist-OCCUPIED
//    segment (or the whole line when it has no segments), floored so nothing
//    collapses to zero. Free "development" segments keep their length.
//  - `line`: the named booked line (or its named occupied segment) is set to the
//    requested length. Development segments can't be targeted.
// Returns null for a no-op or when there is nothing to resize, so the caller falls
// back to a plain move.
function buildResizedServiceRows(
  currentServices: AppointmentServiceRow[],
  target: ResizeTarget,
): { rows: AppointmentServiceRow[] } | null {
  const rows = sortServiceRows(currentServices);
  if (rows.length === 0) return null;
  const MIN_UNIT = 5;
  const currentTotal = rows.reduce((sum, row) => sum + Number(row.duration_minutes ?? 0), 0);
  const resized: AppointmentServiceRow[] = rows.map((row) => ({ ...row }));

  if (target.kind === 'line') {
    const row = resized.find((candidate) => candidate.id === target.lineId);
    if (!row) throw new BadRequestException('That service is not booked on this appointment');
    const requested = Math.max(MIN_UNIT, Math.round(target.durationMinutes));
    const segments = normalizeSegments(row.segments);
    if (segments.length === 0) {
      if (target.segmentIndex != null) throw new BadRequestException('That service has no segments to resize');
      row.duration_minutes = requested;
    } else {
      const segment = target.segmentIndex == null ? undefined : segments[target.segmentIndex];
      if (!segment) throw new BadRequestException('Choose which part of the service to resize');
      if (segment.isStylistFree) throw new BadRequestException('Development time cannot be resized');
      const nextSegments = segments.map((entry, index) =>
        index === target.segmentIndex ? { ...entry, durationMinutes: requested } : entry,
      );
      row.segments = nextSegments;
      row.duration_minutes = nextSegments.reduce((sum, entry) => sum + entry.durationMinutes, 0);
    }
    const nextTotal = resized.reduce((sum, entry) => sum + Number(entry.duration_minutes ?? 0), 0);
    if (nextTotal === currentTotal) return null;
    if (nextTotal > currentTotal && nextTotal > MAX_RESIZED_TOTAL_MINUTES) {
      throw new BadRequestException(`An appointment can't be longer than ${MAX_RESIZED_TOTAL_MINUTES} minutes`);
    }
    return { rows: resized };
  }

  const requested = Math.max(MIN_UNIT, Math.round(target.durationMinutes));
  if (currentTotal <= 0) return null;
  const delta = requested - currentTotal;
  if (delta === 0) return null;

  // Apply the delta to the last stylist-OCCUPIED time, scanning rows from the end:
  // a segment-less line is wholly occupied; otherwise its last non-free segment.
  // This keeps stylist-free "development" time fixed so a drag only changes working
  // time — even when the final line is a standalone free/processing service.
  for (let rowIndex = resized.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = resized[rowIndex];
    const segments = normalizeSegments(row.segments);
    if (segments.length === 0) {
      row.duration_minutes = Math.max(MIN_UNIT, Number(row.duration_minutes ?? 0) + delta);
      return { rows: resized };
    }
    let targetIndex = -1;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (!segments[i].isStylistFree) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex !== -1) {
      const nextSegments = segments.map((segment, index) =>
        index === targetIndex
          ? { ...segment, durationMinutes: Math.max(MIN_UNIT, segment.durationMinutes + delta) }
          : segment,
      );
      row.segments = nextSegments;
      row.duration_minutes = nextSegments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
      return { rows: resized };
    }
    // This line is entirely stylist-free — keep looking at earlier lines.
  }

  // The whole appointment is stylist-free — nothing to resize; fall back to a move.
  return null;
}

/** Occupancy inputs (duration + segments) from resolved catalogue services. */
function occupancyFromResolved(services: ResolvedCatalogService[]): OccupancyService[] {
  return services.map((service) => ({
    durationMinutes: service.durationMinutes,
    segments: service.segments,
  }));
}

/** Occupancy inputs from booked service rows (ordered by sequence). */
function occupancyFromServiceRows(rows: AppointmentServiceRow[]): OccupancyService[] {
  return sortServiceRows(rows).map((row) => ({
    durationMinutes: Number(row.duration_minutes ?? 0),
    segments: normalizeSegments(row.segments),
  }));
}

/** The occupied-windows tstzmultirange literal for a set of services starting at `start`. */
function occupiedRangesLiteralForRows(rows: AppointmentServiceRow[], start: Date): string {
  return toMultirangeLiteral(occupiedIntervalsFrom(occupancyFromServiceRows(rows), start));
}

function occupiedRangesLiteralForResolved(services: ResolvedCatalogService[], start: Date): string {
  return toMultirangeLiteral(occupiedIntervalsFrom(occupancyFromResolved(services), start));
}

/** Per-service breakdown with each service's window + segments for the calendar tile split. */
function toServiceLines(row: AppointmentRow): StaffBookingServiceLine[] {
  // The calendar sub-bands describe the DIARY: only booked lines have a window.
  const rows = sortServiceRows(scheduledServices(row));
  let cursorMs = new Date(row.scheduled_start_at).getTime();
  return rows.map((service) => {
    const durationMinutes = Number(service.duration_minutes ?? 0);
    const startMs = service.scheduled_start_at ? new Date(service.scheduled_start_at).getTime() : cursorMs;
    const endMs = service.scheduled_end_at
      ? new Date(service.scheduled_end_at).getTime()
      : startMs + durationMinutes * 60_000;
    cursorMs = endMs;
    return {
      id: service.id ?? undefined,
      serviceId: service.service_id ?? undefined,
      name: service.service_name_snapshot,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      durationMinutes,
      segments: normalizeSegments(service.segments),
    };
  });
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
  // What the book, the till and QLAB call "the services" is what is PERFORMED
  // (0110). Removed lines stay on `serviceLines` with their provenance.
  const services = performedServices(row);
  const deposits = arrayOf(row.deposits);
  const depositRequiredAmount = services.reduce(
    (sum, service) => sum + Number(service.deposit_required_amount ?? 0),
    0,
  );
  // The scheduled duration is the diary window, which post-check-in changes
  // never move; the booked lines still sum to it for older rows.
  const durationMinutes =
    minutesBetween(row.scheduled_start_at, row.scheduled_end_at) ||
    scheduledServices(row).reduce((sum, service) => sum + Number(service.duration_minutes ?? 0), 0);

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
    services: toServiceLines(row),
    serviceLines: toServiceLineSummaries(row),
    durationMinutes,
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

// Normalizes either confirm-payment request shape into validated tenders: the
// legacy single paymentMethod/amountCents pair or the split `payments` array.
// One tender per method with whole non-negative amounts — the sum-vs-balance
// check happens at the call site where the bill is known.
function normalizeTenders(input: AppointmentPaymentConfirmationRequest): AppointmentPaymentTender[] {
  const tenders: AppointmentPaymentTender[] = input.payments?.length
    ? input.payments.map((tender) => ({ paymentMethod: tender.paymentMethod, amountCents: tender.amountCents }))
    : input.paymentMethod !== undefined && input.amountCents !== undefined
      ? [{ paymentMethod: input.paymentMethod, amountCents: input.amountCents }]
      : [];
  if (tenders.length === 0) {
    throw new ConflictException('At least one payment is required');
  }
  const seenMethods = new Set<string>();
  for (const tender of tenders) {
    if (tender.paymentMethod !== 'cash' && tender.paymentMethod !== 'card_reader') {
      throw new ConflictException('Payment method must be cash or card reader');
    }
    if (!Number.isInteger(tender.amountCents) || tender.amountCents < 0) {
      throw new ConflictException('Payment amounts must be whole non-negative amounts');
    }
    if (seenMethods.has(tender.paymentMethod)) {
      throw new ConflictException('Each payment method can appear at most once per checkout');
    }
    seenMethods.add(tender.paymentMethod);
  }
  return tenders;
}

function toBillRecord(row: BillRow, lines: BillLineRow[]): BillRecord {
  return {
    id: row.id,
    billNumber: Number(row.bill_number),
    businessId: row.business_id,
    locationId: row.location_id,
    visitId: row.visit_id,
    appointmentId: row.appointment_id ?? undefined,
    clientProfileId: row.client_profile_id ?? undefined,
    staffProfileId: row.staff_profile_id ?? undefined,
    status: row.status,
    netCents: row.net_cents,
    taxCents: row.tax_cents,
    grossCents: row.gross_cents,
    discountCents: row.discount_cents,
    depositAppliedCents: row.deposit_applied_cents,
    balanceCollectedCents: row.balance_collected_cents,
    currencyCode: row.currency_code,
    taxLabel: row.tax_label ?? undefined,
    taxRatePercent: Number(row.tax_rate_percent),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    lines: lines.map((line) => ({
      id: line.id,
      sequenceNo: line.sequence_no,
      lineType: line.line_type,
      description: line.description,
      staffProfileId: line.staff_profile_id ?? undefined,
      netCents: line.net_cents,
      taxCents: line.tax_cents,
      grossCents: line.gross_cents,
      taxRatePercent: Number(line.tax_rate_percent),
    })),
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
  lineItems: BillingLineItem[],
): BillingLineItem[] {
  const services = performedServices(appointment);
  const serviceLines = lineItems.filter((item) => item.lineType === 'service');
  if (services.length === 0 || serviceLines.length === 0) return lineItems;

  const currencyCode = serviceLines[0].currencyCode;
  const perServiceLines: BillingLineItem[] = services.map((service) => ({
    lineType: 'service',
    description: service.service_name_snapshot || 'Service',
    amountCents: toCents(service.price_amount),
    currencyCode,
    appointmentServiceId: service.id,
    origin: lineOrigin(service),
    staffProfileId: service.assigned_staff_profile_id ?? appointment.assigned_staff_profile_id ?? undefined,
  }));

  const persistedTotal = serviceLines.reduce((sum, item) => sum + item.amountCents, 0);
  const perServiceTotal = perServiceLines.reduce((sum, item) => sum + item.amountCents, 0);
  if (perServiceTotal !== persistedTotal) return lineItems;

  const nonServiceLines = lineItems.filter((item) => item.lineType !== 'service');
  return [...perServiceLines, ...nonServiceLines];
}

// The colour charge persists as a single rolled-up product_usage line (the table
// is uniquely keyed by visit_id + line_type), but checkout itemises each product
// used. Expand that one (tax-inclusive) line into per-product display lines using
// the cost split captured at completion (metadata.product_breakdown), distributing
// the line's amount in proportion to each product's raw cost. The largest line
// absorbs the rounding remainder, so the per-product lines always sum to exactly
// the colour total the till collects. With no breakdown (legacy/empty visits) the
// single rolled-up line is kept untouched, so the bill always foots either way.
function expandProductUsageLineItems(lineItems: BillingLineItem[]): AppointmentCompletionLineItem[] {
  const productLines = lineItems.filter((item) => item.lineType === 'product_usage');
  const breakdown = productLines.flatMap((line) => line.productBreakdown ?? []);
  const grossTotal = productLines.reduce((sum, item) => sum + item.amountCents, 0);
  const totalCost = breakdown.reduce((sum, entry) => sum + entry.costCents, 0);
  if (productLines.length === 0 || breakdown.length === 0 || grossTotal <= 0 || totalCost <= 0) {
    return stripBreakdown(lineItems);
  }

  const currencyCode = productLines[0].currencyCode;
  const shares = breakdown.map((entry) => Math.round((grossTotal * entry.costCents) / totalCost));
  // breakdown is sorted by cost desc, so the largest line comfortably absorbs the
  // few-pennies rounding remainder without ever going negative.
  shares[0] += grossTotal - shares.reduce((sum, value) => sum + value, 0);

  const perProductLines: AppointmentCompletionLineItem[] = breakdown.map((entry, index) => ({
    lineType: 'product_usage',
    description: entry.description,
    amountCents: shares[index],
    currencyCode,
  }));
  const otherLines = stripBreakdown(lineItems.filter((item) => item.lineType !== 'product_usage'));
  return [...otherLines, ...perProductLines];
}

// Drop the internal productBreakdown so only the public line-item shape leaves the
// billing summary.
function stripBreakdown(items: BillingLineItem[]): AppointmentCompletionLineItem[] {
  return items.map(
    ({ lineType, description, amountCents, currencyCode, appointmentServiceId, origin, staffProfileId }) => ({
      lineType,
      description,
      amountCents,
      currencyCode,
      ...(appointmentServiceId ? { appointmentServiceId } : {}),
      ...(origin ? { origin } : {}),
      ...(staffProfileId ? { staffProfileId } : {}),
    }),
  );
}

// Aggregate raw formula_items costs into one entry per product, summed across every
// formula on the visit and sorted by cost desc. Zero/invalid-cost rows are dropped
// so they never surface as £0.00 colour lines.
function aggregateProductCosts(rows: FormulaItemBreakdownRow[]): ProductBreakdownEntry[] {
  const byProduct = new Map<string, number>();
  for (const row of rows) {
    const costCents = Number(row.cost_cents ?? 0);
    if (!Number.isFinite(costCents) || costCents <= 0) continue;
    const description = productDisplayName(row);
    byProduct.set(description, (byProduct.get(description) ?? 0) + costCents);
  }
  return Array.from(byProduct, ([description, costCents]) => ({ description, costCents })).sort(
    (a, b) => b.costCents - a.costCents,
  );
}

// A readable label for a colour product line: "Brand Product · Shade", falling back
// gracefully when brand or shade is absent.
function productDisplayName(row: FormulaItemBreakdownRow): string {
  const name = [row.brand?.trim(), row.product_name?.trim()].filter(Boolean).join(' ').trim() || 'Colour product';
  const shade = row.shade?.trim();
  return shade ? `${name} · ${shade}` : name;
}

// Read the per-product colour breakdown persisted on a product_usage line's
// metadata. Defensive: anything that isn't a well-formed { description, cost_cents }
// array is treated as absent so the colour charge falls back to its single line.
function parseProductBreakdown(metadata: unknown): ProductBreakdownEntry[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>).product_breakdown;
  if (!Array.isArray(raw)) return undefined;
  const entries: ProductBreakdownEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const costCents = Number(record.cost_cents ?? 0);
    if (!description || !Number.isFinite(costCents) || costCents <= 0) continue;
    entries.push({ description, costCents });
  }
  return entries.length > 0 ? entries : undefined;
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
  lineItems: BillingLineItem[],
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
    // Totals above are computed from the rolled-up gross lines and are unchanged;
    // only the displayed colour charge is itemised per product (sums back to
    // productUsageTotalCents exactly), so every figure the till collects is
    // identical whether or not the colour breakdown is present.
    lineItems: expandProductUsageLineItems(grossLineItems),
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
    .filter((service) => service.status !== 'cancelled')
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

/** Lines that count: everything not removed after check-in (0110). */
function performedServices(row: Pick<AppointmentRow, 'appointment_services'>): AppointmentServiceRow[] {
  return arrayOf(row.appointment_services).filter((service) => service.status !== 'cancelled');
}

/**
 * Lines that own a diary window: the booked ones, whatever happened to them
 * later. A removed booked line still occupies the time it was booked for.
 */
function scheduledServices(row: Pick<AppointmentRow, 'appointment_services'>): AppointmentServiceRow[] {
  return arrayOf(row.appointment_services).filter((service) => lineOrigin(service) === 'booked');
}

function lineOrigin(service: AppointmentServiceRow): AppointmentServiceOrigin {
  return service.origin ?? 'booked';
}

function toServiceLineSummaries(row: AppointmentRow): AppointmentServiceLineSummary[] {
  return sortServiceRows(arrayOf(row.appointment_services))
    .filter((service): service is AppointmentServiceRow & { id: string } => Boolean(service.id))
    .map((service) => ({
      id: service.id,
      serviceId: service.service_id ?? undefined,
      name: service.service_name_snapshot,
      sequenceNo: Number(service.sequence_no ?? 0),
      priceAmount: Number(service.price_amount ?? 0),
      durationMinutes: Number(service.duration_minutes ?? 0),
      status: service.status ?? 'scheduled',
      performed: service.status !== 'cancelled',
      origin: lineOrigin(service),
      assignedStaffProfileId: service.assigned_staff_profile_id ?? undefined,
      addedAt: service.added_at ?? undefined,
      addedByUserProfileId: service.added_by_user_profile_id ?? undefined,
      removedAt: service.removed_at ?? undefined,
      removedByUserProfileId: service.removed_by_user_profile_id ?? undefined,
      removalReason: service.removal_reason ?? undefined,
      replacesAppointmentServiceId: service.replaces_appointment_service_id ?? undefined,
    }));
}

/**
 * T0 (0110). `null` — not `[]` — when the appointment predates the snapshot, so
 * the caller can tell "originally booked nothing" (impossible) from "we do not
 * know what was originally booked" (every pre-0110 appointment).
 */
function toOriginalBookedServices(
  snapshot: OriginalServiceSnapshotRow[] | null | undefined,
): OriginalBookedService[] | null {
  if (!Array.isArray(snapshot)) return null;
  return snapshot
    .map((entry) => ({
      serviceId: entry.serviceId ?? undefined,
      serviceName: entry.serviceName ?? 'Service',
      priceAmount: entry.priceAmount == null ? undefined : Number(entry.priceAmount),
      durationMinutes: entry.durationMinutes == null ? undefined : Number(entry.durationMinutes),
      staffProfileId: entry.staffProfileId ?? undefined,
      sequenceNo: entry.sequenceNo == null ? undefined : Number(entry.sequenceNo),
    }))
    .sort((a, b) => (a.sequenceNo ?? 0) - (b.sequenceNo ?? 0));
}

function toServiceChange(
  row: AppointmentServiceChangeRow,
  names: Map<string, string>,
): AppointmentServiceChange {
  const snapshot = (value: Record<string, unknown> | null): AppointmentServiceChangeSnapshot | undefined => {
    if (!value) return undefined;
    const staffProfileId = typeof value.staffProfileId === 'string' ? value.staffProfileId : undefined;
    return {
      lineId: typeof value.lineId === 'string' ? value.lineId : undefined,
      serviceId: typeof value.serviceId === 'string' ? value.serviceId : undefined,
      serviceName: typeof value.serviceName === 'string' ? value.serviceName : undefined,
      priceAmount: value.priceAmount == null ? undefined : Number(value.priceAmount),
      staffProfileId,
      staffDisplayName: staffProfileId ? names.get(`staff:${staffProfileId}`) : undefined,
      status: (value.status as AppointmentServiceChangeSnapshot['status']) ?? undefined,
      origin: (value.origin as AppointmentServiceOrigin | undefined) ?? undefined,
    };
  };
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    appointmentServiceId: row.appointment_service_id ?? undefined,
    replacedAppointmentServiceId: row.replaced_appointment_service_id ?? undefined,
    action: row.action,
    appointmentStatusAtChange: row.appointment_status_at_change,
    actorUserProfileId: row.actor_user_profile_id ?? undefined,
    actorStaffProfileId: row.actor_staff_profile_id ?? undefined,
    actorDisplayName:
      (row.actor_staff_profile_id ? names.get(`staff:${row.actor_staff_profile_id}`) : undefined) ??
      (row.actor_user_profile_id ? names.get(`user:${row.actor_user_profile_id}`) : undefined),
    before: snapshot(row.before),
    after: snapshot(row.after),
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Map the amend function's stable error prefixes onto HTTP semantics. Anything
 * unrecognised is a genuine failure and surfaces as a 500.
 */
function amendErrorToHttp(message: string): Error {
  if (message.includes('APPOINTMENT_NOT_FOUND')) return new NotFoundException('Booking not found');
  if (message.includes('LINE_NOT_FOUND')) return new NotFoundException('That service is not on this visit');
  if (message.includes('APPOINTMENT_NOT_AMENDABLE:paid') || message.includes('APPOINTMENT_PAID_IMMUTABLE')) {
    return new ConflictException(
      'This appointment is paid, so its services are final. Correct the bill with a refund or adjustment instead.',
    );
  }
  if (message.includes('APPOINTMENT_NOT_AMENDABLE:')) {
    const status = message.split('APPOINTMENT_NOT_AMENDABLE:')[1]?.split(/[^a-z_]/)[0] ?? 'this status';
    return new ConflictException(`Services cannot be changed while the appointment is ${status}`);
  }
  if (message.includes('SERVICE_NOT_AVAILABLE')) {
    return new ConflictException('That service is not available at this location');
  }
  if (message.includes('LAST_PERFORMED_SERVICE')) {
    return new ConflictException('A visit must keep at least one service — replace it instead of removing it');
  }
  if (message.includes('STAFF_NOT_IN_BUSINESS')) {
    return new ConflictException('That stylist is not part of this business');
  }
  if (message.includes('INVALID_ACTION')) return new ConflictException('Invalid service change');
  return new InternalServerErrorException('Unable to change the services on this appointment');
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
