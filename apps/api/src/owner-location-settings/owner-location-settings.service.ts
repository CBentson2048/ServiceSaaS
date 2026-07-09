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
  AuthUser,
  CreateLocationFixedCostRequest,
  EffectiveFixedCostsResponse,
  FixedCostCadence,
  FixedCostCategory,
  LocationDepositType,
  LocationFixedCost,
  LocationOpeningHoursEntry,
  LocationRecordSettings,
  UpdateLocationFixedCostRequest,
  UpdateLocationRecordSettingsRequest,
} from '@sheer/domain';
import {
  defaultLocationRecordSettings,
  defaultOpeningHours,
  monthlyEquivalentFixedCost,
  userHasRole,
} from '@sheer/domain';

const SETTINGS_COLUMNS =
  'location_id,currency_code,opening_hours,chair_count,appointment_slot_minutes,default_deposit_type,default_deposit_value,discount_authorisation_threshold_percent,cash_variance_threshold_amount,colour_margin_target_percent,waste_allowance_percent,rebook_rate_benchmark_percent,utilisation_warning_threshold_percent,payroll_warning_percent,payroll_critical_percent,sunday_report_enabled,sunday_report_recipients,sunday_report_send_hour';

const FIXED_COST_COLUMNS =
  'id,location_id,category,label,amount,cadence,effective_from,effective_to,notes,created_at,updated_at';

interface SettingsRow {
  location_id: string;
  currency_code: string | null;
  opening_hours: unknown;
  chair_count: number | string | null;
  appointment_slot_minutes: number | string | null;
  default_deposit_type: LocationDepositType | null;
  default_deposit_value: number | string | null;
  discount_authorisation_threshold_percent: number | string | null;
  cash_variance_threshold_amount: number | string | null;
  colour_margin_target_percent: number | string | null;
  waste_allowance_percent: number | string | null;
  rebook_rate_benchmark_percent: number | string | null;
  utilisation_warning_threshold_percent: number | string | null;
  payroll_warning_percent: number | string | null;
  payroll_critical_percent: number | string | null;
  sunday_report_enabled: boolean | null;
  sunday_report_recipients: unknown;
  sunday_report_send_hour: number | string | null;
}

