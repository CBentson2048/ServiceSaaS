import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  BirthdayCampaignConfig,
  CampaignType,
  ClientCompletedVisit,
  ClientFutureBooking,
  LapseDetectionSettings,
  LoyaltyMilestoneCampaignConfig,
  PromotionCampaignConfig,
  RebookingCampaignConfig,
  RetentionSettingsRecord,
} from '@sheer/domain';
import {
  birthdayDedupeKey,
  birthdayOccurrence,
  birthdaySendMatch,
  evaluateClientLapse,
  loyaltyDedupeKey,
  promotionDedupeKey,
  promotionWindowIsOpen,
  rebookingDedupeKey,
  resolveLapseDetectionSettings,
} from '@sheer/domain';
import type { CampaignRow } from './campaign-row';
import { campaignConfigOf } from './campaign-row';

/**
 * THE audience layer. One implementation, four typed strategies.
 *
 * Wrike section 14: the campaign type produces candidates; everything after that
 * is shared. Nothing here is duplicated per type, and — just as importantly —
 * nothing here re-implements a rule that already exists elsewhere:
 *
 *   "overdue"         -> evaluateClientLapse() in @sheer/domain (0097's rule).
 *   "attended visit"  -> the predicate inside crm.client_service_history /
 *                        comms.campaign_loyalty_metrics.
 *   "already booked"  -> crm.client_next_bookings, via evaluateClientLapse's
 *                        `booked` status.
 *   "may we message"  -> MessagingService (marketing consent + per-channel
 *                        opt-out + channel plan). NOT here. This service applies
 *                        only the cheap set-based marketing_opt_in pre-filter,
 *                        so that a client with consent withdrawn does not cost a
 *                        pointless queue write; the authoritative check still
 *                        happens in the messaging layer, at enqueue AND at send.
 *
 * READ-ONLY. This service writes nothing, sends nothing and has no side effects,
 * which is what lets the audience preview and the real evaluation share it
 * exactly (Wrike section 33) — the preview is this service with the enqueue step
 * simply not called.
 */

/** One client the campaign type has selected, with their send identity. */
export interface CampaignCandidate {
  clientId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  marketingOptIn: boolean;
  primaryLocationId: string | null;
  /** The deterministic idempotency key for THIS opportunity. */
  dedupeKey: string;
  /** Plain-language statement of why they matched, shown in the preview. */
  matchReason: string;
}

export interface CandidateResolution {
  candidates: CampaignCandidate[];
  /** True when the evidence load hit its bound and the audience is a partial view. */
  truncated: boolean;
}

/** PostgREST caps every response at 1000 rows (supabase/config.toml max_rows). */
const RPC_PAGE_SIZE = 1000;
/** Hard ceiling on clients evaluated for one campaign run. */
const MAX_EVALUATED_CLIENTS = 5000;
/** Client ids per upcoming-bookings call; half a page, so its result cannot be capped. */
const NEXT_BOOKING_BATCH = 500;

interface ServiceHistoryRow {
  client_profile_id: string;
  client_code: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  marketing_opt_in: boolean | null;
  primary_location_id: string | null;
  visits: RawVisit[] | null;
  service_rebooking_interval_days: number | string | null;
}

interface RawVisit {
  visitDate?: string;
  visitAt?: string;
  locationId?: string | null;
  services?: Array<{ serviceId?: string | null; serviceName?: string | null; serviceCategoryId?: string | null }> | null;
}

interface NextBookingRow {
  client_profile_id: string;
  appointment_id: string;
  scheduled_start_at: string;
  location_id: string | null;
}

interface LoyaltyMetricRow {
  client_profile_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  marketing_opt_in: boolean | null;
  primary_location_id: string | null;
  completed_visits: number | string;
  total_spend_cents: number | string;
}

interface BirthdayRow {
  client_profile_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  marketing_opt_in: boolean | null;
  primary_location_id: string | null;
  date_of_birth: string;
}

