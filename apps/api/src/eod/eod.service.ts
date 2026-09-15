import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  EodDayResponse,
  EodReconciliation,
  ListEodDaysResponse,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { isSupportedTimeZone, utcToLocalDate } from '../payroll/period-dates';
import { MONEY_SOURCE, type MoneySource } from '../reports/money/money-source';
import type {
  AddEodPettyCashDto,
  OpenEodDayDto,
  UpdateEodDayDto,
} from './dto';

// The expected-figures window is still computed on a Europe/London day for every
// location (D-1 in docs/V1.1/week-8-r7-cash-up.md). Stored rows carry no marker
// of the zone that computed them, so switching this needs the approved
// source-versioning design first. "Today" (the default date and the future-day
// check) already uses the location's own timezone.
const EOD_TIMEZONE = 'Europe/London';

interface EodRow {
  id: string;
  business_id: string;
  location_id: string;
  business_date: string;
  status: 'open' | 'signed_off';
  opening_float_cents: number;
  expected_cash_cents: number | null;
  counted_cash_cents: number | null;
  expected_card_cents: number | null;
  counted_card_cents: number | null;
  unclassified_retail_cents: number;
  deposits_collected_cents: number;
  deposits_redeemed_cents: number;
  voids_cents: number;
  refunds_cents: number;
  petty_cash_out_cents: number;
  variance_cents: number | null;
  notes: string | null;
  signed_off_by_user_profile_id: string | null;
  signed_off_at: string | null;
  currency_code: string;
  created_at: string;
  updated_at: string;
}

interface PettyCashRow {
  id: string;
  eod_id: string;
  amount_cents: number;
  reason: string;
  recorded_by_user_profile_id: string | null;
  created_at: string;
}

interface ExpectedFiguresRow {
  expected_cash_cents: number | string;
  expected_card_cents: number | string;
  unclassified_retail_cents: number | string;
  deposits_collected_cents: number | string;
  deposits_redeemed_cents: number | string;
  open_visits: number | string;
}

const EOD_COLUMNS =
  'id,business_id,location_id,business_date,status,opening_float_cents,expected_cash_cents,counted_cash_cents,expected_card_cents,counted_card_cents,unclassified_retail_cents,deposits_collected_cents,deposits_redeemed_cents,voids_cents,refunds_cents,petty_cash_out_cents,variance_cents,notes,signed_off_by_user_profile_id,signed_off_at,currency_code,created_at,updated_at';
const PETTY_COLUMNS = 'id,eod_id,amount_cents,reason,recorded_by_user_profile_id,created_at';

/** A location of the actor's own business. */
interface EodLocation {
  id: string;
  timezone: string;
}

