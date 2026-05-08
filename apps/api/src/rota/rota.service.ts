import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AbsenceMutationResponse,
  AbsenceType,
  ApproveLeaveRequestRequest,
  AuthUser,
  BreakMutationResponse,
  CreateAbsenceRequest,
  CreateBreakRequest,
  CreateMyLeaveRequest,
  CreateNewWeekRequest,
  CreateNewWeekResponse,
  CreateShiftRequest,
  LeaveRequestMutationResponse,
  LeaveRequestStatus,
  ListLeaveRequestsResponse,
  MyLeaveRequestsResponse,
  PreviewNewWeekRequest,
  PreviewNewWeekResponse,
  RejectLeaveRequestRequest,
  RotaAbsenceIndicator,
  RotaBreak,
  RotaLeaveRequest,
  RotaShift,
  RotaStaffSummary,
  SaveWeeklyRotaRequest,
  SaveWeeklyRotaResponse,
  ShiftMutationResponse,
  ShiftStatus,
  StylistMyWeekResponse,
  UpdateBreakRequest,
  UpdateShiftRequest,
  WeeklyRotaResponse,
} from '@sheer/domain';

// ---------------------------------------------------------------------------
// Row types — narrow projections of the rota schema rows the service uses.
// We never expose `*Row` to callers; everything is mapped into the domain
// shape on its way out so the API contract is decoupled from the DB.
// ---------------------------------------------------------------------------

interface ShiftRow {
  id: string;
  business_id: string;
  location_id: string;
  staff_profile_id: string;
  status: ShiftStatus;
  scheduled_start_at: string;
  scheduled_end_at: string;
  published_at: string | null;
  notes: string | null;
}

interface BreakRow {
  id: string;
  business_id: string;
  location_id: string;
  shift_id: string;
  started_at: string;
  ended_at: string;
  is_paid: boolean;
  notes: string | null;
}

interface LeaveRequestRow {
  id: string;
  business_id: string;
  location_id: string;
  staff_profile_id: string;
  start_date: string;
  end_date: string;
  status: LeaveRequestStatus;
  reason: string | null;
  reviewed_at: string | null;
  reviewed_by_user_profile_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface AbsenceRow {
  id: string;
  business_id: string;
  location_id: string;
  staff_profile_id: string;
  absence_type: AbsenceType;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
}

interface StaffProfileRow {
  id: string;
  business_id: string;
  user_profile_id: string;
  primary_location_id: string;
  display_name: string;
  is_bookable: boolean;
  color_hex: string | null;
  employment_status: 'active' | 'on_leave' | 'notice' | 'terminated';
}

interface UserProfileRow {
  id: string;
  email: string;
  full_name: string;
}

interface LocationSettingsRow {
  location_id: string;
  holiday_notice_days: number;
}

interface BreakDefaultsRow {
  staff_profile_id: string;
  break_minutes: number;
  is_paid: boolean;
  notes: string | null;
}

interface WeekCreationResultRow {
  shifts_created: number;
  breaks_created: number;
}

type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'override'
  | 'mark_absence'
  | 'past_edit';

type AuditEntity = 'shift' | 'shift_break' | 'leave_request' | 'absence_event';

const DEFAULT_HOLIDAY_NOTICE_DAYS = 30;
const DEFAULT_BREAK_MINUTES = 30;

@Injectable()
export class RotaService {
  private readonly logger = new Logger(RotaService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Returns the weekly rota for a single location.
   *
   * Reusable across owner / manager / stylist:
   * - manager → restricted to actor.allowedLocationIds
   * - owner   → restricted to actor.businessId
   * - stylist → would project to self only (not wired in this phase)
   */
  async getWeeklyRota(
    actor: AuthUser,
    rawLocationId: string | undefined,
    weekStartIso: string,
  ): Promise<WeeklyRotaResponse> {
    const locationId = this.resolveLocationForActor(actor, rawLocationId);
    this.assertLocationScope(actor, locationId);

    const weekStart = parseIsoDate(weekStartIso);
    if (!weekStart) {
      throw new BadRequestException('weekStart must be a valid ISO date (YYYY-MM-DD)');
    }
    // Snap to Monday so callers passing any day in the week still produce a
    // deterministic [Mon, next-Mon) range. Computed in UTC at this stage —
    // good enough for the MVP since the only supported timezone family is
    // Europe/London. A future phase can reproject into the location's TZ.
    const startOfWeek = mondayUtc(weekStart);
    const endOfWeek = addDays(startOfWeek, 7);

    const startIso = startOfWeek.toISOString();
    const endIso = endOfWeek.toISOString();

    const [staff, shifts, breaks, leave, absences, holidayNoticeDays] = await Promise.all([
      this.fetchLocationStaff(actor.businessId, locationId),
      this.fetchShiftsInRange(actor.businessId, locationId, startIso, endIso),
      // Break query is keyed on the same range, but we filter by shift_id
      // afterwards to keep it tight in case `started_at` falls outside.
      this.fetchBreaksForRange(actor.businessId, locationId, startIso, endIso),
      this.fetchLeaveOverlapping(
        actor.businessId,
        locationId,
        toIsoDate(startOfWeek),
        toIsoDate(endOfWeek),
      ),
      this.fetchAbsencesOverlapping(actor.businessId, locationId, startIso, endIso),
      this.fetchHolidayNoticeDays(locationId),
    ]);

    const breaksByShift = new Map<string, BreakRow[]>();
    for (const row of breaks) {
      const list = breaksByShift.get(row.shift_id);
      if (list) list.push(row);
      else breaksByShift.set(row.shift_id, [row]);
    }

    return {
      locationId,
      weekStart: toIsoDate(startOfWeek),
      weekEnd: toIsoDate(endOfWeek),
      staff,
      shifts: shifts.map((row) =>
        toRotaShift(row, breaksByShift.get(row.id) ?? []),
      ),
      leave: leave.map((row) => ({
        id: row.id,
        staffProfileId: row.staff_profile_id,
        status: row.status,
        startDate: row.start_date,
        endDate: row.end_date,
        reason: row.reason ?? undefined,
      })),
      absences: absences.map(toRotaAbsenceIndicator),
      holidayNoticeDays,
      scope: actor.role === 'owner' ? 'owner' : 'manager',
    };
  }

  // -------------------------------------------------------------------------
  // Shift CRUD
  // -------------------------------------------------------------------------

  async createShift(actor: AuthUser, input: CreateShiftRequest): Promise<ShiftMutationResponse> {
    this.assertManagerOrOwner(actor);
    this.assertLocationScope(actor, input.locationId);

    const start = new Date(input.scheduledStartAt);
    const end = new Date(input.scheduledEndAt);
    this.validateRange(start, end, 'shift');

    await this.assertStaffInLocation(actor.businessId, input.staffProfileId, input.locationId);

    const isPast = start.getTime() < Date.now();
    if (isPast) this.requireReason(input.pastEditReason, 'creating a shift in the past');

    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId,
        staff_profile_id: input.staffProfileId,
        scheduled_start_at: start.toISOString(),
        scheduled_end_at: end.toISOString(),
        status: input.status ?? 'published',
        notes: input.notes?.trim() || null,
      })
      .select(SHIFT_COLUMNS)
      .single<ShiftRow>();

