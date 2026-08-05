/**
 * All I/O for the payroll engine. Resolves TRUSTED inputs server-side with the
 * service-role client and hands plain data to the pure calculator.
 *
 * SOURCE-OF-TRUTH RULE (packages/domain/src/payroll.ts header): every pay
 * input — hourly rate, contracted hours, average bill benchmark, employment
 * type — is read here from `core.staff_profiles` directly. Never from a
 * client-facing API response: those redact to 0 (indistinguishable from a real
 * zero) or omit fields entirely for callers without `staff.pay.manage`.
 *
 * Revenue authority (docs/V1.1/3-2 plan.md §5): `booking.appointment_services`
 * is the authority (per-service AND staff-attributed); the rolled-up
 * `billing.visit_line_items` service row is reconciled against it and any
 * disagreement surfaces as a `source_variance` warning — never assumed away.
 */

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import type {
  HourCategory,
  PayrollDataSource,
  PayrollSettings,
  PayrollBusinessDataSource,
  StaffServiceRevenueTargetMode,
} from '@sheer/domain';
import { calculateHours } from './hours.calc';
import type {
  EngineAdjustmentInput,
  EngineInput,
  EngineMetrics,
  EngineRevenueLine,
  ResolvedRuleVersion,
  ResolvedStage,
} from './payroll.calc';
import { majorToCents, numOrNull, numOrZero } from './payroll-money';
import { periodUtcWindow, utcToLocalDate } from './period-dates';

// -----------------------------------------------------------------------------
// Row shapes (snake_case, never leaked)
// -----------------------------------------------------------------------------

interface StaffRow {
  id: string;
  display_name: string | null;
  hourly_rate: number | string | null;
  contracted_hours: number | string | null;
  average_bill_benchmark: number | string | null;
  service_revenue_target_mode: string | null;
  employment_type: string | null;
  employment_status: string | null;
  primary_location_id: string | null;
  termination_date: string | null;
  user_profiles?: { full_name: string | null }[] | { full_name: string | null } | null;
}

interface AssignmentRow {
  staff_profile_id: string;
  structure_id: string;
  effective_from: string;
  effective_to: string | null;
}

interface VersionRow {
  id: string;
  structure_id: string;
  version_no: number | string;
  effective_from: string;
  effective_to: string | null;
  discount_basis: string;
  vat_basis: string;
  tips_included_in_commission: boolean;
  deposit_recognition: string;
  product_cost_mode: string;
  cancellation_fee_share_percent: number | string | null;
}

interface StageRow {
  id: string;
  version_id: string;
  sequence_no: number | string;
  stage_type: string;
  label: string | null;
  tier_semantics: string | null;
  threshold_basis: string | null;
  revenue_stream: string | null;
  in_greater_of_comparison: boolean;
  requires_data_source: string | null;
  config: Record<string, unknown> | null;
}

interface BandRow {
  id: string;
  stage_id: string;
  sequence_no: number | string;
  from_multiple: number | string | null;
  from_amount_cents: number | string | null;
  from_percent: number | string | null;
  rate_percent: number | string;
  accelerator_rate_percent: number | string | null;
}

interface AcceleratorRow {
  id: string;
  stage_id: string;
  evaluation_mode: string;
  required_condition_count: number | string | null;
  required_score: number | string | null;
}

interface ConditionRow {
  accelerator_id: string;
  sequence_no: number | string;
  metric: string;
  comparator: string;
  basis: string;
  threshold_value: number | string | null;
  weight: number | string;
}

interface HourRuleRow {
  version_id: string;
  category: string;
  counts_toward_target: boolean;
  counts_as_paid: boolean;
}

interface ShiftRow {
  id: string;
  staff_profile_id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  shift_breaks?:
    | { started_at: string; ended_at: string; is_paid: boolean }[]
    | { started_at: string; ended_at: string; is_paid: boolean }
    | null;
}

interface AbsenceRow {
  staff_profile_id: string;
  starts_at: string;
  ends_at: string | null;
  absence_type: string | null;
  book_out_types?: { key: string | null }[] | { key: string | null } | null;
}

interface LeaveRow {
  staff_profile_id: string;
  start_date: string;
  end_date: string;
}

interface VisitRow {
  id: string;
  appointment_id: string | null;
  location_id: string | null;
  client_profile_id: string | null;
  primary_staff_profile_id: string | null;
  status: string;
  completed_at: string | null;
  rebooking_outcomes?:
    | { id: string; rebooked_appointment_id: string | null }[]
    | { id: string; rebooked_appointment_id: string | null }
    | null;
}

interface AppointmentServiceRow {
  id: string;
  appointment_id: string;
  service_name_snapshot: string | null;
  price_amount: number | string | null;
  assigned_staff_profile_id: string | null;
}

