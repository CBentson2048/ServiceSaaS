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
  ClientCompletedVisit,
  ClientFutureBooking,
  ClientLapseCounts,
  ClientLapseDetailResponse,
  ClientLapseStatus,
  ClientLapseSummary,
  LapseDetectionSettings,
  ListClientLapseResponse,
  RetentionSettingsRecord,
  RetentionSettingsResponse,
  RetentionSettingsScope,
} from '@sheer/domain';
import {
  DEFAULT_LAPSE_DETECTION_SETTINGS,
  LAPSE_SETTINGS_BOUNDS,
  evaluateClientLapse,
  resolveLapseDetectionSettings,
  userHasAnyRole,
  userHasRole,
} from '@sheer/domain';
import type { ListLapsedClientsQueryDto, UpsertRetentionSettingsDto } from './dto';

/**
 * Client Intelligence — lapsed-client detection.
 *
 * READ-ONLY BY DESIGN (apart from the retention-settings write). Detection never
 * messages a client, creates a campaign, edits a client record, books anything
 * or touches marketing consent. Observing and acting stay separate surfaces so
 * the later observe → understand → recommend → ask → act model holds.
 *
 * The cadence rule itself is NOT here — it is `evaluateClientLapse` in
 * @sheer/domain, the single canonical definition that campaigns, QLOOQO 10 and
 * (later) ZAC all consume. This service's whole job is to load the evidence
 * set-based, resolve the configured buffer, enforce tenancy, and hand both to
 * that function.
 *
 * NOTHING IS STORED. Status is computed on every read from live appointment
 * rows, so booking, cancelling, completing or re-statusing an appointment is
 * reflected on the very next call with no cache to invalidate.
 */

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
  services?: Array<{
    serviceId?: string | null;
    serviceName?: string | null;
    serviceCategoryId?: string | null;
  }> | null;
}

interface NextBookingRow {
  client_profile_id: string;
  appointment_id: string;
  scheduled_start_at: string;
  location_id: string | null;
}

interface ClientProfileRow {
  id: string;
  business_id: string;
  client_code: string;
  primary_location_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  marketing_opt_in: boolean;
}

interface RetentionSettingsRow {
  id: string;
  business_id: string;
  location_id: string | null;
  lapsed_buffer_days: number | string;
  min_completed_visits: number | string;
}

const CLIENT_COLUMNS =
  'id,business_id,client_code,primary_location_id,first_name,last_name,email,phone,marketing_opt_in';

const RETENTION_SETTINGS_COLUMNS =
  'id,business_id,location_id,lapsed_buffer_days,min_completed_visits';

/**
 * PostgREST truncates any response at `max_rows = 1000` (supabase/config.toml),
 * so the RPC is paged rather than called once. Five pages is the hard ceiling on
 * clients evaluated in a single list call — beyond it the response reports
 * `truncated: true` rather than silently answering from a partial set.
 */
const RPC_PAGE_SIZE = 1000;
const MAX_EVALUATED_CLIENTS = 5000;

/**
 * Client ids per upcoming-bookings call. Half a page, so the result — at most
 * one row per client — can never itself reach the 1000-row cap and be silently
 * truncated. `.rpc()` POSTs its arguments, so the id list is a JSON body rather
 * than a URL filter and carries no length hazard.
 */
const NEXT_BOOKING_BATCH = 500;

/**
 * How far back completed visits are read for the LIST view. A client who has not
 * been seen for years is long gone rather than "lapsing", and an unbounded scan
 * on every render is exactly what a retention report must not do. Overridable
 * per request (`lookbackDays`) and always echoed back, so the bound is visible
 * rather than silent. The single-client view applies no lookback at all.
 */
const DEFAULT_LOOKBACK_DAYS = 730;
const MAX_LOOKBACK_DAYS = 3650;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const STATUS_ORDER: Record<ClientLapseStatus, number> = {
  lapsed: 0,
  at_risk: 1,
  booked: 2,
  active: 3,
  insufficient_history: 4,
};