    if (error || !data) {
      this.translateConstraintError(error?.message ?? '', 'shift');
      this.logger.error(`createShift failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create shift');
    }

    await this.recordAudit(actor, {
      entity: 'shift',
      entityId: data.id,
      locationId: data.location_id,
      action: isPast ? 'past_edit' : 'create',
      reason: isPast ? input.pastEditReason : undefined,
      metadata: {
        scheduled_start_at: data.scheduled_start_at,
        scheduled_end_at: data.scheduled_end_at,
        status: data.status,
      },
    });

    return { shift: toRotaShift(data, []) };
  }

  async updateShift(
    actor: AuthUser,
    shiftId: string,
    input: UpdateShiftRequest,
  ): Promise<ShiftMutationResponse> {
    this.assertManagerOrOwner(actor);
    const existing = await this.fetchShift(actor.businessId, shiftId);
    this.assertLocationScope(actor, existing.location_id);

    const start = input.scheduledStartAt ? new Date(input.scheduledStartAt) : new Date(existing.scheduled_start_at);
    const end = input.scheduledEndAt ? new Date(input.scheduledEndAt) : new Date(existing.scheduled_end_at);
    this.validateRange(start, end, 'shift');

    const wasPast = new Date(existing.scheduled_start_at).getTime() < Date.now();
    const willBePast = start.getTime() < Date.now();
    if (wasPast || willBePast) this.requireReason(input.pastEditReason, 'editing a past shift');

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.scheduledStartAt !== undefined) patch.scheduled_start_at = start.toISOString();
    if (input.scheduledEndAt !== undefined) patch.scheduled_end_at = end.toISOString();
    if (input.status !== undefined) patch.status = input.status;
    if (input.notes !== undefined) patch.notes = input.notes === null ? null : input.notes.trim() || null;

    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .update(patch)
      .eq('id', shiftId)
      .eq('business_id', actor.businessId)
      .select(SHIFT_COLUMNS)
      .single<ShiftRow>();

    if (error || !data) {
      this.translateConstraintError(error?.message ?? '', 'shift');
      this.logger.error(`updateShift failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to update shift');
    }

    await this.recordAudit(actor, {
      entity: 'shift',
      entityId: data.id,
      locationId: data.location_id,
      action: wasPast || willBePast ? 'past_edit' : 'update',
      reason: wasPast || willBePast ? input.pastEditReason : undefined,
      metadata: {
        previous: {
          scheduled_start_at: existing.scheduled_start_at,
          scheduled_end_at: existing.scheduled_end_at,
          status: existing.status,
        },
        next: {
          scheduled_start_at: data.scheduled_start_at,
          scheduled_end_at: data.scheduled_end_at,
          status: data.status,
        },
      },
    });

    const breaks = await this.fetchBreaksForShift(shiftId);
    return { shift: toRotaShift(data, breaks) };
  }

  async deleteShift(
    actor: AuthUser,
    shiftId: string,
    pastEditReason?: string,
  ): Promise<{ success: true }> {
    this.assertManagerOrOwner(actor);
    const existing = await this.fetchShift(actor.businessId, shiftId);
    this.assertLocationScope(actor, existing.location_id);

    const wasPast = new Date(existing.scheduled_start_at).getTime() < Date.now();
    if (wasPast) this.requireReason(pastEditReason, 'deleting a past shift');

    const { error } = await this.admin
      .schema('rota')
      .from('shifts')
      .delete()
      .eq('id', shiftId)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`deleteShift failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete shift');
    }

    await this.recordAudit(actor, {
      entity: 'shift',
      entityId: shiftId,
      locationId: existing.location_id,
      action: wasPast ? 'past_edit' : 'delete',
      reason: wasPast ? pastEditReason : undefined,
      metadata: {
        scheduled_start_at: existing.scheduled_start_at,
        scheduled_end_at: existing.scheduled_end_at,
        status: existing.status,
      },
    });

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Break CRUD
  // -------------------------------------------------------------------------

  async addBreak(
    actor: AuthUser,
    shiftId: string,
    input: CreateBreakRequest,
  ): Promise<BreakMutationResponse> {
    this.assertManagerOrOwner(actor);
    const shift = await this.fetchShift(actor.businessId, shiftId);
    this.assertLocationScope(actor, shift.location_id);

    const start = new Date(input.startedAt);
    const end = new Date(input.endedAt);
    this.validateBreakWithinShift(shift, start, end, []);

    const wasPast = new Date(shift.scheduled_start_at).getTime() < Date.now();
    if (wasPast) this.requireReason(input.pastEditReason, 'adding a break to a past shift');

    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .insert({
        business_id: shift.business_id,
        location_id: shift.location_id,
        shift_id: shift.id,
        started_at: start.toISOString(),
        ended_at: end.toISOString(),
        is_paid: input.isPaid ?? false,
        notes: input.notes?.trim() || null,
      })
      .select(BREAK_COLUMNS)
      .single<BreakRow>();

    if (error || !data) {
      this.logger.error(`addBreak failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to add break');
    }

    await this.recordAudit(actor, {
      entity: 'shift_break',
      entityId: data.id,
      locationId: shift.location_id,
      action: wasPast ? 'past_edit' : 'create',
      reason: wasPast ? input.pastEditReason : undefined,
      metadata: { shift_id: shift.id, started_at: data.started_at, ended_at: data.ended_at },
    });

    const breaks = await this.fetchBreaksForShift(shiftId);
    return { shift: toRotaShift(shift, breaks), break: toRotaBreak(data) };
  }

