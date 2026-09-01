/**
 * The upsell selection matrix for the canonical logic (packages/domain
 * collectUpsellCandidates / rankUpsellCandidates). This is the definition proof:
 *
 *   trigger matches context      -> candidate
 *   rule disabled                -> SUPPRESSED, and the pattern engine cannot
 *                                   reintroduce the same add-on
 *   location rule                -> beats a business-wide rule
 *   service trigger              -> beats a category trigger
 *   suppression                  -> beats priority at the same specificity
 *   rule + pattern on one add-on -> ONE suggestion, merged provenance
 *   add-on already in context    -> never suggested (and so never itself)
 *   owner rules                  -> rank above pattern-only suggestions
 *
 * What these specs do NOT prove: that the SQL in 0103 counts the right
 * appointments (that is supabase/tests/upsell_suggestions.sql), or that the
 * service scopes its reads (upsell-suggestion.service.spec.ts). They pin the
 * precedence rules and the ordering.
 */
import {
  UPSELL_MAX_SUGGESTIONS,
  UPSELL_PATTERN_THRESHOLDS,
  coBookRate,
  collectUpsellCandidates,
  patternClearsThresholds,
  rankUpsellCandidates,
  type UpsellPatternCandidate,
  type UpsellRule,
} from '@sheer/domain';

const BUSINESS = 'biz-1';
const PINNER = 'loc-pinner';
const PRIMROSE = 'loc-primrose';

const COLOUR = 'svc-colour';
const TONER = 'svc-toner';
const TREATMENT = 'svc-treatment';
const BLOWDRY = 'svc-blowdry';
const CUT = 'svc-cut';
const COLOUR_CATEGORY = 'cat-colour';

function rule(overrides: Partial<UpsellRule> & Pick<UpsellRule, 'id' | 'suggestedServiceId'>): UpsellRule {
  return {
    businessId: BUSINESS,
    locationId: null,
    name: 'rule',
    enabled: true,
    triggerType: 'service',
    triggerServiceId: COLOUR,
    triggerServiceCategoryId: null,
    priority: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function pattern(
  suggestedServiceId: string,
  cooccurrenceCount: number,
  baseCount = 100,
  triggerServiceId = COLOUR,
): UpsellPatternCandidate {
  return { triggerServiceId, suggestedServiceId, baseCount, cooccurrenceCount };
}

/** A booking containing just Full Head Colour, at Pinner. */
const colourContext = [{ serviceId: COLOUR, serviceCategoryId: COLOUR_CATEGORY }];

describe('owner rules produce suggestions', () => {
  it('suggests the configured add-on when the trigger service is booked', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [rule({ id: 'r1', suggestedServiceId: TONER, name: 'Colour → Toner' })],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      suggestedServiceId: TONER,
      source: 'owner_rule',
      triggerServiceId: COLOUR,
      ruleId: 'r1',
      ruleName: 'Colour → Toner',
      ruleScope: 'business',
    });
  });

  it('suggests nothing when no rule trigger is in the booking', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: [{ serviceId: CUT, serviceCategoryId: 'cat-cutting' }],
      rules: [rule({ id: 'r1', suggestedServiceId: TONER })],
    });

    expect(candidates).toHaveLength(0);
  });

  it('fires a category-trigger rule for any service in that category', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: [{ serviceId: 'svc-balayage', serviceCategoryId: COLOUR_CATEGORY }],
      rules: [
        rule({
          id: 'r1',
          suggestedServiceId: TONER,
          triggerType: 'service_category',
          triggerServiceId: null,
          triggerServiceCategoryId: COLOUR_CATEGORY,
        }),
      ],
    });

    expect(candidates).toHaveLength(1);
    // The reason line must name a real service the client is booked for.
    expect(candidates[0].triggerServiceId).toBe('svc-balayage');
  });

  it('does not duplicate a candidate when two booked services both trigger it', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: [
        { serviceId: COLOUR, serviceCategoryId: COLOUR_CATEGORY },
        { serviceId: 'svc-highlights', serviceCategoryId: COLOUR_CATEGORY },
      ],
      rules: [
        rule({ id: 'r1', suggestedServiceId: TONER, triggerServiceId: COLOUR }),
        rule({ id: 'r2', suggestedServiceId: TONER, triggerServiceId: 'svc-highlights' }),
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].suggestedServiceId).toBe(TONER);
  });
});

describe('disabled rules stop producing suggestions', () => {
  it('returns nothing for a disabled rule', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [rule({ id: 'r1', suggestedServiceId: TONER, enabled: false })],
    });

    expect(candidates).toHaveLength(0);
  });

  it('SUPPRESSES the add-on so a historical pattern cannot reintroduce it', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [rule({ id: 'r1', suggestedServiceId: TONER, enabled: false })],
      // Overwhelming evidence — 80% co-book rate over 100 appointments.
      patterns: [pattern(TONER, 80)],
    });

    expect(candidates).toHaveLength(0);
  });

  it('suppresses only the disabled pair, leaving other patterns intact', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [rule({ id: 'r1', suggestedServiceId: TONER, enabled: false })],
      patterns: [pattern(TONER, 80), pattern(TREATMENT, 40)],
    });

    expect(candidates.map((candidate) => candidate.suggestedServiceId)).toEqual([TREATMENT]);
    expect(candidates[0].source).toBe('booking_pattern');
  });
});

