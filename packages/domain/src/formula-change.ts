/**
 * Formula Change Detection — the canonical deterministic comparison
 * (QLOOQO V1.1, Wrike 4507283774).
 *
 * ONE trustworthy answer to: "did this client's colour formula change in a way
 * that is meaningful to the stylist?" — not "did the formula record change?".
 *
 * Everything here is PURE: no clock reads, no I/O, no natural language, no model
 * of any kind. The same formula history plus the same thresholds always produces
 * the same result, byte for byte. That is the whole point of the ticket, and it
 * is why the arithmetic below is integer/BigInt rather than floating point.
 *
 * ---------------------------------------------------------------------------
 * WHAT QLOOQO CAN ACTUALLY COMPARE (read this before adding a dimension)
 * ---------------------------------------------------------------------------
 * `lab.formula_items` stores: product_id, product_name, brand, shade, developer,
 * ratio, captured_grams. Of those:
 *
 *   COMPARABLE — product identity (`product_id`) and quantity (`captured_grams`).
 *     These are structured, stable and already the basis of stock deduction, so
 *     composition and add/remove are computed from real data.
 *
 *   COMPARABLE WITH A STRICT PARSE — `developer`. It is a dedicated column whose
 *     only purpose is oxidant strength ("20 vol"). It is free text, so it is
 *     parsed STRICTLY: a value that does not match an unambiguous pattern makes
 *     the dimension `unavailable` rather than guessed.
 *
 *   NOT COMPARABLE — colour LEVEL and TONE/family. There is no structured field
 *     for either. `shade` is free text AND, on the catalogue path, the Lab app
 *     writes the PRODUCT NAME into it (apps/sheer-lab .. FormulaScreen.tsx,
 *     `shade: product.name`), so it holds "Koleston Perfect" as often as "6/0".
 *     Parsing it would be exactly the "parse arbitrary product names and pretend
 *     that is reliable" the ticket forbids. Both dimensions therefore report
 *     `unavailable` with a machine-readable reason, and the UI says so out loud.
 *     Making them real needs a schema change (a canonical level/tone column, or
 *     an approved shade-notation parser), not a regex here.
 *
 * A dimension that cannot be evaluated is reported as UNAVAILABLE. It is never
 * silently skipped and never guessed.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Severity. Only `significant` raises the stylist-facing intelligence flag;
 * `minor` is retained in the assessment detail so "we looked and it was small"
 * is distinguishable from "we did not look", but it never clutters staff UI.
 */
export type FormulaChangeSeverity = 'none' | 'minor' | 'significant';

/** Why a formula was flagged. Every reason is explainable to a stylist. */
export type FormulaChangeReasonType =
  | 'formula_composition_shift'
  | 'material_product_added'
  | 'material_product_removed'
  | 'developer_shift';

/** The dimensions this comparison considers. */
export type FormulaChangeDimension = 'composition' | 'developer' | 'level' | 'tone';

/** Why a dimension could not be evaluated. Machine-readable, never a guess. */
export type FormulaChangeUnavailableReason =
  /** No structured colour-level field exists; `shade` is a free-text display label. */
  | 'no_structured_level_data'
  /** No structured tone/family field or canonical mapping exists. */
  | 'no_structured_tone_data'
  /** One or both formulas record no developer strength. */
  | 'no_developer_recorded'
  /** A developer value did not match an unambiguous strength pattern. */
  | 'developer_not_parseable'
  /** The two developer values use different units (vol vs %); never interconverted. */
  | 'developer_units_incompatible'
  /** Components span stock units that cannot be summed into one basis. */
  | 'incompatible_units'
  /** A formula recorded no usable quantities at all. */
  | 'no_quantities_recorded';

/** Why no assessment could be produced at all. */
export type FormulaChangeUnavailableCause =
  /** The client's first comparable formula — nothing to compare against. */
  | 'no_prior_comparable_formula'
  /** The client has no saved formula history at all. */
  | 'no_formula_history';

