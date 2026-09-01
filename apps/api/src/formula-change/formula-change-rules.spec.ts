/**
 * The pure formula-change rules in @sheer/domain.
 *
 * Deterministic and clock-free, so they can be asserted exactly. The cases that
 * matter most are the NEGATIVE ones: a bigger batch of the same recipe, a 2%
 * ratio tweak and a trace additive must all stay silent, because a flag stylists
 * learn to ignore is worse than no flag at all.
 *
 * The I/O half — comparable-history resolution, tenancy and settings — is in
 * formula-change.service.spec.ts; the database's own constraints are in
 * supabase/tests/formula_change_detection.sql.
 */
import {
  DEFAULT_FORMULA_CHANGE_THRESHOLDS,
  FORMULA_CHANGE_BOUNDS,
  compareFormulas,
  formulaComparabilityKey,
  noComparableFormula,
  parseDeveloperStrength,
  resolveFormulaChangeThresholds,
  validateFormulaChangeThresholds,
  type FormulaChangeThresholds,
  type FormulaComponentInput,
  type FormulaSnapshotInput,
} from '@sheer/domain';

const THRESHOLDS: FormulaChangeThresholds = { ...DEFAULT_FORMULA_CHANGE_THRESHOLDS };

/** `A 50` -> one component of product A at 50 units. */
function formula(
  components: Array<[string, number] | FormulaComponentInput>,
  overrides: Partial<FormulaSnapshotInput> = {},
): FormulaSnapshotInput {
  return {
    formulaId: overrides.formulaId ?? 'f1',
    savedAt: overrides.savedAt ?? '2026-08-01T10:00:00Z',
    comparabilityKey: 'permanent_colour',
    components: components.map((component) =>
      Array.isArray(component)
        ? { identity: `product:${component[0]}`, displayName: component[0], quantity: component[1] }
        : component,
    ),
    ...overrides,
  };
}

const reasonTypes = (assessment: ReturnType<typeof compareFormulas>) =>
  assessment.reasons.filter((r) => r.significant).map((r) => r.type);

// ---------------------------------------------------------------------------
// Normalisation — Wrike sections 7 and 50
// ---------------------------------------------------------------------------