@Injectable()
export class CampaignAudienceService {
  private readonly logger = new Logger(CampaignAudienceService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Candidates for one campaign on one salon-local date.
   *
   * `todayLocalDate` is supplied by the caller, already resolved in the
   * campaign's governing timezone. This service never reads the clock for a
   * calendar decision, so a preview and the real run on the same day see exactly
   * the same audience.
   */
  async resolveCandidates(campaign: CampaignRow, todayLocalDate: string): Promise<CandidateResolution> {
    const locationIds = campaign.location_id ? [campaign.location_id] : null;

    switch (campaign.campaign_type as CampaignType) {
      case 'rebooking':
        return this.resolveRebooking(campaign, todayLocalDate, locationIds);
      case 'birthday':
        return this.resolveBirthday(campaign, todayLocalDate, locationIds);
      case 'promotion':
        return this.resolvePromotion(campaign, todayLocalDate, locationIds);
      case 'loyalty_milestone':
        return this.resolveLoyalty(campaign, locationIds);
      default:
        this.logger.error(`unknown campaign type ${campaign.campaign_type} on campaign ${campaign.id}`);
        return { candidates: [], truncated: false };
    }
  }

  // -------------------------------------------------------------------------
  // Rebooking — Wrike sections 9, 10, 40
  // -------------------------------------------------------------------------

  /**
   * Clients whose own cadence says they are due back and who have NO valid
   * upcoming appointment.
   *
   * Every part of that sentence is `evaluateClientLapse`'s to decide, not this
   * service's. In particular the `booked` status — which a valid future
   * appointment produces — is simply not in `targetStatuses`, and that is the
   * whole of "if the client already has an appropriate future appointment, do
   * not send". There is no second overdue calculation anywhere in this file.
   *
   * The send identity is the client's expected-return date, so a daily evaluator
   * messages once per rebooking cycle and not once per day.
   */
  private async resolveRebooking(
    campaign: CampaignRow,
    todayLocalDate: string,
    locationIds: string[] | null,
  ): Promise<CandidateResolution> {
    const config = campaignConfigOf(campaign) as RebookingCampaignConfig & { type: 'rebooking' };
    const targets = new Set(config.targetStatuses);

    const settings = await this.resolveLapseSettings(campaign.business_id, campaign.location_id);
    const { rows, truncated } = await this.fetchServiceHistory({
      businessId: campaign.business_id,
      timezone: campaign.timezone,
      locationIds,
      maxVisits: settings.historyVisitLimit,
    });
    if (rows.length === 0) return { candidates: [], truncated };

    const nextBookings = await this.fetchNextBookings(
      campaign.business_id,
      rows.map((row) => row.client_profile_id),
    );

    const candidates: CampaignCandidate[] = [];
    for (const row of rows) {
      const result = evaluateClientLapse({
        clientId: row.client_profile_id,
        businessId: campaign.business_id,
        locationId: row.primary_location_id,
        visits: toCompletedVisits(row.visits),
        nextBooking: nextBookings.get(row.client_profile_id) ?? null,
        serviceRebookingIntervalDays: toNullableNumber(row.service_rebooking_interval_days),
        today: todayLocalDate,
        timezone: campaign.timezone,
        settings,
      });

      if (!targets.has(result.status as 'lapsed' | 'at_risk')) continue;
      if (result.overdueDays < config.minOverdueDays) continue;
      if (config.serviceCategoryId && result.serviceCategoryId !== config.serviceCategoryId) continue;
      // No expected return means no opportunity to act on. Skipping is the only
      // honest option — a fabricated one would let the same client be messaged
      // again tomorrow.
      if (!result.expectedNextVisitAt) continue;
      // ...and no completed visit means no CYCLE to key on. The cycle identity
      // is the last completed visit, never the expected-return date, so an owner
      // editing a retention or rebooking-interval setting cannot re-arm someone
      // who has already been nudged this cycle.
      if (!result.lastCompletedVisitDate) continue;

      candidates.push({
        clientId: row.client_profile_id,
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        email: row.email,
        phone: row.phone,
        marketingOptIn: row.marketing_opt_in === true,
        primaryLocationId: row.primary_location_id,
        dedupeKey: rebookingDedupeKey(campaign.id, row.client_profile_id, result.lastCompletedVisitDate),
        matchReason:
          result.status === 'lapsed'
            ? `${result.overdueDays} days overdue (usually returns every ${result.usualIntervalDays} days)`
            : `Due back — ${result.overdueDays} day${result.overdueDays === 1 ? '' : 's'} past their usual ${result.usualIntervalDays}-day cadence`,
      });
    }

    return { candidates, truncated };
  }

  // -------------------------------------------------------------------------
  // Birthday — Wrike sections 11, 42
  // -------------------------------------------------------------------------

  /**
   * Clients whose birthday (or its configured lead time) lands on today's
   * SALON-LOCAL date.
   *
   * The target date is computed here, in salon-local calendar days, and handed
   * to SQL as a plain date. Nothing about this depends on the server's UTC
   * calendar. A 29 February birthday is observed on 28 February in a common
   * year, and the SQL and the TypeScript implement that identically —
   * `birthdayOccurrence` re-checks the SQL's answer below.
   */
  private async resolveBirthday(
    campaign: CampaignRow,
    todayLocalDate: string,
    locationIds: string[] | null,
  ): Promise<CandidateResolution> {
    const config = campaignConfigOf(campaign) as BirthdayCampaignConfig & { type: 'birthday' };
    const targetDate = addDays(todayLocalDate, config.daysBefore);

    const rows = await this.fetchAllPages<BirthdayRow>('campaign_birthday_candidates', {
      p_business_id: campaign.business_id,
      p_target_date: targetDate,
      p_location_ids: locationIds,
    });

    const candidates: CampaignCandidate[] = [];
    for (const row of rows) {
      // Re-derive the match in TypeScript rather than trusting the SQL alone.
      // The two implementations of the leap-day rule must agree, and this is
      // where a divergence would be caught rather than silently mis-sent.
      const match = birthdaySendMatch(row.date_of_birth, todayLocalDate, config.daysBefore);
      if (!match) continue;

      candidates.push({
        clientId: row.client_profile_id,
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        email: row.email,
        phone: row.phone,
        marketingOptIn: row.marketing_opt_in === true,
        primaryLocationId: row.primary_location_id,
        dedupeKey: birthdayDedupeKey(campaign.id, row.client_profile_id, match.birthdayYear),
        matchReason:
          config.daysBefore === 0
            ? `Birthday today (${match.birthdayDate})`
            : `Birthday in ${config.daysBefore} day${config.daysBefore === 1 ? '' : 's'} (${match.birthdayDate})`,
      });
    }

    return { candidates, truncated: rows.length >= MAX_EVALUATED_CLIENTS };
  }

  // -------------------------------------------------------------------------
  // Promotion — Wrike sections 12, 39
  // -------------------------------------------------------------------------

  /**
   * Owner-defined audience inside an explicit date window.
   *
   * The window is checked here as well as by the evaluator, so a promotion can
   * never send outside it by any path. The filters are a CONTROLLED set —
   * location, lapse status, service category, minimum completed visits — every
   * one of which is answered by evidence the platform already computes. There is
   * no query builder and no arbitrary filtering (Wrike section 12).
   *
   * Identity is one message per client per campaign, ever: editing a live
   * promotion re-targets nobody who has already had it.
   */
  private async resolvePromotion(
    campaign: CampaignRow,
    todayLocalDate: string,
    locationIds: string[] | null,
  ): Promise<CandidateResolution> {
    const config = campaignConfigOf(campaign) as PromotionCampaignConfig & { type: 'promotion' };
    if (!promotionWindowIsOpen(config, todayLocalDate)) return { candidates: [], truncated: false };

    const settings = await this.resolveLapseSettings(campaign.business_id, campaign.location_id);
    // READ ENOUGH VISITS TO ANSWER THE QUESTION THAT WAS ASKED.
    //
    // `historyVisitLimit` is a platform bound (10) chosen for cadence maths,
    // which never needs more. But the promotion filter below counts visits
    // against an OWNER-CONFIGURED floor, and a floor above the bound could never
    // be reached: a client with 12 completed visits returned 10, so
    // `minCompletedVisits: 12` silently matched nobody and the campaign looked
    // broken rather than misconfigured.
    //
    // Raise the read only as far as the configured floor actually requires, so
    // the default costs exactly what it did before and nothing loads lifetime
    // history. `promotionMinCompletedVisits` is CHECK-bounded, so this cannot be
    // driven arbitrarily high by configuration.
    const maxVisits = Math.max(settings.historyVisitLimit, config.minCompletedVisits);
    const { rows, truncated } = await this.fetchServiceHistory({
      businessId: campaign.business_id,
      timezone: campaign.timezone,
      locationIds,
      maxVisits,
    });
    if (rows.length === 0) return { candidates: [], truncated };

    const needsLapseStatus = (config.lapseStatuses?.length ?? 0) > 0;
    const nextBookings = needsLapseStatus
      ? await this.fetchNextBookings(campaign.business_id, rows.map((r) => r.client_profile_id))
      : new Map<string, ClientFutureBooking>();

    const wanted = new Set(config.lapseStatuses ?? []);
    const candidates: CampaignCandidate[] = [];

    for (const row of rows) {
      const visits = toCompletedVisits(row.visits);
      if (visits.length < config.minCompletedVisits) continue;

      // The lapse evaluation is only run when a filter actually needs it — a
      // plain "everyone" promotion does not pay for cadence maths it will ignore.
      let matchDetail = `${visits.length} completed visit${visits.length === 1 ? '' : 's'}`;
      if (needsLapseStatus || config.serviceCategoryId) {
        const result = evaluateClientLapse({
          clientId: row.client_profile_id,
          businessId: campaign.business_id,
          locationId: row.primary_location_id,
          visits,
          nextBooking: nextBookings.get(row.client_profile_id) ?? null,
          serviceRebookingIntervalDays: toNullableNumber(row.service_rebooking_interval_days),
          today: todayLocalDate,
          timezone: campaign.timezone,
          settings,
        });
        if (needsLapseStatus && !wanted.has(result.status as 'lapsed' | 'at_risk')) continue;
        if (config.serviceCategoryId && result.serviceCategoryId !== config.serviceCategoryId) continue;
        matchDetail = needsLapseStatus ? `${result.status.replace('_', ' ')}, ${matchDetail}` : matchDetail;
      }

      candidates.push({
        clientId: row.client_profile_id,
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        email: row.email,
        phone: row.phone,
        marketingOptIn: row.marketing_opt_in === true,
        primaryLocationId: row.primary_location_id,
        dedupeKey: promotionDedupeKey(campaign.id, row.client_profile_id),
        matchReason: `Matches the promotion audience (${matchDetail})`,
      });
    }

    return { candidates, truncated };
  }

  // -------------------------------------------------------------------------
  // Loyalty milestone — Wrike sections 13, 41
  // -------------------------------------------------------------------------

  /**
   * Clients who have REACHED the configured milestone.
   *
   * `>=` rather than `=` on purpose: a client who reached 10 visits while the
   * campaign was still a draft, or during an outage, should still be recognised
   * once the owner switches it on. Firing exactly once is the send ledger's job
   * (the milestone is in the dedupe key), not an equality test's — an equality
   * test would both miss people and still re-fire nobody, which is the worst of
   * both.
   *
   * The metrics come from `comms.campaign_loyalty_metrics`: the same attendance
   * predicate as lapse detection, and settled bills only, in integer pence.
   */
  private async resolveLoyalty(
    campaign: CampaignRow,
    locationIds: string[] | null,
  ): Promise<CandidateResolution> {
    const config = campaignConfigOf(campaign) as LoyaltyMilestoneCampaignConfig & {
      type: 'loyalty_milestone';
    };

    const rows = await this.fetchAllPages<LoyaltyMetricRow>('campaign_loyalty_metrics', {
      p_business_id: campaign.business_id,
      p_timezone: campaign.timezone,
      p_location_ids: locationIds,
    });

    const candidates: CampaignCandidate[] = [];
    for (const row of rows) {
      const visits = Number(row.completed_visits ?? 0);
      // Pence throughout. Integer comparison, no currency arithmetic, no floats.
      const spendCents = Number(row.total_spend_cents ?? 0);
      const value = config.metric === 'completed_visits' ? visits : spendCents;
      if (!Number.isFinite(value) || value < config.threshold) continue;

      candidates.push({
        clientId: row.client_profile_id,
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        email: row.email,
        phone: row.phone,
        marketingOptIn: row.marketing_opt_in === true,
        primaryLocationId: row.primary_location_id,
        dedupeKey: loyaltyDedupeKey(campaign.id, row.client_profile_id, config.metric, config.threshold),
        matchReason:
          config.metric === 'completed_visits'
            ? `Reached ${visits} completed visits (milestone ${config.threshold})`
            : `Reached ${formatMinor(spendCents)} of settled spend (milestone ${formatMinor(config.threshold)})`,
      });
    }

    return { candidates, truncated: rows.length >= MAX_EVALUATED_CLIENTS };
  }

  // -------------------------------------------------------------------------
  // Evidence loading — set-based, bounded, never one query per client
  // -------------------------------------------------------------------------

  private async fetchServiceHistory(input: {
    businessId: string;
    timezone: string;
    locationIds: string[] | null;
    maxVisits: number;
  }): Promise<{ rows: ServiceHistoryRow[]; truncated: boolean }> {
    const rows: ServiceHistoryRow[] = [];
    let offset = 0;

    for (;;) {
      const { data, error } = await this.admin.schema('crm').rpc('client_service_history', {
        p_business_id: input.businessId,
        p_timezone: input.timezone,
        p_client_ids: null,
        p_location_ids: input.locationIds,
        p_since: null,
        p_max_visits: input.maxVisits,
        p_limit: RPC_PAGE_SIZE,
        p_offset: offset,
      });

      if (error) throw new Error(`client_service_history failed: ${error.message}`);

      const batch = (data ?? []) as ServiceHistoryRow[];
      rows.push(...batch);
      if (batch.length < RPC_PAGE_SIZE) return { rows, truncated: false };

      offset += RPC_PAGE_SIZE;
      if (offset >= MAX_EVALUATED_CLIENTS) {
        this.logger.warn(
          `campaign audience hit the ${MAX_EVALUATED_CLIENTS}-client cap for business ${input.businessId}`,
        );
        return { rows, truncated: true };
      }
    }
  }

  /**
   * Valid upcoming appointments, batched.
   *
   * NOT fail-open. Treating a read error as "no upcoming booking" would mark
   * every already-booked client due and feed them to a rebooking campaign —
   * exactly the message Wrike section 9 forbids. A failed read fails the run.
   */
  private async fetchNextBookings(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, ClientFutureBooking>> {
    const byClient = new Map<string, ClientFutureBooking>();
    if (clientIds.length === 0) return byClient;

    for (let from = 0; from < clientIds.length; from += NEXT_BOOKING_BATCH) {
      const batch = clientIds.slice(from, from + NEXT_BOOKING_BATCH);
      const { data, error } = await this.admin.schema('crm').rpc('client_next_bookings', {
        p_business_id: businessId,
        p_client_ids: batch,
        p_location_ids: null,
        p_now: new Date().toISOString(),
        p_limit: RPC_PAGE_SIZE,
        p_offset: 0,
      });
      if (error) throw new Error(`client_next_bookings failed: ${error.message}`);

      for (const row of (data ?? []) as NextBookingRow[]) {
        byClient.set(row.client_profile_id, {
          appointmentId: row.appointment_id,
          scheduledStartAt: row.scheduled_start_at,
          locationId: row.location_id,
        });
      }
    }
    return byClient;
  }

  /** Drain a paged `comms` RPC up to the evaluation cap. */
  private async fetchAllPages<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
    const rows: T[] = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await this.admin
        .schema('comms')
        .rpc(fn, { ...args, p_limit: RPC_PAGE_SIZE, p_offset: offset });
      if (error) throw new Error(`${fn} failed: ${error.message}`);

      const batch = (data ?? []) as T[];
      rows.push(...batch);
      if (batch.length < RPC_PAGE_SIZE) return rows;

      offset += RPC_PAGE_SIZE;
      if (offset >= MAX_EVALUATED_CLIENTS) {
        this.logger.warn(`${fn} hit the ${MAX_EVALUATED_CLIENTS}-client cap`);
        return rows;
      }
    }
  }