// ---------------------------------------------------------------------------
// Comparability — Wrike section 4
// ---------------------------------------------------------------------------

/**
 * The canonical "what kind of colour work is this?" key.
 *
 * These are `ServiceBillingCategory` values (billing.service_billing_category_enum,
 * 0043), linked to bookable services by `booking.service_categories.billing_category`
 * (0091) — the same linkage Colour Prep already uses to decide which appointments
 * are colour appointments. A root colour is `permanent_colour`, a toner is
 * `semi_toners`, bleach is `lightener_bleach`.
 *
 * Two formulas are comparable only when their keys are EQUAL, which is what stops
 * a toner being reported as a massive change from last month's root colour.
 *
 * KNOWN LIMITATION, stated rather than hidden: `lab.formulas` has no service or
 * category column of its own, so a formula inherits the key of its APPOINTMENT.
 * A visit with several colour services (colour + toner) yields one combined key
 * covering both, and both visits must carry the same combination to be compared.
 * That is deliberately conservative — declining to compare is always safer than
 * comparing the wrong pair.
 */
export type FormulaComparabilityKey = string;

/** Build the comparability key from an appointment's colour billing categories. */
export function formulaComparabilityKey(billingCategories: readonly string[]): FormulaComparabilityKey {
  const unique = Array.from(new Set(billingCategories.filter(Boolean))).sort();
  // A formula with no resolvable colour category compares only with other
  // uncategorised formulas. It is never treated as matching everything.
  return unique.length === 0 ? 'uncategorised' : unique.join('+');
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One component of a formula, reduced to what can honestly be compared.
 *
 * `identity` is the STABLE match key (Wrike section 48), resolved by the caller:
 * `product:<uuid>` for a catalogue line, `manual:<normalised name>` for a
 * hand-entered line that never had a product id. A manual line is never merged
 * with a catalogue line, and two different catalogue products are never merged
 * because their names look similar.
 */
export interface FormulaComponentInput {
  identity: string;
  /** Display label for the reason text. Never used for matching. */
  displayName: string;
  /** Quantity in the product's own base stock unit. */
  quantity: number;
  /** `products.stock_unit`. Defaults to gram, matching the storage column. */
  stockUnit?: 'gram' | 'millilitre' | 'unit' | null;
  /** Raw `formula_items.developer`, if recorded. */
  developer?: string | null;
}

export interface FormulaSnapshotInput {
  formulaId: string;
  savedAt: string;
  comparabilityKey: FormulaComparabilityKey;
  components: FormulaComponentInput[];
  /** Context echoed into the assessment for the UI. */
  serviceName?: string | null;
  stylistName?: string | null;
  visitId?: string | null;
}

/**
 * Salon sensitivity settings.
 *
 * Deliberately three numbers, not a rule engine. Every one maps to a sentence a
 * salon owner can read, and every one is expressed as a WHOLE PERCENT so the
 * settings UI, the database CHECK constraints and this module agree exactly.
 */
export interface FormulaChangeThresholds {
  /**
   * Composition distance at or above which the formula is flagged, in percent.
   * "Flag when the formula composition changes by at least N%."
   */
  compositionChangePercent: number;
  /**
   * The share a single component must reach before its addition or removal can
   * flag on its own, in percent. Stops a 2% additive from raising a flag.
   */
  componentMaterialityPercent: number;
  /**
   * Developer strength change, in volumes, at or above which the formula is
   * flagged. 20 vol -> 40 vol is operationally significant even when the colour
   * components are unchanged.
   */
  developerVolumeDelta: number;
}

/**
 * Platform defaults.
 *
 * THESE ARE PRODUCT DEFAULTS CHOSEN BY ENGINEERING, NOT VALUES SUPPLIED BY THE
 * CLIENT. They are set deliberately conservative — a stylist who learns to
 * ignore the flag is worse than no flag at all — and they are expected to be
 * tuned once real salon data is available.
 *
 *   compositionChangePercent 30 — a third of the mix by share has moved. Routine
 *     ratio tweaks (50/50 -> 48/52 is 2%) stay far below it; a genuine product
 *     swap (50/50 -> 60% of a new product) lands well above.
 *   componentMaterialityPercent 15 — below roughly a sixth of the mix, adding or
 *     dropping a component is a tweak, not a reformulation. Such a component
 *     still contributes to the composition distance; it just cannot flag alone.
 *   developerVolumeDelta 10 — one full step on the standard 10/20/30/40 vol
 *     ladder. 20 -> 30 flags; 20 -> 20 does not.
 */
export const DEFAULT_FORMULA_CHANGE_THRESHOLDS: FormulaChangeThresholds = {
  compositionChangePercent: 30,
  componentMaterialityPercent: 15,
  developerVolumeDelta: 10,
};

/** Hard bounds, mirrored exactly by the CHECK constraints in migration 0105. */
export const FORMULA_CHANGE_BOUNDS = {
  compositionChangePercent: { min: 1, max: 100 },
  componentMaterialityPercent: { min: 1, max: 100 },
  developerVolumeDelta: { min: 1, max: 60 },
} as const;

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface FormulaChangeReason {
  type: FormulaChangeReasonType;
  /** One sentence a stylist reads. No maths, no internal identifiers. */
  summary: string;
  /** Whether this reason on its own is enough to flag. */
  significant: boolean;
  /** Composition distance, whole percent, for `formula_composition_shift`. */
  changePercent?: number;
  /** Component share, whole percent, for add/remove reasons. */
  componentSharePercent?: number;
  /** Developer strengths for `developer_shift`. */
  previousDeveloper?: string;
  currentDeveloper?: string;
}

/** What was and was not evaluated, so the UI never implies a check it did not make. */
export interface FormulaChangeDimensionResult {
  dimension: FormulaChangeDimension;
  evaluated: boolean;
  unavailableReason?: FormulaChangeUnavailableReason;
}

/** A formula reduced for display beside the flag. */
export interface FormulaChangeSnapshotSummary {
  formulaId: string;
  savedAt: string;
  serviceName?: string;
  stylistName?: string;
  components: Array<{ displayName: string; sharePercent: number }>;
}

export interface FormulaChangeAssessment {
  /** False when no comparison could be made at all (first formula, no history). */
  available: boolean;
  unavailableCause?: FormulaChangeUnavailableCause;
  severity: FormulaChangeSeverity;
  /** True only for `significant`. The single field UI should gate the flag on. */
  significant: boolean;
  reasons: FormulaChangeReason[];
  dimensions: FormulaChangeDimensionResult[];
  current?: FormulaChangeSnapshotSummary;
  previous?: FormulaChangeSnapshotSummary;
  /** The thresholds actually applied, echoed so behaviour is explicable. */
  thresholds: FormulaChangeThresholds;
}

// ---------------------------------------------------------------------------
// Exact share arithmetic — Wrike section 47
// ---------------------------------------------------------------------------
//
// Shares and distances are computed in BASIS POINTS (0..10000) using BigInt, with
// a single rounding step at the very end. Floating point is never used, so a
// comparison sitting exactly on a threshold resolves the same way on every
// machine, every run, forever. `29.999999999%` cannot occur: the value either is
// 30% or it is not.
//
// Quantities are numeric(12,3) in Postgres, so they are scaled by 1000 into
// integer thousandths before any arithmetic. BigInt is used because the exact
// common-denominator form below multiplies two totals together and would
// otherwise exceed Number.MAX_SAFE_INTEGER on a large formula.

const BASIS_POINTS = 10_000n;
/** numeric(12,3) in Postgres, so thousandths captures every stored digit exactly. */
const QUANTITY_SCALE = 1000;

/** A quantity as exact integer thousandths. Negative and non-finite become 0. */
function toScaled(quantity: number): bigint {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0n;
  return BigInt(Math.round(quantity * QUANTITY_SCALE));
}

/** Round a BigInt ratio to the nearest integer, half away from zero. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Basis points -> whole percent, rounded half up. Display only. */
function bpToPercent(bp: bigint): number {
  return Number(divRound(bp, 100n));
}

// ---------------------------------------------------------------------------
// Normalisation — Wrike sections 7 and 8
// ---------------------------------------------------------------------------

interface NormalisedFormula {
  /** identity -> exact scaled quantity. */
  quantities: Map<string, bigint>;
  names: Map<string, string>;
  total: bigint;
  /** Null when the components cannot share one quantity basis. */
  unit: 'gram' | 'millilitre' | 'unit' | null;
  unavailable?: FormulaChangeUnavailableReason;
}

/**
 * Collapse a formula's components to identity -> quantity, and establish whether
 * they share ONE unit basis.
 *
 * UNIT SAFETY (Wrike section 8). `inventory.products.stock_unit` says what one
 * unit of a quantity means: gram, millilitre or whole item. The platform's
 * canonical rule (apps/api/src/inventory/unit-conversion.ts) is that NONE of
 * these convert into each other — millilitres to grams needs a density the
 * catalogue does not carry. Shares are therefore computed only when every
 * component shares one basis; a genuinely mixed formula reports
 * `incompatible_units` rather than inventing a total. Components with no product
 * row default to gram, which is what the storage column already means.
 */
function normalise(components: readonly FormulaComponentInput[]): NormalisedFormula {
  const quantities = new Map<string, bigint>();
  const names = new Map<string, string>();
  const units = new Set<string>();
  let total = 0n;

  for (const component of components) {
    const scaled = toScaled(component.quantity);
    if (scaled <= 0n) continue; // a zero line contributes nothing to a share
    const unit = component.stockUnit ?? 'gram';
    units.add(unit);
    quantities.set(component.identity, (quantities.get(component.identity) ?? 0n) + scaled);
    if (!names.has(component.identity)) names.set(component.identity, component.displayName);
    total += scaled;
  }

  if (total === 0n) {
    return { quantities, names, total: 0n, unit: null, unavailable: 'no_quantities_recorded' };
  }
  if (units.size > 1) {
    return { quantities, names, total, unit: null, unavailable: 'incompatible_units' };
  }
  return { quantities, names, total, unit: [...units][0] as NormalisedFormula['unit'] };
}

/**
 * Composition distance as an exact basis-point value in [0, 10000].
 *
 *   distance = 0.5 x SUM over all products of |previousShare - currentShare|
 *
 * 0 means identical composition; 10000 means no overlap at all. It is computed
 * over a COMMON DENOMINATOR rather than by rounding each share first, so the
 * result is exact:
 *
 *   SUM |p_i/P - c_i/C|  =  SUM |p_i*C - c_i*P| / (P*C)
 *
 * This is what makes a pure batch-size change a non-event (Wrike section 7):
 * 30g+30g and 45g+45g both give shares of 50%/50%, so the distance is exactly 0.
 */
function compositionDistanceBp(previous: NormalisedFormula, current: NormalisedFormula): bigint {
  const identities = new Set([...previous.quantities.keys(), ...current.quantities.keys()]);
  const P = previous.total;
  const C = current.total;
  if (P === 0n || C === 0n) return 0n;

  let numerator = 0n;
  for (const identity of identities) {
    const p = previous.quantities.get(identity) ?? 0n;
    const c = current.quantities.get(identity) ?? 0n;
    const term = p * C - c * P;
    numerator += term < 0n ? -term : term;
  }
  // numerator / (P*C) is the L1 sum; halve it, then express in basis points.
  return divRound(numerator * BASIS_POINTS, P * C * 2n);
}

/** A component's share of its formula, in basis points. */
function shareBp(quantity: bigint, total: bigint): bigint {
  return total === 0n ? 0n : divRound(quantity * BASIS_POINTS, total);
}

// ---------------------------------------------------------------------------
// Developer — Wrike section 16
// ---------------------------------------------------------------------------

interface DeveloperStrength {
  value: number;
  unit: 'vol' | 'percent';
  raw: string;
}

/**
 * Parse a developer strength STRICTLY.
 *
 * `formula_items.developer` is a dedicated column for oxidant strength, not a
 * product name, so reading it is not the forbidden "parse arbitrary text" — but
 * it IS free text, so anything that is not unambiguous is refused rather than
 * guessed. "20 vol", "20vol", "20 Volume", "6%" parse; "20-30 vol", "as before"
 * and "Welloxon" do not.
 *
 * Volumes and percents are NEVER converted into one another here. They are
 * related by a fixed factor in trade practice, but applying it silently is the
 * same class of mistake as converting millilitres to grams, so a mismatched pair
 * reports `developer_units_incompatible`.
 */
export function parseDeveloperStrength(raw: string | null | undefined): DeveloperStrength | null {
  if (!raw) return null;
  const normalised = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalised) return null;

  const vol = /^(\d+(?:\.\d+)?)\s*(?:vol|volume|v)$/.exec(normalised);
  if (vol) return { value: Number(vol[1]), unit: 'vol', raw: raw.trim() };

  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(normalised);
  if (percent) return { value: Number(percent[1]), unit: 'percent', raw: raw.trim() };

  return null;
}

