/**
 * Rule-based upsell suggestions — the canonical candidate selection (V1.1).
 *
 * ONE trustworthy answer to: "given what is on this booking or bill right now,
 * which add-ons should staff be offered, and why?" Booking and checkout both
 * consume THIS logic — neither may re-derive a recommendation of its own.
 *
 * DETERMINISTIC, NEVER PREDICTIVE. No ML, no LLM, no ZAC, no embeddings, no
 * "confidence". Every input is supplied by the caller, so these functions are
 * pure: no clock reads, no I/O, no natural language. The same rules + the same
 * history + the same context always produce the same ordered suggestions, which
 * is what makes the feature explainable to a salon owner and testable here.
 *
 * SUGGEST ONLY. Nothing in this file, or anything that consumes it, may add a
 * service, alter a booking, change a bill or charge a client. A suggestion is an
 * offer to a member of staff, who decides.
 *
 * ---------------------------------------------------------------------------
 * THE RULE (documented once, here)
 * ---------------------------------------------------------------------------
 * 1. TRIGGERS. A rule fires when the current context contains its trigger: the
 *    exact service (`trigger_type = 'service'`), or any service in its category
 *    (`'service_category'`). "Context" is the set of services already on the
 *    appointment, the draft booking or the bill.
 *
 * 2. SCOPE. A rule is business-wide (`locationId` null) or pinned to one
 *    location. Only rules for the acting location or business-wide ones are
 *    considered; a rule from another business or another location can never
 *    reach the context.
 *
 * 3. PRECEDENCE. Several rules can point at the SAME add-on. Exactly one of them
 *    decides its fate, chosen by this total order — the first difference wins:
 *
 *      a. location-scoped  beats  business-wide       (the salon's own override)
 *      b. service trigger  beats  category trigger    (the more specific intent)
 *      c. suppressed       beats  enabled             (an explicit "no" wins)
 *      d. higher priority  beats  lower
 *      e. older createdAt, then lower id              (pure tie-break)
 *
 *    (c) sits above (d) deliberately: priority ranks what is shown, it never
 *    decides whether something is shown. An owner who switched a rule off has
 *    said no, and no amount of priority on a competing rule overrides that.
 *
 * 4. SUPPRESSION. `enabled = false` is not merely "this rule is paused" — it
 *    suppresses the add-on for this trigger context in this scope ENTIRELY,
 *    including any historical pattern pointing at the same service. Wrike left
 *    this open (§17); this is the safe reading, because the alternative is a
 *    salon owner switching a suggestion off and watching it come straight back
 *    with a different label, which reads as the system ignoring them. The owner
 *    has the final say on what their salon recommends.
 *
 * 5. PATTERNS. A historical candidate is a plain count: of the completed
 *    appointments containing service A, how many also contained service B (see
 *    `booking.service_cooccurrence`, migration 0103, for the exact SQL). It
 *    survives only if it clears every threshold in {@link UPSELL_PATTERN_THRESHOLDS}
 *    and is not suppressed by (4).
 *
 * 6. MERGE. An owner rule and a pattern pointing at the same service are ONE
 *    suggestion, sourced `owner_rule_and_pattern`, carrying both the rule's
 *    identity and the pattern's evidence. Suggestions are never stacked.
 *
 * 7. ALREADY PRESENT. A service already in the context is never suggested. This
 *    also makes self-suggestion impossible, whatever the rule says.
 *
 * 8. RANKING. Owner-configured suggestions rank above pattern-only ones,
 *    because an owner's explicit intent outranks an inference. Within each
 *    band the order is fully specified (see {@link rankUpsellCandidates}), and
 *    the result is capped at {@link UPSELL_MAX_SUGGESTIONS}.
 */

// ---------------------------------------------------------------------------
// Thresholds & bounds
// ---------------------------------------------------------------------------

