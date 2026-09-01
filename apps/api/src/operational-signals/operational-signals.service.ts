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
  AttendanceEvent,
  AuthUser,
  BackToBackColourSignal,
  ClientVisitSpend,
  ColourAppointmentInput,
  NoShowRiskSignal,
  OperationalSignalReport,
  OperationalSignalSettingsRecord,
  OperationalSignalThresholds,
  SlotGapSignal,
  SpendTrendSignal,
} from '@sheer/domain';
import {
  DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
  assessNoShowRisk,
  assessSpendTrend,
  detectBackToBackColour,
  findSlotGaps,
  resolveOperationalSignalThresholds,
  userHasAnyRole,
  userHasRole,
  validateOperationalSignalThresholds,
} from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { parseMultirange } from '../common/occupied-ranges';
import type { UpsertOperationalSignalSettingsDto } from './dto';

/**
 * Operational & Client Intelligence Signals (Wrike 4507283793).
 *
 * COMPUTED ON READ, NOTHING PERSISTED — the platform's established intelligence
 * pattern (client lapse 0097, formula change 0105). Signals derive from live
 * appointment, bill and rota rows, so a cancelled appointment, a settled bill or
 * a changed threshold is reflected on the very next call, with no cache to
 * invalidate and no second ledger to drift.
 *
 * READ-ONLY. The only write is the settings upsert. Nothing here creates,
 * cancels, reprices or moves an appointment, and no Tier 1 module imports this
 * one — so a signal failure cannot reach booking, checkout, QLAB, CRM or the
 * till (Wrike sections 51-53).
 *
 * SET-BASED. Client signals for a page of clients and every diary signal for a
 * whole day each cost a fixed number of queries, never one per client or per
 * appointment (Wrike sections 49-50).
 */
@Injectable()
export class OperationalSignalsService {
  private readonly logger = new Logger(OperationalSignalsService.name);
  private readonly admin: SupabaseClient;

  /**
   * Settled bills read per client. Two comparison windows need `2 * windowVisits`
   * visits; this ceiling bounds the scan while comfortably covering the largest
   * configurable window (12 visits per side).
   */
  private static readonly SPEND_HISTORY_LIMIT = 40;
  /** Overall row bound for a bulk read before per-client windowing. */
  private static readonly BULK_ROW_CAP = 1000;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // =========================================================================
  // Client signals — spend trend + no-show risk
  // =========================================================================

  /**
   * Both client-level signals for one client.
   *
   * The client id is validated against the ACTING business before any history is
   * read, so `?clientId=<arbitrary>` can never cross a tenant boundary. Managers
   * and stylists are additionally bounded to their own locations, mirroring the
   * CRM scoping the client profile itself uses.
   */
  async clientSignals(actor: AuthUser, clientProfileId: string): Promise<ClientSignals> {
    this.assertClientIntelligenceAccess(actor);
    const client = await this.fetchClientForActor(actor, clientProfileId);

    const thresholds = await this.thresholdsFor(actor.businessId, client.primary_location_id);
    const byClient = await this.clientSignalsBulk(actor.businessId, [clientProfileId], thresholds);
    return (
      byClient.get(clientProfileId) ?? {
        spendTrend: assessSpendTrend([], thresholds.spend),
        noShowRisk: assessNoShowRisk([], todayIn('UTC'), thresholds.noShow),
      }
    );
  }

  /**
   * Both client-level signals for many clients at once.
   *
   * The caller must already have authorised the business and the client set.
   * Four queries total regardless of how many clients are passed: bills,
   * appointments, locations (for cancellation policy) and settings.
   */
  async clientSignalsBulk(
    businessId: string,
    clientProfileIds: string[],
    thresholds?: OperationalSignalThresholds,
  ): Promise<Map<string, ClientSignals>> {
    const result = new Map<string, ClientSignals>();
    const clientIds = [...new Set(clientProfileIds.filter(Boolean))];
    if (clientIds.length === 0) return result;

    const effective = thresholds ?? (await this.thresholdsFor(businessId, null));
    const [timezone, noticeHoursByLocation] = await Promise.all([
      this.fetchBusinessTimezone(businessId),
      this.fetchCancellationNoticeHours(businessId),
    ]);
    const today = todayIn(timezone);

    const sinceIso = new Date(
      Date.now() - effective.noShow.lookbackDays * 86_400_000,
    ).toISOString();

    const [bills, appointments] = await Promise.all([
      this.loadSettledBills(businessId, clientIds),
      this.loadAttendanceAppointments(businessId, clientIds, sinceIso),
    ]);

    const spendByClient = new Map<string, ClientVisitSpend[]>();
    for (const bill of bills) {
      if (!bill.client_profile_id) continue;
      const list = spendByClient.get(bill.client_profile_id) ?? [];
      list.push({
        visitDate: localDate(timezone, bill.occurred_at),
        grossCents: Number(bill.gross_cents ?? 0),
      });
      spendByClient.set(bill.client_profile_id, list);
    }

    const attendanceByClient = new Map<string, AttendanceEvent[]>();
    for (const appointment of appointments) {
      const outcome = this.classifyAttendance(appointment, noticeHoursByLocation);
      if (!outcome) continue;
      const list = attendanceByClient.get(appointment.client_profile_id) ?? [];
      list.push({ scheduledDate: localDate(timezone, appointment.scheduled_start_at), outcome });
      attendanceByClient.set(appointment.client_profile_id, list);
    }

    for (const clientId of clientIds) {
      // Bills arrive newest-first from the query; the calculator wants oldest-first.
      const spend = (spendByClient.get(clientId) ?? [])
        .slice()
        .sort((a, b) => a.visitDate.localeCompare(b.visitDate));
      result.set(clientId, {
        spendTrend: assessSpendTrend(spend, effective.spend),
        noShowRisk: assessNoShowRisk(attendanceByClient.get(clientId) ?? [], today, effective.noShow),
      });
    }
    return result;
  }