  async updateBreak(
    actor: AuthUser,
    shiftId: string,
    breakId: string,
    input: UpdateBreakRequest,
  ): Promise<BreakMutationResponse> {
    this.assertManagerOrOwner(actor);
    const shift = await this.fetchShift(actor.businessId, shiftId);
    this.assertLocationScope(actor, shift.location_id);

    const existing = await this.fetchBreak(shift.business_id, shiftId, breakId);

    const start = input.startedAt ? new Date(input.startedAt) : new Date(existing.started_at);
    const end = input.endedAt ? new Date(input.endedAt) : new Date(existing.ended_at);

    const otherBreaks = (await this.fetchBreaksForShift(shiftId)).filter((b) => b.id !== breakId);
    this.validateBreakWithinShift(shift, start, end, otherBreaks);

    const wasPast = new Date(shift.scheduled_start_at).getTime() < Date.now();
    if (wasPast) this.requireReason(input.pastEditReason, 'editing a break on a past shift');

    const patch: Record<string, unknown> = {};
    if (input.startedAt !== undefined) patch.started_at = start.toISOString();
    if (input.endedAt !== undefined) patch.ended_at = end.toISOString();
    if (input.isPaid !== undefined) patch.is_paid = input.isPaid;
    if (input.notes !== undefined) patch.notes = input.notes === null ? null : input.notes.trim() || null;

    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .update(patch)
      .eq('id', breakId)
      .eq('shift_id', shiftId)
      .eq('business_id', shift.business_id)
      .select(BREAK_COLUMNS)
      .single<BreakRow>();

    if (error || !data) {
      this.logger.error(`updateBreak failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to update break');
    }

    await this.recordAudit(actor, {
      entity: 'shift_break',
      entityId: data.id,
      locationId: shift.location_id,
      action: wasPast ? 'past_edit' : 'update',
      reason: wasPast ? input.pastEditReason : undefined,
      metadata: {
        shift_id: shift.id,
        previous: { started_at: existing.started_at, ended_at: existing.ended_at },
        next: { started_at: data.started_at, ended_at: data.ended_at },
      },
    });

    const breaks = await this.fetchBreaksForShift(shiftId);
    return { shift: toRotaShift(shift, breaks), break: toRotaBreak(data) };
  }

  async deleteBreak(
    actor: AuthUser,
    shiftId: string,
    breakId: string,
    pastEditReason?: string,
  ): Promise<{ success: true }> {
    this.assertManagerOrOwner(actor);
    const shift = await this.fetchShift(actor.businessId, shiftId);
    this.assertLocationScope(actor, shift.location_id);
    const existing = await this.fetchBreak(shift.business_id, shiftId, breakId);

    const wasPast = new Date(shift.scheduled_start_at).getTime() < Date.now();
    if (wasPast) this.requireReason(pastEditReason, 'deleting a break on a past shift');

    const { error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .delete()
      .eq('id', breakId)
      .eq('shift_id', shiftId)
      .eq('business_id', shift.business_id);

    if (error) {
      this.logger.error(`deleteBreak failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete break');
    }

    await this.recordAudit(actor, {
      entity: 'shift_break',
      entityId: breakId,
      locationId: shift.location_id,
      action: wasPast ? 'past_edit' : 'delete',
      reason: wasPast ? pastEditReason : undefined,
      metadata: { shift_id: shift.id, started_at: existing.started_at, ended_at: existing.ended_at },
    });

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Leave requests
  // -------------------------------------------------------------------------

  async listLeaveRequests(
    actor: AuthUser,
    rawLocationId: string | undefined,
    statusFilter?: LeaveRequestStatus | 'all',
  ): Promise<ListLeaveRequestsResponse> {
    this.assertManagerOrOwner(actor);

    let locationId: string | null = null;
    if (rawLocationId) {
      this.assertLocationScope(actor, rawLocationId);
      locationId = rawLocationId;
    } else if (actor.role === 'manager') {
      locationId = this.resolveLocationForActor(actor, undefined);
    }

    let query = this.admin
      .schema('rota')
      .from('leave_requests')
      .select(LEAVE_COLUMNS)
      .eq('business_id', actor.businessId)
      .order('start_date', { ascending: true });

    if (locationId) query = query.eq('location_id', locationId);
    if (statusFilter && statusFilter !== 'all') query = query.eq('status', statusFilter);

    const { data, error } = await query.returns<LeaveRequestRow[]>();
    if (error) {
      this.logger.error(`listLeaveRequests failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load leave requests');
    }
    const rows = data ?? [];

    const staffByLocation = new Map<string, RotaStaffSummary[]>();
    for (const row of rows) {
      if (staffByLocation.has(row.location_id)) continue;
      staffByLocation.set(
        row.location_id,
        await this.fetchLocationStaff(actor.businessId, row.location_id),
      );
    }
    const staffById = new Map<string, RotaStaffSummary>();
    for (const summaries of staffByLocation.values()) {
      for (const s of summaries) staffById.set(s.staffProfileId, s);
    }

    const noticeByLocation = new Map<string, number>();
    for (const lid of staffByLocation.keys()) {
      noticeByLocation.set(lid, await this.fetchHolidayNoticeDays(lid));
    }

    const todayUtc = startOfDayUtc(new Date());
    const leaveRequests: RotaLeaveRequest[] = rows.map((row) => {
      const noticeDays = differenceInDays(parseIsoDate(row.start_date) ?? todayUtc, todayUtc);
      const locationNotice = noticeByLocation.get(row.location_id) ?? DEFAULT_HOLIDAY_NOTICE_DAYS;
      return {
        id: row.id,
        businessId: row.business_id,
        locationId: row.location_id,
        staffProfileId: row.staff_profile_id,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
        reason: row.reason ?? undefined,
        reviewedAt: row.reviewed_at ?? undefined,
        reviewedByUserProfileId: row.reviewed_by_user_profile_id ?? undefined,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        staff: staffById.get(row.staff_profile_id),
        noticeDays,
        insideNoticeWindow: noticeDays < locationNotice,
      };
    });

    // Echo holiday notice for the location that the request was scoped to.
    // When listing across many locations (owner), pick the strictest (smallest)
    // so the UI can warn correctly.
    const holidayNoticeDays = locationId
      ? noticeByLocation.get(locationId) ?? (await this.fetchHolidayNoticeDays(locationId))
      : Math.min(
          ...(Array.from(noticeByLocation.values()).length > 0
            ? Array.from(noticeByLocation.values())
            : [DEFAULT_HOLIDAY_NOTICE_DAYS]),
        );

    return {
      leaveRequests,
      holidayNoticeDays,
      scope: actor.role === 'owner' ? 'owner' : 'manager',
    };
  }

  async getMyWeek(actor: AuthUser, weekStartIso: string): Promise<StylistMyWeekResponse> {
    const { staffProfileId, locationId } = this.resolveStylistScope(actor);
    const weekStart = parseIsoDate(weekStartIso);
    if (!weekStart) {
      throw new BadRequestException('weekStart must be a valid ISO date (YYYY-MM-DD)');
    }
    const startOfWeek = mondayUtc(weekStart);
    const endOfWeek = addDays(startOfWeek, 7);
    const startIso = startOfWeek.toISOString();
    const endIso = endOfWeek.toISOString();

    const [shifts, breaks, leave, absences] = await Promise.all([
      this.fetchShiftsInRange(actor.businessId, locationId, startIso, endIso),
      this.fetchBreaksForRange(actor.businessId, locationId, startIso, endIso),
      this.fetchLeaveOverlapping(
        actor.businessId,
        locationId,
        toIsoDate(startOfWeek),
        toIsoDate(endOfWeek),
      ),
      this.fetchAbsencesOverlapping(actor.businessId, locationId, startIso, endIso),
    ]);

    const ownShifts = shifts.filter((row) => row.staff_profile_id === staffProfileId);
    const ownShiftIds = new Set(ownShifts.map((row) => row.id));
    const breaksByShift = groupBreaksByShift(
      breaks.filter((row) => ownShiftIds.has(row.shift_id)),
    );

    return {
      weekStart: toIsoDate(startOfWeek),
      weekEnd: toIsoDate(endOfWeek),
      staffProfileId,
      locationId,
      shifts: ownShifts.map((row) => toRotaShift(row, breaksByShift.get(row.id) ?? [])),
      leave: leave
        .filter((row) => row.staff_profile_id === staffProfileId && row.status === 'approved')
        .map((row) => ({
          id: row.id,
          staffProfileId: row.staff_profile_id,
          status: row.status,
          startDate: row.start_date,
          endDate: row.end_date,
          reason: row.reason ?? undefined,
        })),
      absences: absences
        .filter((row) => row.staff_profile_id === staffProfileId)
        .map(toRotaAbsenceIndicator),
    };
  }

  async listMyLeaveRequests(actor: AuthUser): Promise<MyLeaveRequestsResponse> {
    const { staffProfileId, locationId } = this.resolveStylistScope(actor);
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select(LEAVE_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('staff_profile_id', staffProfileId)
      .order('start_date', { ascending: false })
      .returns<LeaveRequestRow[]>();

    if (error) {
      this.logger.error(`listMyLeaveRequests failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load leave requests');
    }

    const holidayNoticeDays = await this.fetchHolidayNoticeDays(locationId);
    const todayUtc = startOfDayUtc(new Date());
    return {
      holidayNoticeDays,
      leaveRequests: (data ?? []).map((row) => ({
        id: row.id,
        businessId: row.business_id,
        locationId: row.location_id,
        staffProfileId: row.staff_profile_id,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
        reason: row.reason ?? undefined,
        reviewedAt: row.reviewed_at ?? undefined,
        reviewedByUserProfileId: row.reviewed_by_user_profile_id ?? undefined,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        noticeDays: differenceInDays(parseIsoDate(row.start_date) ?? todayUtc, todayUtc),
        insideNoticeWindow:
          differenceInDays(parseIsoDate(row.start_date) ?? todayUtc, todayUtc) < holidayNoticeDays,
      })),
    };
  }

  async createMyLeaveRequest(
    actor: AuthUser,
    input: CreateMyLeaveRequest,
  ): Promise<LeaveRequestMutationResponse> {
    const { staffProfileId, locationId } = this.resolveStylistScope(actor);
    const startDate = parseIsoDate(input.startDate);
    const endDate = parseIsoDate(input.endDate);
    if (!startDate || !endDate) {
      throw new BadRequestException('startDate and endDate must be valid ISO dates (YYYY-MM-DD)');
    }
    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    const noticeDays = await this.fetchHolidayNoticeDays(locationId);
    const daysUntilStart = differenceInDays(startDate, startOfDayUtc(new Date()));
    const insideNoticeWindow = daysUntilStart < noticeDays;
    const now = new Date().toISOString();

    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .insert({
        business_id: actor.businessId,
        location_id: locationId,
        staff_profile_id: staffProfileId,
        requested_by_user_profile_id: actor.id,
        start_date: toIsoDate(startDate),
        end_date: toIsoDate(endDate),
        status: 'pending',
        reason: input.reason?.trim() || null,
        metadata: {
          inside_notice_window: insideNoticeWindow,
          days_until_start: daysUntilStart,
          required_notice_days: noticeDays,
        },
      })
      .select(LEAVE_COLUMNS)
      .single<LeaveRequestRow>();

    if (error || !data) {
      this.logger.error(`createMyLeaveRequest failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create leave request');
    }

    await this.recordAudit(actor, {
      entity: 'leave_request',
      entityId: data.id,
      locationId,
      action: 'create',
      metadata: {
        source: 'stylist_self_service',
        start_date: data.start_date,
        end_date: data.end_date,
        inside_notice_window: insideNoticeWindow,
      },
    });

    return {
      leaveRequest: {
        id: data.id,
        businessId: data.business_id,
        locationId: data.location_id,
        staffProfileId: data.staff_profile_id,
        startDate: data.start_date,
        endDate: data.end_date,
        status: data.status,
        reason: data.reason ?? undefined,
        reviewedAt: data.reviewed_at ?? undefined,
        reviewedByUserProfileId: data.reviewed_by_user_profile_id ?? undefined,
        metadata: data.metadata ?? {},
        createdAt: data.created_at ?? now,
        updatedAt: data.updated_at ?? now,
        noticeDays: daysUntilStart,
        insideNoticeWindow,
      },
    };
  }

  async cancelMyLeaveRequest(
    actor: AuthUser,
    requestId: string,
  ): Promise<LeaveRequestMutationResponse> {
    const { staffProfileId, locationId } = this.resolveStylistScope(actor);
    const existing = await this.fetchLeaveRequest(actor.businessId, requestId);
    if (existing.staff_profile_id !== staffProfileId || existing.location_id !== locationId) {
      throw new ForbiddenException('Leave request is outside the signed-in stylist scope');
    }
    if (existing.status !== 'pending') {
      throw new BadRequestException(
        `Cannot cancel a leave request with status ${existing.status}`,
      );
    }

    const cancelledAt = new Date().toISOString();
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .update({
        status: 'cancelled',
        updated_at: cancelledAt,
        metadata: {
          ...(existing.metadata ?? {}),
          cancelled_at: cancelledAt,
          cancelled_by_user_profile_id: actor.id,
          cancelled_by: 'stylist_self_service',
        },
      })
      .eq('id', requestId)
      .eq('business_id', actor.businessId)
      .eq('staff_profile_id', staffProfileId)
      .eq('status', 'pending')
      .select(LEAVE_COLUMNS)
      .single<LeaveRequestRow>();

    if (error || !data) {
      this.logger.error(`cancelMyLeaveRequest failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to cancel leave request');
    }

    await this.recordAudit(actor, {
      entity: 'leave_request',
      entityId: data.id,
      locationId,
      action: 'cancel',
      metadata: {
        source: 'stylist_self_service',
        previous_status: existing.status,
      },
    });

    return { leaveRequest: await this.hydrateLeaveRequest(data) };
  }

  async approveLeaveRequest(
    actor: AuthUser,
    requestId: string,
    input: ApproveLeaveRequestRequest = {},
  ): Promise<LeaveRequestMutationResponse> {
    this.assertManagerOrOwner(actor);
    const existing = await this.fetchLeaveRequest(actor.businessId, requestId);
    this.assertLocationScope(actor, existing.location_id);

    if (existing.status !== 'pending') {
      throw new BadRequestException(
        `Cannot approve a leave request with status ${existing.status}`,
      );
    }

    const noticeDays = await this.fetchHolidayNoticeDays(existing.location_id);
    const startDate = parseIsoDate(existing.start_date);
    const todayUtc = startOfDayUtc(new Date());
    const daysUntilStart = startDate ? differenceInDays(startDate, todayUtc) : noticeDays;
    const insideThreshold = daysUntilStart < noticeDays;

    if (insideThreshold && !input.override) {
      throw new BadRequestException(
        `Leave request falls inside the ${noticeDays}-day holiday notice rule. Re-submit with override=true to approve anyway.`,
      );
    }

    const reviewedAt = new Date().toISOString();
    const metadataAfter = {
      ...(existing.metadata ?? {}),
      ...(insideThreshold && input.override
        ? {
            holiday_notice_override: {
              days_until_start: daysUntilStart,
              required_notice_days: noticeDays,
              note: input.reviewerNote ?? null,
              overridden_at: reviewedAt,
              overridden_by_user_profile_id: actor.id,
            },
          }
        : {}),
      ...(input.reviewerNote ? { reviewer_note: input.reviewerNote } : {}),
    };

    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .update({
        status: 'approved',
        reviewed_at: reviewedAt,
        reviewed_by_user_profile_id: actor.id,
        metadata: metadataAfter,
        updated_at: reviewedAt,
      })
      .eq('id', requestId)
      .eq('business_id', actor.businessId)
      .select(LEAVE_COLUMNS)
      .single<LeaveRequestRow>();

    if (error || !data) {
      this.logger.error(`approveLeaveRequest failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to approve leave request');
    }

    await this.recordAudit(actor, {
      entity: 'leave_request',
      entityId: data.id,
      locationId: data.location_id,
      action: insideThreshold && input.override ? 'override' : 'approve',
      reason: input.reviewerNote,
      metadata: {
        days_until_start: daysUntilStart,
        required_notice_days: noticeDays,
        overridden: insideThreshold && input.override,
      },
    });

    return { leaveRequest: await this.hydrateLeaveRequest(data) };
  }

  async rejectLeaveRequest(
    actor: AuthUser,
    requestId: string,
    input: RejectLeaveRequestRequest = {},
  ): Promise<LeaveRequestMutationResponse> {
    this.assertManagerOrOwner(actor);
    const existing = await this.fetchLeaveRequest(actor.businessId, requestId);
    this.assertLocationScope(actor, existing.location_id);

    if (existing.status !== 'pending') {
      throw new BadRequestException(
        `Cannot reject a leave request with status ${existing.status}`,
      );
    }

    const reviewedAt = new Date().toISOString();
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .update({
        status: 'rejected',
        reviewed_at: reviewedAt,
        reviewed_by_user_profile_id: actor.id,
        reason: input.reason ?? existing.reason ?? null,
        updated_at: reviewedAt,
      })
      .eq('id', requestId)
      .eq('business_id', actor.businessId)
      .select(LEAVE_COLUMNS)
      .single<LeaveRequestRow>();

    if (error || !data) {
      this.logger.error(`rejectLeaveRequest failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to reject leave request');
    }

    await this.recordAudit(actor, {
      entity: 'leave_request',
      entityId: data.id,
      locationId: data.location_id,
      action: 'reject',
      reason: input.reason,
      metadata: {},
    });

    return { leaveRequest: await this.hydrateLeaveRequest(data) };
  }

  // -------------------------------------------------------------------------
  // Absences
  // -------------------------------------------------------------------------

  async markAbsence(
    actor: AuthUser,
    input: CreateAbsenceRequest,
  ): Promise<AbsenceMutationResponse> {
    this.assertManagerOrOwner(actor);
    this.assertLocationScope(actor, input.locationId);
    await this.assertStaffInLocation(actor.businessId, input.staffProfileId, input.locationId);

    const start = new Date(input.startsAt);
    const end = input.endsAt ? new Date(input.endsAt) : null;
    if (Number.isNaN(start.getTime())) {
      throw new BadRequestException('startsAt must be a valid ISO timestamp');
    }
    if (end && Number.isNaN(end.getTime())) {
      throw new BadRequestException('endsAt must be a valid ISO timestamp');
    }
    if (end && end.getTime() <= start.getTime()) {
      throw new BadRequestException('Absence end must be strictly after start');
    }

    const { data, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId,
        staff_profile_id: input.staffProfileId,
        absence_type: input.absenceType,
        starts_at: start.toISOString(),
        ends_at: end?.toISOString() ?? null,
        notes: input.notes?.trim() || null,
        created_by_user_profile_id: actor.id,
      })
      .select(ABSENCE_COLUMNS)
      .single<AbsenceRow>();

    if (error || !data) {
      this.logger.error(`markAbsence failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to mark absence');
    }

    await this.recordAudit(actor, {
      entity: 'absence_event',
      entityId: data.id,
      locationId: data.location_id,
      action: 'mark_absence',
      metadata: {
        absence_type: data.absence_type,
        starts_at: data.starts_at,
        ends_at: data.ends_at,
      },
    });

    return { absence: toRotaAbsenceIndicator(data) };
  }

  // -------------------------------------------------------------------------
  // Optional bulk save (week-level)
  // -------------------------------------------------------------------------

  async previewNewWeek(
    actor: AuthUser,
    input: PreviewNewWeekRequest,
  ): Promise<PreviewNewWeekResponse> {
    this.assertManagerOrOwner(actor);
    const locationId = this.resolveLocationForActor(actor, input.locationId);
    this.assertLocationScope(actor, locationId);

    const weekStart = parseIsoDate(input.weekStart);
    if (!weekStart) {
      throw new BadRequestException('weekStart must be a valid ISO date (YYYY-MM-DD)');
    }
    const startOfWeek = mondayUtc(weekStart);
    const endOfWeek = addDays(startOfWeek, 7);

    const staff = await this.fetchLocationStaff(actor.businessId, locationId);

    let shiftsToCreate = 0;
    let breaksToCreate = 0;
    const warnings: string[] = [];

    // Check if current week already has shifts
    const existingShifts = await this.fetchShiftsInRange(
      actor.businessId,
      locationId,
      startOfWeek.toISOString(),
      endOfWeek.toISOString(),
    );
    if (existingShifts.length > 0) {
      warnings.push('This week already has shifts. Creating a new week may duplicate shifts.');
    }

    if (input.creationMode === 'clone_last_week') {
      const lastWeekStart = addDays(startOfWeek, -7);
      const lastWeekEnd = startOfWeek;
      const lastWeekShifts = await this.fetchShiftsInRange(
        actor.businessId,
        locationId,
        lastWeekStart.toISOString(),
        lastWeekEnd.toISOString(),
      );

      if (lastWeekShifts.length === 0) {
        warnings.push('No shifts found in the previous week to clone.');
      } else {
        shiftsToCreate = lastWeekShifts.length;
        const lastWeekBreaks = await this.fetchBreaksForRange(
          actor.businessId,
          locationId,
          lastWeekStart.toISOString(),
          lastWeekEnd.toISOString(),
        );
        breaksToCreate = lastWeekBreaks.length;
        const breaksByShift = groupBreaksByShift(lastWeekBreaks);
        return {
          weekStart: toIsoDate(startOfWeek),
          creationMode: input.creationMode,
          staffCount: staff.length,
          shiftsToCreate,
          breaksToCreate,
          warnings,
          draftShifts: lastWeekShifts.map((shift) =>
            toDraftShift(shift, breaksByShift.get(shift.id) ?? [], 7),
          ),
        };
      }
    } else if (input.creationMode === 'generate_from_defaults') {
      warnings.push('Generate from defaults is partially supported. Will generate empty shifts for bookable staff.');
      shiftsToCreate = staff.filter((s) => s.isBookable).length * 5; // Assuming 5 days a week for preview
      breaksToCreate = shiftsToCreate; // Assuming 1 break per shift
    }

    return {
      weekStart: toIsoDate(startOfWeek),
      creationMode: input.creationMode,
      staffCount: staff.length,
      shiftsToCreate,
      breaksToCreate,
      warnings,
    };
  }

  async createNewWeek(
    actor: AuthUser,
    input: CreateNewWeekRequest,
  ): Promise<CreateNewWeekResponse> {
    this.assertManagerOrOwner(actor);
    const locationId = this.resolveLocationForActor(actor, input.locationId);
    this.assertLocationScope(actor, locationId);

    const weekStart = parseIsoDate(input.weekStart);
    if (!weekStart) {
      throw new BadRequestException('weekStart must be a valid ISO date (YYYY-MM-DD)');
    }
    const startOfWeek = mondayUtc(weekStart);
    const endOfWeek = addDays(startOfWeek, 7);

    // Prevent duplicate unsafe creation if we wanted to strictly block it,
    // but for now we just rely on the preview warning, or we can enforce it.
    // Let's enforce it to be safe:
    const existingShifts = await this.fetchShiftsInRange(
      actor.businessId,
      locationId,
      startOfWeek.toISOString(),
      endOfWeek.toISOString(),
    );
    if (existingShifts.length > 0) {
      throw new BadRequestException('This week already has shifts. Cannot create new week.');
    }

    let shiftsCreated = 0;
    let breaksCreated = 0;

    if (input.shifts) {
      const created = await this.createWeekFromDraft(actor, locationId, startOfWeek, input.shifts);
      shiftsCreated = created.shiftsCreated;
      breaksCreated = created.breaksCreated;
    } else if (input.creationMode === 'clone_last_week') {
      const cloned = await this.clonePreviousWeek(actor, locationId, startOfWeek);
      shiftsCreated = cloned.shiftsCreated;
      breaksCreated = cloned.breaksCreated;
    } else if (input.creationMode === 'generate_from_defaults') {
      // Scaffold it honestly
      const staff = await this.fetchLocationStaff(actor.businessId, locationId);
      for (const s of staff) {
        if (!s.isBookable) continue;
        // Generate Mon-Fri 9-5
        for (let i = 0; i < 5; i++) {
          const day = addDays(startOfWeek, i);
          const start = new Date(day);
          start.setUTCHours(9, 0, 0, 0);
          const end = new Date(day);
          end.setUTCHours(17, 0, 0, 0);

          const { shift } = await this.createShift(actor, {
            locationId,
            staffProfileId: s.staffProfileId,
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: end.toISOString(),
            status: 'published',
          });
          shiftsCreated++;

          if (s.defaultBreakMinutes > 0) {
            const breakStart = new Date(start);
            breakStart.setUTCHours(12, 0, 0, 0);
            const breakEnd = new Date(breakStart.getTime() + s.defaultBreakMinutes * 60000);
            await this.addBreak(actor, shift.id, {
              startedAt: breakStart.toISOString(),
              endedAt: breakEnd.toISOString(),
              isPaid: s.defaultBreakIsPaid,
              notes: s.defaultBreakNotes,
            });
            breaksCreated++;
          }
        }
      }
    }

    return {
      weekStart: toIsoDate(startOfWeek),
      shiftsCreated,
      breaksCreated,
    };
  }

  private async clonePreviousWeek(
    actor: AuthUser,
    locationId: string,
    startOfWeek: Date,
  ): Promise<{ shiftsCreated: number; breaksCreated: number }> {
    const { data, error } = await this.admin.schema('rota').rpc('clone_previous_week', {
      p_actor_user_profile_id: actor.id,
      p_actor_role: actor.role,
      p_business_id: actor.businessId,
      p_location_id: locationId,
      p_target_week_start: startOfWeek.toISOString(),
    });

    if (error) {
      const message = error.message ?? '';
      if (message.includes('No shifts found in the previous week')) {
        throw new BadRequestException('No shifts found in the previous week to clone.');
      }
      if (message.includes('Target week already has shifts')) {
        throw new BadRequestException('This week already has shifts. Cannot create new week.');
      }
      this.translateConstraintError(message, 'shift');
      this.logger.error(`clonePreviousWeek failed: ${message}`);
      throw new InternalServerErrorException('Unable to clone previous week');
    }

    const row = Array.isArray(data)
      ? (data[0] as WeekCreationResultRow | undefined)
      : (data as WeekCreationResultRow | null);

    if (!row) {
      this.logger.error('clonePreviousWeek failed: no result row returned');
      throw new InternalServerErrorException('Unable to clone previous week');
    }

    return {
      shiftsCreated: row.shifts_created,
      breaksCreated: row.breaks_created,
    };
  }

  private async createWeekFromDraft(
    actor: AuthUser,
    locationId: string,
    startOfWeek: Date,
    shifts: NonNullable<CreateNewWeekRequest['shifts']>,
  ): Promise<{ shiftsCreated: number; breaksCreated: number }> {
    const endOfWeek = addDays(startOfWeek, 7);
    for (const shift of shifts) {
      await this.assertStaffInLocation(actor.businessId, shift.staffProfileId, locationId);
      const start = new Date(shift.scheduledStartAt);
      const end = new Date(shift.scheduledEndAt);
      this.validateRange(start, end, 'shift');
      if (start.getTime() < startOfWeek.getTime() || start.getTime() >= endOfWeek.getTime()) {
        throw new BadRequestException('Draft shift must start inside the target week');
      }
      for (const breakInput of shift.breaks ?? []) {
        const breakStart = new Date(breakInput.startedAt);
        const breakEnd = new Date(breakInput.endedAt);
        this.validateRange(breakStart, breakEnd, 'break');
        if (breakStart.getTime() < start.getTime() || breakEnd.getTime() > end.getTime()) {
          throw new BadRequestException('Draft break must stay within its shift range');
        }
      }
    }

    const { data, error } = await this.admin.schema('rota').rpc('create_week_from_draft', {
      p_actor_user_profile_id: actor.id,
      p_actor_role: actor.role,
      p_business_id: actor.businessId,
      p_location_id: locationId,
      p_target_week_start: startOfWeek.toISOString(),
      p_shifts: shifts,
    });

    if (error) {
      const message = error.message ?? '';
      if (message.includes('Target week already has shifts')) {
        throw new BadRequestException('This week already has shifts. Cannot create new week.');
      }
      this.translateConstraintError(message, 'shift');
      this.logger.error(`createWeekFromDraft failed: ${message}`);
      throw new InternalServerErrorException('Unable to create week from draft');
    }

    const row = Array.isArray(data)
      ? (data[0] as WeekCreationResultRow | undefined)
      : (data as WeekCreationResultRow | null);

    if (!row) {
      this.logger.error('createWeekFromDraft failed: no result row returned');
      throw new InternalServerErrorException('Unable to create week from draft');
    }

    return {
      shiftsCreated: row.shifts_created,
      breaksCreated: row.breaks_created,
    };
  }

  async saveWeeklyRota(
    actor: AuthUser,
    input: SaveWeeklyRotaRequest,
  ): Promise<SaveWeeklyRotaResponse> {
    this.assertManagerOrOwner(actor);
    this.assertLocationScope(actor, input.locationId);

    const now = Date.now();
    const requiresPastEditReason = input.shifts.some(
      (s) => new Date(s.scheduledStartAt).getTime() < now,
    );
    if (requiresPastEditReason) {
      this.requireReason(input.pastEditReason, 'saving rota changes for past dates');
    }

    const saved: RotaShift[] = [];
    for (const shiftInput of input.shifts) {
      if (shiftInput.id) {
        const result = await this.updateShift(actor, shiftInput.id, {
          scheduledStartAt: shiftInput.scheduledStartAt,
          scheduledEndAt: shiftInput.scheduledEndAt,
          status: shiftInput.status,
          notes: shiftInput.notes,
          pastEditReason: input.pastEditReason,
        });
        saved.push(result.shift);
      } else {
        const result = await this.createShift(actor, {
          locationId: input.locationId,
          staffProfileId: shiftInput.staffProfileId,
          scheduledStartAt: shiftInput.scheduledStartAt,
          scheduledEndAt: shiftInput.scheduledEndAt,
          status: shiftInput.status,
          notes: shiftInput.notes,
          pastEditReason: input.pastEditReason,
        });
        saved.push(result.shift);
      }
    }

    return { saved };
  }

  // -------------------------------------------------------------------------
  // Permission helpers
  // -------------------------------------------------------------------------

  private assertManagerOrOwner(actor: AuthUser): void {
    if (actor.role !== 'owner' && actor.role !== 'manager') {
      throw new ForbiddenException('Rota management is restricted to owners and managers');
    }
  }

  private resolveStylistScope(actor: AuthUser): { staffProfileId: string; locationId: string } {
    if (actor.role !== 'stylist') {
      throw new ForbiddenException('Stylist rota access is restricted to stylist accounts');
    }
    if (!actor.staffProfileId) {
      throw new ForbiddenException('Stylist profile is not configured');
    }
    const locationId = actor.allowedLocationIds[0];
    if (!locationId) {
      throw new ForbiddenException('Stylist location is not configured');
    }
    return { staffProfileId: actor.staffProfileId, locationId };
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (actor.role === 'owner') return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your assigned scope');
    }
  }

  /**
   * Resolve the location id to operate on for a manager. Owners must
   * specify it explicitly (the manager UI is the only consumer of this
   * fallback today, but the helper is shape-compatible with future owner
   * UI which will always provide a `locationId`).
   */
  private resolveLocationForActor(actor: AuthUser, raw: string | undefined): string {
    if (raw) return raw;
    if (actor.role === 'manager' && actor.allowedLocationIds.length > 0) {
      return actor.allowedLocationIds[0];
    }
    throw new BadRequestException('locationId is required');
  }

  private async assertStaffInLocation(
    businessId: string,
    staffProfileId: string,
    locationId: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,primary_location_id,business_id')
      .eq('id', staffProfileId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string; primary_location_id: string; business_id: string }>();
    if (error) {
      this.logger.error(`assertStaffInLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify staff scope');
    }
    if (!data) {
      throw new NotFoundException('Staff member not found in your business');
    }
    if (data.primary_location_id !== locationId) {
      throw new ForbiddenException('Staff member is assigned to a different location');
    }
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private validateRange(start: Date, end: Date, label: 'shift' | 'break'): void {
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException(`${label} start/end must be valid ISO timestamps`);
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException(`${label} end must be strictly after start`);
    }
  }

  private validateBreakWithinShift(
    shift: ShiftRow,
    start: Date,
    end: Date,
    others: BreakRow[],
  ): void {
    this.validateRange(start, end, 'break');
    const shiftStart = new Date(shift.scheduled_start_at).getTime();
    const shiftEnd = new Date(shift.scheduled_end_at).getTime();
    if (start.getTime() < shiftStart || end.getTime() > shiftEnd) {
      throw new BadRequestException('Break must stay within the shift range');
    }
    for (const other of others) {
      const a = new Date(other.started_at).getTime();
      const b = new Date(other.ended_at).getTime();
      if (start.getTime() < b && end.getTime() > a) {
        throw new BadRequestException('Breaks may not overlap');
      }
    }
  }

  private requireReason(reason: string | undefined, action: string): void {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException(`Reason is required for ${action}`);
    }
  }

  private translateConstraintError(message: string, label: 'shift' | 'break'): void {
    const lower = message.toLowerCase();
    if (lower.includes('rota_shifts_no_overlap')) {
      throw new BadRequestException(
        'This staff member already has a shift overlapping the requested time',
      );
    }
    if (lower.includes('shifts_check') && label === 'shift') {
      throw new BadRequestException('Shift end must be strictly after start');
    }
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  private async recordAudit(
    actor: AuthUser,
    input: {
      entity: AuditEntity;
      entityId: string | null;
      locationId: string | null;
      action: AuditAction;
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const { error } = await this.admin
      .schema('audit')
      .from('rota_audit_events')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId,
        actor_user_profile_id: actor.id,
        actor_role: actor.role,
        entity_type: input.entity,
        entity_id: input.entityId,
        action: input.action,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
      });

    if (error) {
      // Audit failures must never block the primary mutation — they log
      // loudly so operators can investigate.
      this.logger.error(`recordAudit failed (${input.entity}/${input.action}): ${error.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Data fetchers
  // -------------------------------------------------------------------------

  private async fetchShift(businessId: string, shiftId: string): Promise<ShiftRow> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select(SHIFT_COLUMNS)
      .eq('id', shiftId)
      .eq('business_id', businessId)
      .maybeSingle<ShiftRow>();
    if (error) {
      this.logger.error(`fetchShift failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load shift');
    }
    if (!data) throw new NotFoundException('Shift not found');
    return data;
  }

  private async fetchBreak(
    businessId: string,
    shiftId: string,
    breakId: string,
  ): Promise<BreakRow> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .select(BREAK_COLUMNS)
      .eq('id', breakId)
      .eq('shift_id', shiftId)
      .eq('business_id', businessId)
      .maybeSingle<BreakRow>();
    if (error) {
      this.logger.error(`fetchBreak failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load break');
    }
    if (!data) throw new NotFoundException('Break not found');
    return data;
  }

  private async fetchLeaveRequest(
    businessId: string,
    requestId: string,
  ): Promise<LeaveRequestRow> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select(LEAVE_COLUMNS)
      .eq('id', requestId)
      .eq('business_id', businessId)
      .maybeSingle<LeaveRequestRow>();
    if (error) {
      this.logger.error(`fetchLeaveRequest failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load leave request');
    }
    if (!data) throw new NotFoundException('Leave request not found');
    return data;
  }

  private async fetchShiftsInRange(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<ShiftRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select(SHIFT_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .gte('scheduled_start_at', fromIso)
      .lt('scheduled_start_at', toIso)
      .order('scheduled_start_at', { ascending: true })
      .returns<ShiftRow[]>();
    if (error) {
      this.logger.error(`fetchShiftsInRange failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load shifts');
    }
    return data ?? [];
  }

  private async fetchBreaksForRange(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<BreakRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .select(BREAK_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .gte('started_at', fromIso)
      .lt('started_at', toIso)
      .returns<BreakRow[]>();
    if (error) {
      this.logger.error(`fetchBreaksForRange failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load breaks');
    }
    return data ?? [];
  }

  private async fetchBreaksForShift(shiftId: string): Promise<BreakRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .select(BREAK_COLUMNS)
      .eq('shift_id', shiftId)
      .order('started_at', { ascending: true })
      .returns<BreakRow[]>();
    if (error) {
      this.logger.error(`fetchBreaksForShift failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load breaks for shift');
    }
    return data ?? [];
  }

  private async fetchLeaveOverlapping(
    businessId: string,
    locationId: string,
    fromDate: string,
    toDate: string,
  ): Promise<LeaveRequestRow[]> {
    // Overlap test for [start, end] vs [from, to): start <= to-1 and end >= from.
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select(LEAVE_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .lte('start_date', toDate)
      .gte('end_date', fromDate)
      .returns<LeaveRequestRow[]>();
    if (error) {
      this.logger.error(`fetchLeaveOverlapping failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load leave for the week');
    }
    return data ?? [];
  }

  private async fetchAbsencesOverlapping(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<AbsenceRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .select(ABSENCE_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .lte('starts_at', toIso)
      .or(`ends_at.gte.${fromIso},ends_at.is.null`)
      .returns<AbsenceRow[]>();
    if (error) {
      this.logger.error(`fetchAbsencesOverlapping failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load absences for the week');
    }
    return data ?? [];
  }

  private async fetchHolidayNoticeDays(locationId: string): Promise<number> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('location_id,holiday_notice_days')
      .eq('location_id', locationId)
      .maybeSingle<LocationSettingsRow>();
    if (error) {
      this.logger.error(`fetchHolidayNoticeDays failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location settings');
    }
    return data?.holiday_notice_days ?? DEFAULT_HOLIDAY_NOTICE_DAYS;
  }

  private async fetchLocationStaff(
    businessId: string,
    locationId: string,
  ): Promise<RotaStaffSummary[]> {
    const { data: staffRows, error: staffError } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,business_id,user_profile_id,primary_location_id,display_name,is_bookable,color_hex,employment_status')
      .eq('business_id', businessId)
      .eq('primary_location_id', locationId)
      .returns<StaffProfileRow[]>();
    if (staffError) {
      this.logger.error(`fetchLocationStaff staff_profiles failed: ${staffError.message}`);
      throw new InternalServerErrorException('Unable to load location staff');
    }

    const staff = (staffRows ?? []).filter((s) => s.employment_status !== 'terminated');
    const userIds = staff.map((s) => s.user_profile_id);
    const staffIds = staff.map((s) => s.id);

    const [userProfiles, breakDefaults] = await Promise.all([
      this.fetchUserProfiles(userIds),
      this.fetchBreakDefaults(staffIds),
    ]);
    const profilesById = new Map(userProfiles.map((p) => [p.id, p]));
    const defaultsByStaff = new Map(breakDefaults.map((d) => [d.staff_profile_id, d]));

    return staff
      .map((row) => {
        const profile = profilesById.get(row.user_profile_id);
        const defaults = defaultsByStaff.get(row.id);
        return {
          staffProfileId: row.id,
          userProfileId: row.user_profile_id,
          fullName: profile?.full_name ?? row.display_name,
          displayName: row.display_name,
          email: profile?.email ?? '',
          colorHex: row.color_hex ?? undefined,
          isBookable: row.is_bookable,
          defaultBreakMinutes: defaults?.break_minutes ?? DEFAULT_BREAK_MINUTES,
          defaultBreakIsPaid: defaults?.is_paid ?? false,
          defaultBreakNotes: defaults?.notes ?? undefined,
        } satisfies RotaStaffSummary;
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private async fetchUserProfiles(ids: string[]): Promise<UserProfileRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.admin
      .schema('core')
      .from('user_profiles')
      .select('id,email,full_name')
      .in('id', ids)
      .returns<UserProfileRow[]>();
    if (error) {
      this.logger.error(`fetchUserProfiles failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load user profiles');
    }
    return data ?? [];
  }

  private async fetchBreakDefaults(staffIds: string[]): Promise<BreakDefaultsRow[]> {
    if (staffIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('rota')
      .from('staff_break_defaults')
      .select('staff_profile_id,break_minutes,is_paid,notes')
      .in('staff_profile_id', staffIds)
      .returns<BreakDefaultsRow[]>();
    if (error) {
      this.logger.error(`fetchBreakDefaults failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load break defaults');
    }
    return data ?? [];
  }

  private async hydrateLeaveRequest(row: LeaveRequestRow): Promise<RotaLeaveRequest> {
    const [staff, noticeDays] = await Promise.all([
      this.fetchLocationStaff(row.business_id, row.location_id),
      this.fetchHolidayNoticeDays(row.location_id),
    ]);
    const today = startOfDayUtc(new Date());
    const start = parseIsoDate(row.start_date) ?? today;
    const days = differenceInDays(start, today);
    return {
      id: row.id,
      businessId: row.business_id,
      locationId: row.location_id,
      staffProfileId: row.staff_profile_id,
      startDate: row.start_date,
      endDate: row.end_date,
      status: row.status,
      reason: row.reason ?? undefined,
      reviewedAt: row.reviewed_at ?? undefined,
      reviewedByUserProfileId: row.reviewed_by_user_profile_id ?? undefined,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      staff: staff.find((s) => s.staffProfileId === row.staff_profile_id),
      noticeDays: days,
      insideNoticeWindow: days < noticeDays,
    };
  }
}

// ---------------------------------------------------------------------------
// Mappers + helpers (module-private; not exported)
// ---------------------------------------------------------------------------

const SHIFT_COLUMNS =
  'id,business_id,location_id,staff_profile_id,status,scheduled_start_at,scheduled_end_at,published_at,notes';
const BREAK_COLUMNS =
  'id,business_id,location_id,shift_id,started_at,ended_at,is_paid,notes';
const LEAVE_COLUMNS =
  'id,business_id,location_id,staff_profile_id,start_date,end_date,status,reason,reviewed_at,reviewed_by_user_profile_id,metadata,created_at,updated_at';
const ABSENCE_COLUMNS =
  'id,business_id,location_id,staff_profile_id,absence_type,starts_at,ends_at,notes';

function toRotaShift(row: ShiftRow, breaks: BreakRow[]): RotaShift {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    staffProfileId: row.staff_profile_id,
    status: row.status,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    publishedAt: row.published_at ?? undefined,
    notes: row.notes ?? undefined,
    breaks: breaks.map(toRotaBreak),
  };
}

function toRotaBreak(row: BreakRow): RotaBreak {
  return {
    id: row.id,
    shiftId: row.shift_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    isPaid: row.is_paid,
    notes: row.notes ?? undefined,
  };
}

function toDraftShift(row: ShiftRow, breaks: BreakRow[], dayOffset: number): RotaShift {
  const shiftId = `draft:${row.id}`;
  return {
    id: shiftId,
    businessId: row.business_id,
    locationId: row.location_id,
    staffProfileId: row.staff_profile_id,
    status: 'published',
    scheduledStartAt: addDays(new Date(row.scheduled_start_at), dayOffset).toISOString(),
    scheduledEndAt: addDays(new Date(row.scheduled_end_at), dayOffset).toISOString(),
    notes: row.notes ?? undefined,
    breaks: breaks.map((breakRow) => ({
      id: `draft:${breakRow.id}`,
      shiftId,
      startedAt: addDays(new Date(breakRow.started_at), dayOffset).toISOString(),
      endedAt: addDays(new Date(breakRow.ended_at), dayOffset).toISOString(),
      isPaid: breakRow.is_paid,
      notes: breakRow.notes ?? undefined,
    })),
  };
}

function toRotaAbsenceIndicator(row: AbsenceRow): RotaAbsenceIndicator {
  return {
    id: row.id,
    staffProfileId: row.staff_profile_id,
    absenceType: row.absence_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? undefined,
    notes: row.notes ?? undefined,
  };
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function mondayUtc(date: Date): Date {
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // distance back to Monday
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - diff);
  return monday;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function groupBreaksByShift(breaks: BreakRow[]): Map<string, BreakRow[]> {
  const breaksByShift = new Map<string, BreakRow[]>();
  for (const row of breaks) {
    const list = breaksByShift.get(row.shift_id);
    if (list) list.push(row);
    else breaksByShift.set(row.shift_id, [row]);
  }
  return breaksByShift;
}

function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function differenceInDays(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}