@Injectable()
export class ClientIntelligenceService {
  private readonly logger = new Logger(ClientIntelligenceService.name);
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
   * Lapse status for every client with completed history in scope.
   *
   * Cadence has to be computed for the whole scope before it can be filtered or
   * counted — a page of clients filtered afterwards would paginate over the
   * wrong set and under-report the counts. The evidence load is therefore
   * set-based and bounded (a fixed number of RPC pages, never one query per
   * client) and the filtering, sorting and paging happen on the computed result.
   */
  async listLapsedClients(
    actor: AuthUser,
    query: ListLapsedClientsQueryDto,
  ): Promise<ListClientLapseResponse> {
    this.assertIntelligenceAccess(actor);
    if (query.locationId) this.assertLocationScope(actor, query.locationId);

    const locationIds = this.resolveReadableLocationIds(actor, query.locationId);
    // A location override applies only when the effective scope IS one location
    // — an explicit `locationId`, or a manager who only has one. A business-wide
    // list is governed by the business-wide policy.
    const settingsLocationId = locationIds?.length === 1 ? locationIds[0] : null;
    const [settings, timezone] = await Promise.all([
      this.resolveSettings(actor.businessId, settingsLocationId),
      this.fetchBusinessTimezone(actor.businessId),
    ]);
    const today = localDateIn(timezone, new Date());

    const pageSize = clampInt(query.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const lookbackDays = clampInt(query.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1, MAX_LOOKBACK_DAYS);

    // A location-scoped actor with no locations can see nothing. Return the
    // empty shape rather than querying with an empty IN list.
    if (locationIds && locationIds.length === 0) {
      return emptyList(settings, page, pageSize);
    }

    const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
    const { rows: historyRows, truncated } = await this.fetchServiceHistory({
      businessId: actor.businessId,
      timezone,
      locationIds,
      since,
      maxVisits: settings.historyVisitLimit,
    });

    if (historyRows.length === 0) {
      return emptyList(settings, page, pageSize);
    }

    const clientIds = historyRows.map((row) => row.client_profile_id);
    const nextBookings = await this.fetchNextBookings(actor.businessId, clientIds);

    const summaries = historyRows.map((row) =>
      this.toSummary(profileFromHistory(actor.businessId, row), row, nextBookings.get(row.client_profile_id) ?? null, {
        timezone,
        today,
        settings,
      }),
    );

    const counts = countByStatus(summaries);
    const statuses = query.status?.length ? new Set(query.status) : null;
    const filtered = summaries.filter((summary) => {
      if (statuses && !statuses.has(summary.status)) return false;
      if (query.serviceId && summary.representativeServiceId !== query.serviceId) return false;
      if (query.serviceCategoryId && summary.serviceCategoryId !== query.serviceCategoryId) {
        return false;
      }
      return true;
    });

    // Most-overdue first within the most actionable status, then by name so the
    // order is total and a page boundary never wobbles between identical rows.
    filtered.sort((a, b) => {
      const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (byStatus !== 0) return byStatus;
      if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
      return a.displayName.localeCompare(b.displayName) || a.clientId.localeCompare(b.clientId);
    });

    const from = (page - 1) * pageSize;
    return {
      clients: filtered.slice(from, from + pageSize),
      counts,
      settings,
      truncated,
      evaluatedClientCount: summaries.length,
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
      },
    };
  }

  /** Lapse status for one client, with the full evidence trail. */
  async getClientLapseStatus(
    actor: AuthUser,
    clientId: string,
  ): Promise<ClientLapseDetailResponse> {
    this.assertIntelligenceAccess(actor);
    const profile = await this.fetchClientForActor(actor, clientId);

    const [settings, timezone] = await Promise.all([
      // The client's own location governs their buffer, when they have one.
      this.resolveSettings(actor.businessId, profile.primary_location_id ?? null),
      this.fetchBusinessTimezone(actor.businessId),
    ]);
    const today = localDateIn(timezone, new Date());

    // No lookback bound here: a single client's full recent history is cheap and
    // the profile view should show the real cadence, not a windowed one.
    const { rows } = await this.fetchServiceHistory({
      businessId: actor.businessId,
      timezone,
      clientIds: [clientId],
      maxVisits: settings.historyVisitLimit,
    });
    const nextBookings = await this.fetchNextBookings(actor.businessId, [clientId]);

    const history = rows.find((row) => row.client_profile_id === clientId) ?? emptyHistory(clientId);

    return {
      intelligence: this.toSummary(profile, history, nextBookings.get(clientId) ?? null, {
        timezone,
        today,
        settings,
      }),
      settings,
    };
  }