describe('quantity normalisation', () => {
  it('does NOT flag a larger batch of the identical recipe', () => {
    // The headline false-positive this feature must never produce. 50/50 both
    // times: distance is exactly 0, not "different numbers therefore changed".
    const assessment = compareFormulas(formula([['A', 30], ['B', 30]]), formula([['A', 45], ['B', 45]]), THRESHOLDS);

    expect(assessment.significant).toBe(false);
    expect(assessment.severity).toBe('none');
    expect(assessment.reasons).toHaveLength(0);
  });

  it('does not flag a small ratio adjustment', () => {
    // 50/50 -> 48/52 is a 2% distance, far below the 30% threshold.
    const assessment = compareFormulas(formula([['A', 50], ['B', 50]]), formula([['A', 48], ['B', 52]]), THRESHOLDS);

    expect(assessment.significant).toBe(false);
    expect(assessment.severity).toBe('minor');
    expect(assessment.reasons[0]).toMatchObject({ type: 'formula_composition_shift', changePercent: 2 });
  });

  it('flags a genuine ratio swing past the threshold', () => {
    // 50/50 -> 80/20 is a 30% distance: exactly the default threshold.
    const assessment = compareFormulas(formula([['A', 50], ['B', 50]]), formula([['A', 80], ['B', 20]]), THRESHOLDS);

    expect(assessment.significant).toBe(true);
    expect(reasonTypes(assessment)).toContain('formula_composition_shift');
  });

  it('is scale-invariant: the same recipe at any batch size is distance 0', () => {
    for (const scale of [0.5, 2, 10, 33.333]) {
      const assessment = compareFormulas(
        formula([['A', 20], ['B', 60], ['C', 20]]),
        formula([['A', 20 * scale], ['B', 60 * scale], ['C', 20 * scale]]),
        THRESHOLDS,
      );
      expect(assessment.reasons).toHaveLength(0);
    }
  });

  it('handles fractional gram quantities exactly', () => {
    // numeric(12,3) values must not drift through floating point.
    const assessment = compareFormulas(
      formula([['A', 33.333], ['B', 66.667]]),
      formula([['A', 66.666], ['B', 133.334]]),
      THRESHOLDS,
    );
    expect(assessment.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit safety — Wrike section 8
// ---------------------------------------------------------------------------

describe('unit handling', () => {
  const grams = (id: string, quantity: number): FormulaComponentInput => ({
    identity: `product:${id}`,
    displayName: id,
    quantity,
    stockUnit: 'gram',
  });
  const millilitres = (id: string, quantity: number): FormulaComponentInput => ({
    identity: `product:${id}`,
    displayName: id,
    quantity,
    stockUnit: 'millilitre',
  });

  it('compares normally when every component shares one basis', () => {
    const assessment = compareFormulas(
      formula([grams('A', 50), grams('B', 50)]),
      formula([grams('A', 20), grams('B', 80)]),
      THRESHOLDS,
    );
    expect(assessment.dimensions.find((d) => d.dimension === 'composition')?.evaluated).toBe(true);
  });

  it('refuses to fabricate a total across incompatible units', () => {
    // Millilitres and grams do not convert without a density the catalogue does
    // not carry — the same rule inventory/unit-conversion.ts already enforces.
    const assessment = compareFormulas(
      formula([grams('A', 50), millilitres('B', 50)]),
      formula([grams('A', 20), millilitres('B', 80)]),
      THRESHOLDS,
    );

    const composition = assessment.dimensions.find((d) => d.dimension === 'composition');
    expect(composition?.evaluated).toBe(false);
    expect(composition?.unavailableReason).toBe('incompatible_units');
    expect(assessment.significant).toBe(false); // never guessed into a flag
  });

  it('reports a formula with no usable quantities rather than dividing by zero', () => {
    const assessment = compareFormulas(formula([['A', 0]]), formula([['A', 50]]), THRESHOLDS);
    const composition = assessment.dimensions.find((d) => d.dimension === 'composition');
    expect(composition?.evaluated).toBe(false);
    expect(composition?.unavailableReason).toBe('no_quantities_recorded');
  });
});

// ---------------------------------------------------------------------------
// Composition, additions and removals — Wrike sections 13, 14, 52
// ---------------------------------------------------------------------------

describe('product composition', () => {
  it('flags a full product replacement', () => {
    const assessment = compareFormulas(formula([['A', 50], ['B', 50]]), formula([['C', 60], ['B', 40]]), THRESHOLDS);
    expect(assessment.significant).toBe(true);
    expect(reasonTypes(assessment)).toContain('formula_composition_shift');
  });

  it('reaches distance 100% when nothing overlaps', () => {
    const assessment = compareFormulas(formula([['A', 100]]), formula([['Z', 100]]), THRESHOLDS);
    expect(assessment.reasons.find((r) => r.type === 'formula_composition_shift')?.changePercent).toBe(100);
  });

  it('does NOT flag a trace additive being dropped', () => {
    // 49/49/2 -> 50/50. C was 2% of the mix, far below materiality, and the
    // resulting distance is only 2%.
    const assessment = compareFormulas(
      formula([['A', 49], ['B', 49], ['C', 2]]),
      formula([['A', 50], ['B', 50]]),
      THRESHOLDS,
    );

    expect(assessment.significant).toBe(false);
    const removal = assessment.reasons.find((r) => r.type === 'material_product_removed');
    expect(removal?.significant).toBe(false);
    expect(removal?.componentSharePercent).toBe(2);
  });

  it('flags a material product being added', () => {
    const assessment = compareFormulas(
      formula([['A', 50], ['B', 50]]),
      formula([['A', 40], ['B', 40], ['C', 20]]),
      THRESHOLDS,
    );
    expect(assessment.significant).toBe(true);
    expect(reasonTypes(assessment)).toContain('material_product_added');
  });

  it('flags a material product being removed, quoting its OLD share', () => {
    const assessment = compareFormulas(
      formula([['A', 40], ['B', 40], ['C', 20]]),
      formula([['A', 50], ['B', 50]]),
      THRESHOLDS,
    );
    const removal = assessment.reasons.find((r) => r.type === 'material_product_removed');
    expect(removal?.significant).toBe(true);
    expect(removal?.componentSharePercent).toBe(20);
    expect(removal?.summary).toContain('was 20%');
  });

  it('applies materiality exactly at the threshold', () => {
    // 15% is the default materiality. A component at exactly 15% flags.
    const atThreshold = compareFormulas(
      formula([['A', 100]]),
      formula([['A', 85], ['C', 15]]),
      THRESHOLDS,
    );
    expect(atThreshold.reasons.find((r) => r.type === 'material_product_added')?.significant).toBe(true);

    // 14% does not flag on its own.
    const below = compareFormulas(formula([['A', 100]]), formula([['A', 86], ['C', 14]]), THRESHOLDS);
    expect(below.reasons.find((r) => r.type === 'material_product_added')?.significant).toBe(false);
  });

  it('matches components by stable identity, never by display name', () => {
    // Same product id, renamed in the catalogue since. Not a change.
    const previous = formula([
      { identity: 'product:A', displayName: 'Koleston 7/1', quantity: 50 },
      { identity: 'product:B', displayName: 'Welloxon', quantity: 50 },
    ]);
    const current = formula([
      { identity: 'product:A', displayName: 'Koleston Perfect 7/1 (2026)', quantity: 50 },
      { identity: 'product:B', displayName: 'Welloxon Perfect', quantity: 50 },
    ]);
    expect(compareFormulas(previous, current, THRESHOLDS).reasons).toHaveLength(0);
  });

  it('never merges a manual line with a catalogue product', () => {
    const previous = formula([{ identity: 'manual:wella|blondor', displayName: 'Blondor', quantity: 100 }]);
    const current = formula([{ identity: 'product:blondor-uuid', displayName: 'Blondor', quantity: 100 }]);
    // Same name, different identity namespace: this IS a change, not a match.
    expect(compareFormulas(previous, current, THRESHOLDS).significant).toBe(true);
  });

  it('sums duplicate lines of the same product before comparing', () => {
    const previous = formula([['A', 100]]);
    const current = formula([['A', 60], ['A', 40]]);
    expect(compareFormulas(previous, current, THRESHOLDS).reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Level and tone — Wrike sections 2, 37, 51, 53
// ---------------------------------------------------------------------------

describe('level and tone', () => {
  it('always reports level as unavailable, and never fabricates one', () => {
    // QLOOQO has no structured colour-level field. `shade` is free text and the
    // Lab app writes the product NAME into it on the catalogue path, so parsing
    // it would be guesswork wearing a number's clothes.
    const assessment = compareFormulas(formula([['A', 50]]), formula([['A', 50]]), THRESHOLDS);
    const level = assessment.dimensions.find((d) => d.dimension === 'level');

    expect(level?.evaluated).toBe(false);
    expect(level?.unavailableReason).toBe('no_structured_level_data');
    expect(assessment.reasons.some((r) => r.summary.toLowerCase().includes('level'))).toBe(false);
  });

  it('always reports tone as unavailable', () => {
    const assessment = compareFormulas(formula([['A', 50]]), formula([['A', 50]]), THRESHOLDS);
    const tone = assessment.dimensions.find((d) => d.dimension === 'tone');

    expect(tone?.evaluated).toBe(false);
    expect(tone?.unavailableReason).toBe('no_structured_tone_data');
  });

  it('states every dimension it considered, so the UI cannot imply a check it did not make', () => {
    const assessment = compareFormulas(formula([['A', 50]]), formula([['A', 50]]), THRESHOLDS);
    expect(assessment.dimensions.map((d) => d.dimension).sort()).toEqual([
      'composition',
      'developer',
      'level',
      'tone',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Developer — Wrike section 16
// ---------------------------------------------------------------------------

describe('developer strength', () => {
  const withDeveloper = (quantity: number, developer: string | null): FormulaComponentInput => ({
    identity: 'product:A',
    displayName: 'Colour',
    quantity,
    developer,
  });

  it('parses only unambiguous strengths', () => {
    expect(parseDeveloperStrength('20 vol')).toMatchObject({ value: 20, unit: 'vol' });
    expect(parseDeveloperStrength('20vol')).toMatchObject({ value: 20, unit: 'vol' });
    expect(parseDeveloperStrength('20 Volume')).toMatchObject({ value: 20, unit: 'vol' });
    expect(parseDeveloperStrength('6%')).toMatchObject({ value: 6, unit: 'percent' });

    // Anything ambiguous is refused rather than guessed.
    expect(parseDeveloperStrength('20-30 vol')).toBeNull();
    expect(parseDeveloperStrength('Welloxon Perfect')).toBeNull();
    expect(parseDeveloperStrength('as before')).toBeNull();
    expect(parseDeveloperStrength(null)).toBeNull();
  });

  it('flags a developer change at or above the threshold', () => {
    const assessment = compareFormulas(
      formula([withDeveloper(100, '20 vol')]),
      formula([withDeveloper(100, '40 vol')]),
      THRESHOLDS,
    );
    expect(assessment.significant).toBe(true);
    const reason = assessment.reasons.find((r) => r.type === 'developer_shift');
    expect(reason).toMatchObject({ previousDeveloper: '20 vol', currentDeveloper: '40 vol' });
  });

  it('treats exactly the threshold as significant', () => {
    // Default delta is 10 vol: 20 -> 30 flags.
    const at = compareFormulas(
      formula([withDeveloper(100, '20 vol')]),
      formula([withDeveloper(100, '30 vol')]),
      THRESHOLDS,
    );
    expect(at.significant).toBe(true);

    // 20 -> 29 is below it.
    const below = compareFormulas(
      formula([withDeveloper(100, '20 vol')]),
      formula([withDeveloper(100, '29 vol')]),
      THRESHOLDS,
    );
    expect(below.significant).toBe(false);
    expect(below.reasons.find((r) => r.type === 'developer_shift')?.significant).toBe(false);
  });

  it('uses the STRONGEST developer when a formula has several', () => {
    const previous = formula([
      { identity: 'product:A', displayName: 'A', quantity: 50, developer: '10 vol' },
      { identity: 'product:B', displayName: 'B', quantity: 50, developer: '20 vol' },
    ]);
    const current = formula([
      { identity: 'product:A', displayName: 'A', quantity: 50, developer: '10 vol' },
      { identity: 'product:B', displayName: 'B', quantity: 50, developer: '40 vol' },
    ]);
    expect(compareFormulas(previous, current, THRESHOLDS).significant).toBe(true);
  });

  it('reports unavailable when a developer is not recorded', () => {
    const assessment = compareFormulas(
      formula([withDeveloper(100, null)]),
      formula([withDeveloper(100, '40 vol')]),
      THRESHOLDS,
    );
    const developer = assessment.dimensions.find((d) => d.dimension === 'developer');
    expect(developer?.evaluated).toBe(false);
    expect(developer?.unavailableReason).toBe('no_developer_recorded');
  });

  it('reports unavailable rather than guessing an unreadable value', () => {
    const assessment = compareFormulas(
      formula([withDeveloper(100, 'Welloxon Perfect')]),
      formula([withDeveloper(100, '40 vol')]),
      THRESHOLDS,
    );
    expect(assessment.dimensions.find((d) => d.dimension === 'developer')?.unavailableReason).toBe(
      'developer_not_parseable',
    );
  });

  it('never converts volumes into percents', () => {
    // 6% and 20 vol are the same strength in trade practice, but applying that
    // factor silently is the same class of error as converting ml to grams.
    const assessment = compareFormulas(
      formula([withDeveloper(100, '6%')]),
      formula([withDeveloper(100, '20 vol')]),
      THRESHOLDS,
    );
    expect(assessment.dimensions.find((d) => d.dimension === 'developer')?.unavailableReason).toBe(
      'developer_units_incompatible',
    );
    expect(assessment.significant).toBe(false);
  });

  it('does not flag an unchanged developer', () => {
    const assessment = compareFormulas(
      formula([withDeveloper(100, '20 vol')]),
      formula([withDeveloper(100, '20 vol')]),
      THRESHOLDS,
    );
    expect(assessment.reasons.some((r) => r.type === 'developer_shift')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined significance and severity — Wrike sections 17, 42
// ---------------------------------------------------------------------------

describe('significance', () => {
  it('is an OR of explainable rules, not an opaque score', () => {
    // Composition alone is below threshold, but the developer alone is above it.
    const assessment = compareFormulas(
      formula([{ identity: 'product:A', displayName: 'A', quantity: 100, developer: '20 vol' }]),
      formula([{ identity: 'product:A', displayName: 'A', quantity: 100, developer: '40 vol' }]),
      THRESHOLDS,
    );
    expect(assessment.significant).toBe(true);
    expect(reasonTypes(assessment)).toEqual(['developer_shift']);
  });

  it('grades severity none / minor / significant', () => {
    expect(compareFormulas(formula([['A', 50]]), formula([['A', 50]]), THRESHOLDS).severity).toBe('none');
    expect(
      compareFormulas(formula([['A', 50], ['B', 50]]), formula([['A', 48], ['B', 52]]), THRESHOLDS).severity,
    ).toBe('minor');
    expect(
      compareFormulas(formula([['A', 50], ['B', 50]]), formula([['A', 90], ['B', 10]]), THRESHOLDS).severity,
    ).toBe('significant');
  });

  it('puts significant reasons first so the headline reads correctly', () => {
    const assessment = compareFormulas(
      formula([['A', 50], ['B', 50]]),
      formula([['A', 10], ['B', 50], ['C', 40]]),
      THRESHOLDS,
    );
    expect(assessment.reasons[0].significant).toBe(true);
  });

  it('never flags on total batch quantity alone', () => {
    // A batch three times the size, same recipe: hair length, not a reformulation.
    const assessment = compareFormulas(formula([['A', 30], ['B', 30]]), formula([['A', 90], ['B', 90]]), THRESHOLDS);
    expect(assessment.significant).toBe(false);
    expect(assessment.reasons).toHaveLength(0);
  });

  it('summarises every reason in words a stylist can read', () => {
    const assessment = compareFormulas(formula([['A', 100]]), formula([['Blondor', 100]]), THRESHOLDS);
    for (const reason of assessment.reasons) {
      expect(reason.summary).toMatch(/[a-z]/i);
      expect(reason.summary).not.toMatch(/product:|manual:|undefined|NaN/);
    }
  });
});

// ---------------------------------------------------------------------------
// No history — Wrike section 36
// ---------------------------------------------------------------------------

describe('missing history', () => {
  it('does not treat a first formula as a 100% change', () => {
    const assessment = noComparableFormula('no_prior_comparable_formula', THRESHOLDS, formula([['A', 100]]));
    expect(assessment.available).toBe(false);
    expect(assessment.significant).toBe(false);
    expect(assessment.severity).toBe('none');
    expect(assessment.unavailableCause).toBe('no_prior_comparable_formula');
    expect(assessment.reasons).toHaveLength(0);
  });

  it('distinguishes "no history at all" from "no comparable history"', () => {
    expect(noComparableFormula('no_formula_history', THRESHOLDS).unavailableCause).toBe('no_formula_history');
  });
});

// ---------------------------------------------------------------------------
// Comparability keys — Wrike section 4
// ---------------------------------------------------------------------------

describe('comparability key', () => {
  it('keys on the colour billing category', () => {
    expect(formulaComparabilityKey(['permanent_colour'])).toBe('permanent_colour');
    expect(formulaComparabilityKey(['semi_toners'])).toBe('semi_toners');
  });

  it('does not treat a toner as comparable to a root colour', () => {
    expect(formulaComparabilityKey(['permanent_colour'])).not.toBe(formulaComparabilityKey(['semi_toners']));
  });

  it('is order-independent for a multi-service appointment', () => {
    expect(formulaComparabilityKey(['semi_toners', 'permanent_colour'])).toBe(
      formulaComparabilityKey(['permanent_colour', 'semi_toners']),
    );
  });

  it('gives an uncategorised formula its own key rather than matching everything', () => {
    expect(formulaComparabilityKey([])).toBe('uncategorised');
    expect(formulaComparabilityKey([])).not.toBe(formulaComparabilityKey(['permanent_colour']));
  });
});

// ---------------------------------------------------------------------------
// Thresholds — Wrike sections 18, 22, 49, 55
// ---------------------------------------------------------------------------

describe('thresholds', () => {
  it('changes the verdict deterministically', () => {
    const previous = formula([['A', 50], ['B', 50]]);
    const current = formula([['A', 70], ['B', 30]]); // 20% distance

    expect(compareFormulas(previous, current, { ...THRESHOLDS, compositionChangePercent: 30 }).significant).toBe(
      false,
    );
    expect(compareFormulas(previous, current, { ...THRESHOLDS, compositionChangePercent: 20 }).significant).toBe(
      true,
    );
  });

  it('treats exactly the threshold as significant', () => {
    const assessment = compareFormulas(
      formula([['A', 50], ['B', 50]]),
      formula([['A', 70], ['B', 30]]),
      { ...THRESHOLDS, compositionChangePercent: 20 },
    );
    expect(assessment.reasons[0].changePercent).toBe(20);
    expect(assessment.significant).toBe(true);
  });

  it('is stable at the boundary rather than flapping', () => {
    // Integer/BigInt arithmetic throughout: the same inputs give the same answer
    // every time, with no 29.999999999% to alternate around.
    const previous = formula([['A', 50], ['B', 50]]);
    const current = formula([['A', 80], ['B', 20]]);
    const verdicts = Array.from({ length: 50 }, () => compareFormulas(previous, current, THRESHOLDS).significant);
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe(true);
  });

  it('echoes the thresholds it applied', () => {
    const custom = { compositionChangePercent: 42, componentMaterialityPercent: 7, developerVolumeDelta: 5 };
    expect(compareFormulas(formula([['A', 50]]), formula([['A', 50]]), custom).thresholds).toEqual(custom);
  });

  describe('precedence', () => {
    const business = {
      businessId: 'b1',
      locationId: null,
      compositionChangePercent: 40,
      componentMaterialityPercent: 20,
      developerVolumeDelta: 20,
    };
    const location = {
      businessId: 'b1',
      locationId: 'loc-1',
      compositionChangePercent: 25,
      componentMaterialityPercent: 10,
      developerVolumeDelta: 5,
    };

    it('falls back to platform defaults when nothing is configured', () => {
      expect(resolveFormulaChangeThresholds([], 'loc-1')).toEqual(DEFAULT_FORMULA_CHANGE_THRESHOLDS);
    });

    it('uses the business default when no location override exists', () => {
      expect(resolveFormulaChangeThresholds([business], 'loc-1').compositionChangePercent).toBe(40);
    });

    it('lets a location override win outright', () => {
      expect(resolveFormulaChangeThresholds([business, location], 'loc-1').compositionChangePercent).toBe(25);
    });

    it('does not apply a location override to a different location', () => {
      expect(resolveFormulaChangeThresholds([business, location], 'loc-2').compositionChangePercent).toBe(40);
    });

    it('never stacks or blends scopes — the winning row is used whole', () => {
      // All three numbers come from the location row, not two from it and one
      // from the business row, which would be a combination nobody chose.
      expect(resolveFormulaChangeThresholds([business, location], 'loc-1')).toEqual({
        compositionChangePercent: 25,
        componentMaterialityPercent: 10,
        developerVolumeDelta: 5,
      });
    });
  });

  describe('validation', () => {
    const valid = { compositionChangePercent: 30, componentMaterialityPercent: 15, developerVolumeDelta: 10 };

    it('accepts a valid set', () => {
      expect(validateFormulaChangeThresholds(valid)).toEqual([]);
    });

    it('rejects impossible values', () => {
      expect(validateFormulaChangeThresholds({ ...valid, compositionChangePercent: -200 })).not.toEqual([]);
      expect(validateFormulaChangeThresholds({ ...valid, compositionChangePercent: 5000 })).not.toEqual([]);
      expect(validateFormulaChangeThresholds({ ...valid, componentMaterialityPercent: 0 })).not.toEqual([]);
      expect(validateFormulaChangeThresholds({ ...valid, developerVolumeDelta: 0 })).not.toEqual([]);
    });

    it('rejects fractional thresholds, which would make the boundary ambiguous', () => {
      expect(validateFormulaChangeThresholds({ ...valid, compositionChangePercent: 30.5 })).not.toEqual([]);
    });

    it('reports every problem at once', () => {
      expect(
        validateFormulaChangeThresholds({
          compositionChangePercent: -1,
          componentMaterialityPercent: -1,
          developerVolumeDelta: -1,
        }),
      ).toHaveLength(3);
    });

    it('accepts both ends of every documented bound', () => {
      for (const [field, bounds] of Object.entries(FORMULA_CHANGE_BOUNDS)) {
        for (const value of [bounds.min, bounds.max]) {
          expect(validateFormulaChangeThresholds({ ...valid, [field]: value })).toEqual([]);
        }
      }
    });
  });
});