describe('location vs business precedence', () => {
  it('lets a location rule suppress an inherited business-wide suggestion', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [
        rule({ id: 'biz', suggestedServiceId: TONER, locationId: null, enabled: true }),
        rule({ id: 'loc', suggestedServiceId: TONER, locationId: PINNER, enabled: false }),
      ],
    });

    expect(candidates).toHaveLength(0);
  });

  it('applies the business-wide rule at a location that has no override', () => {
    const candidates = collectUpsellCandidates({
      locationId: PRIMROSE,
      contextServices: colourContext,
      rules: [
        rule({ id: 'biz', suggestedServiceId: TONER, locationId: null, enabled: true }),
        rule({ id: 'loc', suggestedServiceId: TONER, locationId: PINNER, enabled: false }),
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleId).toBe('biz');
  });

  it('ignores another location’s rule entirely', () => {
    const candidates = collectUpsellCandidates({
      locationId: PRIMROSE,
      contextServices: colourContext,
      rules: [rule({ id: 'loc', suggestedServiceId: TONER, locationId: PINNER })],
    });

    expect(candidates).toHaveLength(0);
  });

  it('lets a location rule enable what the business default suppresses', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [
        rule({ id: 'biz', suggestedServiceId: TONER, locationId: null, enabled: false }),
        rule({ id: 'loc', suggestedServiceId: TONER, locationId: PINNER, enabled: true }),
      ],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleScope).toBe('location');
  });
});

describe('trigger specificity and suppression precedence', () => {
  it('lets a service-trigger rule beat a category-trigger rule at the same scope', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [
        rule({
          id: 'cat',
          suggestedServiceId: TONER,
          triggerType: 'service_category',
          triggerServiceId: null,
          triggerServiceCategoryId: COLOUR_CATEGORY,
          enabled: true,
        }),
        rule({ id: 'svc', suggestedServiceId: TONER, triggerServiceId: COLOUR, enabled: false }),
      ],
    });

    expect(candidates).toHaveLength(0);
  });

  it('puts suppression above priority at the same specificity', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: [
        { serviceId: COLOUR, serviceCategoryId: COLOUR_CATEGORY },
        { serviceId: 'svc-highlights', serviceCategoryId: COLOUR_CATEGORY },
      ],
      rules: [
        // Same scope, same trigger type, different trigger services — so only
        // enabled-vs-suppressed separates them. Priority must not save it.
        rule({ id: 'on', suggestedServiceId: TONER, triggerServiceId: COLOUR, priority: 1000 }),
        rule({
          id: 'off',
          suggestedServiceId: TONER,
          triggerServiceId: 'svc-highlights',
          enabled: false,
          priority: 0,
        }),
      ],
    });

    expect(candidates).toHaveLength(0);
  });

  it('is order-independent: the same rules in reverse decide identically', () => {
    const rules = [
      rule({ id: 'biz', suggestedServiceId: TONER, locationId: null, enabled: true, priority: 900 }),
      rule({ id: 'loc', suggestedServiceId: TONER, locationId: PINNER, enabled: false, priority: 1 }),
    ];
    const forwards = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules,
    });
    const backwards = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [...rules].reverse(),
    });

    expect(forwards).toEqual(backwards);
    expect(forwards).toHaveLength(0);
  });
});

describe('historical patterns', () => {
  it('produces a pattern-only candidate carrying its evidence', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [],
      patterns: [pattern(TREATMENT, 34, 100)],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      suggestedServiceId: TREATMENT,
      source: 'booking_pattern',
      supportCount: 34,
      baseCount: 100,
      coBookRate: 0.34,
      priority: 0,
    });
  });

  it('merges an owner rule and a pattern for the same add-on into ONE suggestion', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [rule({ id: 'r1', suggestedServiceId: TONER, priority: 50 })],
      patterns: [pattern(TONER, 35)],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      suggestedServiceId: TONER,
      source: 'owner_rule_and_pattern',
      ruleId: 'r1',
      priority: 50,
      supportCount: 35,
      coBookRate: 0.35,
    });
  });

  it('ignores a pattern whose trigger is not actually in the context', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [],
      patterns: [pattern(TREATMENT, 40, 100, CUT)],
    });

    expect(candidates).toHaveLength(0);
  });

  it('keeps the strongest evidence when two triggers both co-book the same add-on', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: [
        { serviceId: COLOUR, serviceCategoryId: COLOUR_CATEGORY },
        { serviceId: CUT, serviceCategoryId: 'cat-cutting' },
      ],
      rules: [],
      patterns: [pattern(BLOWDRY, 20, 100, COLOUR), pattern(BLOWDRY, 60, 100, CUT)],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ coBookRate: 0.6, triggerServiceId: CUT });
  });
});