  /** The configured buffer, business default plus every location override. */
  async getRetentionSettings(actor: AuthUser): Promise<RetentionSettingsResponse> {
    this.assertIntelligenceAccess(actor);
    const rows = await this.fetchRetentionSettingsRows(actor.businessId);

    const configured: RetentionSettingsScope[] = rows.map((row) => ({
      locationId: row.locationId,
      lapsedBufferDays: row.lapsedBufferDays,
      minCompletedVisits: row.minCompletedVisits,
      configured: true,
    }));

    // Always surface the business-wide scope, even when unconfigured, so a
    // caller can see the platform defaults that are actually in force rather
    // than an empty list that reads as "no policy".
    if (!configured.some((scope) => scope.locationId === null)) {
      configured.unshift({
        locationId: null,
        lapsedBufferDays: DEFAULT_LAPSE_DETECTION_SETTINGS.lapsedBufferDays,
        minCompletedVisits: DEFAULT_LAPSE_DETECTION_SETTINGS.minCompletedVisits,
        configured: false,
      });
    }
    configured.sort((a, b) => {
      if (a.locationId === b.locationId) return 0;
      if (a.locationId === null) return -1;
      if (b.locationId === null) return 1;
      return a.locationId.localeCompare(b.locationId);
    });

    return { scopes: configured, defaults: { ...DEFAULT_LAPSE_DETECTION_SETTINGS } };
  }

  // -------------------------------------------------------------------------
  // The single write: retention policy
  // -------------------------------------------------------------------------

  /**
   * Set the buffer for a business or one of its locations. This is the only
   * write in the module, and it changes POLICY, never a client record.
   */
  async upsertRetentionSettings(
    actor: AuthUser,
    input: UpsertRetentionSettingsDto,
  ): Promise<RetentionSettingsResponse> {
    this.assertManagerOrOwner(actor);

    const locationId = input.locationId ?? null;
    if (locationId) {
      this.assertLocationScope(actor, locationId);
      await this.assertLocationBelongsToBusiness(actor.businessId, locationId);
    }

    const { lapsedBufferDays, minCompletedVisits } = input;
    assertInBounds('lapsedBufferDays', lapsedBufferDays, LAPSE_SETTINGS_BOUNDS.lapsedBufferDays);
    assertInBounds(
      'minCompletedVisits',
      minCompletedVisits,
      LAPSE_SETTINGS_BOUNDS.minCompletedVisits,
    );

    const { error } = await this.admin
      .schema('crm')
      .from('retention_settings')
      .upsert(
        {
          business_id: actor.businessId,
          location_id: locationId,
          lapsed_buffer_days: lapsedBufferDays,
          min_completed_visits: minCompletedVisits,
        },
        // Inferred against the `unique nulls not distinct (business_id,
        // location_id)` constraint from 0097, so the business-wide row (NULL
        // location) upserts as one row rather than accumulating duplicates.
        { onConflict: 'business_id,location_id' },
      );

    if (error) {
      this.logger.error(`upsertRetentionSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save retention settings');
    }

    return this.getRetentionSettings(actor);
  }

  // -------------------------------------------------------------------------
  // Evidence loading (set-based; never one query per client)
  // -------------------------------------------------------------------------

  private async fetchServiceHistory(input: {
    businessId: string;
    timezone: string;
    clientIds?: string[];
    locationIds?: string[];
    since?: string;
    maxVisits: number;
  }): Promise<{ rows: ServiceHistoryRow[]; truncated: boolean }> {
    const rows: ServiceHistoryRow[] = [];
    let offset = 0;

    // Bounded paging, not N+1: at most MAX_EVALUATED_CLIENTS / RPC_PAGE_SIZE
    // round trips regardless of how many clients the business has.
    for (;;) {
      const { data, error } = await this.admin.schema('crm').rpc('client_service_history', {
        p_business_id: input.businessId,
        p_timezone: input.timezone,
        p_client_ids: input.clientIds ?? null,
        p_location_ids: input.locationIds ?? null,
        p_since: input.since ?? null,
        p_max_visits: input.maxVisits,
        p_limit: RPC_PAGE_SIZE,
        p_offset: offset,
      });

      if (error) {
        this.logger.error(`client_service_history failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to load client service history');
      }

      const batch = (data ?? []) as ServiceHistoryRow[];
      rows.push(...batch);
      if (batch.length < RPC_PAGE_SIZE) return { rows, truncated: false };

      offset += RPC_PAGE_SIZE;
      if (offset >= MAX_EVALUATED_CLIENTS) {
        // A full final page does not by itself mean rows were dropped — the
        // business may have exactly the cap. One 1-row probe settles it, so
        // `truncated` is the truth rather than a conservative guess.
        const remaining = await this.probeForMoreHistory(input, offset);
        if (remaining) {
          this.logger.warn(
            `client_service_history hit the ${MAX_EVALUATED_CLIENTS}-client cap for business ${input.businessId}`,
          );
        }
        return { rows, truncated: remaining };
      }
    }
  }