interface VisitLineItemRow {
  visit_id: string;
  line_type: string;
  amount_cents: number | string | null;
  cost_amount_cents: number | string | null;
}

interface TaxSettingRow {
  location_id: string;
  is_active: boolean;
  rate_percentage: number | string | null;
  display_mode: string | null;
}

interface AdjustmentRow {
  id: string;
  staff_profile_id: string;
  amount_cents: number | string;
  description: string;
  applied_at: string | null;
}

interface SalonPaymentRow {
  visit_id: string;
  amount_cents: number | string | null;
}

interface TargetRow {
  staff_profile_id: string | null;
  amount_cents: number | string;
}

// -----------------------------------------------------------------------------
// Trusted shapes handed onward
// -----------------------------------------------------------------------------

export interface TrustedStaff {
  staffProfileId: string;
  staffName: string;
  employmentType: string;
  employmentStatus: string;
  primaryLocationId: string | null;
  hourlyRateCents: number | null;
  contractedHours: number | null;
  averageBillBenchmarkCents: number | null;
  serviceRevenueTargetMode: StaffServiceRevenueTargetMode;
}

export interface ResolvedPayrollSettings extends PayrollSettings {
  /** Effective timezone after the location fallback. */
  effectiveTimezone: string;
}

const STAFF_COLUMNS =
  'id,display_name,hourly_rate,contracted_hours,average_bill_benchmark,service_revenue_target_mode,employment_type,employment_status,primary_location_id,termination_date,user_profiles(full_name)';

const DEFAULT_TIMEZONE = 'Europe/London';

/** Shift statuses that represent real scheduled time (never cancelled). */
const COUNTED_SHIFT_STATUSES = ['published', 'completed'];