@Injectable()
export class EodService {
  private readonly logger = new Logger(EodService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
    // R1's authoritative location currency rule: settings row, else the
    // business default; an unusable code is never replaced by a guess.
    @Inject(MONEY_SOURCE) private readonly currencies: Pick<MoneySource, 'locationCurrencies'>,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Opens (or returns) the trading day for a location, auto-populating the
   * expected figures from the day's checkout records. Idempotent: opening an
   * already-open day just returns it — two receptionists can't fork a day.
   */
  async openDay(actor: AuthUser, input: OpenEodDayDto): Promise<EodDayResponse> {
    const location = await this.resolveLocation(actor, input.locationId);
    const today = locationToday(location);
    const businessDate = input.businessDate ?? today;
    if (businessDate > today) {
      throw new BadRequestException('This trading day has not started yet at this location');
    }

    const existing = await this.fetchDayRow(actor.businessId, input.locationId, businessDate);
    if (existing) return this.buildDayResponse(actor, existing);

    const currencyCode = await this.fetchLocationCurrency(actor.businessId, input.locationId);
    const expected = await this.fetchExpectedFigures(
      actor.businessId,
      input.locationId,
      businessDate,
    );
    const { data, error } = await this.admin
      .schema('billing')
      .from('eod_reconciliations')
      .insert({
        business_id: actor.businessId,
        location_id: input.locationId,
        business_date: businessDate,
        expected_cash_cents: expected.expectedCashCents,
        expected_card_cents: expected.expectedCardCents,
        unclassified_retail_cents: expected.unclassifiedRetailCents,
        deposits_collected_cents: expected.depositsCollectedCents,
        deposits_redeemed_cents: expected.depositsRedeemedCents,
        currency_code: currencyCode,
        opened_by_user_profile_id: actor.id,
      })
      .select(EOD_COLUMNS)
      .single<EodRow>();
    if (error || !data) {
      // A racing open hits unique(location_id, business_date) — return theirs.
      const raced = await this.fetchDayRow(actor.businessId, input.locationId, businessDate);
      if (raced) return this.buildDayResponse(actor, raced);
      this.logger.error(`openDay failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to open the trading day');
    }

    await this.audit.record(actor, {
      action: 'cashup.opened',
      entityType: 'cashup',
      entityId: data.id,
      locationId: input.locationId,
      after: {
        businessDate,
        expectedCashCents: expected.expectedCashCents,
        expectedCardCents: expected.expectedCardCents,
      },
    });
    return this.buildDayResponse(actor, data);
  }

  /** The day (or null when not yet opened) plus its live context. */
  async getDay(
    actor: AuthUser,
    locationId: string,
    businessDate?: string,
  ): Promise<EodDayResponse> {
    const location = await this.resolveLocation(actor, locationId);
    const date = businessDate ?? locationToday(location);
    const row = await this.fetchDayRow(actor.businessId, locationId, date);
    if (!row) {
      const [threshold, expected] = await Promise.all([
        this.fetchVarianceThresholdCents(actor.businessId, locationId),
        this.fetchExpectedFigures(actor.businessId, locationId, date),
      ]);
      return {
        day: null,
        openVisits: expected.openVisits,
        cashVarianceThresholdCents: threshold,
        notCaptured: NOT_CAPTURED,
      };
    }
    return this.buildDayResponse(actor, row);
  }

  async listDays(
    actor: AuthUser,
    locationId: string,
    limit = 30,
  ): Promise<ListEodDaysResponse> {
    await this.resolveLocation(actor, locationId);
    const { data, error } = await this.admin
      .schema('billing')
      .from('eod_reconciliations')
      .select(EOD_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('location_id', locationId)
      .order('business_date', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 90))
      .returns<EodRow[]>();
    if (error) {
      this.logger.error(`listDays failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load end-of-day history');
    }
    const rows = data ?? [];
    const petty = await this.fetchPettyCash(rows.map((row) => row.id));
    return { days: rows.map((row) => toEodReconciliation(row, petty.get(row.id) ?? [])) };
  }

  /**
   * Recomputes the expected side from the checkout records as they stand now
   * — the ticket's "completing/paying a visit updates that day's figures".
   */
  async refreshExpected(actor: AuthUser, id: string): Promise<EodDayResponse> {
    const { row } = await this.fetchDayById(actor, id);
    this.assertOpen(row);
    const updated = await this.applyExpected(row);
    return this.buildDayResponse(actor, updated);
  }

  async updateDay(actor: AuthUser, id: string, input: UpdateEodDayDto): Promise<EodDayResponse> {
    const { row } = await this.fetchDayById(actor, id);
    this.assertOpen(row);
    const patch: Record<string, unknown> = {};
    if (input.openingFloatCents !== undefined) patch.opening_float_cents = input.openingFloatCents;
    if (input.countedCashCents !== undefined) patch.counted_cash_cents = input.countedCashCents;
    if (input.countedCardCents !== undefined) patch.counted_card_cents = input.countedCardCents;
    if (input.voidsCents !== undefined) patch.voids_cents = input.voidsCents;
    if (input.refundsCents !== undefined) patch.refunds_cents = input.refundsCents;
    if (input.notes !== undefined) patch.notes = input.notes.trim() || null;
    if (Object.keys(patch).length === 0) return this.buildDayResponse(actor, row);

    const updated = await this.updateRow(row.id, patch);
    return this.buildDayResponse(actor, updated);
  }

  async addPettyCash(
    actor: AuthUser,
    id: string,
    input: AddEodPettyCashDto,
  ): Promise<EodDayResponse> {
    const { row } = await this.fetchDayById(actor, id);
    this.assertOpen(row);
    const { error } = await this.admin.schema('billing').from('eod_petty_cash_entries').insert({
      eod_id: row.id,
      amount_cents: input.amountCents,
      reason: input.reason.trim(),
      recorded_by_user_profile_id: actor.id,
    });
    if (error) {
      this.logger.error(`addPettyCash failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to record petty cash');
    }
    // Keep the denormalised header sum true to the entries. The entry is saved,
    // so a failed re-read must not write a total: the header keeps its last true
    // value and Refresh or sign-off re-reads the entries.
    let total: number;
    try {
      total = await this.fetchPettyCashTotal(row.id);
    } catch {
      throw new InternalServerErrorException(
        'Petty cash was recorded, but the day total could not be updated. Reload the day before adding it again.',
      );
    }
    const updated = await this.updateRow(row.id, { petty_cash_out_cents: total });

    await this.audit.record(actor, {
      action: 'petty_cash.recorded',
      entityType: 'cashup',
      entityId: row.id,
      locationId: row.location_id,
      after: { amountCents: input.amountCents, reason: input.reason.trim() },
    });
    return this.buildDayResponse(actor, updated);
  }

  /**
   * Freezes the day: one final expected recompute (so checkouts taken between
   * opening and signing are captured) and petty cash re-read from its entries,
   * then variance = counted − expected, status → signed_off, who/when stamped.
   * Signed-off days never change. A day that has not started at the location
   * cannot be signed off.
   */
  async signOff(actor: AuthUser, id: string): Promise<EodDayResponse> {
    const { row, location } = await this.fetchDayById(actor, id);
    this.assertOpen(row);
    if (row.business_date > locationToday(location)) {
      throw new BadRequestException('This trading day has not started yet at this location, so it cannot be signed off');
    }
    if (row.counted_cash_cents === null || row.counted_card_cents === null) {
      throw new BadRequestException('Enter the counted cash and card amounts before signing off');
    }
    const refreshed = await this.applyExpected(row);
    const variance =
      (refreshed.counted_cash_cents ?? 0) +
      (refreshed.counted_card_cents ?? 0) -
      ((refreshed.expected_cash_cents ?? 0) + (refreshed.expected_card_cents ?? 0));

    const updated = await this.updateRow(row.id, {
      status: 'signed_off',
      variance_cents: variance,
      signed_off_by_user_profile_id: actor.id,
      signed_off_at: new Date().toISOString(),
    });

    await this.audit.record(actor, {
      action: 'cashup.signed_off',
      entityType: 'cashup',
      entityId: row.id,
      locationId: row.location_id,
      after: {
        businessDate: row.business_date,
        varianceCents: variance,
        countedCashCents: refreshed.counted_cash_cents,
        countedCardCents: refreshed.counted_card_cents,
        expectedCashCents: refreshed.expected_cash_cents,
        expectedCardCents: refreshed.expected_card_cents,
        pettyCashOutCents: refreshed.petty_cash_out_cents,
      },
    });
    return this.buildDayResponse(actor, updated);
  }

  // -------------------------------------------------------------------------

  /**
   * Rewrites the derived figures: expected takings and the petty cash total from
   * its entries. Every read happens before the single write, so a failed read
   * changes nothing.
   */
  private async applyExpected(row: EodRow): Promise<EodRow> {
    const pettyCashOutCents = await this.fetchPettyCashTotal(row.id);
    const expected = await this.fetchExpectedFigures(
      row.business_id,
      row.location_id,
      row.business_date,
    );
    return this.updateRow(row.id, {
      expected_cash_cents: expected.expectedCashCents,
      expected_card_cents: expected.expectedCardCents,
      unclassified_retail_cents: expected.unclassifiedRetailCents,
      deposits_collected_cents: expected.depositsCollectedCents,
      deposits_redeemed_cents: expected.depositsRedeemedCents,
      petty_cash_out_cents: pettyCashOutCents,
    });
  }

  private async fetchExpectedFigures(
    businessId: string,
    locationId: string,
    businessDate: string,
  ): Promise<{
    expectedCashCents: number;
    expectedCardCents: number;
    unclassifiedRetailCents: number;
    depositsCollectedCents: number;
    depositsRedeemedCents: number;
    openVisits: number;
  }> {
    const window = businessDayWindow(businessDate);
    const { data, error } = await this.admin.schema('billing').rpc('eod_expected_figures', {
      p_business_id: businessId,
      p_location_id: locationId,
      p_day_start: window.start,
      p_day_end: window.end,
    });
    if (error) {
      this.logger.error(`eod_expected_figures failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to compute expected takings');
    }
    const row = (data as ExpectedFiguresRow[] | null)?.[0];
    return {
      expectedCashCents: Number(row?.expected_cash_cents ?? 0),
      expectedCardCents: Number(row?.expected_card_cents ?? 0),
      unclassifiedRetailCents: Number(row?.unclassified_retail_cents ?? 0),
      depositsCollectedCents: Number(row?.deposits_collected_cents ?? 0),
      depositsRedeemedCents: Number(row?.deposits_redeemed_cents ?? 0),
      openVisits: Number(row?.open_visits ?? 0),
    };
  }

  private async buildDayResponse(actor: AuthUser, row: EodRow): Promise<EodDayResponse> {
    const [petty, threshold, expected] = await Promise.all([
      this.fetchPettyCash([row.id]),
      this.fetchVarianceThresholdCents(row.business_id, row.location_id),
      this.fetchExpectedFigures(row.business_id, row.location_id, row.business_date),
    ]);
    return {
      day: toEodReconciliation(row, petty.get(row.id) ?? []),
      openVisits: expected.openVisits,
      cashVarianceThresholdCents: threshold,
      notCaptured: NOT_CAPTURED,
    };
  }

  private async fetchDayRow(
    businessId: string,
    locationId: string,
    businessDate: string,
  ): Promise<EodRow | null> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('eod_reconciliations')
      .select(EOD_COLUMNS)
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .eq('business_date', businessDate)
      .maybeSingle<EodRow>();
    if (error) {
      this.logger.error(`fetchDayRow failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load the trading day');
    }
    return data ?? null;
  }

  private async fetchDayById(actor: AuthUser, id: string): Promise<{ row: EodRow; location: EodLocation }> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('eod_reconciliations')
      .select(EOD_COLUMNS)
      .eq('id', id)
      .eq('business_id', actor.businessId)
      .maybeSingle<EodRow>();
    if (error) {
      this.logger.error(`fetchDayById failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load the trading day');
    }
    if (!data) throw new NotFoundException('Trading day not found');
    const location = await this.resolveLocation(actor, data.location_id);
    return { row: data, location };
  }

  private async updateRow(id: string, patch: Record<string, unknown>): Promise<EodRow> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('eod_reconciliations')
      .update(patch)
      .eq('id', id)
      .select(EOD_COLUMNS)
      .single<EodRow>();
    if (error || !data) {
      this.logger.error(`eod update failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to save the trading day');
    }
    return data;
  }

  private async fetchPettyCash(eodIds: string[]): Promise<Map<string, PettyCashRow[]>> {
    const byDay = new Map<string, PettyCashRow[]>();
    if (eodIds.length === 0) return byDay;
    const { data, error } = await this.admin
      .schema('billing')
      .from('eod_petty_cash_entries')
      .select(PETTY_COLUMNS)
      .in('eod_id', eodIds)
      .order('created_at', { ascending: true })
      .returns<PettyCashRow[]>();
    if (error) {
      // Never an empty list: that would read (and be summed) as no petty cash.
      this.logger.error(`fetchPettyCash failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load petty cash');
    }
    for (const row of data ?? []) {
      byDay.set(row.eod_id, [...(byDay.get(row.eod_id) ?? []), row]);
    }
    return byDay;
  }

  /** The sum of the day's petty cash entries; a failed read throws. */
  private async fetchPettyCashTotal(eodId: string): Promise<number> {
    const petty = await this.fetchPettyCash([eodId]);
    return (petty.get(eodId) ?? []).reduce((sum, entry) => sum + entry.amount_cents, 0);
  }

  private async fetchLocationCurrency(businessId: string, locationId: string): Promise<string> {
    const code = (await this.currencies.locationCurrencies(businessId, [locationId])).get(locationId);
    if (!code) {
      // Never the column's GBP default: a day in the wrong currency is worse than no day.
      throw new BadRequestException('Set the location’s currency before opening a trading day');
    }
    return code;
  }

  private async fetchVarianceThresholdCents(businessId: string, locationId: string): Promise<number> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('location_id,cash_variance_threshold_amount')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<{ cash_variance_threshold_amount: number | string }>();
    if (error) {
      this.logger.error(`fetchVarianceThresholdCents failed: ${error.message}`);
      return 500;
    }
    // Stored in major units (see 0053); default £5.
    const major = Number(data?.cash_variance_threshold_amount ?? 5);
    return Number.isFinite(major) ? Math.round(major * 100) : 500;
  }

  private assertOpen(row: EodRow): void {
    if (row.status === 'signed_off') {
      throw new ConflictException('This trading day has been signed off and can no longer change');
    }
  }

  /**
   * The same-business location boundary, for every actor, owners included: the
   * location must belong to the actor's business. A non-owner must also hold the
   * location. A location of another business and an unknown id get the same 403.
   */
  private async resolveLocation(actor: AuthUser, locationId: string): Promise<EodLocation> {
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,business_id,timezone')
      .eq('id', locationId)
      .eq('business_id', actor.businessId)
      .maybeSingle<{ id: string; business_id: string; timezone: string }>();
    if (error) {
      this.logger.error(`resolveLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load the location');
    }
    if (!data || data.business_id !== actor.businessId) {
      throw new ForbiddenException('Location is outside your scope');
    }
    return { id: data.id, timezone: data.timezone };
  }
}

/** Today's date at the location, YYYY-MM-DD, in the location's own timezone. */
function locationToday(location: EodLocation): string {
  if (!isSupportedTimeZone(location.timezone)) {
    throw new BadRequestException('The location’s timezone is not valid. Fix it in location settings first.');
  }
  return utcToLocalDate(location.timezone, Date.now());
}

// Categories the platform cannot feed automatically yet — surfaced honestly
// in the UI instead of silently reporting zero (mirrors the stance recorded
// in payroll.business_data_sources).
const NOT_CAPTURED = ['refunds', 'voids'];

function toEodReconciliation(row: EodRow, petty: PettyCashRow[]): EodReconciliation {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    businessDate: row.business_date,
    status: row.status,
    openingFloatCents: row.opening_float_cents,
    expectedCashCents: row.expected_cash_cents ?? undefined,
    countedCashCents: row.counted_cash_cents ?? undefined,
    expectedCardCents: row.expected_card_cents ?? undefined,
    countedCardCents: row.counted_card_cents ?? undefined,
    unclassifiedRetailCents: row.unclassified_retail_cents,
    depositsCollectedCents: row.deposits_collected_cents,
    depositsRedeemedCents: row.deposits_redeemed_cents,
    voidsCents: row.voids_cents,
    refundsCents: row.refunds_cents,
    pettyCashOutCents: row.petty_cash_out_cents,
    varianceCents: row.variance_cents ?? undefined,
    notes: row.notes ?? undefined,
    signedOffByUserProfileId: row.signed_off_by_user_profile_id ?? undefined,
    signedOffAt: row.signed_off_at ?? undefined,
    currencyCode: row.currency_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pettyCash: petty.map((entry) => ({
      id: entry.id,
      amountCents: entry.amount_cents,
      reason: entry.reason,
      recordedByUserProfileId: entry.recorded_by_user_profile_id ?? undefined,
      createdAt: entry.created_at,
    })),
  };
}

/**
 * The UTC instants bounding one location-local trading day. DST-safe: the
 * offset is derived per boundary date, so a 23h/25h changeover day still maps
 * to [local midnight, next local midnight).
 */
export function businessDayWindow(businessDate: string): { start: string; end: string } {
  return {
    start: zonedMidnightUtc(businessDate).toISOString(),
    end: zonedMidnightUtc(nextDate(businessDate)).toISOString(),
  };
}

function nextDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function zonedMidnightUtc(isoDate: string): Date {
  const probe = new Date(`${isoDate}T00:00:00.000Z`);
  return new Date(probe.getTime() - tzOffsetMinutes(probe, EOD_TIMEZONE) * 60_000);
}

/** Minutes the zone is ahead of UTC at the given instant. */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - at.getTime()) / 60_000;
}