  /** One row at `offset`: is there anything past the evaluation cap? */
  private async probeForMoreHistory(
    input: { businessId: string; timezone: string; clientIds?: string[]; locationIds?: string[]; since?: string; maxVisits: number },
    offset: number,
  ): Promise<boolean> {
    const { data, error } = await this.admin.schema('crm').rpc('client_service_history', {
      p_business_id: input.businessId,
      p_timezone: input.timezone,
      p_client_ids: input.clientIds ?? null,
      p_location_ids: input.locationIds ?? null,
      p_since: input.since ?? null,
      p_max_visits: input.maxVisits,
      p_limit: 1,
      p_offset: offset,
    });
    if (error) {
      // Unknown rather than proven-complete: say truncated, never claim
      // completeness the read could not establish.
      this.logger.error(`client_service_history truncation probe failed: ${error.message}`);
      return true;
    }
    return ((data ?? []) as unknown[]).length > 0;
  }

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

      if (error) {
        // Deliberately NOT fail-open. The rebooking-nudge suppression check can
        // safely treat an error as "not rebooked" (worst case: one extra
        // message). Here the same fallback would mark every already-booked
        // client lapsed and feed them to a win-back campaign, so a failed read
        // must fail the request instead.
        this.logger.error(`client_next_bookings failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to load upcoming appointments');
      }

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

  private async fetchClientForActor(actor: AuthUser, clientId: string): Promise<ClientProfileRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('id', clientId)
      .eq('business_id', actor.businessId)
      .is('merged_into_id', null)
      .maybeSingle<ClientProfileRow>();

    if (error) {
      this.logger.error(`fetchClientForActor failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load CRM client');
    }
    // Same message for "another tenant's client" and "no such client": a
    // distinguishable 403 would confirm the id exists somewhere.
    if (!data) throw new NotFoundException('CRM client not found');

    if (userHasRole(actor, 'owner')) return data;
    if (data.primary_location_id && actor.allowedLocationIds.includes(data.primary_location_id)) {
      return data;
    }
    throw new ForbiddenException('CRM client is outside your scope');
  }