describe('threshold arithmetic', () => {
  it('documents the V1.1 defaults', () => {
    expect(UPSELL_PATTERN_THRESHOLDS).toEqual({
      minBaseSample: 10,
      minCooccurrence: 3,
      minRate: 0.2,
      lookbackDays: 365,
    });
  });

  it('accepts 10 base / 5 co-booked (rate 0.5)', () => {
    expect(patternClearsThresholds(pattern(TONER, 5, 10))).toBe(true);
  });

  it('rejects 10 base / 1 co-booked: below the minimum co-occurrence', () => {
    expect(patternClearsThresholds(pattern(BLOWDRY, 1, 10))).toBe(false);
  });

  it('rejects 9 base: too little history to draw any conclusion from', () => {
    expect(patternClearsThresholds(pattern(TONER, 9, 9))).toBe(false);
  });

  it('rejects 100 base / 3 co-booked: clears the count but not the 20% rate', () => {
    expect(patternClearsThresholds(pattern(TONER, 3, 100))).toBe(false);
  });

  it('reports a rate of 0 rather than dividing by a zero base', () => {
    expect(coBookRate({ baseCount: 0, cooccurrenceCount: 4 })).toBe(0);
  });
});

describe('already-present exclusion', () => {
  it('does not suggest an add-on the booking already contains', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: [
        { serviceId: COLOUR, serviceCategoryId: COLOUR_CATEGORY },
        { serviceId: TONER, serviceCategoryId: COLOUR_CATEGORY },
      ],
      rules: [rule({ id: 'r1', suggestedServiceId: TONER })],
      patterns: [pattern(TONER, 80)],
    });

    expect(candidates).toHaveLength(0);
  });

  it('never lets a service suggest itself, even if a rule somehow says so', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [rule({ id: 'r1', suggestedServiceId: COLOUR, triggerServiceId: COLOUR })],
    });

    expect(candidates).toHaveLength(0);
  });
});

describe('ranking', () => {
  it('ranks owner-configured suggestions above pattern-only ones', () => {
    const ranked = rankUpsellCandidates(
      collectUpsellCandidates({
        locationId: PINNER,
        contextServices: colourContext,
        rules: [rule({ id: 'r1', suggestedServiceId: TONER, priority: 10 })],
        // A far stronger pattern still ranks below explicit owner intent.
        patterns: [pattern(TREATMENT, 90)],
      }),
    );

    expect(ranked.map((candidate) => candidate.suggestedServiceId)).toEqual([TONER, TREATMENT]);
    expect(ranked.map((candidate) => candidate.rank)).toEqual([1, 2]);
  });

  it('orders owner rules by priority, highest first', () => {
    const ranked = rankUpsellCandidates(
      collectUpsellCandidates({
        locationId: PINNER,
        contextServices: colourContext,
        rules: [
          rule({ id: 'low', suggestedServiceId: TONER, priority: 10 }),
          rule({ id: 'high', suggestedServiceId: TREATMENT, priority: 900 }),
        ],
      }),
    );

    expect(ranked.map((candidate) => candidate.suggestedServiceId)).toEqual([TREATMENT, TONER]);
  });

  it('orders pattern-only suggestions by co-book rate, then support count', () => {
    const ranked = rankUpsellCandidates(
      collectUpsellCandidates({
        locationId: PINNER,
        contextServices: colourContext,
        rules: [],
        patterns: [pattern(BLOWDRY, 30, 100), pattern(TREATMENT, 60, 100), pattern(TONER, 45, 100)],
      }),
    );

    expect(ranked.map((candidate) => candidate.suggestedServiceId)).toEqual([
      TREATMENT,
      TONER,
      BLOWDRY,
    ]);
  });

  it('bounds the list at UPSELL_MAX_SUGGESTIONS', () => {
    const patterns = Array.from({ length: 12 }, (_, index) =>
      pattern(`svc-${String(index).padStart(2, '0')}`, 90 - index, 100),
    );
    const ranked = rankUpsellCandidates(
      collectUpsellCandidates({
        locationId: PINNER,
        contextServices: colourContext,
        rules: [],
        patterns,
      }),
    );

    expect(ranked).toHaveLength(UPSELL_MAX_SUGGESTIONS);
    expect(ranked[0].suggestedServiceId).toBe('svc-00');
  });

  it('is stable: shuffled identical input produces identical output', () => {
    const candidates = collectUpsellCandidates({
      locationId: PINNER,
      contextServices: colourContext,
      rules: [
        rule({ id: 'a', suggestedServiceId: TONER, priority: 5 }),
        rule({ id: 'b', suggestedServiceId: TREATMENT, priority: 5 }),
      ],
      patterns: [pattern(BLOWDRY, 40), pattern(CUT, 40)],
    });

    const first = rankUpsellCandidates(candidates);
    const second = rankUpsellCandidates([...candidates].reverse());
    expect(second).toEqual(first);
  });
});