interface FixedCostRow {
  id: string;
  location_id: string;
  category: FixedCostCategory;
  label: string | null;
  amount: number | string | null;
  cadence: FixedCostCadence;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class OwnerLocationSettingsService {
  private readonly logger = new Logger(OwnerLocationSettingsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Record settings
  // ---------------------------------------------------------------------------

  async getSettings(actor: AuthUser, locationId: string): Promise<LocationRecordSettings> {
    this.assertManagementAccess(actor, locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, locationId);
    return this.resolveSettings(actor.businessId, locationId);
  }

  async updateSettings(
    actor: AuthUser,
    input: UpdateLocationRecordSettingsRequest,
  ): Promise<LocationRecordSettings> {
    this.assertManagementAccess(actor, input.locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, input.locationId);

    if (
      input.payrollWarningPercent !== undefined &&
      input.payrollCriticalPercent !== undefined &&
      input.payrollCriticalPercent < input.payrollWarningPercent
    ) {
      throw new BadRequestException(
        'payrollCriticalPercent must be greater than or equal to payrollWarningPercent',
      );
    }

    const patch: Record<string, unknown> = {
      business_id: actor.businessId,
      location_id: input.locationId,
    };
    if (input.openingHours !== undefined) patch.opening_hours = normalizeOpeningHours(input.openingHours);
    if (input.chairCount !== undefined) patch.chair_count = input.chairCount;
    if (input.appointmentSlotMinutes !== undefined) patch.appointment_slot_minutes = input.appointmentSlotMinutes;
    if (input.defaultDepositType !== undefined) patch.default_deposit_type = input.defaultDepositType;
    if (input.defaultDepositValue !== undefined) patch.default_deposit_value = input.defaultDepositValue;
    if (input.discountAuthorisationThresholdPercent !== undefined)
      patch.discount_authorisation_threshold_percent = input.discountAuthorisationThresholdPercent;
    if (input.cashVarianceThresholdAmount !== undefined)
      patch.cash_variance_threshold_amount = input.cashVarianceThresholdAmount;
    if (input.colourMarginTargetPercent !== undefined)
      patch.colour_margin_target_percent = input.colourMarginTargetPercent;
    if (input.wasteAllowancePercent !== undefined) patch.waste_allowance_percent = input.wasteAllowancePercent;
    if (input.rebookRateBenchmarkPercent !== undefined)
      patch.rebook_rate_benchmark_percent = input.rebookRateBenchmarkPercent;
    if (input.utilisationWarningThresholdPercent !== undefined)
      patch.utilisation_warning_threshold_percent = input.utilisationWarningThresholdPercent;
    if (input.payrollWarningPercent !== undefined) patch.payroll_warning_percent = input.payrollWarningPercent;
    if (input.payrollCriticalPercent !== undefined) patch.payroll_critical_percent = input.payrollCriticalPercent;
    if (input.sundayReportEnabled !== undefined) patch.sunday_report_enabled = input.sundayReportEnabled;
    if (input.sundayReportRecipients !== undefined)
      patch.sunday_report_recipients = normalizeRecipients(input.sundayReportRecipients);
    if (input.sundayReportSendHour !== undefined) patch.sunday_report_send_hour = input.sundayReportSendHour;

    // Deposit coherence: a 'none' deposit must carry a 0 value (DB check constraint).
    if (patch.default_deposit_type === 'none') patch.default_deposit_value = 0;

    const { error } = await this.admin
      .schema('core')
      .from('location_settings')
      .upsert(patch, { onConflict: 'location_id' });
    if (error) {
      this.logger.error(`updateSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update location settings');
    }

    return this.resolveSettings(actor.businessId, input.locationId);
  }

  private async resolveSettings(
    businessId: string,
    locationId: string,
  ): Promise<LocationRecordSettings> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select(SETTINGS_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<SettingsRow>();
    if (error) {
      this.logger.error(`resolveSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location settings');
    }
    return data ? toSettings(data) : defaultLocationRecordSettings(locationId);
  }

  // ---------------------------------------------------------------------------
  // Effective-dated fixed costs
  // ---------------------------------------------------------------------------

  async listFixedCosts(actor: AuthUser, locationId: string): Promise<LocationFixedCost[]> {
    this.assertManagementAccess(actor, locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, locationId);

    const { data, error } = await this.admin
      .schema('billing')
      .from('location_fixed_costs')
      .select(FIXED_COST_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('location_id', locationId)
      .order('effective_from', { ascending: false })
      .order('category', { ascending: true })
      .returns<FixedCostRow[]>();
    if (error) {
      this.logger.error(`listFixedCosts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load fixed costs');
    }
    return (data ?? []).map(toFixedCost);
  }

  async createFixedCost(
    actor: AuthUser,
    input: CreateLocationFixedCostRequest,
  ): Promise<LocationFixedCost> {
    this.assertManagementAccess(actor, input.locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, input.locationId);
    assertEffectiveRange(input.effectiveFrom, input.effectiveTo ?? null);

    const { data, error } = await this.admin
      .schema('billing')
      .from('location_fixed_costs')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId,
        category: input.category,
        label: input.label?.trim() || null,
        amount: input.amount,
        cadence: input.cadence ?? 'monthly',
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        notes: input.notes?.trim() || null,
      })
      .select(FIXED_COST_COLUMNS)
      .single<FixedCostRow>();
    if (error || !data) {
      this.logger.error(`createFixedCost failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create fixed cost');
    }
    return toFixedCost(data);
  }

  async updateFixedCost(
    actor: AuthUser,
    id: string,
    input: UpdateLocationFixedCostRequest,
  ): Promise<LocationFixedCost> {
    const existing = await this.fetchFixedCost(actor.businessId, id);
    this.assertManagementAccess(actor, existing.location_id);

    const nextFrom = input.effectiveFrom ?? existing.effective_from;
    const nextTo = input.effectiveTo !== undefined ? input.effectiveTo : existing.effective_to;
    assertEffectiveRange(nextFrom, nextTo ?? null);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.category !== undefined) patch.category = input.category;
    if (input.label !== undefined) patch.label = input.label?.trim() || null;
    if (input.amount !== undefined) patch.amount = input.amount;
    if (input.cadence !== undefined) patch.cadence = input.cadence;
    if (input.effectiveFrom !== undefined) patch.effective_from = input.effectiveFrom;
    if (input.effectiveTo !== undefined) patch.effective_to = input.effectiveTo;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

    const { data, error } = await this.admin
      .schema('billing')
      .from('location_fixed_costs')
      .update(patch)
      .eq('id', id)
      .eq('business_id', actor.businessId)
      .select(FIXED_COST_COLUMNS)
      .single<FixedCostRow>();
    if (error || !data) {
      this.logger.error(`updateFixedCost failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to update fixed cost');
    }
    return toFixedCost(data);
  }

  async deleteFixedCost(actor: AuthUser, id: string): Promise<void> {
    const existing = await this.fetchFixedCost(actor.businessId, id);
    this.assertManagementAccess(actor, existing.location_id);

    const { error } = await this.admin
      .schema('billing')
      .from('location_fixed_costs')
      .delete()
      .eq('id', id)
      .eq('business_id', actor.businessId);
    if (error) {
      this.logger.error(`deleteFixedCost failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete fixed cost');
    }
  }

  /** Fixed costs in force on a date, plus their monthly-equivalent total. */
  async getEffectiveFixedCosts(
    actor: AuthUser,
    locationId: string,
    date?: string,
  ): Promise<EffectiveFixedCostsResponse> {
    this.assertManagementAccess(actor, locationId);
    await this.assertLocationBelongsToBusiness(actor.businessId, locationId);

    const onDate = date ?? new Date().toISOString().slice(0, 10);

    const { data, error } = await this.admin
      .schema('billing')
      .from('location_fixed_costs')
      .select(FIXED_COST_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('location_id', locationId)
      .lte('effective_from', onDate)
      .or(`effective_to.is.null,effective_to.gt.${onDate}`)
      .order('category', { ascending: true })
      .returns<FixedCostRow[]>();
    if (error) {
      this.logger.error(`getEffectiveFixedCosts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve effective fixed costs');
    }

    const items = (data ?? []).map(toFixedCost);
    const monthlyEquivalentTotal = round2(
      items.reduce((sum, item) => sum + monthlyEquivalentFixedCost(item.amount, item.cadence), 0),
    );
    return { date: onDate, monthlyEquivalentTotal, items };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async fetchFixedCost(businessId: string, id: string): Promise<FixedCostRow> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('location_fixed_costs')
      .select(FIXED_COST_COLUMNS)
      .eq('id', id)
      .eq('business_id', businessId)
      .maybeSingle<FixedCostRow>();
    if (error) {
      this.logger.error(`fetchFixedCost failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load fixed cost');
    }
    if (!data) throw new NotFoundException('Fixed cost not found in your business');
    return data;
  }

  private async assertLocationBelongsToBusiness(
    businessId: string,
    locationId: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to verify location');
    if (!data) throw new BadRequestException('Location does not belong to this business');
  }

  private assertManagementAccess(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (userHasRole(actor, 'manager') && actor.allowedLocationIds.includes(locationId)) return;
    throw new ForbiddenException(
      'You do not have permission to manage settings for this location',
    );
  }
}

// ---------------------------------------------------------------------------
// Mapping / normalisation
// ---------------------------------------------------------------------------

function num(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSettings(row: SettingsRow): LocationRecordSettings {
  const fallback = defaultLocationRecordSettings(row.location_id, row.currency_code ?? 'GBP');
  return {
    locationId: row.location_id,
    currencyCode: row.currency_code ?? 'GBP',
    openingHours: parseOpeningHours(row.opening_hours),
    chairCount: num(row.chair_count, fallback.chairCount),
    appointmentSlotMinutes: num(row.appointment_slot_minutes, fallback.appointmentSlotMinutes),
    defaultDepositType: row.default_deposit_type ?? fallback.defaultDepositType,
    defaultDepositValue: num(row.default_deposit_value, fallback.defaultDepositValue),
    discountAuthorisationThresholdPercent: num(
      row.discount_authorisation_threshold_percent,
      fallback.discountAuthorisationThresholdPercent,
    ),
    cashVarianceThresholdAmount: num(row.cash_variance_threshold_amount, fallback.cashVarianceThresholdAmount),
    colourMarginTargetPercent: num(row.colour_margin_target_percent, fallback.colourMarginTargetPercent),
    wasteAllowancePercent: num(row.waste_allowance_percent, fallback.wasteAllowancePercent),
    rebookRateBenchmarkPercent: num(row.rebook_rate_benchmark_percent, fallback.rebookRateBenchmarkPercent),
    utilisationWarningThresholdPercent: num(
      row.utilisation_warning_threshold_percent,
      fallback.utilisationWarningThresholdPercent,
    ),
    payrollWarningPercent: num(row.payroll_warning_percent, fallback.payrollWarningPercent),
    payrollCriticalPercent: num(row.payroll_critical_percent, fallback.payrollCriticalPercent),
    sundayReportEnabled: row.sunday_report_enabled ?? fallback.sundayReportEnabled,
    sundayReportRecipients: parseRecipients(row.sunday_report_recipients),
    sundayReportSendHour: num(row.sunday_report_send_hour, fallback.sundayReportSendHour),
  };
}

function parseOpeningHours(value: unknown): LocationOpeningHoursEntry[] {
  if (!Array.isArray(value)) return defaultOpeningHours();
  const entries = value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      weekday: Number(entry.weekday),
      isOpen: Boolean(entry.isOpen),
      opensAt: String(entry.opensAt ?? '09:00'),
      closesAt: String(entry.closesAt ?? '18:00'),
    }))
    .filter((entry) => Number.isInteger(entry.weekday) && entry.weekday >= 0 && entry.weekday <= 6)
    .sort((a, b) => a.weekday - b.weekday);
  return entries.length > 0 ? entries : defaultOpeningHours();
}

function parseRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeOpeningHours(entries: LocationOpeningHoursEntry[]): LocationOpeningHoursEntry[] {
  return entries
    .slice()
    .sort((a, b) => a.weekday - b.weekday)
    .map((entry) => ({
      weekday: entry.weekday,
      isOpen: entry.isOpen,
      opensAt: entry.opensAt,
      closesAt: entry.closesAt,
    }));
}

function normalizeRecipients(recipients: string[]): string[] {
  return [...new Set(recipients.map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

function toFixedCost(row: FixedCostRow): LocationFixedCost {
  return {
    id: row.id,
    locationId: row.location_id,
    category: row.category,
    label: row.label,
    amount: num(row.amount, 0),
    cadence: row.cadence,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertEffectiveRange(from: string, to: string | null): void {
  if (to && to <= from) {
    throw new BadRequestException('effectiveTo must be after effectiveFrom');
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