function first<T>(value: T[] | T | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function arrayOf<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

@Injectable()
export class PayrollInputsService {
  private readonly logger = new Logger(PayrollInputsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Settings & capture matrix
  // ---------------------------------------------------------------------------

  async loadSettings(businessId: string): Promise<ResolvedPayrollSettings> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('payroll_settings')
      .select(
        'business_id,week_start_day,default_calculation_frequency,default_payment_frequency,timezone,created_at,updated_at',
      )
      .eq('business_id', businessId)
      .maybeSingle();
    if (error) {
      this.logger.error(`loadSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load payroll settings');
    }
    if (data) {
      return {
        businessId: data.business_id,
        weekStartDay: numOrZero(data.week_start_day),
        defaultCalculationFrequency: data.default_calculation_frequency,
        defaultPaymentFrequency: data.default_payment_frequency,
        timezone: data.timezone,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        effectiveTimezone: data.timezone ?? DEFAULT_TIMEZONE,
      };
    }
    // Businesses created before 0073's trigger have no row: seed the default
    // (select-then-insert; the partial-unique/upsert trap does not apply here
    // but the house rule is the same).
    const { data: inserted, error: insertError } = await this.admin
      .schema('payroll')
      .from('payroll_settings')
      .insert({ business_id: businessId })
      .select(
        'business_id,week_start_day,default_calculation_frequency,default_payment_frequency,timezone,created_at,updated_at',
      )
      .single();
    if (insertError || !inserted) {
      this.logger.error(`loadSettings seed failed: ${insertError?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to initialise payroll settings');
    }
    return {
      businessId: inserted.business_id,
      weekStartDay: numOrZero(inserted.week_start_day),
      defaultCalculationFrequency: inserted.default_calculation_frequency,
      defaultPaymentFrequency: inserted.default_payment_frequency,
      timezone: inserted.timezone,
      createdAt: inserted.created_at,
      updatedAt: inserted.updated_at,
      effectiveTimezone: inserted.timezone ?? DEFAULT_TIMEZONE,
    };
  }

  async loadCaptureMatrix(businessId: string): Promise<{
    capture: Record<PayrollDataSource, boolean>;
    rows: PayrollBusinessDataSource[];
  }> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('business_data_sources')
      .select('business_id,source,is_captured,notes,updated_at')
      .eq('business_id', businessId);
    if (error) {
      this.logger.error(`loadCaptureMatrix failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load payroll data sources');
    }
    // Fail closed: a source with no row counts as NOT captured.
    const capture: Record<PayrollDataSource, boolean> = {
      service_revenue: false,
      retail_sales: false,
      tips: false,
      refunds: false,
      cancellation_fees: false,
      product_cost: false,
    };
    const rows: PayrollBusinessDataSource[] = [];
    for (const row of data ?? []) {
      capture[row.source as PayrollDataSource] = row.is_captured === true;
      rows.push({
        businessId: row.business_id,
        source: row.source,
        isCaptured: row.is_captured === true,
        notes: row.notes,
        updatedAt: row.updated_at,
      });
    }
    return { capture, rows };
  }

  // ---------------------------------------------------------------------------
  // Staff (trusted, unredacted — service role)
  // ---------------------------------------------------------------------------

  async loadStaff(businessId: string): Promise<TrustedStaff[]> {
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select(STAFF_COLUMNS)
      .eq('business_id', businessId)
      .neq('employment_status', 'terminated')
      .returns<StaffRow[]>();
    if (error) {
      this.logger.error(`loadStaff failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load staff for payroll');
    }
    return (data ?? []).map((row) => ({
      staffProfileId: row.id,
      staffName:
        row.display_name?.trim() || first(row.user_profiles)?.full_name?.trim() || 'Unknown staff',
      employmentType: row.employment_type ?? 'employed',
      employmentStatus: row.employment_status ?? 'active',
      primaryLocationId: row.primary_location_id,
      hourlyRateCents: majorToCents(row.hourly_rate),
      contractedHours: numOrNull(row.contracted_hours),
      averageBillBenchmarkCents: majorToCents(row.average_bill_benchmark),
      serviceRevenueTargetMode: row.service_revenue_target_mode === 'pro_rated' ? 'pro_rated' : 'flat',
    }));
  }

  // ---------------------------------------------------------------------------
  // Rule resolution: (staff, date) -> assignment -> version -> stages/bands/...
  // ---------------------------------------------------------------------------

  async resolveRuleVersions(
    businessId: string,
    staffProfileIds: string[],
    onDate: string,
  ): Promise<Map<string, ResolvedRuleVersion>> {
    const resolved = new Map<string, ResolvedRuleVersion>();
    if (staffProfileIds.length === 0) return resolved;

    const { data: assignments, error: assignmentError } = await this.admin
      .schema('payroll')
      .from('staff_pay_assignments')
      .select('staff_profile_id,structure_id,effective_from,effective_to')
      .eq('business_id', businessId)
      .in('staff_profile_id', staffProfileIds)
      .lte('effective_from', onDate)
      .or(`effective_to.is.null,effective_to.gt.${onDate}`)
      .returns<AssignmentRow[]>();
    if (assignmentError) {
      this.logger.error(`resolveRuleVersions assignments failed: ${assignmentError.message}`);
      throw new InternalServerErrorException('Unable to resolve pay assignments');
    }
    if (!assignments || assignments.length === 0) return resolved;

    const structureIds = [...new Set(assignments.map((a) => a.structure_id))];

    const [{ data: structures, error: structuresError }, { data: versions, error: versionsError }] =
      await Promise.all([
        this.admin
          .schema('payroll')
          .from('pay_structures')
          .select('id,name')
          .in('id', structureIds),
        this.admin
          .schema('payroll')
          .from('pay_structure_versions')
          .select(
            'id,structure_id,version_no,effective_from,effective_to,discount_basis,vat_basis,tips_included_in_commission,deposit_recognition,product_cost_mode,cancellation_fee_share_percent',
          )
          .in('structure_id', structureIds)
          .lte('effective_from', onDate)
          .or(`effective_to.is.null,effective_to.gt.${onDate}`)
          .returns<VersionRow[]>(),
      ]);
    if (structuresError || versionsError) {
      this.logger.error(
        `resolveRuleVersions structures/versions failed: ${structuresError?.message ?? versionsError?.message}`,
      );
      throw new InternalServerErrorException('Unable to resolve pay structures');
    }

    const versionByStructure = new Map<string, VersionRow>();
    for (const version of versions ?? []) versionByStructure.set(version.structure_id, version);
    const structureNames = new Map<string, string>();
    for (const structure of structures ?? []) structureNames.set(structure.id, structure.name);

    const versionIds = [...versionByStructure.values()].map((v) => v.id);
    if (versionIds.length === 0) return resolved;

    const [{ data: stages, error: stagesError }, { data: hourRules, error: hourRulesError }] =
      await Promise.all([
        this.admin
          .schema('payroll')
          .from('pay_structure_stages')
          .select(
            'id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream,in_greater_of_comparison,requires_data_source,config',
          )
          .in('version_id', versionIds)
          .returns<StageRow[]>(),
        this.admin
          .schema('payroll')
          .from('version_hour_rules')
          .select('version_id,category,counts_toward_target,counts_as_paid')
          .in('version_id', versionIds)
          .returns<HourRuleRow[]>(),
      ]);
    if (stagesError || hourRulesError) {
      this.logger.error(
        `resolveRuleVersions stages failed: ${stagesError?.message ?? hourRulesError?.message}`,
      );
      throw new InternalServerErrorException('Unable to resolve pay rule stages');
    }

    const stageIds = (stages ?? []).map((s) => s.id);
    const [{ data: bands, error: bandsError }, { data: accelerators, error: acceleratorsError }] =
      await Promise.all([
        stageIds.length > 0
          ? this.admin
              .schema('payroll')
              .from('pay_structure_bands')
              .select(
                'id,stage_id,sequence_no,from_multiple,from_amount_cents,from_percent,rate_percent,accelerator_rate_percent',
              )
              .in('stage_id', stageIds)
              .returns<BandRow[]>()
          : Promise.resolve({ data: [] as BandRow[], error: null }),
        stageIds.length > 0
          ? this.admin
              .schema('payroll')
              .from('accelerators')
              .select('id,stage_id,evaluation_mode,required_condition_count,required_score')
              .in('stage_id', stageIds)
              .returns<AcceleratorRow[]>()
          : Promise.resolve({ data: [] as AcceleratorRow[], error: null }),
      ]);
    if (bandsError || acceleratorsError) {
      this.logger.error(
        `resolveRuleVersions bands failed: ${bandsError?.message ?? acceleratorsError?.message}`,
      );
      throw new InternalServerErrorException('Unable to resolve pay rule bands');
    }

    const acceleratorIds = (accelerators ?? []).map((a) => a.id);
    const { data: conditions, error: conditionsError } =
      acceleratorIds.length > 0
        ? await this.admin
            .schema('payroll')
            .from('accelerator_conditions')
            .select('accelerator_id,sequence_no,metric,comparator,basis,threshold_value,weight')
            .in('accelerator_id', acceleratorIds)
            .returns<ConditionRow[]>()
        : { data: [] as ConditionRow[], error: null };
    if (conditionsError) {
      this.logger.error(`resolveRuleVersions conditions failed: ${conditionsError.message}`);
      throw new InternalServerErrorException('Unable to resolve accelerator conditions');
    }

    // Assemble per version.
    const stagesByVersion = new Map<string, ResolvedStage[]>();
    for (const stageRow of stages ?? []) {
      const stageBands = (bands ?? [])
        .filter((b) => b.stage_id === stageRow.id)
        .map((b) => ({
          id: b.id,
          sequenceNo: numOrZero(b.sequence_no),
          fromMultiple: numOrNull(b.from_multiple),
          fromAmountCents: numOrNull(b.from_amount_cents),
          fromPercent: numOrNull(b.from_percent),
          ratePercent: numOrZero(b.rate_percent),
          acceleratorRatePercent: numOrNull(b.accelerator_rate_percent),
        }))
        .sort((a, b) => a.sequenceNo - b.sequenceNo);

      const acceleratorRow = (accelerators ?? []).find((a) => a.stage_id === stageRow.id);
      const resolvedStage: ResolvedStage = {
        id: stageRow.id,
        sequenceNo: numOrZero(stageRow.sequence_no),
        stageType: stageRow.stage_type as ResolvedStage['stageType'],
        label: stageRow.label,
        tierSemantics: (stageRow.tier_semantics as ResolvedStage['tierSemantics']) ?? null,
        thresholdBasis: (stageRow.threshold_basis as ResolvedStage['thresholdBasis']) ?? null,
        revenueStream: (stageRow.revenue_stream as ResolvedStage['revenueStream']) ?? null,
        inGreaterOfComparison: stageRow.in_greater_of_comparison === true,
        requiresDataSource:
          (stageRow.requires_data_source as ResolvedStage['requiresDataSource']) ?? null,
        config: stageRow.config ?? {},
        bands: stageBands,
        accelerator: acceleratorRow
          ? {
              evaluationMode: acceleratorRow.evaluation_mode as never,
              requiredConditionCount: numOrNull(acceleratorRow.required_condition_count),
              requiredScore: numOrNull(acceleratorRow.required_score),
              conditions: (conditions ?? [])
                .filter((c) => c.accelerator_id === acceleratorRow.id)
                .map((c) => ({
                  sequenceNo: numOrZero(c.sequence_no),
                  metric: c.metric as never,
                  comparator: c.comparator as never,
                  basis: c.basis as never,
                  thresholdValue: numOrNull(c.threshold_value),
                  weight: numOrZero(c.weight),
                }))
                .sort((a, b) => a.sequenceNo - b.sequenceNo),
            }
          : null,
      };
      const list = stagesByVersion.get(stageRow.version_id) ?? [];
      list.push(resolvedStage);
      stagesByVersion.set(stageRow.version_id, list);
    }

    const hourRulesByVersion = new Map<string, ResolvedRuleVersion['hourRules']>();
    for (const rule of hourRules ?? []) {
      const map = hourRulesByVersion.get(rule.version_id) ?? {};
      map[rule.category as HourCategory] = {
        countsTowardTarget: rule.counts_toward_target === true,
        countsAsPaid: rule.counts_as_paid === true,
      };
      hourRulesByVersion.set(rule.version_id, map);
    }

    for (const assignment of assignments) {
      const version = versionByStructure.get(assignment.structure_id);
      if (!version) continue; // assignment exists but no version in force
      resolved.set(assignment.staff_profile_id, {
        versionId: version.id,
        structureId: version.structure_id,
        structureName: structureNames.get(version.structure_id) ?? 'Pay structure',
        versionNo: numOrZero(version.version_no),
        discountBasis: version.discount_basis as ResolvedRuleVersion['discountBasis'],
        vatBasis: version.vat_basis as ResolvedRuleVersion['vatBasis'],
        tipsIncludedInCommission: version.tips_included_in_commission === true,
        depositRecognition:
          version.deposit_recognition as ResolvedRuleVersion['depositRecognition'],
        productCostMode: version.product_cost_mode as ResolvedRuleVersion['productCostMode'],
        cancellationFeeSharePercent: numOrNull(version.cancellation_fee_share_percent),
        stages: (stagesByVersion.get(version.id) ?? []).sort((a, b) => a.sequenceNo - b.sequenceNo),
        hourRules: hourRulesByVersion.get(version.id) ?? {},
      });
    }
    return resolved;
  }

  // ---------------------------------------------------------------------------
  // Full engine input for one staff member over a period
  // ---------------------------------------------------------------------------

  async buildEngineInputs(args: {
    businessId: string;
    periodStart: string;
    periodEnd: string;
    timezone: string;
    staff: TrustedStaff[];
    versions: Map<string, ResolvedRuleVersion>;
    capture: Record<PayrollDataSource, boolean>;
    /**
     * When generating a specific period, adjustments ORIGINATING from that
     * period must not be consumed by it (pay_adjustments_origin_differs; a
     * correction to P lands in a later period, never P itself).
     */
    excludeOriginPayPeriodId?: string;
  }): Promise<Map<string, EngineInput>> {
    const { businessId, periodStart, periodEnd, timezone, staff, versions, capture } = args;
    const staffIds = staff.map((s) => s.staffProfileId);
    const { fromUtc, toUtc } = periodUtcWindow(timezone, periodStart, periodEnd);

    const [shifts, absences, leave, visits, taxByLocation, retailByStaff, adjustments, targets] =
      await Promise.all([
        this.fetchShifts(businessId, staffIds, fromUtc, toUtc),
        this.fetchAbsences(businessId, staffIds, fromUtc, toUtc),
        this.fetchLeave(businessId, staffIds, periodStart, periodEnd),
        this.fetchVisits(businessId, fromUtc, toUtc),
        this.fetchTaxSettings(businessId),
        capture.retail_sales
          ? this.fetchRetail(businessId, fromUtc, toUtc)
          : Promise.resolve(new Map<string, number>()),
        this.fetchUnappliedAdjustments(businessId, staffIds, args.excludeOriginPayPeriodId),
        this.fetchTrackingTargets(businessId, staffIds, periodStart),
      ]);

    const visitIds = visits.map((v) => v.id);
    const appointmentIds = visits
      .map((v) => v.appointment_id)
      .filter((id): id is string => id !== null);
    const [servicesByAppointment, lineItemsByVisit, paymentsByVisit] = await Promise.all([
      this.fetchAppointmentServices(appointmentIds),
      this.fetchVisitLineItems(visitIds),
      this.fetchSalonPayments(visitIds),
    ]);

    const inputs = new Map<string, EngineInput>();
    for (const member of staff) {
      const memberShifts = shifts.filter((s) => s.staff_profile_id === member.staffProfileId);
      const memberBreaks = memberShifts.flatMap((s) =>
        arrayOf(s.shift_breaks).map((b) => ({
          startsAtMs: Date.parse(b.started_at),
          endsAtMs: Date.parse(b.ended_at),
          isPaid: b.is_paid === true,
        })),
      );
      const hours = calculateHours({
        periodStartMs: Date.parse(fromUtc),
        periodEndMs: Date.parse(toUtc),
        shifts: memberShifts.map((s) => ({
          startsAtMs: Date.parse(s.scheduled_start_at),
          endsAtMs: Date.parse(s.scheduled_end_at),
        })),
        breaks: memberBreaks,
        absences: absences
          .filter((a) => a.staff_profile_id === member.staffProfileId)
          .map((a) => ({
            startsAtMs: Date.parse(a.starts_at),
            endsAtMs: a.ends_at ? Date.parse(a.ends_at) : null,
            bookOutKey: first(a.book_out_types)?.key ?? null,
            absenceType: a.absence_type,
          })),
        approvedLeave: leave
          .filter((l) => l.staff_profile_id === member.staffProfileId)
          .map((l) => ({
            // Whole-day leave: [start 00:00, end+1d 00:00) in the payroll tz.
            startsAtMs: Date.parse(periodUtcWindow(timezone, l.start_date, l.start_date).fromUtc),
            endsAtMs:
              Date.parse(periodUtcWindow(timezone, l.end_date, l.end_date).fromUtc) + 86_400_000,
          })),
      });

      // ---- Revenue: appointment_services attributed to this staff member ----
      const serviceLines: EngineRevenueLine[] = [];
      let expectedRollupCents = 0;
      let actualRollupCents = 0;
      let hasRollupDisagreement = false;
      const memberVisitIds: string[] = [];
      const clientIds = new Set<string>();
      let productCostCents = 0;

      for (const visit of visits) {
        const services = visit.appointment_id
          ? (servicesByAppointment.get(visit.appointment_id) ?? [])
          : [];
        const visitTaxRate = taxByLocation.get(visit.location_id ?? '') ?? null;
        const lineItems = lineItemsByVisit.get(visit.id) ?? [];
        const serviceRollup = lineItems.find((li) => li.line_type === 'service');
        const productUsage = lineItems.find((li) => li.line_type === 'product_usage');

        const visitServicesForMember = services.filter((service) => {
          const attributed = service.assigned_staff_profile_id ?? visit.primary_staff_profile_id;
          return attributed === member.staffProfileId;
        });
        if (visitServicesForMember.length === 0) continue;

        memberVisitIds.push(visit.id);
        if (visit.client_profile_id) clientIds.add(visit.client_profile_id);
        if (productUsage) {
          productCostCents += numOrZero(productUsage.cost_amount_cents);
        }

        const occurredOn = visit.completed_at
          ? utcToLocalDate(timezone, visit.completed_at)
          : periodStart;

        const visitHeadlineTotal = services.reduce(
          (sum, s) => sum + (majorToCents(s.price_amount) ?? 0),
          0,
        );
        if (serviceRollup) {
          expectedRollupCents += visitHeadlineTotal;
          actualRollupCents += numOrZero(serviceRollup.amount_cents);
          if (visitHeadlineTotal !== numOrZero(serviceRollup.amount_cents)) {
            hasRollupDisagreement = true;
          }
        }

        for (const service of visitServicesForMember) {
          const headline = majorToCents(service.price_amount) ?? 0;
          // Per-service actual amounts do not exist (the roll-up is one row per
          // visit); pro-rating would fabricate precision. Headline is used and
          // any roll-up variance is surfaced (plan §5 Data Source Readiness).
          serviceLines.push({
            sourceType: 'appointment_service',
            sourceId: service.id,
            occurredOn,
            label: service.service_name_snapshot?.trim() || 'Service',
            headlineAmountCents: headline,
            actualAmountCents: null,
            amountsIncludeTax: visitTaxRate?.displayMode === 'inc_tax',
            taxRatePercent: visitTaxRate?.ratePercent ?? 0,
          });
        }
      }

      const totalCollectedCents = memberVisitIds.reduce(
        (sum, visitId) => sum + (paymentsByVisit.get(visitId) ?? 0),
        0,
      );

      // ---- Metrics for accelerator conditions ----
      const memberVisits = visits.filter((v) => memberVisitIds.includes(v.id));
      const rebookedCount = memberVisits.filter((v) =>
        arrayOf(v.rebooking_outcomes).some((o) => o.rebooked_appointment_id !== null),
      ).length;
      const serviceRevenueForAvg = serviceLines.reduce((sum, l) => sum + l.headlineAmountCents, 0);
      const metrics: EngineMetrics = {
        rebookingRatePercent:
          memberVisits.length > 0
            ? Math.round((rebookedCount / memberVisits.length) * 1000) / 10
            : null,
        averageBillCents:
          memberVisits.length > 0 ? Math.round(serviceRevenueForAvg / memberVisits.length) : null,
        // Utilisation is a browser-side derivation today (plan §5) — no
        // trusted server figure exists, so conditions on it are unevaluable.
        utilisationPercent: null,
        clientCount: clientIds.size > 0 ? clientIds.size : null,
      };

      const memberAdjustments: EngineAdjustmentInput[] = adjustments
        .filter((a) => a.staff_profile_id === member.staffProfileId)
        .map((a) => ({
          id: a.id,
          amountCents: numOrZero(a.amount_cents),
          description: a.description,
        }));

      inputs.set(member.staffProfileId, {
        period: { periodStart, periodEnd },
        currencyCode: 'GBP',
        staff: {
          staffProfileId: member.staffProfileId,
          staffName: member.staffName,
          employmentType: member.employmentType,
          hourlyRateCents: member.hourlyRateCents,
          contractedHours: member.contractedHours,
          averageBillBenchmarkCents: member.averageBillBenchmarkCents,
          serviceRevenueTargetMode: member.serviceRevenueTargetMode,
        },
        version: versions.get(member.staffProfileId) ?? null,
        hours,
        serviceLines,
        retailRevenueCents: retailByStaff.get(member.staffProfileId) ?? 0,
        productCostCents: productCostCents > 0 ? productCostCents : null,
        capture,
        metrics,
        adjustments: memberAdjustments,
        trackingTargetCents: targets.get(member.staffProfileId) ?? null,
        totalCollectedCents,
        serviceRevenueVariance: hasRollupDisagreement
          ? { expectedCents: expectedRollupCents, actualCents: actualRollupCents }
          : null,
      });
    }
    return inputs;
  }

  // ---------------------------------------------------------------------------
  // Fetch helpers
  // ---------------------------------------------------------------------------

  private async fetchShifts(
    businessId: string,
    staffIds: string[],
    fromUtc: string,
    toUtc: string,
  ): Promise<ShiftRow[]> {
    if (staffIds.length === 0) return [];
    // Overlap form — a shift straddling the boundary must not be dropped.
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select(
        'id,staff_profile_id,status,scheduled_start_at,scheduled_end_at,shift_breaks(started_at,ended_at,is_paid)',
      )
      .eq('business_id', businessId)
      .in('staff_profile_id', staffIds)
      .in('status', COUNTED_SHIFT_STATUSES)
      .lt('scheduled_start_at', toUtc)
      .gt('scheduled_end_at', fromUtc)
      .returns<ShiftRow[]>();
    if (error) {
      this.logger.error(`fetchShifts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load rota shifts for payroll');
    }
    return data ?? [];
  }

  private async fetchAbsences(
    businessId: string,
    staffIds: string[],
    fromUtc: string,
    toUtc: string,
  ): Promise<AbsenceRow[]> {
    if (staffIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .select('staff_profile_id,starts_at,ends_at,absence_type,book_out_types(key)')
      .eq('business_id', businessId)
      .in('staff_profile_id', staffIds)
      .lt('starts_at', toUtc)
      .or(`ends_at.is.null,ends_at.gt.${fromUtc}`)
      .returns<AbsenceRow[]>();
    if (error) {
      this.logger.error(`fetchAbsences failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load absences for payroll');
    }
    return data ?? [];
  }

  private async fetchLeave(
    businessId: string,
    staffIds: string[],
    periodStart: string,
    periodEnd: string,
  ): Promise<LeaveRow[]> {
    if (staffIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select('staff_profile_id,start_date,end_date')
      .eq('business_id', businessId)
      .in('staff_profile_id', staffIds)
      .eq('status', 'approved')
      .lte('start_date', periodEnd)
      .gte('end_date', periodStart)
      .returns<LeaveRow[]>();
    if (error) {
      this.logger.error(`fetchLeave failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load leave for payroll');
    }
    return data ?? [];
  }

  private async fetchVisits(
    businessId: string,
    fromUtc: string,
    toUtc: string,
  ): Promise<VisitRow[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(
        'id,appointment_id,location_id,client_profile_id,primary_staff_profile_id,status,completed_at,rebooking_outcomes(id,rebooked_appointment_id)',
      )
      .eq('business_id', businessId)
      .eq('status', 'paid')
      .gte('completed_at', fromUtc)
      .lt('completed_at', toUtc)
      .returns<VisitRow[]>();
    if (error) {
      this.logger.error(`fetchVisits failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load visits for payroll');
    }
    return data ?? [];
  }

  private async fetchAppointmentServices(
    appointmentIds: string[],
  ): Promise<Map<string, AppointmentServiceRow[]>> {
    const byAppointment = new Map<string, AppointmentServiceRow[]>();
    if (appointmentIds.length === 0) return byAppointment;
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('id,appointment_id,service_name_snapshot,price_amount,assigned_staff_profile_id')
      .in('appointment_id', appointmentIds)
      .returns<AppointmentServiceRow[]>();
    if (error) {
      this.logger.error(`fetchAppointmentServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load appointment services for payroll');
    }
    for (const row of data ?? []) {
      const list = byAppointment.get(row.appointment_id) ?? [];
      list.push(row);
      byAppointment.set(row.appointment_id, list);
    }
    return byAppointment;
  }

  private async fetchVisitLineItems(visitIds: string[]): Promise<Map<string, VisitLineItemRow[]>> {
    const byVisit = new Map<string, VisitLineItemRow[]>();
    if (visitIds.length === 0) return byVisit;
    const { data, error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .select('visit_id,line_type,amount_cents,cost_amount_cents')
      .in('visit_id', visitIds)
      .returns<VisitLineItemRow[]>();
    if (error) {
      this.logger.error(`fetchVisitLineItems failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load visit line items for payroll');
    }
    for (const row of data ?? []) {
      const list = byVisit.get(row.visit_id) ?? [];
      list.push(row);
      byVisit.set(row.visit_id, list);
    }
    return byVisit;
  }

  private async fetchSalonPayments(visitIds: string[]): Promise<Map<string, number>> {
    const byVisit = new Map<string, number>();
    if (visitIds.length === 0) return byVisit;
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .select('visit_id,amount_cents')
      .in('visit_id', visitIds)
      .returns<SalonPaymentRow[]>();
    if (error) {
      this.logger.error(`fetchSalonPayments failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load payments for payroll');
    }
    for (const row of data ?? []) {
      byVisit.set(row.visit_id, (byVisit.get(row.visit_id) ?? 0) + numOrZero(row.amount_cents));
    }
    return byVisit;
  }

  private async fetchTaxSettings(
    businessId: string,
  ): Promise<Map<string, { displayMode: string; ratePercent: number }>> {
    const byLocation = new Map<string, { displayMode: string; ratePercent: number }>();
    const { data, error } = await this.admin
      .schema('billing')
      .from('tax_settings')
      .select('location_id,is_active,rate_percentage,display_mode')
      .eq('business_id', businessId)
      .returns<TaxSettingRow[]>();
    if (error) {
      this.logger.error(`fetchTaxSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load tax settings for payroll');
    }
    for (const row of data ?? []) {
      if (row.is_active !== true) continue;
      byLocation.set(row.location_id, {
        displayMode: row.display_mode ?? 'ex_tax',
        ratePercent: numOrZero(row.rate_percentage),
      });
    }
    return byLocation;
  }

  private async fetchRetail(
    businessId: string,
    fromUtc: string,
    toUtc: string,
  ): Promise<Map<string, number>> {
    const byStaff = new Map<string, number>();
    const { data, error } = await this.admin
      .schema('billing')
      .from('retail_sales')
      .select('staff_profile_id,total_amount_cents')
      .eq('business_id', businessId)
      .gte('sold_at', fromUtc)
      .lt('sold_at', toUtc);
    if (error) {
      this.logger.error(`fetchRetail failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load retail sales for payroll');
    }
    for (const row of data ?? []) {
      if (!row.staff_profile_id) continue;
      byStaff.set(
        row.staff_profile_id,
        (byStaff.get(row.staff_profile_id) ?? 0) + numOrZero(row.total_amount_cents),
      );
    }
    return byStaff;
  }

  private async fetchUnappliedAdjustments(
    businessId: string,
    staffIds: string[],
    excludeOriginPayPeriodId?: string,
  ): Promise<AdjustmentRow[]> {
    if (staffIds.length === 0) return [];
    let request = this.admin
      .schema('payroll')
      .from('pay_adjustments')
      .select('id,staff_profile_id,amount_cents,description,applied_at')
      .eq('business_id', businessId)
      .in('staff_profile_id', staffIds)
      .is('applied_at', null);
    if (excludeOriginPayPeriodId) {
      // .or() form: a bare .neq() would also drop NULL-origin rows.
      request = request.or(
        `origin_pay_period_id.is.null,origin_pay_period_id.neq.${excludeOriginPayPeriodId}`,
      );
    }
    const { data, error } = await request.returns<AdjustmentRow[]>();
    if (error) {
      this.logger.error(`fetchUnappliedAdjustments failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay adjustments');
    }
    return data ?? [];
  }

  private async fetchTrackingTargets(
    businessId: string,
    staffIds: string[],
    onDate: string,
  ): Promise<Map<string, number>> {
    const byStaff = new Map<string, number>();
    if (staffIds.length === 0) return byStaff;
    const { data, error } = await this.admin
      .schema('payroll')
      .from('targets')
      .select('staff_profile_id,amount_cents')
      .eq('business_id', businessId)
      .eq('scope', 'staff')
      .eq('metric', 'service_revenue')
      .in('staff_profile_id', staffIds)
      .lte('effective_from', onDate)
      .or(`effective_to.is.null,effective_to.gt.${onDate}`)
      .returns<TargetRow[]>();
    if (error) {
      this.logger.error(`fetchTrackingTargets failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load payroll targets');
    }
    for (const row of data ?? []) {
      if (row.staff_profile_id) byStaff.set(row.staff_profile_id, numOrZero(row.amount_cents));
    }
    return byStaff;
  }
}