  private async fetchBusinessTimezone(businessId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('timezone')
      .eq('id', businessId)
      .maybeSingle<{ timezone: string | null }>();

    if (error) {
      this.logger.error(`fetchBusinessTimezone failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load business settings');
    }
    // Retention is a business-wide question, so the business timezone anchors
    // "today" — using each location's own would make one client's status depend
    // on which branch they were last seen at.
    return data?.timezone ?? 'Europe/London';
  }

  private async fetchRetentionSettingsRows(
    businessId: string,
  ): Promise<RetentionSettingsRecord[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('retention_settings')
      .select(RETENTION_SETTINGS_COLUMNS)
      .eq('business_id', businessId)
      .returns<RetentionSettingsRow[]>();

    if (error) {
      this.logger.error(`fetchRetentionSettingsRows failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load retention settings');
    }

    return (data ?? []).map((row) => ({
      businessId: row.business_id,
      locationId: row.location_id,
      lapsedBufferDays: Number(row.lapsed_buffer_days),
      minCompletedVisits: Number(row.min_completed_visits),
    }));
  }

  /** Location override → business default → platform default. */
  private async resolveSettings(
    businessId: string,
    locationId: string | null,
  ): Promise<LapseDetectionSettings> {
    const rows = await this.fetchRetentionSettingsRows(businessId);
    return resolveLapseDetectionSettings(rows, locationId);
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private toSummary(
    profile: ClientProfileRow,
    history: ServiceHistoryRow,
    nextBooking: ClientFutureBooking | null,
    context: { timezone: string; today: string; settings: LapseDetectionSettings },
  ): ClientLapseSummary {
    const result = evaluateClientLapse({
      clientId: profile.id,
      businessId: profile.business_id,
      locationId: profile.primary_location_id,
      visits: toCompletedVisits(history.visits),
      nextBooking,
      serviceRebookingIntervalDays: toNullableNumber(history.service_rebooking_interval_days),
      today: context.today,
      timezone: context.timezone,
      settings: context.settings,
    });

    return {
      ...result,
      clientCode: profile.client_code,
      firstName: profile.first_name,
      lastName: profile.last_name,
      displayName: `${profile.first_name} ${profile.last_name}`.trim(),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.phone ? { phone: profile.phone } : {}),
      // Carried for the campaign layer to apply its own consent rules. Cadence
      // detection never encodes marketing policy — it only reports the facts.
      marketingOptIn: profile.marketing_opt_in,
    };
  }

  // -------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------

  /**
   * Client intelligence is a management surface: it exposes every client's
   * cadence across the whole business at once. Existing CRM permissions still
   * apply; role access is NOT widened just because the intelligence exists.
   */
  private assertIntelligenceAccess(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Client intelligence requires owner or manager access');
    }
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('This action requires owner or manager access');
    }
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your CRM scope');
    }
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

    if (error) {
      this.logger.error(`assertLocationBelongsToBusiness failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify location');
    }
    if (!data) throw new NotFoundException('Location not found');
  }

  /**
   * Undefined = no location filter (owners see the whole business). A non-owner
   * is always narrowed to their own locations, and an explicit `locationId` has
   * already been checked against that scope by the caller.
   */
  private resolveReadableLocationIds(actor: AuthUser, requested?: string): string[] | undefined {
    if (userHasRole(actor, 'owner')) return requested ? [requested] : undefined;
    return requested ? [requested] : actor.allowedLocationIds;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The client's display fields as the history RPC returned them. Reusing that row
 * keeps the list to one round trip and means the tenancy and tombstone filters
 * that produced it are the same ones that produced the visits.
 */
function profileFromHistory(businessId: string, row: ServiceHistoryRow): ClientProfileRow {
  return {
    id: row.client_profile_id,
    business_id: businessId,
    client_code: row.client_code ?? '',
    primary_location_id: row.primary_location_id,
    first_name: row.first_name ?? '',
    last_name: row.last_name ?? '',
    email: row.email,
    phone: row.phone,
    marketing_opt_in: row.marketing_opt_in ?? false,
  };
}

/** A client with no completed visits at all — honestly empty, not absent. */
function emptyHistory(clientId: string): ServiceHistoryRow {
  return {
    client_profile_id: clientId,
    client_code: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    marketing_opt_in: null,
    primary_location_id: null,
    visits: [],
    service_rebooking_interval_days: null,
  };
}

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

function countByStatus(summaries: readonly ClientLapseSummary[]): ClientLapseCounts {
  const counts: ClientLapseCounts = {
    active: 0,
    atRisk: 0,
    lapsed: 0,
    booked: 0,
    insufficientHistory: 0,
  };
  for (const summary of summaries) {
    if (summary.status === 'active') counts.active += 1;
    else if (summary.status === 'at_risk') counts.atRisk += 1;
    else if (summary.status === 'lapsed') counts.lapsed += 1;
    else if (summary.status === 'booked') counts.booked += 1;
    else counts.insufficientHistory += 1;
  }
  return counts;
}

function emptyList(
  settings: LapseDetectionSettings,
  page: number,
  pageSize: number,
): ListClientLapseResponse {
  return {
    clients: [],
    counts: { active: 0, atRisk: 0, lapsed: 0, booked: 0, insufficientHistory: 0 },
    settings,
    truncated: false,
    evaluatedClientCount: 0,
    pagination: { page, pageSize, total: 0, totalPages: 1 },
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function assertInBounds(
  field: string,
  value: number,
  bounds: { min: number; max: number },
): void {
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new BadRequestException(
      `${field} must be a whole number between ${bounds.min} and ${bounds.max}`,
    );
  }
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The salon-local calendar date of an instant. DST-safe: the conversion is done
 * by ICU rather than by subtracting a fixed offset, so a client whose expected
 * return straddles a BST/GMT switch never gains or loses a day.
 */
function localDateIn(timeZone: string, at: Date): string {
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timeZone, formatter);
  }
  // Read the PARTS rather than the formatted string: the exact separator and
  // field order en-CA emits varies between ICU builds, and this must produce
  // the same YYYY-MM-DD the SQL `at time zone ...::date` cast produces. Same
  // technique as apps/api/src/payroll/period-dates.ts (kept local because that
  // module is payroll-period specific).
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
