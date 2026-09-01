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
  UpsellCandidate,
  UpsellContextKind,
  UpsellContextService,
  UpsellPatternCandidate,
  UpsellRule,
  UpsellSuggestion,
  UpsellSuggestionsResponse,
} from '@sheer/domain';
import {
  UPSELL_MAX_CONTEXT_SERVICES,
  UPSELL_MAX_SUGGESTIONS,
  UPSELL_PATTERN_THRESHOLDS,
  collectUpsellCandidates,
  rankUpsellCandidates,
  userHasRole,
} from '@sheer/domain';
import type { DraftUpsellContextDto } from './dto';

/**
 * UpsellSuggestionService — the ONE deterministic add-on recommender.
 *
 * Booking and checkout both call this; neither holds recommendation logic of
 * its own. The pipeline is exactly the one the ticket specifies:
 *
 *   context → owner rules + booking patterns → eligibility → dedup → rank → suggestions
 *
 * and the middle of it (precedence, suppression, merge, ranking) is NOT here —
 * it is `collectUpsellCandidates` / `rankUpsellCandidates` in @sheer/domain, so
 * the rules are pure, unit-testable and impossible for a second caller to
 * re-derive differently. This service's job is the I/O either side: resolve the
 * context safely, load rules and history set-based, apply catalogue eligibility,
 * and attach canonical pricing.
 *
 * SUGGEST ONLY. There is not a single write in this file. It cannot add a
 * service, alter an appointment, touch a bill or charge anyone — staff add an
 * add-on through the existing booking/checkout flow, or it does not happen.
 *
 * NOT ON THE CRITICAL PATH. Nothing in booking or till calls this service:
 * the suggestion endpoints are separate, and the UI fetches them in their own
 * effect. If this service is slow, throws, or the whole module is removed,
 * appointments are still created and bills are still settled. That isolation is
 * structural, not a try/catch — see upsell-suggestion.service.spec.ts.
 */

interface ServiceRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  service_category_id: string | null;
  estimated_duration_minutes: number;
  base_price: number | string;
  is_active: boolean;
  service_categories: { name: string } | { name: string }[] | null;
}

interface AppointmentRow {
  id: string;
  business_id: string;
  location_id: string;
  assigned_staff_profile_id: string | null;
  appointment_services:
    | { service_id: string; status: string }[]
    | { service_id: string; status: string }
    | null;
}

interface RuleRow {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  enabled: boolean;
  trigger_type: 'service' | 'service_category';
  trigger_service_id: string | null;
  trigger_service_category_id: string | null;
  suggested_service_id: string;
  priority: number | string;
  created_at: string;
  updated_at: string;
}

interface CooccurrenceRow {
  trigger_service_id: string;
  suggested_service_id: string;
  base_count: number | string;
  cooccurrence_count: number | string;
}

interface EligibilityRow {
  service_id: string;
  price_amount: number | string | null;
}

const SERVICE_COLUMNS =
  'id,business_id,location_id,name,service_category_id,estimated_duration_minutes,base_price,is_active,service_categories(name)';

const RULE_COLUMNS =
  'id,business_id,location_id,name,enabled,trigger_type,trigger_service_id,trigger_service_category_id,suggested_service_id,priority,created_at,updated_at';

/** Appointment service lines that still count as "on the booking". */
const LIVE_LINE_STATUSES = new Set(['scheduled', 'in_progress', 'completed']);