/**
 * The evidence a historical co-occurrence must show before it may be suggested.
 * Conservative V1.1 defaults, chosen so a brand-new salon (or a rarely-booked
 * service) produces NO pattern suggestions rather than confident-looking noise
 * from three appointments. No product decision existed when this was built, so
 * these are deliberately cautious and deliberately in ONE place: change them
 * here and every caller — API, SQL parameters and tests — follows.
 *
 * - `minBaseSample`   the trigger service must have been completed this many
 *                     times at all, or the rate below is meaningless.
 * - `minCooccurrence` the pair must have occurred this many times, so a single
 *                     coincidence can never clear the rate on a small base.
 * - `minRate`         the pair must represent at least this share of the base.
 * - `lookbackDays`    how far back evidence is read. Bounds the scan and stops
 *                     a service the salon dropped two years ago from being
 *                     suggested off stale history.
 */
export const UPSELL_PATTERN_THRESHOLDS = {
  minBaseSample: 10,
  minCooccurrence: 3,
  minRate: 0.2,
  lookbackDays: 365,
} as const;

/**
 * The most suggestions any context returns. Staff are mid-booking or mid-
 * checkout with a client in front of them; a list of fifteen add-ons is noise
 * they will scroll past. Enforced server-side, not just in the UI.
 */
export const UPSELL_MAX_SUGGESTIONS = 5;

/** Hard ceiling on services accepted as a draft-booking context, to bound the query. */
export const UPSELL_MAX_CONTEXT_SERVICES = 20;

// ---------------------------------------------------------------------------
// Rule model
// ---------------------------------------------------------------------------

export type UpsellRuleTriggerType = 'service' | 'service_category';

/** Where a suggestion came from. Shown to staff as plain language, never as a score. */
export type UpsellSuggestionSource = 'owner_rule' | 'booking_pattern' | 'owner_rule_and_pattern';

/** Which scope the deciding rule was configured at. */
export type UpsellRuleScope = 'business' | 'location';

/** One owner-configured add-on rule (`booking.upsell_rules`, migration 0103). */
export interface UpsellRule {
  id: string;
  businessId: string;
  /** null/undefined = business-wide default; set = that location only. */
  locationId?: string | null;
  name: string;
  /** false SUPPRESSES this add-on for this trigger in this scope — see rule (4). */
  enabled: boolean;
  triggerType: UpsellRuleTriggerType;
  triggerServiceId?: string | null;
  triggerServiceCategoryId?: string | null;
  suggestedServiceId: string;
  /** 0-1000, higher first. Ranks; never decides enable-vs-suppress. */
  priority: number;
  createdAt: string;
  updatedAt: string;
}

/** A rule joined to the names the owner UI displays. */
export interface UpsellRuleDetail extends UpsellRule {
  triggerServiceName?: string;
  triggerServiceCategoryName?: string;
  suggestedServiceName: string;
  locationName?: string;
}

/**
 * One raw co-occurrence count from `booking.service_cooccurrence`. Counts only —
 * the rate is derived, never stored.
 */
export interface UpsellPatternCandidate {
  triggerServiceId: string;
  suggestedServiceId: string;
  /** Completed appointments containing the trigger service. */
  baseCount: number;
  /** Of those, how many also contained the suggested service. */
  cooccurrenceCount: number;
}

/** A service already present on the booking / bill being considered. */
export interface UpsellContextService {
  serviceId: string;
  serviceCategoryId?: string | null;
}

// ---------------------------------------------------------------------------
// Candidates & suggestions
// ---------------------------------------------------------------------------

/**
 * A selected add-on before pricing and naming are attached. Carries its own
 * provenance so every suggestion can explain itself (Wrike §21).
 */