  /** Best-effort variant for surfaces that must render even when signals fail. */
  async clientSignalsSafe(actor: AuthUser, clientProfileId: string): Promise<ClientSignals | undefined> {
    try {
      return await this.clientSignals(actor, clientProfileId);
    } catch (err) {
      this.logger.error(`client signals failed for ${clientProfileId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Map an appointment row onto a canonical attendance outcome.
   *
   * The statuses are exactly `booking.appointment_status_enum` after the 0045
   * rename. A LATE cancellation is not invented here: the platform already
   * defines the line as `core.location_settings.cancellation_notice_hours` — the
   * same value the client app calls the refund cutoff — and
   * `appointments.cancelled_at` records which side of it the client landed on.
   *
   * BUT NOTE WHAT THAT DOES AND DOES NOT MEAN. The window is mutable and is not
   * snapshotted onto the appointment, so this classifies a past cancellation
   * against the salon's CURRENT policy. Widening the window from 24h to 48h will
   * reclassify history. That is deterministic (same data + same configuration ->
   * same answer) and it is why the wording everywhere says "inside the notice
   * period" rather than "was late". A durable marker stamped at cancel time
   * would make it a historical fact instead of a re-evaluation; that is a schema
   * change, listed as remaining work.
   *
   * `pending`, `accepted`, `checked_in` and `rejected` return null: the
   * appointment either has not resolved yet, or the SALON declined it, and
   * neither is client attendance behaviour.
   */
  private classifyAttendance(
    row: AttendanceAppointmentRow,
    noticeHoursByLocation: Map<string, number>,
  ): AttendanceEvent['outcome'] | null {
    if (row.status === 'awaiting_payment' || row.status === 'paid') return 'attended';
    if (row.status === 'no_show') return 'no_show';
    if (row.status !== 'cancelled') return null;

    // Without a cancellation timestamp there is no way to know which side of the
    // notice window it fell, so it counts as an ordinary cancellation — the
    // conservative reading, and never inferred from anything else.
    if (!row.cancelled_at) return 'cancelled';

    const noticeHours = noticeHoursByLocation.get(row.location_id);
    if (noticeHours === undefined) return 'cancelled';

    const cutoffMs = Date.parse(row.scheduled_start_at) - noticeHours * 3_600_000;
    return Date.parse(row.cancelled_at) > cutoffMs ? 'late_cancelled' : 'cancelled';
  }

  // =========================================================================
  // Diary signals — back-to-back colour + slot gaps
  // =========================================================================

  /**
   * Every operational signal for one location on one salon-local day.
   *
   * ONE calculation for the whole diary, never one call per appointment. The
   * per-client no-show flags are resolved in a single bulk pass over the day's
   * clients, and the colour and gap detection run over data loaded once.
   */
  async diarySignals(actor: AuthUser, locationId: string, date?: string): Promise<DiarySignals> {
    this.assertDiaryAccess(actor);
    const location = await this.fetchLocationForActor(actor, locationId);

    const thresholds = await this.thresholdsFor(actor.businessId, location.id);
    const timezone = location.timezone || 'Europe/London';
    const localDay = date ?? todayIn(timezone);
    const { fromIso, toIso } = dayWindow(localDay, timezone);

    const appointments = await this.loadDiaryAppointments(actor.businessId, location.id, fromIso, toIso);

    const colourByAppointment = await this.resolveColourAppointments(
      actor.businessId,
      appointments.map((row) => row.id),
    );

    const colourInputs: ColourAppointmentInput[] = appointments.map((row) => ({
      appointmentId: row.id,
      staffProfileId: row.assigned_staff_profile_id ?? '',
      clientDisplayName: row.client_display_name ?? 'Client',
      startsAt: row.scheduled_start_at,
      endsAt: row.scheduled_end_at,
      // The stylist-OCCUPIED windows, not the whole span: QLOOQO models colour
      // development as stylist-free, so measuring buffers against raw boundaries
      // would manufacture warnings for the interleaving the platform allows.
      occupiedIntervals: parseMultirange(row.occupied_ranges).map((interval) => ({
        startMs: interval.start.getTime(),
        endMs: interval.end.getTime(),
      })),
      isColour: (colourByAppointment.get(row.id)?.length ?? 0) > 0,
      serviceNames: row.service_names ?? [],
    }));

    const backToBackColour = detectBackToBackColour(colourInputs, thresholds.colour);
    const slotGaps = await this.computeSlotGaps({
      businessId: actor.businessId,
      locationId: location.id,
      fromIso,
      toIso,
      appointments,
      thresholds,
    });

    const clientIds = [...new Set(appointments.map((row) => row.client_profile_id).filter(Boolean))];
    const clientSignals = await this.clientSignalsBulk(actor.businessId, clientIds, thresholds);

    // Only a client with an actual pattern earns a diary badge. A `low` or
    // `insufficient_data` client is not annotated at all — a warning on every
    // row is a warning nobody reads.
    const noShowByAppointment: Record<string, NoShowRiskSignal> = {};
    for (const appointment of appointments) {
      const signal = clientSignals.get(appointment.client_profile_id)?.noShowRisk;
      if (signal && (signal.level === 'medium' || signal.level === 'high')) {
        noShowByAppointment[appointment.id] = signal;
      }
    }

    return {
      locationId: location.id,
      date: localDay,
      timezone,
      backToBackColour,
      slotGaps,
      noShowByAppointment,
      thresholds,
    };
  }

  /** Best-effort variant: the diary must load even when intelligence does not. */
  async diarySignalsSafe(
    actor: AuthUser,
    locationId: string,
    date?: string,
  ): Promise<DiarySignals | undefined> {
    try {
      return await this.diarySignals(actor, locationId, date);
    } catch (err) {
      this.logger.error(`diary signals failed for ${locationId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Genuinely bookable dead time per stylist.
   *
   * The busy set mirrors the platform's own availability engine
   * (`availableSlotsInShift` in public-booking.service.ts) exactly: shift breaks,
   * stylist-occupied appointment windows, approved leave and blocking absences.
   * Reusing that definition rather than inventing one is what makes a lunch
   * break correctly NOT a gap, and it is why this method loads the same four
   * sources rather than differencing appointment timestamps.
   */
  private async computeSlotGaps(input: {
    businessId: string;
    locationId: string;
    fromIso: string;
    toIso: string;
    appointments: DiaryAppointmentRow[];
    thresholds: OperationalSignalThresholds;
  }): Promise<SlotGapSignal[]> {
    const [shifts, breaks, leave, absences] = await Promise.all([
      this.loadShifts(input.businessId, input.locationId, input.fromIso, input.toIso),
      this.loadShiftBreaks(input.businessId, input.locationId, input.fromIso, input.toIso),
      this.loadLeave(input.businessId, input.locationId, input.fromIso, input.toIso),
      this.loadAbsences(input.businessId, input.locationId, input.fromIso, input.toIso),
    ]);
    if (shifts.length === 0) return [];

    const nonBlockingTypeIds = await this.fetchNonBlockingBookOutTypeIds(input.businessId, absences);

    const occupiedByStaff = new Map<string, Array<{ startMs: number; endMs: number }>>();
    for (const appointment of input.appointments) {
      const staffId = appointment.assigned_staff_profile_id;
      if (!staffId) continue;
      const intervals = parseMultirange(appointment.occupied_ranges).map((interval) => ({
        startMs: interval.start.getTime(),
        endMs: interval.end.getTime(),
      }));
      // A booking with no recorded occupancy still holds the chair; falling back
      // to its full span is the conservative reading and never invents free time.
      const effective =
        intervals.length > 0
          ? intervals
          : [
              {
                startMs: Date.parse(appointment.scheduled_start_at),
                endMs: Date.parse(appointment.scheduled_end_at),
              },
            ];
      occupiedByStaff.set(staffId, [...(occupiedByStaff.get(staffId) ?? []), ...effective]);
    }

    const breaksByShift = new Map<string, ShiftBreakRow[]>();
    for (const row of breaks) {
      breaksByShift.set(row.shift_id, [...(breaksByShift.get(row.shift_id) ?? []), row]);
    }
    const leaveByStaff = new Map<string, LeaveRow[]>();
    for (const row of leave) {
      leaveByStaff.set(row.staff_profile_id, [...(leaveByStaff.get(row.staff_profile_id) ?? []), row]);
    }
    const absenceByStaff = new Map<string, AbsenceRow[]>();
    for (const row of absences) {
      // A book-out type flagged "does not block appointments" leaves the stylist
      // bookable, so it must not close a gap either.
      if (row.book_out_type_id && nonBlockingTypeIds.has(row.book_out_type_id)) continue;
      absenceByStaff.set(row.staff_profile_id, [...(absenceByStaff.get(row.staff_profile_id) ?? []), row]);
    }

    const gaps: SlotGapSignal[] = [];
    for (const shift of shifts) {
      const busy = [
        ...(breaksByShift.get(shift.id) ?? []).map((row) => ({
          startMs: Date.parse(row.started_at),
          endMs: Date.parse(row.ended_at),
        })),
        ...(occupiedByStaff.get(shift.staff_profile_id) ?? []),
        ...(leaveByStaff.get(shift.staff_profile_id) ?? []).map((row) => ({
          // Leave is stored as whole DATES; a leave day removes the entire shift.
          startMs: Date.parse(`${row.start_date}T00:00:00Z`),
          endMs: Date.parse(`${row.end_date}T23:59:59Z`),
        })),
        ...(absenceByStaff.get(shift.staff_profile_id) ?? []).map((row) => ({
          startMs: Date.parse(row.starts_at),
          // An open-ended absence runs to the end of the shift.
          endMs: row.ends_at ? Date.parse(row.ends_at) : Date.parse(shift.scheduled_end_at),
        })),
      ].filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs));

      gaps.push(
        ...findSlotGaps(
          {
            staffProfileId: shift.staff_profile_id,
            shift: {
              startMs: Date.parse(shift.scheduled_start_at),
              endMs: Date.parse(shift.scheduled_end_at),
            },
            busy,
          },
          input.thresholds.slotGap,
        ),
      );
    }

    // Deterministic order regardless of query/Map iteration order.
    return gaps.sort(
      (a, b) => a.startsAt.localeCompare(b.startsAt) || a.staffProfileId.localeCompare(b.staffProfileId),
    );
  }

  // =========================================================================
  // Reporting
  // =========================================================================

  /**
   * Structured roll-up for reporting (Wrike sections 36-39).
   *
   * Reporting consumes THESE numbers, never rendered UI text, so changing a
   * wording can never move a report. Every count comes from the same calculators
   * the diary and profile use — there is no second implementation to disagree.
   */
  async report(actor: AuthUser, locationId: string, date?: string): Promise<OperationalSignalReport> {
    this.assertReportAccess(actor);
    const location = await this.fetchLocationForActor(actor, locationId);
    const thresholds = await this.thresholdsFor(actor.businessId, location.id);
    const timezone = location.timezone || 'Europe/London';
    const localDay = date ?? todayIn(timezone);

    const diary = await this.diarySignals(actor, location.id, localDay);

    // Client-level counts are taken over the clients ACTUALLY IN THE DIARY for
    // the window, not over the whole client base: an unbounded business-wide
    // sweep on an interactive report is exactly the N+1-shaped cost section 49
    // forbids, and the window is what the report is about.
    const { fromIso, toIso } = dayWindow(localDay, timezone);
    const appointments = await this.loadDiaryAppointments(actor.businessId, location.id, fromIso, toIso);
    const clientIds = [...new Set(appointments.map((row) => row.client_profile_id).filter(Boolean))];
    const clientSignals = await this.clientSignalsBulk(actor.businessId, clientIds, thresholds);

    const spend = { rising: 0, stable: 0, falling: 0, insufficientData: 0, clientsEvaluated: 0 };
    const noShow = {
      low: 0,
      medium: 0,
      high: 0,
      insufficientData: 0,
      clientsEvaluated: 0,
      upcomingAppointmentsForFlaggedClients: 0,
    };

    for (const signals of clientSignals.values()) {
      spend.clientsEvaluated += 1;
      if (signals.spendTrend.status === 'rising') spend.rising += 1;
      else if (signals.spendTrend.status === 'falling') spend.falling += 1;
      else if (signals.spendTrend.status === 'stable') spend.stable += 1;
      else spend.insufficientData += 1;

      noShow.clientsEvaluated += 1;
      if (signals.noShowRisk.level === 'high') noShow.high += 1;
      else if (signals.noShowRisk.level === 'medium') noShow.medium += 1;
      else if (signals.noShowRisk.level === 'low') noShow.low += 1;
      else noShow.insufficientData += 1;
    }
    noShow.upcomingAppointmentsForFlaggedClients = Object.keys(diary.noShowByAppointment).length;

    const overlapCount = diary.backToBackColour.filter((s) => s.kind === 'overlap').length;
    const totalGapMinutes = diary.slotGaps.reduce((sum, gap) => sum + gap.gapMinutes, 0);

    return {
      businessId: actor.businessId,
      locationId: location.id,
      fromDate: localDay,
      toDate: localDay,
      timezone,
      spendTrend: spend,
      noShowRisk: noShow,
      backToBackColour: {
        warningCount: diary.backToBackColour.length,
        overlapCount,
        staffAffected: new Set(diary.backToBackColour.map((s) => s.staffProfileId)).size,
      },
      slotGaps: {
        gapCount: diary.slotGaps.length,
        totalGapMinutes,
        averageGapMinutes:
          diary.slotGaps.length === 0 ? 0 : Math.round(totalGapMinutes / diary.slotGaps.length),
        staffAffected: new Set(diary.slotGaps.map((g) => g.staffProfileId)).size,
      },
      thresholds,
    };
  }

  // =========================================================================
  // Data access — bounded and set-based
  // =========================================================================

  /**
   * Settled bills only.
   *
   * `status = 'paid'` is the platform's meaning of money actually collected;
   * `voided` is excluded, which is how a reversed transaction fails to inflate a
   * client's average. QLOOQO models no per-bill refund (only end-of-day counted
   * refunds), so there is nothing further to subtract — stated here so a future
   * reader does not assume the omission was an oversight.
   */
  private async loadSettledBills(businessId: string, clientIds: string[]): Promise<BillRow[]> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('bills')
      .select('client_profile_id,gross_cents,occurred_at')
      .eq('business_id', businessId)
      .eq('status', 'paid')
      .in('client_profile_id', clientIds)
      .order('occurred_at', { ascending: false })
      .limit(Math.min(OperationalSignalsService.BULK_ROW_CAP, clientIds.length * OperationalSignalsService.SPEND_HISTORY_LIMIT))
      .returns<BillRow[]>();
    if (error) throw new Error(`load bills failed: ${error.message}`);
    return data ?? [];
  }

  private async loadAttendanceAppointments(
    businessId: string,
    clientIds: string[],
    sinceIso: string,
  ): Promise<AttendanceAppointmentRow[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('client_profile_id,location_id,status,scheduled_start_at,cancelled_at')
      .eq('business_id', businessId)
      .in('client_profile_id', clientIds)
      .in('status', ['awaiting_payment', 'paid', 'no_show', 'cancelled'])
      .gte('scheduled_start_at', sinceIso)
      .order('scheduled_start_at', { ascending: false })
      .limit(OperationalSignalsService.BULK_ROW_CAP)
      .returns<AttendanceAppointmentRow[]>();
    if (error) throw new Error(`load attendance failed: ${error.message}`);
    return data ?? [];
  }

  /**
   * The day's diary appointments.
   *
   * Cancelled, rejected and no-show appointments are excluded: they do not
   * occupy the diary, so they must not close a gap or create a colour-sequencing
   * warning. A no-show is attendance HISTORY (and counts in the no-show signal),
   * but it never held the chair.
   */
  private async loadDiaryAppointments(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<DiaryAppointmentRow[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select(
        'id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at,occupied_ranges',
      )
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .in('status', ['pending', 'accepted', 'checked_in', 'awaiting_payment', 'paid'])
      .gte('scheduled_start_at', fromIso)
      .lt('scheduled_start_at', toIso)
      .order('scheduled_start_at', { ascending: true })
      .returns<DiaryAppointmentRow[]>();
    if (error) throw new Error(`load diary appointments failed: ${error.message}`);

    const rows = data ?? [];
    if (rows.length === 0) return rows;

    // Client names and service names, both set-based.
    const [clients, services] = await Promise.all([
      this.loadClientNames(businessId, rows.map((r) => r.client_profile_id)),
      this.loadServiceNames(rows.map((r) => r.id)),
    ]);
    for (const row of rows) {
      row.client_display_name = clients.get(row.client_profile_id);
      row.service_names = services.get(row.id) ?? [];
    }
    return rows;
  }

  private async loadClientNames(businessId: string, clientIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const ids = [...new Set(clientIds.filter(Boolean))];
    if (ids.length === 0) return names;
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,first_name,last_name')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<Array<{ id: string; first_name: string; last_name: string }>>();
    if (error) throw new Error(`load client names failed: ${error.message}`);
    for (const row of data ?? []) names.set(row.id, `${row.first_name} ${row.last_name}`.trim());
    return names;
  }

  private async loadServiceNames(appointmentIds: string[]): Promise<Map<string, string[]>> {
    const byAppointment = new Map<string, string[]>();
    if (appointmentIds.length === 0) return byAppointment;
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('appointment_id,service_name_snapshot')
      .in('appointment_id', appointmentIds)
      .returns<Array<{ appointment_id: string; service_name_snapshot: string }>>();
    if (error) throw new Error(`load service names failed: ${error.message}`);
    for (const row of data ?? []) {
      byAppointment.set(row.appointment_id, [
        ...(byAppointment.get(row.appointment_id) ?? []),
        row.service_name_snapshot,
      ]);
    }
    return byAppointment;
  }

  /**
   * Which appointments are colour work, and in which categories.
   *
   * STRUCTURAL, never textual: appointment -> appointment_services -> services ->
   * service_categories.billing_category. This is the same linkage Colour Prep and
   * formula-change detection use, so all three agree on what colour is. A service
   * whose category has a NULL billing_category is not colour work.
   */
  private async resolveColourAppointments(
    businessId: string,
    appointmentIds: string[],
  ): Promise<Map<string, string[]>> {
    const byAppointment = new Map<string, string[]>();
    if (appointmentIds.length === 0) return byAppointment;

    const { data: links, error: linkError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('appointment_id,service_id')
      .in('appointment_id', appointmentIds)
      .returns<Array<{ appointment_id: string; service_id: string }>>();
    if (linkError) throw new Error(`load appointment services failed: ${linkError.message}`);

    const serviceIds = [...new Set((links ?? []).map((l) => l.service_id).filter(Boolean))];
    if (serviceIds.length === 0) return byAppointment;

    const { data: services, error: serviceError } = await this.admin
      .schema('booking')
      .from('services')
      .select('id,service_category_id')
      .eq('business_id', businessId)
      .in('id', serviceIds)
      .returns<Array<{ id: string; service_category_id: string | null }>>();
    if (serviceError) throw new Error(`load services failed: ${serviceError.message}`);

    const categoryIds = [
      ...new Set((services ?? []).map((s) => s.service_category_id).filter((id): id is string => Boolean(id))),
    ];
    if (categoryIds.length === 0) return byAppointment;

    const { data: categories, error: categoryError } = await this.admin
      .schema('booking')
      .from('service_categories')
      .select('id,billing_category')
      .eq('business_id', businessId)
      .in('id', categoryIds)
      .not('billing_category', 'is', null)
      .returns<Array<{ id: string; billing_category: string | null }>>();
    if (categoryError) throw new Error(`load service categories failed: ${categoryError.message}`);

    const billingByCategory = new Map<string, string>();
    for (const row of categories ?? []) {
      if (row.billing_category) billingByCategory.set(row.id, row.billing_category);
    }
    const billingByService = new Map<string, string>();
    for (const service of services ?? []) {
      const billing = service.service_category_id
        ? billingByCategory.get(service.service_category_id)
        : undefined;
      if (billing) billingByService.set(service.id, billing);
    }
    for (const link of links ?? []) {
      const billing = billingByService.get(link.service_id);
      if (!billing) continue;
      const list = byAppointment.get(link.appointment_id) ?? [];
      if (!list.includes(billing)) list.push(billing);
      byAppointment.set(link.appointment_id, list);
    }
    return byAppointment;
  }

  private async loadShifts(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<ShiftRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select('id,staff_profile_id,scheduled_start_at,scheduled_end_at,status')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      // A draft or cancelled shift is not a commitment to be at work, so it
      // cannot contain lost capacity. Only published/completed shifts count.
      .in('status', ['published', 'completed'])
      .lt('scheduled_start_at', toIso)
      .gt('scheduled_end_at', fromIso)
      .returns<ShiftRow[]>();
    if (error) throw new Error(`load shifts failed: ${error.message}`);
    return data ?? [];
  }

  private async loadShiftBreaks(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<ShiftBreakRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .select('shift_id,started_at,ended_at')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .lt('started_at', toIso)
      .gt('ended_at', fromIso)
      .returns<ShiftBreakRow[]>();
    if (error) throw new Error(`load shift breaks failed: ${error.message}`);
    return data ?? [];
  }

  private async loadLeave(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<LeaveRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select('staff_profile_id,start_date,end_date,status')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      // Only APPROVED leave removes availability. A pending request has not been
      // granted and must not silently close the diary.
      .eq('status', 'approved')
      .lte('start_date', toIso.slice(0, 10))
      .gte('end_date', fromIso.slice(0, 10))
      .returns<LeaveRow[]>();
    if (error) throw new Error(`load leave failed: ${error.message}`);
    return data ?? [];
  }

  private async loadAbsences(
    businessId: string,
    locationId: string,
    fromIso: string,
    toIso: string,
  ): Promise<AbsenceRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .select('staff_profile_id,starts_at,ends_at,book_out_type_id')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .lt('starts_at', toIso)
      .returns<AbsenceRow[]>();
    if (error) throw new Error(`load absences failed: ${error.message}`);
    return (data ?? []).filter((row) => !row.ends_at || Date.parse(row.ends_at) > Date.parse(fromIso));
  }

  /**
   * Book-out types configured NOT to block appointments. Mirrors the same rule
   * public-booking applies, so a "Marketing" book-out that still allows bookings
   * does not close a diary gap either.
   */
  private async fetchNonBlockingBookOutTypeIds(
    businessId: string,
    absences: AbsenceRow[],
  ): Promise<Set<string>> {
    const typeIds = [...new Set(absences.map((r) => r.book_out_type_id).filter((id): id is string => Boolean(id)))];
    if (typeIds.length === 0) return new Set();
    const { data, error } = await this.admin
      .schema('rota')
      .from('book_out_types')
      .select('id,blocks_appointments')
      .eq('business_id', businessId)
      .in('id', typeIds)
      .returns<Array<{ id: string; blocks_appointments: boolean }>>();
    if (error) {
      // Not fatal: treating every typed absence as blocking is the conservative
      // direction — it can only hide a gap, never invent one.
      this.logger.error(`load book-out types failed: ${error.message}`);
      return new Set();
    }
    return new Set((data ?? []).filter((row) => row.blocks_appointments === false).map((row) => row.id));
  }

  private async fetchCancellationNoticeHours(businessId: string): Promise<Map<string, number>> {
    const byLocation = new Map<string, number>();
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('location_id,cancellation_notice_hours')
      .returns<Array<{ location_id: string; cancellation_notice_hours: number | null }>>();
    if (error) {
      this.logger.error(`load cancellation policy failed: ${error.message}`);
      return byLocation;
    }
    for (const row of data ?? []) {
      if (row.cancellation_notice_hours !== null) {
        byLocation.set(row.location_id, Number(row.cancellation_notice_hours));
      }
    }
    void businessId;
    return byLocation;
  }

  private async fetchBusinessTimezone(businessId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('timezone')
      .eq('id', businessId)
      .maybeSingle<{ timezone: string | null }>();
    if (error) throw new Error(`load business timezone failed: ${error.message}`);
    return data?.timezone ?? 'Europe/London';
  }

  // =========================================================================
  // Settings
  // =========================================================================

  async thresholdsFor(businessId: string, locationId: string | null): Promise<OperationalSignalThresholds> {
    try {
      return resolveOperationalSignalThresholds(await this.loadSettingsRows(businessId), locationId);
    } catch (err) {
      // Platform defaults are the least sensitive setting, so a degraded read can
      // only under-report, never manufacture a signal.
      this.logger.error(`load signal settings failed: ${(err as Error).message}`);
      return JSON.parse(JSON.stringify(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS));
    }
  }

  async getSettings(actor: AuthUser): Promise<OperationalSignalSettingsResponse> {
    this.assertSettingsRead(actor);
    const records = await this.loadSettingsRows(actor.businessId);
    const scopes = records.map((record) => ({
      locationId: record.locationId,
      spend: record.spend,
      noShow: record.noShow,
      colour: record.colour,
      slotGap: record.slotGap,
      configured: true,
    }));
    if (!scopes.some((scope) => scope.locationId === null)) {
      scopes.unshift({
        locationId: null,
        ...JSON.parse(JSON.stringify(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS)),
        configured: false,
      });
    }
    return { scopes, defaults: JSON.parse(JSON.stringify(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS)) };
  }

  async upsertSettings(
    actor: AuthUser,
    input: UpsertOperationalSignalSettingsDto,
  ): Promise<OperationalSignalSettingsResponse> {
    this.assertSettingsManage(actor);

    const thresholds: OperationalSignalThresholds = {
      spend: input.spend,
      noShow: input.noShow,
      colour: input.colour,
      slotGap: input.slotGap,
    };
    const errors = validateOperationalSignalThresholds(thresholds);
    if (errors.length > 0) throw new BadRequestException(errors.join('; '));

    const locationId = input.locationId ?? null;
    if (locationId) await this.assertLocationInBusiness(actor.businessId, locationId);

    const before = resolveOperationalSignalThresholds(
      await this.loadSettingsRows(actor.businessId),
      locationId,
    );

    const { error } = await this.admin
      .schema('analytics')
      .from('operational_signal_settings')
      .upsert(
        {
          business_id: actor.businessId,
          location_id: locationId,
          spend_window_visits: thresholds.spend.windowVisits,
          spend_materiality_percent: thresholds.spend.materialityPercent,
          no_show_lookback_days: thresholds.noShow.lookbackDays,
          no_show_minimum_appointments: thresholds.noShow.minimumRelevantAppointments,
          no_show_medium_rate_percent: thresholds.noShow.mediumRatePercent,
          no_show_high_rate_percent: thresholds.noShow.highRatePercent,
          no_show_high_count: thresholds.noShow.highNoShowCount,
          no_show_medium_late_cancellations: thresholds.noShow.mediumLateCancellationCount,
          colour_buffer_minutes: thresholds.colour.minimumBufferMinutes,
          slot_gap_minimum_minutes: thresholds.slotGap.minimumGapMinutes,
        },
        { onConflict: 'business_id,location_id' },
      );
    if (error) {
      this.logger.error(`upsert signal settings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save intelligence settings');
    }

    await this.audit.record(actor, {
      action: 'operational_signal_settings.updated',
      entityType: 'operational_signal_settings',
      locationId,
      before: { ...before },
      after: { ...thresholds },
    });

    return this.getSettings(actor);
  }

  private async loadSettingsRows(businessId: string): Promise<OperationalSignalSettingsRecord[]> {
    const { data, error } = await this.admin
      .schema('analytics')
      .from('operational_signal_settings')
      .select(
        'business_id,location_id,spend_window_visits,spend_materiality_percent,no_show_lookback_days,' +
          'no_show_minimum_appointments,no_show_medium_rate_percent,no_show_high_rate_percent,' +
          'no_show_high_count,no_show_medium_late_cancellations,colour_buffer_minutes,slot_gap_minimum_minutes',
      )
      .eq('business_id', businessId)
      .returns<SettingsRow[]>();
    if (error) throw new Error(`load signal settings failed: ${error.message}`);

    return (data ?? []).map((row) => ({
      businessId: row.business_id,
      locationId: row.location_id,
      spend: {
        windowVisits: Number(row.spend_window_visits),
        materialityPercent: Number(row.spend_materiality_percent),
      },
      noShow: {
        lookbackDays: Number(row.no_show_lookback_days),
        minimumRelevantAppointments: Number(row.no_show_minimum_appointments),
        mediumRatePercent: Number(row.no_show_medium_rate_percent),
        highRatePercent: Number(row.no_show_high_rate_percent),
        highNoShowCount: Number(row.no_show_high_count),
        mediumLateCancellationCount: Number(row.no_show_medium_late_cancellations),
      },
      colour: { minimumBufferMinutes: Number(row.colour_buffer_minutes) },
      slotGap: { minimumGapMinutes: Number(row.slot_gap_minimum_minutes) },
    }));
  }

  // =========================================================================
  // Access control
  // =========================================================================

  /**
   * Client signals ride on CRM access: whoever may open a client record may see
   * the intelligence about it. Access is NOT widened just because the signals
   * exist, and these are staff-only — no public or client-facing endpoint
   * exposes them (Wrike section 48).
   */
  private assertClientIntelligenceAccess(actor: AuthUser): void {
    if (userHasRole(actor, 'client') || !userHasAnyRole(actor, ['owner', 'manager', 'stylist'])) {
      throw new ForbiddenException('Client intelligence requires staff access');
    }
  }

  /** Diary signals ride on diary access. */
  private assertDiaryAccess(actor: AuthUser): void {
    if (userHasRole(actor, 'client') || !userHasAnyRole(actor, ['owner', 'manager', 'stylist'])) {
      throw new ForbiddenException('Diary intelligence requires staff access');
    }
  }

  /** Reporting is a management surface, matching the other report permissions. */
  private assertReportAccess(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Intelligence reporting requires owner or manager access');
    }
  }

  private assertSettingsRead(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Intelligence settings require owner or manager access');
    }
  }

  /** Changing what staff get warned about is an owner decision. */
  private assertSettingsManage(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Changing intelligence sensitivity requires owner access');
    }
  }

  private async fetchClientForActor(actor: AuthUser, clientProfileId: string): Promise<ClientRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,business_id,primary_location_id')
      .eq('id', clientProfileId)
      .eq('business_id', actor.businessId)
      .maybeSingle<ClientRow>();
    if (error) {
      this.logger.error(`verify client failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify the client');
    }
    // Same 404 for "another tenant's client" and "no such client".
    if (!data) throw new NotFoundException('Client not found');

    if (userHasRole(actor, 'owner')) return data;
    if (data.primary_location_id && actor.allowedLocationIds.includes(data.primary_location_id)) {
      return data;
    }
    throw new ForbiddenException('Client is outside your scope');
  }

  private async fetchLocationForActor(actor: AuthUser, locationId: string): Promise<LocationRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,business_id,timezone')
      .eq('id', locationId)
      .eq('business_id', actor.businessId)
      .maybeSingle<LocationRow>();
    if (error) {
      this.logger.error(`verify location failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify the location');
    }
    if (!data) throw new NotFoundException('Location not found');
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(data.id)) {
      throw new ForbiddenException('Location is outside your scope');
    }
    return data;
  }

  private async assertLocationInBusiness(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to verify the location');
    if (!data) throw new NotFoundException('Location not found');
  }
}

// ---------------------------------------------------------------------------
// Contracts and row shapes
// ---------------------------------------------------------------------------

export interface ClientSignals {
  spendTrend: SpendTrendSignal;
  noShowRisk: NoShowRiskSignal;
}

export interface DiarySignals {
  locationId: string;
  date: string;
  timezone: string;
  backToBackColour: BackToBackColourSignal[];
  slotGaps: SlotGapSignal[];
  /** Appointment id -> the client's risk signal. Only medium/high appear. */
  noShowByAppointment: Record<string, NoShowRiskSignal>;
  thresholds: OperationalSignalThresholds;
}

export interface OperationalSignalSettingsResponse {
  scopes: Array<OperationalSignalThresholds & { locationId: string | null; configured: boolean }>;
  defaults: OperationalSignalThresholds;
}

interface ClientRow {
  id: string;
  business_id: string;
  primary_location_id: string | null;
}
interface LocationRow {
  id: string;
  business_id: string;
  timezone: string | null;
}
interface BillRow {
  client_profile_id: string | null;
  gross_cents: number | string;
  occurred_at: string;
}
interface AttendanceAppointmentRow {
  client_profile_id: string;
  location_id: string;
  status: string;
  scheduled_start_at: string;
  cancelled_at: string | null;
}
interface DiaryAppointmentRow {
  id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  occupied_ranges: string | null;
  client_display_name?: string;
  service_names?: string[];
}
interface ShiftRow {
  id: string;
  staff_profile_id: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  status: string;
}
interface ShiftBreakRow {
  shift_id: string;
  started_at: string;
  ended_at: string;
}
interface LeaveRow {
  staff_profile_id: string;
  start_date: string;
  end_date: string;
  status: string;
}
interface AbsenceRow {
  staff_profile_id: string;
  starts_at: string;
  ends_at: string | null;
  book_out_type_id: string | null;
}
interface SettingsRow {
  business_id: string;
  location_id: string | null;
  spend_window_visits: number | string;
  spend_materiality_percent: number | string;
  no_show_lookback_days: number | string;
  no_show_minimum_appointments: number | string;
  no_show_medium_rate_percent: number | string;
  no_show_high_rate_percent: number | string;
  no_show_high_count: number | string;
  no_show_medium_late_cancellations: number | string;
  colour_buffer_minutes: number | string;
  slot_gap_minimum_minutes: number | string;
}

// ---------------------------------------------------------------------------
// Salon-local time
// ---------------------------------------------------------------------------

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The salon-local calendar date of an instant.
 *
 * DST-safe: the conversion is done by ICU rather than by subtracting a fixed
 * offset, and the PARTS are read rather than the formatted string because field
 * order varies between ICU builds. Same technique as the lapse and campaign
 * services.
 */
export function localDate(timeZone: string, iso: string): string {
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dateFormatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function todayIn(timeZone: string): string {
  return localDate(timeZone, new Date().toISOString());
}

/**
 * The absolute instants bounding a salon-local calendar day.
 *
 * Computed by probing the zone's offset at midday on the target date rather than
 * by assuming a fixed offset, so a DST-transition day is still exactly one local
 * day — which may be 23 or 25 real hours.
 */
export function dayWindow(localDay: string, timeZone: string): { fromIso: string; toIso: string } {
  const from = zonedMidnight(localDay, timeZone);
  const nextDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const to = zonedMidnight(nextDay, timeZone);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function zonedMidnight(localDay: string, timeZone: string): Date {
  // Start from the UTC instant of that wall-clock midnight, then correct by the
  // zone's actual offset at that moment. One correction pass is enough for every
  // real IANA zone.
  const naive = Date.parse(`${localDay}T00:00:00Z`);
  const offsetMs = zoneOffsetMs(timeZone, new Date(naive));
  return new Date(naive - offsetMs);
}

function zoneOffsetMs(timeZone: string, at: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}