@Injectable()
export class UpsellSuggestionService {
  private readonly logger = new Logger(UpsellSuggestionService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  /**
   * Suggestions for a persisted appointment — the booking screen and the
   * checkout panel both use this. The context (business, location, services,
   * stylist) is read from the appointment itself, never from the caller, so
   * there is no tenant id to spoof.
   *
   * `contextKind` only changes the staff-facing wording; the candidate set is
   * identical, because "what is already on this booking" and "what is already
   * on this bill" are the same set of appointment service lines.
   */
  async forAppointment(
    actor: AuthUser,
    appointmentId: string,
    contextKind: UpsellContextKind,
  ): Promise<UpsellSuggestionsResponse> {
    const appointment = await this.fetchAppointment(actor.businessId, appointmentId);
    this.assertLocationScope(actor, appointment.location_id);

    const lines = arrayOf(appointment.appointment_services).filter((line) =>
      LIVE_LINE_STATUSES.has(line.status),
    );
    const contextServiceIds = unique(lines.map((line) => line.service_id));

    return this.suggest({
      contextKind,
      businessId: actor.businessId,
      locationId: appointment.location_id,
      contextServiceIds,
      staffProfileId: appointment.assigned_staff_profile_id ?? undefined,
    });
  }

  /**
   * Suggestions for a booking that does not exist yet — staff are still picking
   * services on the New Booking screen. Only the location, the chosen services
   * and (optionally) the stylist come from the client; the business comes from
   * the token, the location is checked against the actor's scope, and every
   * service id is re-validated against that business and location before it is
   * treated as context.
   */
  async forDraft(actor: AuthUser, dto: DraftUpsellContextDto): Promise<UpsellSuggestionsResponse> {
    this.assertLocationScope(actor, dto.locationId);
    const contextServiceIds = unique(dto.serviceIds);
    if (contextServiceIds.length === 0) {
      throw new BadRequestException('At least one service is required');
    }
    if (contextServiceIds.length > UPSELL_MAX_CONTEXT_SERVICES) {
      throw new BadRequestException(
        `At most ${UPSELL_MAX_CONTEXT_SERVICES} services can be considered at once`,
      );
    }

    return this.suggest({
      contextKind: 'booking',
      businessId: actor.businessId,
      locationId: dto.locationId,
      contextServiceIds,
      staffProfileId: dto.staffProfileId,
    });
  }

  // --- The pipeline ---------------------------------------------------------

  private async suggest(input: {
    contextKind: UpsellContextKind;
    businessId: string;
    locationId: string;
    contextServiceIds: string[];
    staffProfileId?: string;
  }): Promise<UpsellSuggestionsResponse> {
    const { contextKind, businessId, locationId, contextServiceIds, staffProfileId } = input;

    // `contextServiceIds` on the response reports the services the suggestions
    // were actually DERIVED from, so it stays empty until the caller's ids have
    // been validated against the catalogue below — echoing back an id that
    // resolved to nothing would misreport what was considered.
    const empty: UpsellSuggestionsResponse = {
      contextKind,
      locationId,
      contextServiceIds: [],
      suggestions: [],
      patternsUnavailable: false,
    };
    if (contextServiceIds.length === 0) return empty;

    // 1. Resolve the context services THEMSELVES against the catalogue. A
    //    service id that is not this business's, or not offered at this
    //    location, contributes no context — so a caller cannot smuggle another
    //    salon's service in to fish for its rules.
    const contextServices = await this.fetchServices(businessId, locationId, contextServiceIds);
    if (contextServices.length === 0) return empty;

    const context: UpsellContextService[] = contextServices.map((row) => ({
      serviceId: row.id,
      serviceCategoryId: row.service_category_id,
    }));
    const contextIds = context.map((service) => service.serviceId);
    const categoryIds = unique(
      context.map((service) => service.serviceCategoryId).filter((id): id is string => !!id),
    );

    // 2. Candidate sources, loaded in parallel. Patterns are optional
    //    intelligence: if that read fails the owner's rules still answer.
    const [rules, patternResult] = await Promise.all([
      this.fetchRules(businessId, contextIds, categoryIds),
      this.fetchPatterns(businessId, contextIds),
    ]);

    // 3. Precedence, suppression, merge and already-booked exclusion — all in
    //    the pure domain layer.
    const candidates = collectUpsellCandidates({
      locationId,
      contextServices: context,
      rules,
      patterns: patternResult.patterns,
    });
    if (candidates.length === 0) {
      return { ...empty, contextServiceIds: contextIds, patternsUnavailable: patternResult.unavailable };
    }

    // 4. Eligibility, then ranking, then the bound. Filtering BEFORE the rank
    //    means an ineligible top candidate cannot consume one of the slots.
    const eligible = await this.filterEligible(businessId, locationId, candidates, staffProfileId);
    const ranked = rankUpsellCandidates(eligible.candidates, UPSELL_MAX_SUGGESTIONS);

    const currencyCode = await this.fetchCurrencyCode(businessId, locationId);
    const nameById = new Map(contextServices.map((row) => [row.id, row.name]));

    return {
      contextKind,
      locationId,
      contextServiceIds: contextIds,
      patternsUnavailable: patternResult.unavailable,
      suggestions: ranked.map((candidate) => {
        const service = eligible.serviceById.get(candidate.suggestedServiceId)!;
        const triggerServiceName = candidate.triggerServiceId
          ? nameById.get(candidate.triggerServiceId)
          : undefined;
        const suggestion: UpsellSuggestion = {
          ...candidate,
          serviceId: service.id,
          name: service.name,
          serviceCategoryId: service.service_category_id ?? undefined,
          categoryName: first(service.service_categories)?.name,
          priceAmount: eligible.priceById.get(service.id) ?? Number(service.base_price),
          currencyCode,
          durationMinutes: service.estimated_duration_minutes,
          triggerServiceName,
          reason: buildReason(candidate, triggerServiceName),
          // With no stylist chosen yet, capability and schedule fit are settled
          // by the booking flow when staff actually add the service.
          requiresAvailabilityCheck: !staffProfileId,
        };
        return suggestion;
      }),
    };
  }

  // --- Loads ----------------------------------------------------------------

  private async fetchAppointment(businessId: string, appointmentId: string): Promise<AppointmentRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,business_id,location_id,assigned_staff_profile_id,appointment_services(service_id,status)')
      .eq('id', appointmentId)
      .eq('business_id', businessId)
      .maybeSingle<AppointmentRow>();

    if (error) {
      this.logger.error(`fetchAppointment failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load appointment');
    }
    if (!data) throw new NotFoundException('Appointment not found');
    return data;
  }

  /**
   * The canonical "is this service offered here?" predicate, unchanged from the
   * booking engine: active, this business, and either unscoped or this
   * location's own. Upsell does not get its own availability rules.
   */
  private async fetchServices(
    businessId: string,
    locationId: string,
    serviceIds: string[],
  ): Promise<ServiceRow[]> {
    if (serviceIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('booking')
      .from('services')
      .select(SERVICE_COLUMNS)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .in('id', serviceIds)
      .or(`location_id.is.null,location_id.eq.${locationId}`)
      .returns<ServiceRow[]>();

    if (error) {
      this.logger.error(`fetchServices failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load services');
    }
    return data ?? [];
  }

  /**
   * Every rule this business has whose trigger is in the current context.
   * Disabled rules are loaded DELIBERATELY — they carry the owner's suppression
   * and the domain layer needs to see them to honour it.
   *
   * Only `business_id` and the trigger are filtered here. Location scoping is
   * left to `collectUpsellCandidates` (which re-checks it regardless, so it is
   * the real boundary) rather than chaining a second `.or()` — two `or` filters
   * on one PostgREST request combine in a way that is easy to get subtly wrong,
   * and a tenancy filter is not the place to rely on that. The extra rows are a
   * handful: rules for ONE business whose trigger is in THIS context.
   */
  private async fetchRules(
    businessId: string,
    contextServiceIds: string[],
    categoryIds: string[],
  ): Promise<UpsellRule[]> {
    const triggerFilters: string[] = [];
    if (contextServiceIds.length > 0) {
      triggerFilters.push(`trigger_service_id.in.(${contextServiceIds.join(',')})`);
    }
    if (categoryIds.length > 0) {
      triggerFilters.push(`trigger_service_category_id.in.(${categoryIds.join(',')})`);
    }
    if (triggerFilters.length === 0) return [];

    const { data, error } = await this.admin
      .schema('booking')
      .from('upsell_rules')
      .select(RULE_COLUMNS)
      .eq('business_id', businessId)
      .or(triggerFilters.join(','))
      .returns<RuleRow[]>();

    if (error) {
      this.logger.error(`fetchRules failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load upsell rules');
    }
    return (data ?? []).map(toRule);
  }

  /**
   * Historical co-occurrence for every context service in ONE call. Bounded by
   * the configured lookback and pruned by the configured thresholds inside the
   * function, so nothing unbounded crosses the wire.
   *
   * FAIL-SOFT. Patterns are optional intelligence: a failure here is logged and
   * reported as `patternsUnavailable`, and the owner's explicitly configured
   * rules still answer the request. It never throws.
   */
  private async fetchPatterns(
    businessId: string,
    contextServiceIds: string[],
  ): Promise<{ patterns: UpsellPatternCandidate[]; unavailable: boolean }> {
    if (contextServiceIds.length === 0) return { patterns: [], unavailable: false };

    const since = new Date(
      Date.now() - UPSELL_PATTERN_THRESHOLDS.lookbackDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    try {
      const { data, error } = await this.admin.schema('booking').rpc('service_cooccurrence', {
        p_business_id: businessId,
        p_trigger_service_ids: contextServiceIds,
        p_since: since,
        p_min_base_sample: UPSELL_PATTERN_THRESHOLDS.minBaseSample,
        p_min_cooccurrence: UPSELL_PATTERN_THRESHOLDS.minCooccurrence,
        p_min_rate: UPSELL_PATTERN_THRESHOLDS.minRate,
      });

      if (error) {
        this.logger.warn(`service_cooccurrence unavailable, using owner rules only: ${error.message}`);
        return { patterns: [], unavailable: true };
      }
      return {
        patterns: ((data ?? []) as CooccurrenceRow[]).map((row) => ({
          triggerServiceId: row.trigger_service_id,
          suggestedServiceId: row.suggested_service_id,
          baseCount: Number(row.base_count),
          cooccurrenceCount: Number(row.cooccurrence_count),
        })),
        unavailable: false,
      };
    } catch (err) {
      this.logger.warn(
        `service_cooccurrence threw, using owner rules only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { patterns: [], unavailable: true };
    }
  }

  /**
   * Catalogue + capability eligibility for the surviving candidates, in two
   * set-based reads — never one per candidate.
   *
   * A candidate is dropped unless the service is active, belongs to this
   * business and is offered at this location. When a stylist IS assigned, the
   * canonical staff/service eligibility table decides capability: an add-on the
   * assigned stylist cannot perform is not offered, because the existing
   * multi-service booking rule is that one stylist performs the whole
   * appointment. That same read carries the stylist's per-service price
   * override, so the effective price comes from the canonical pricing path
   * rather than being recomputed here.
   */
  private async filterEligible(
    businessId: string,
    locationId: string,
    candidates: UpsellCandidate[],
    staffProfileId?: string,
  ): Promise<{
    candidates: UpsellCandidate[];
    serviceById: Map<string, ServiceRow>;
    priceById: Map<string, number>;
  }> {
    const ids = candidates.map((candidate) => candidate.suggestedServiceId);
    const services = await this.fetchServices(businessId, locationId, ids);
    const serviceById = new Map(services.map((row) => [row.id, row]));

    const priceById = new Map<string, number>();
    let capableServiceIds: Set<string> | undefined;

    if (staffProfileId && services.length > 0) {
      const { data, error } = await this.admin
        .schema('booking')
        .from('staff_service_eligibility')
        .select('service_id,price_amount')
        .eq('business_id', businessId)
        .eq('staff_profile_id', staffProfileId)
        .in(
          'service_id',
          services.map((row) => row.id),
        )
        .returns<EligibilityRow[]>();

      if (error) {
        this.logger.error(`filterEligible staff capability read failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to load stylist eligibility');
      }
      capableServiceIds = new Set((data ?? []).map((row) => row.service_id));
      for (const row of data ?? []) {
        if (row.price_amount !== null) priceById.set(row.service_id, Number(row.price_amount));
      }
    }

    return {
      candidates: candidates.filter((candidate) => {
        if (!serviceById.has(candidate.suggestedServiceId)) return false;
        if (capableServiceIds && !capableServiceIds.has(candidate.suggestedServiceId)) return false;
        return true;
      }),
      serviceById,
      priceById,
    };
  }

  private async fetchCurrencyCode(businessId: string, locationId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,businesses!inner(default_currency_code),location_settings(currency_code)')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{
        businesses: { default_currency_code: string } | { default_currency_code: string }[] | null;
        location_settings: { currency_code: string } | { currency_code: string }[] | null;
      }>();

    if (error) {
      this.logger.error(`fetchCurrencyCode failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location currency');
    }
    return (
      first(data?.location_settings)?.currency_code ??
      first(data?.businesses)?.default_currency_code ??
      'GBP'
    );
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }
  }
}

/**
 * Staff-facing explanation. Deliberately plain operational language: this is
 * deterministic rule/history logic, and calling it "AI" would both mislead
 * staff and imply ZAC produced it.
 */
function buildReason(candidate: UpsellCandidate, triggerServiceName?: string): string {
  const forService = triggerServiceName ? ` for ${triggerServiceName}` : '';
  switch (candidate.source) {
    case 'owner_rule':
      return `Configured add-on${forService}`;
    case 'owner_rule_and_pattern':
      return `Configured add-on${forService} · frequently booked together`;
    case 'booking_pattern':
    default:
      return triggerServiceName
        ? `Frequently booked with ${triggerServiceName}`
        : 'Frequently booked together';
  }
}

function toRule(row: RuleRow): UpsellRule {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    name: row.name,
    enabled: row.enabled,
    triggerType: row.trigger_type,
    triggerServiceId: row.trigger_service_id,
    triggerServiceCategoryId: row.trigger_service_category_id,
    suggestedServiceId: row.suggested_service_id,
    priority: Number(row.priority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function first<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function arrayOf<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