/**
 * The formula's governing developer strength: the STRONGEST one present.
 *
 * A formula may carry several developers (one per colour line). The strongest is
 * the operationally significant one — it sets the lift the hair actually sees —
 * and it is a single explainable number rather than a weighted blend that would
 * mean nothing chemically.
 *
 * Returns the parse outcome as well as the value, so "no developer recorded" and
 * "developer recorded but unreadable" stay distinguishable.
 */
function governingDeveloper(components: readonly FormulaComponentInput[]): {
  strength: DeveloperStrength | null;
  sawAny: boolean;
  sawUnparseable: boolean;
} {
  let strongest: DeveloperStrength | null = null;
  let sawAny = false;
  let sawUnparseable = false;

  for (const component of components) {
    const raw = component.developer?.trim();
    if (!raw) continue;
    sawAny = true;
    const parsed = parseDeveloperStrength(raw);
    if (!parsed) {
      sawUnparseable = true;
      continue;
    }
    if (!strongest || parsed.value > strongest.value) strongest = parsed;
  }
  return { strength: strongest, sawAny, sawUnparseable };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/**
 * Compare two comparable formulas and return a structured, explainable
 * assessment.
 *
 * SIGNIFICANCE IS AN OR OF EXPLAINABLE RULES (Wrike section 17) — never an
 * opaque score:
 *
 *   composition distance  >= compositionChangePercent
 *   OR a component at/above componentMaterialityPercent was added
 *   OR a component at/above componentMaterialityPercent was removed
 *   OR developer strength moved by >= developerVolumeDelta
 *
 * Boundary semantics are `>=` throughout: a change exactly ON the threshold IS
 * significant. Stated once here, tested explicitly, and true of every rule.
 *
 * Total batch quantity is deliberately NOT a rule (Wrike section 15). Batch size
 * tracks hair length, density and regrowth, not the recipe; it is reported as
 * context through the shares and never flags on its own.
 */
export function compareFormulas(
  previous: FormulaSnapshotInput,
  current: FormulaSnapshotInput,
  thresholds: FormulaChangeThresholds,
): FormulaChangeAssessment {
  const prev = normalise(previous.components);
  const curr = normalise(current.components);

  const dimensions: FormulaChangeDimensionResult[] = [];
  const reasons: FormulaChangeReason[] = [];

  // --- Level and tone: structurally unavailable, and said so out loud. --------
  dimensions.push({ dimension: 'level', evaluated: false, unavailableReason: 'no_structured_level_data' });
  dimensions.push({ dimension: 'tone', evaluated: false, unavailableReason: 'no_structured_tone_data' });

  // --- Composition, additions and removals -----------------------------------
  const compositionBlocked = prev.unavailable ?? curr.unavailable;
  if (compositionBlocked) {
    dimensions.push({ dimension: 'composition', evaluated: false, unavailableReason: compositionBlocked });
  } else {
    dimensions.push({ dimension: 'composition', evaluated: true });

    const distanceBp = compositionDistanceBp(prev, curr);
    const distancePercent = bpToPercent(distanceBp);
    const compositionThresholdBp = BigInt(thresholds.compositionChangePercent) * 100n;

    if (distanceBp >= compositionThresholdBp) {
      reasons.push({
        type: 'formula_composition_shift',
        summary: `Formula composition changed by ${distancePercent}%`,
        significant: true,
        changePercent: distancePercent,
      });
    } else if (distanceBp > 0n) {
      // Retained as detail, never surfaced as a flag.
      reasons.push({
        type: 'formula_composition_shift',
        summary: `Formula composition changed by ${distancePercent}%`,
        significant: false,
        changePercent: distancePercent,
      });
    }

    const materialityBp = BigInt(thresholds.componentMaterialityPercent) * 100n;

    // A component present now and absent before, at or above materiality.
    for (const [identity, quantity] of curr.quantities) {
      if (prev.quantities.has(identity)) continue;
      const share = shareBp(quantity, curr.total);
      const name = curr.names.get(identity) ?? 'A product';
      const material = share >= materialityBp;
      reasons.push({
        type: 'material_product_added',
        summary: `${name} added (${bpToPercent(share)}% of the mix)`,
        significant: material,
        componentSharePercent: bpToPercent(share),
      });
    }

    // A component present before and absent now, at or above its OLD share.
    for (const [identity, quantity] of prev.quantities) {
      if (curr.quantities.has(identity)) continue;
      const share = shareBp(quantity, prev.total);
      const name = prev.names.get(identity) ?? 'A product';
      const material = share >= materialityBp;
      reasons.push({
        type: 'material_product_removed',
        summary: `${name} removed (was ${bpToPercent(share)}% of the mix)`,
        significant: material,
        componentSharePercent: bpToPercent(share),
      });
    }
  }

  // --- Developer -------------------------------------------------------------
  const prevDev = governingDeveloper(previous.components);
  const currDev = governingDeveloper(current.components);

  if (!prevDev.sawAny || !currDev.sawAny) {
    dimensions.push({ dimension: 'developer', evaluated: false, unavailableReason: 'no_developer_recorded' });
  } else if (!prevDev.strength || !currDev.strength) {
    dimensions.push({ dimension: 'developer', evaluated: false, unavailableReason: 'developer_not_parseable' });
  } else if (prevDev.strength.unit !== currDev.strength.unit) {
    dimensions.push({
      dimension: 'developer',
      evaluated: false,
      unavailableReason: 'developer_units_incompatible',
    });
  } else {
    dimensions.push({ dimension: 'developer', evaluated: true });
    const delta = Math.abs(currDev.strength.value - prevDev.strength.value);
    // Only a `vol` comparison is threshold-checked: the threshold itself is
    // expressed in volumes, and applying it to a percent scale would be a
    // different (much coarser) rule wearing the same name.
    const comparable = prevDev.strength.unit === 'vol';
    if (delta > 0) {
      const significant = comparable && delta >= thresholds.developerVolumeDelta;
      reasons.push({
        type: 'developer_shift',
        summary: `Developer changed from ${prevDev.strength.raw} to ${currDev.strength.raw}`,
        significant,
        previousDeveloper: prevDev.strength.raw,
        currentDeveloper: currDev.strength.raw,
      });
    }
  }

  const significant = reasons.some((reason) => reason.significant);
  const severity: FormulaChangeSeverity = significant
    ? 'significant'
    : reasons.length > 0
      ? 'minor'
      : 'none';

  return {
    available: true,
    severity,
    significant,
    // Significant reasons first, so the UI's first line is the headline.
    reasons: [...reasons].sort((a, b) => Number(b.significant) - Number(a.significant)),
    dimensions,
    current: toSummary(current, curr),
    previous: toSummary(previous, prev),
    thresholds,
  };
}

/** The "no comparable history" answer — explicitly NOT a 100% change. */
export function noComparableFormula(
  cause: FormulaChangeUnavailableCause,
  thresholds: FormulaChangeThresholds,
  current?: FormulaSnapshotInput,
): FormulaChangeAssessment {
  return {
    available: false,
    unavailableCause: cause,
    severity: 'none',
    significant: false,
    reasons: [],
    dimensions: [],
    ...(current ? { current: toSummary(current, normalise(current.components)) } : {}),
    thresholds,
  };
}

function toSummary(input: FormulaSnapshotInput, normalised: NormalisedFormula): FormulaChangeSnapshotSummary {
  const components = [...normalised.quantities.entries()]
    .map(([identity, quantity]) => ({
      displayName: normalised.names.get(identity) ?? 'Product',
      sharePercent: bpToPercent(shareBp(quantity, normalised.total)),
    }))
    // Largest share first, then by name so the order is total and stable.
    .sort((a, b) => b.sharePercent - a.sharePercent || a.displayName.localeCompare(b.displayName));

  return {
    formulaId: input.formulaId,
    savedAt: input.savedAt,
    ...(input.serviceName ? { serviceName: input.serviceName } : {}),
    ...(input.stylistName ? { stylistName: input.stylistName } : {}),
    components,
  };
}

// ---------------------------------------------------------------------------
// Threshold resolution — Wrike section 49
// ---------------------------------------------------------------------------

/** One stored settings row. `locationId` null is the business-wide default. */
export interface FormulaChangeSettingsRecord extends FormulaChangeThresholds {
  businessId: string;
  locationId: string | null;
}

/**
 * Location override -> business default -> platform default.
 *
 * Resolution is PER ROW, not per field: the first configured scope wins outright
 * and its three numbers are used together. Thresholds never stack, and a
 * location row never inherits two of its values from the business row — that
 * would produce a combination nobody chose. Mirrors
 * `resolveLapseDetectionSettings` in ./client-intelligence, so the two
 * intelligence features resolve settings identically.
 */
export function resolveFormulaChangeThresholds(
  records: readonly FormulaChangeSettingsRecord[],
  locationId: string | null,
): FormulaChangeThresholds {
  const forLocation = locationId
    ? records.find((record) => record.locationId === locationId)
    : undefined;
  const business = records.find((record) => record.locationId === null);
  const chosen = forLocation ?? business;
  if (!chosen) return { ...DEFAULT_FORMULA_CHANGE_THRESHOLDS };
  return {
    compositionChangePercent: chosen.compositionChangePercent,
    componentMaterialityPercent: chosen.componentMaterialityPercent,
    developerVolumeDelta: chosen.developerVolumeDelta,
  };
}

/** Validate an owner-supplied threshold set. Returns every problem at once. */
export function validateFormulaChangeThresholds(input: Partial<FormulaChangeThresholds>): string[] {
  const errors: string[] = [];
  const check = (field: keyof FormulaChangeThresholds, label: string) => {
    const value = input[field];
    const bounds = FORMULA_CHANGE_BOUNDS[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      errors.push(`${label} must be a whole number between ${bounds.min} and ${bounds.max}`);
    }
  };
  check('compositionChangePercent', 'Formula composition change');
  check('componentMaterialityPercent', 'Material product component');
  check('developerVolumeDelta', 'Developer change');
  return errors;
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

export interface FormulaChangeSettingsScope extends FormulaChangeThresholds {
  locationId: string | null;
  /** False when this scope is showing platform defaults rather than a stored row. */
  configured: boolean;
}

export interface FormulaChangeSettingsResponse {
  scopes: FormulaChangeSettingsScope[];
  defaults: FormulaChangeThresholds;
}

export interface UpsertFormulaChangeSettingsRequest extends FormulaChangeThresholds {
  locationId?: string | null;
}

export interface ClientFormulaChangeResponse {
  clientProfileId: string;
  assessment: FormulaChangeAssessment;
}