export interface UpsellCandidate {
  suggestedServiceId: string;
  source: UpsellSuggestionSource;
  /** The service IN THE CONTEXT that caused this suggestion. */
  triggerServiceId?: string;
  /** Set when an owner rule is involved. */
  ruleId?: string;
  ruleName?: string;
  ruleTriggerType?: UpsellRuleTriggerType;
  ruleScope?: UpsellRuleScope;
  /** The deciding rule's priority; 0 for a pattern-only candidate. */
  priority: number;
  /** Set when a historical pattern is involved. */
  supportCount?: number;
  baseCount?: number;
  /** `supportCount / baseCount`, rounded to 4dp. Reported, never stored. */
  coBookRate?: number;
}

/** A ranked candidate. `rank` is 1-based and stable for identical inputs. */
export interface RankedUpsellCandidate extends UpsellCandidate {
  rank: number;
}

/**
 * What booking and checkout render. Price and duration are resolved by the
 * canonical pricing path (per-stylist override where one exists, otherwise the
 * service base price) — the upsell engine chooses WHAT to suggest, never what
 * it costs.
 */
export interface UpsellSuggestion extends RankedUpsellCandidate {
  serviceId: string;
  name: string;
  categoryName?: string;
  serviceCategoryId?: string;
  priceAmount: number;
  currencyCode: string;
  durationMinutes: number;
  /** The service in the context this add-on was suggested for, for UI copy. */
  triggerServiceName?: string;
  /**
   * Staff-facing explanation. Deliberately plain — "Configured add-on for Full
   * Head Colour", never "AI recommends". Built by the API from the provenance
   * above so the wording lives in one place.
   */
  reason: string;
  /**
   * True when the assigned stylist's ability to perform this add-on could not be
   * confirmed (no stylist chosen yet). Staff still see the suggestion; the
   * existing booking flow resolves the stylist and the schedule when they add it.
   */
  requiresAvailabilityCheck: boolean;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface CollectUpsellCandidatesInput {
  /** The location being acted at. Rules for other locations are ignored. */
  locationId: string;
  /** Services already on the appointment / draft booking / bill. */
  contextServices: readonly UpsellContextService[];
  /** Candidate rules. Rules for another business must never be passed in. */
  rules: readonly UpsellRule[];
  /** Raw counts from `booking.service_cooccurrence`, already threshold-filtered. */
  patterns?: readonly UpsellPatternCandidate[];
}

interface RuleDecision {
  rule: UpsellRule;
  scope: UpsellRuleScope;
  /** The context service that matched this rule's trigger. */
  matchedTriggerServiceId: string;
}

/**
 * Does this rule apply at this location? Business-wide rules apply everywhere;
 * a location rule applies only at its own location.
 */
function ruleIsInScope(rule: UpsellRule, locationId: string): boolean {
  return !rule.locationId || rule.locationId === locationId;
}

function ruleScopeOf(rule: UpsellRule): UpsellRuleScope {
  return rule.locationId ? 'location' : 'business';
}

/**
 * The context service that fires this rule, or undefined if none does. For a
 * category trigger the FIRST matching context service (in the order given) is
 * reported, so the reason line names a real service the client is booked for.
 */
function matchTrigger(
  rule: UpsellRule,
  contextServices: readonly UpsellContextService[],
): string | undefined {
  if (rule.triggerType === 'service') {
    const match = contextServices.find((service) => service.serviceId === rule.triggerServiceId);
    return match?.serviceId;
  }
  const match = contextServices.find(
    (service) =>
      !!rule.triggerServiceCategoryId && service.serviceCategoryId === rule.triggerServiceCategoryId,
  );
  return match?.serviceId;
}

/**
 * Total order implementing precedence rule (3). Returns a negative number when
 * `a` should decide over `b`. Every comparison is on a defined value, so the
 * order is total and the result never depends on input sequence.
 */
function compareDecisions(a: RuleDecision, b: RuleDecision): number {
  // a. location-scoped beats business-wide.
  if (a.scope !== b.scope) return a.scope === 'location' ? -1 : 1;
  // b. an exact-service trigger beats a category trigger.
  if (a.rule.triggerType !== b.rule.triggerType) return a.rule.triggerType === 'service' ? -1 : 1;
  // c. an explicit "no" beats an enable at the same specificity.
  if (a.rule.enabled !== b.rule.enabled) return a.rule.enabled ? 1 : -1;
  // d. higher priority first.
  if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
  // e. pure tie-break: oldest rule, then lowest id.
  if (a.rule.createdAt !== b.rule.createdAt) return a.rule.createdAt < b.rule.createdAt ? -1 : 1;
  return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
}

/** `cooccurrenceCount / baseCount`, rounded to 4dp. 0 when there is no base. */
export function coBookRate(candidate: Pick<UpsellPatternCandidate, 'baseCount' | 'cooccurrenceCount'>): number {
  if (!candidate.baseCount || candidate.baseCount <= 0) return 0;
  return Math.round((candidate.cooccurrenceCount / candidate.baseCount) * 10_000) / 10_000;
}

/** True when a raw co-occurrence clears every configured evidence threshold. */
export function patternClearsThresholds(
  candidate: UpsellPatternCandidate,
  thresholds: typeof UPSELL_PATTERN_THRESHOLDS = UPSELL_PATTERN_THRESHOLDS,
): boolean {
  return (
    candidate.baseCount >= thresholds.minBaseSample &&
    candidate.cooccurrenceCount >= thresholds.minCooccurrence &&
    coBookRate(candidate) >= thresholds.minRate
  );
}

/**
 * Owner rules + historical patterns → one deduplicated candidate per add-on,
 * with suppression and already-booked exclusions applied. Unranked and
 * unfiltered by service eligibility: the caller checks that a candidate service
 * is active, in-business, available at the location and performable, because
 * only it can see the service catalogue. See rules (1)-(7) at the top.
 */
export function collectUpsellCandidates(input: CollectUpsellCandidatesInput): UpsellCandidate[] {
  const { locationId, contextServices, rules, patterns = [] } = input;
  const contextServiceIds = new Set(contextServices.map((service) => service.serviceId));

  // --- Owner rules: one deciding rule per suggested service (rule 3) ---------
  const decisionBySuggestedService = new Map<string, RuleDecision>();
  for (const rule of rules) {
    if (!ruleIsInScope(rule, locationId)) continue;
    const matchedTriggerServiceId = matchTrigger(rule, contextServices);
    if (!matchedTriggerServiceId) continue;

    const decision: RuleDecision = {
      rule,
      scope: ruleScopeOf(rule),
      matchedTriggerServiceId,
    };
    const incumbent = decisionBySuggestedService.get(rule.suggestedServiceId);
    if (!incumbent || compareDecisions(decision, incumbent) < 0) {
      decisionBySuggestedService.set(rule.suggestedServiceId, decision);
    }
  }

  const candidates = new Map<string, UpsellCandidate>();

  for (const [suggestedServiceId, decision] of decisionBySuggestedService) {
    // Rule (4): a suppressed relationship produces nothing, and blocks the
    // pattern engine below from reintroducing it.
    if (!decision.rule.enabled) continue;
    // Rule (7): never suggest what is already there (which also rules out
    // self-suggestion, whatever the rule says).
    if (contextServiceIds.has(suggestedServiceId)) continue;

    candidates.set(suggestedServiceId, {
      suggestedServiceId,
      source: 'owner_rule',
      triggerServiceId: decision.matchedTriggerServiceId,
      ruleId: decision.rule.id,
      ruleName: decision.rule.name,
      ruleTriggerType: decision.rule.triggerType,
      ruleScope: decision.scope,
      priority: decision.rule.priority,
    });
  }

  // --- Historical patterns --------------------------------------------------
  // Strongest evidence per suggested service wins; a pair the context triggers
  // twice (two trigger services both co-booked with it) is still one suggestion.
  for (const pattern of patterns) {
    const { suggestedServiceId } = pattern;
    if (contextServiceIds.has(suggestedServiceId)) continue;
    if (!contextServiceIds.has(pattern.triggerServiceId)) continue;

    const decision = decisionBySuggestedService.get(suggestedServiceId);
    // Rule (4) again: history may not override an owner's deliberate "no".
    if (decision && !decision.rule.enabled) continue;

    const rate = coBookRate(pattern);
    const existing = candidates.get(suggestedServiceId);

    if (!existing) {
      candidates.set(suggestedServiceId, {
        suggestedServiceId,
        source: 'booking_pattern',
        triggerServiceId: pattern.triggerServiceId,
        priority: 0,
        supportCount: pattern.cooccurrenceCount,
        baseCount: pattern.baseCount,
        coBookRate: rate,
      });
      continue;
    }

    // Rule (6): merge onto the existing candidate rather than stacking a
    // second one. Keep the strongest evidence when several pairs point here.
    if (existing.coBookRate !== undefined && existing.coBookRate >= rate) continue;
    existing.supportCount = pattern.cooccurrenceCount;
    existing.baseCount = pattern.baseCount;
    existing.coBookRate = rate;
    existing.source = existing.ruleId ? 'owner_rule_and_pattern' : 'booking_pattern';
    if (!existing.ruleId) existing.triggerServiceId = pattern.triggerServiceId;
  }

  return [...candidates.values()];
}

/**
 * Rule (8). Owner-configured suggestions first — an owner's explicit intent
 * outranks an inference drawn from history — then pattern-only ones. Within
 * each band: priority, then co-book rate, then support count, then service id.
 * Every tie-break is on a defined value, so the order is total: identical inputs
 * always produce identical output, whatever order they arrived in.
 */
export function rankUpsellCandidates(
  candidates: readonly UpsellCandidate[],
  limit: number = UPSELL_MAX_SUGGESTIONS,
): RankedUpsellCandidate[] {
  const ownerBand = (candidate: UpsellCandidate): number => (candidate.ruleId ? 0 : 1);

  return [...candidates]
    .sort((a, b) => {
      const band = ownerBand(a) - ownerBand(b);
      if (band !== 0) return band;
      if (a.priority !== b.priority) return b.priority - a.priority;
      const rateDelta = (b.coBookRate ?? 0) - (a.coBookRate ?? 0);
      if (rateDelta !== 0) return rateDelta;
      const supportDelta = (b.supportCount ?? 0) - (a.supportCount ?? 0);
      if (supportDelta !== 0) return supportDelta;
      return a.suggestedServiceId < b.suggestedServiceId
        ? -1
        : a.suggestedServiceId > b.suggestedServiceId
          ? 1
          : 0;
    })
    .slice(0, Math.max(0, limit))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/** Where the suggestions were asked for. Drives the staff-facing copy only. */
export type UpsellContextKind = 'booking' | 'checkout';

export interface UpsellSuggestionsResponse {
  contextKind: UpsellContextKind;
  locationId: string;
  /** Services the suggestions were derived from, for the UI's "for X" copy. */
  contextServiceIds: string[];
  suggestions: UpsellSuggestion[];
  /**
   * True when the historical pattern source was skipped or failed. Suggestions
   * from owner rules are still returned — an intelligence source going quiet
   * must degrade the list, never fail the request.
   */
  patternsUnavailable: boolean;
}

/** Draft (pre-save) booking context: staff are still choosing services. */
export interface DraftUpsellContextRequest {
  locationId: string;
  serviceIds: string[];
  /** The chosen stylist, when one has been chosen. Filters by capability. */
  staffProfileId?: string;
}

export interface ListUpsellRulesResponse {
  rules: UpsellRuleDetail[];
}

export interface UpsellRuleResponse {
  rule: UpsellRuleDetail;
}

export interface UpsertUpsellRuleRequest {
  name: string;
  locationId?: string | null;
  triggerType: UpsellRuleTriggerType;
  triggerServiceId?: string | null;
  triggerServiceCategoryId?: string | null;
  suggestedServiceId: string;
  priority?: number;
  enabled?: boolean;
}