  /**
   * The salon's lapse policy — location override, then business default, then
   * the platform default. Exactly the resolution ClientIntelligenceService
   * applies, so a rebooking campaign and the retention report can never disagree
   * about who is overdue.
   */
  private async resolveLapseSettings(
    businessId: string,
    locationId: string | null,
  ): Promise<LapseDetectionSettings> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('retention_settings')
      .select('id,business_id,location_id,lapsed_buffer_days,min_completed_visits')
      .eq('business_id', businessId)
      .returns<
        Array<{
          business_id: string;
          location_id: string | null;
          lapsed_buffer_days: number | string;
          min_completed_visits: number | string;
        }>
      >();

    if (error) throw new Error(`load retention settings failed: ${error.message}`);

    const records: RetentionSettingsRecord[] = (data ?? []).map((row) => ({
      businessId: row.business_id,
      locationId: row.location_id,
      lapsedBufferDays: Number(row.lapsed_buffer_days),
      minCompletedVisits: Number(row.min_completed_visits),
    }));
    return resolveLapseDetectionSettings(records, locationId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCompletedVisits(raw: RawVisit[] | null): ClientCompletedVisit[] {
  if (!Array.isArray(raw)) return [];
  const visits: ClientCompletedVisit[] = [];
  for (const entry of raw) {
    if (!entry?.visitDate || !entry.visitAt) continue;
    visits.push({
      visitDate: entry.visitDate,
      visitAt: entry.visitAt,
      locationId: entry.locationId ?? null,
      services: (entry.services ?? [])
        .filter((service) => Boolean(service?.serviceName))
        .map((service) => ({
          serviceId: service.serviceId ?? null,
          serviceName: service.serviceName as string,
          serviceCategoryId: service.serviceCategoryId ?? null,
        })),
    });
  }
  return visits;
}

/** Postgres numerics arrive as strings through PostgREST. */
function toNullableNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` local date. DST-safe by construction. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(
    at.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** Minor units to a readable amount. Display only — never used for comparison. */
function formatMinor(cents: number): string {
  return `£${(Math.round(cents) / 100).toFixed(2)}`;
}

/** Re-exported so the evaluator and the tests share one leap-day answer. */
export { birthdayOccurrence };
