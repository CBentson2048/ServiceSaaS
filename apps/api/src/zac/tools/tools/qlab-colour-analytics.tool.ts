import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import type { ZacLabAnalyticsRead } from '../ports/zac-service-ports';
import { projectColourLocation } from '../ports/zac-service-ports';
import {
  capConfidenceAcross,
  isMeasured,
  limitationsFor,
  money,
  rate,
  toNullableNumber,
} from '../coverage/zac-coverage';
import { probeColourCoverage } from '../coverage/zac-feasibility-probe';
import { periodFromInput } from '../zac-period';

/**
 * NINETY DAYS, NOT THIRTY — and the difference is evidenced, not stylistic.
 *
 * The newest costed formula on the working database is 2026-07-21. Against a
 * 30-day default (the convention every other reporting tool uses) this tool
 * returns nothing at all on the only tenant that has real colour data. Colour
 * is also genuinely lower-frequency than bookings or retail: five saved
 * formulas across two months is a normal small-salon volume, and a monthly
 * window would report single-digit samples as trends.
 */
const DEFAULT_RANGE_DAYS = 90;

/**
 * How far back "has this salon EVER mixed colour?" reaches.
 *
 * This second read is what lets an empty window be reported as STALENESS rather
 * than ABSENCE — two facts that need opposite answers. Without it, "no colour
 * work in the last 90 days" is indistinguishable from "this salon does not use
 * Qlooqo Lab".
 */
const BASELINE_DAYS = 365;

/**
 * Hard ceiling on the reporting window.
 *
 * `LabAnalyticsService.fetchFormulas` has no `.limit()`, so the window IS the
 * bound on how much it reads. "Show me colour margin for all time" would
 * otherwise be an unbounded scan on the first busy salon.
 */
const MAX_WINDOW_DAYS = 366;

/** Products named in the prose. The rest stay in the structured payload. */
const TOP_PRODUCT_COUNT = 3;

/** Below this many formulas a margin percentage is noise wearing a decimal point. */
const MARGIN_SAMPLE_FLOOR = 3;

/**
 * Workstream 3 — the COLOUR domain.
 *
 * Reads the guarded `LabAnalyticsService.summary`, which computes colour
 * revenue, formula cost, gross margin and product usage in-process from
 * `lab.formulas` filtered to `status = 'saved'`. ZAC recomputes none of it:
 * the client plan's own rule is that QLOOQO remains the source of truth and
 * ZAC must not introduce competing formulas.
 *
 * THREE THINGS THIS TOOL REFUSES TO DO, each because the live data makes the
 * naive version actively misleading:
 *
 * 1. REPORT WASTE AS A PERCENTAGE. Every one of the 20 `lab.formula_items` on
 *    the database records `waste_grams = 0` and `waste_cost_cents = 0`, and
 *    `inventory.waste_events` holds 0 rows and is SELECTed nowhere in the
 *    platform. Colour waste therefore has no surviving numerator ANYWHERE.
 *    "0% waste" would tell an owner they run a perfect colour bar. The truth —
 *    waste is not captured when formulas are saved — is a different statement
 *    and an actionable one, so that is what gets said and the percentage is
 *    suppressed entirely.
 *
 * 2. REPORT A MARGIN OVER ZERO REVENUE. One tenant's four saved formulas record
 *    charge 0 and cost 0. `0/0` renders as "0% margin" — a fabricated trading
 *    result for a salon that has simply never priced a formula. Every rate goes
 *    through `ZacCoverageReading`, which has no way to produce a number from a
 *    zero denominator.
 *
 * 3. NAME A STYLIST. `SheerLabAnalyticsResponse.byStylist` carries `hourlyRate`,
 *    `contractedHours` and `averageBillBenchmark` alongside the colour figures,
 *    read from `core.staff_profiles` under `report.lab_analytics.view` with NO
 *    payroll permission anywhere in the path. Per-stylist colour margin would
 *    therefore also be disclosing pay data. That array is never read — enforced
 *    by the absence of any stylist projector and by the WS3 boundary sweep.
 *
 * PERMISSION NOTE, LOAD-BEARING. `summary` re-checks the caller's ROLE and
 * location scope, but NOT `report.lab_analytics.view`. On the ZAC path the
 * declaration below is the ONLY thing enforcing that key. It must never be
 * weakened.
 */
export class QlabColourAnalyticsTool implements ZacReadOnlyTool {
  readonly name = 'qlab.colour_analytics' as const;
  readonly domain = 'qlab' as const;
  readonly description =
    'Summarises colour revenue, formula cost, gross margin and the products colour work consumes, from saved Qlooqo Lab formulas.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.lab_analytics.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      locationId: {
        type: 'string',
        description: 'Optional single-location focus; must be inside the acting user scope.',
      },
      period: { type: 'object' },
    },
    additionalProperties: true,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Colour revenue, formula cost, gross margin and leading colour products, with an explicit statement of what is not measured.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  // Colour figures move only when a formula is saved, and a stale answer here
  // is cheap; but a salon mid-service wants today's number, so ten minutes.
  readonly cachePolicy = { ttlSeconds: 600, perTenant: true } as const;
  readonly rateLimit = { perMinute: 6 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly lab: ZacLabAnalyticsRead) {}

  async execute(
    actor: AuthUser,
    _context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const nowMs = Date.now();
    const requested = periodFromInput(input, DEFAULT_RANGE_DAYS, nowMs);
    const period = clampWindow(requested, nowMs);
    const locationId = typeof input['locationId'] === 'string' ? input['locationId'] : undefined;

    // The probe runs FIRST and decides which of four answers this is. Reporting
    // before establishing whether colour is set up at all is how a zero becomes
    // a finding.
    const probe = await probeColourCoverage(this.lab, actor, {
      ...(locationId === undefined ? {} : { locationId }),
      windowFromIso: period.fromIso,
      windowToIso: period.toIso,
      nowMs,
      baselineDays: BASELINE_DAYS,
    });

    if (probe.verdict === 'unreadable') {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not read your colour analytics just now.',
        rowCount: null,
      };
    }

    if (probe.verdict === 'not_configured') {
      return {
        status: 'ok',
        data: { formulas_in_window: 0, formulas_in_baseline: 0, baseline_days: BASELINE_DAYS },
        explanation: 'No colour formula has ever been saved for this business.',
        rowCount: 0,
        presentation: {
          answer:
            `I have no colour work to report on. No formula has ever been saved in Qlooqo Lab for the ` +
            `locations I can see, so there is nothing to measure colour cost or margin from.\n\n` +
            `This is about set-up rather than performance — colour figures appear once your team mixes ` +
            `and saves formulas in the Lab.`,
          evidence: [this.evidence(period.fromIso, period.toIso)],
          confidence: 'high',
          limitations: [
            'This reflects only what has been saved in Qlooqo Lab. Colour done outside the Lab is not recorded anywhere I can read.',
          ],
          suggestedNextStep:
            'Ask "what stock am I running low on?" for the inventory side, which is recorded separately.',
          responseType: 'Explanation',
        },
      };
    }

    let summary: Awaited<ReturnType<ZacLabAnalyticsRead['summary']>>;
    try {
      // ALWAYS an explicit custom window. The service's 'today'/'week'/'month'
      // presets resolve in the API HOST's local timezone while ZAC works in
      // UTC, so passing a preset would silently report a different window from
      // the one named in the answer.
      summary = await this.lab.summary(actor, 'custom', locationId, period.fromIso, period.toIso);
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not read your colour analytics just now.',
        rowCount: null,
      };
    }

    const currency = summary.summary.currencyCode || 'GBP';
    const locations = summary.byLocation.map(projectColourLocation);

    // ---- Empty window, but colour exists on record -> STALENESS -------------
    if (summary.summary.formulasMixed === 0) {
      return {
        status: 'ok',
        data: {
          range_start: period.fromIso,
          range_end: period.toIso,
          formulas_in_window: 0,
          formulas_in_baseline: probe.formulasInBaseline,
          baseline_days: BASELINE_DAYS,
        },
        explanation: `No formulas were saved in ${period.label}.`,
        rowCount: 0,
        presentation: {
          answer:
            `No colour formulas were saved in ${period.label}, so I have nothing to report for that window.\n\n` +
            `Your team has saved ${probe.formulasInBaseline} ${plural(probe.formulasInBaseline, 'formula')} ` +
            `in the last ${BASELINE_DAYS} days, so the Lab is in use — the colour work just sits outside the ` +
            `period you asked about.`,
          evidence: [this.evidence(period.fromIso, period.toIso)],
          confidence: 'high',
          limitations: [
            `I am reporting on ${period.label}${period.explicit ? '' : ' (my default window, since you did not name one)'}.`,
            'Only formulas SAVED in Qlooqo Lab count. Drafts and colour mixed outside the Lab are not recorded.',
            ...(period.unsupportedReason ? [period.unsupportedReason] : []),
          ],
          suggestedNextStep: 'Ask about a wider window, for example "colour margin over the last 6 months".',
          responseType: 'Explanation',
        },
      };
    }

    // ---- Margin -------------------------------------------------------------
    // Through ZacCoverageReading so a zero-revenue tenant yields null, not 0%.
    const marginReading = rate({
      numerator: summary.summary.grossMarginCents,
      denominator: summary.summary.colourRevenueCents,
      sampleUnit: 'saved formulas',
      asOf: period.toIso,
      sampleFloor: MARGIN_SAMPLE_FLOOR,
    });

    const chargedNothing = summary.summary.colourRevenueCents <= 0;

    // ---- Worst location -----------------------------------------------------
    // `summary.worstLocationName` is DISCARDED and recomputed. The source ranks
    // on a percent that returns 0 for a zero denominator, so a site that did no
    // colour at all outranks a site with a genuinely thin margin. Only sites
    // that actually charged for colour can be "worst" at it — and the ranking
    // runs on ZacCoverageReading values, so an unmeasurable site cannot place.
    const trading = locations
      .map((location) => ({
        location,
        margin: rate({
          numerator: location.grossMarginCents,
          denominator: location.colourRevenueCents,
          sampleUnit: 'saved formulas',
          asOf: period.toIso,
        }),
      }))
      .filter((entry): entry is typeof entry & { margin: ReturnType<typeof rate> } =>
        isMeasured(entry.margin),
      );
    const worst =
      trading.length > 1
        ? [...trading].sort(
            (a, b) => (toNullableNumber(a.margin) ?? 0) - (toNullableNumber(b.margin) ?? 0),
          )[0]
        : undefined;

    const topByCost = summary.mostUsedProductsByCost.slice(0, TOP_PRODUCT_COUNT);

    const limitations: string[] = [
      `I am reporting on ${period.label}${period.explicit ? '' : ' (my default window, since you did not name one)'}, from formulas SAVED in Qlooqo Lab. Drafts and colour mixed outside the Lab are not counted.`,
      ...limitationsFor(marginReading, 'colour margin'),
      ...probe.limitations,
      ...(period.unsupportedReason ? [period.unsupportedReason] : []),
    ];

    // THE WASTE STATEMENT. Not a percentage — a statement about measurement.
    if (probe.wasteNeverCaptured) {
      limitations.push(
        'No saved formula records any waste, so I cannot tell you what colour waste is costing you. ' +
          'That is a gap in what is captured when a formula is saved, not evidence that waste is zero — ' +
          'I have left the figure out rather than report it as nothing.',
      );
    }

    limitations.push(
      'This is colour revenue against the cost of the product mixed. It is not profit: it takes no account of the stylist time, rent or overheads behind the service.',
    );

    const answer = this.buildAnswer({
      period: period.label,
      currency,
      formulas: summary.summary.formulasMixed,
      revenueCents: summary.summary.colourRevenueCents,
      costCents: summary.summary.formulaCostCents,
      marginCents: summary.summary.grossMarginCents,
      marginPercent: toNullableNumber(marginReading),
      chargedNothing,
      wasteNeverCaptured: probe.wasteNeverCaptured,
      ...(worst === undefined ? {} : { worstName: worst.location.locationName }),
      worstPercent: worst ? toNullableNumber(worst.margin) : null,
      locationCount: trading.length,
      topProducts: topByCost.map((product) => ({
        name: product.productName,
        costCents: product.totalCostCents,
        formulaCount: product.formulaCount,
      })),
    });

    return {
      status: 'ok',
      data: {
        range_start: period.fromIso,
        range_end: period.toIso,
        formulas_mixed: summary.summary.formulasMixed,
        colour_revenue_cents: summary.summary.colourRevenueCents,
        formula_cost_cents: summary.summary.formulaCostCents,
        gross_margin_cents: summary.summary.grossMarginCents,
        // NULL, never 0, when there is no revenue to measure against.
        gross_margin_percent: toNullableNumber(marginReading),
        waste_captured: !probe.wasteNeverCaptured,
        currency_code: currency,
        locations_trading_colour: trading.length,
        by_location: locations,
        top_products_by_cost: topByCost.map((product) => ({
          product_name: product.productName,
          total_cost_cents: product.totalCostCents,
          total_weight_grams: product.totalWeightGrams,
          formula_count: product.formulaCount,
        })),
      },
      explanation:
        'Colour revenue, formula cost and margin are read from your saved Qlooqo Lab formulas; nothing is recalculated.',
      rowCount: summary.summary.formulasMixed,
      presentation: {
        answer,
        evidence: [this.evidence(period.fromIso, period.toIso)],
        confidence: capConfidenceAcross('high', [marginReading]),
        limitations,
        suggestedNextStep: probe.wasteNeverCaptured
          ? 'Recording waste grams when a formula is saved would let me show what colour waste is costing you.'
          : 'Ask "what colour stock am I running low on?" to see the inventory behind this.',
        responseType: 'Insight',
      },
    };
  }

  private buildAnswer(input: {
    period: string;
    currency: string;
    formulas: number;
    revenueCents: number;
    costCents: number;
    marginCents: number;
    marginPercent: number | null;
    chargedNothing: boolean;
    wasteNeverCaptured: boolean;
    worstName?: string;
    worstPercent: number | null;
    locationCount: number;
    topProducts: { name: string; costCents: number; formulaCount: number }[];
  }): string {
    const parts: string[] = [];

    if (input.chargedNothing) {
      // Charge 0 AND cost 0 is the live AndrewHair shape. Saying "0% margin"
      // here would invent a trading result out of an unpriced Lab.
      parts.push(
        `Your team saved ${input.formulas} colour ${plural(input.formulas, 'formula')} in ${input.period}, ` +
          `but none of them recorded a charge to the client or a product cost, so there is no margin to work out.\n\n` +
          `That usually means colour is not being priced through the Lab yet — the formulas are being saved, ` +
          `but without the cost and charge figures a margin needs.`,
      );
      return parts.join('\n\n');
    }

    const headline =
      `Across ${input.formulas} colour ${plural(input.formulas, 'formula')} saved in ${input.period}, ` +
      `you charged ${money(input.revenueCents, input.currency)} for colour and the product mixed cost ` +
      `${money(input.costCents, input.currency)}.`;

    parts.push(
      input.marginPercent === null
        ? `${headline} That leaves ${money(input.marginCents, input.currency)}. I have not put a percentage on it — the sample is too small for one to mean anything.`
        : `${headline} That leaves ${money(input.marginCents, input.currency)}, a gross margin of ${input.marginPercent}% on colour.`,
    );

    if (input.worstName && input.worstPercent !== null) {
      parts.push(
        `${input.worstName} is your thinnest colour margin at ${input.worstPercent}%, across the ` +
          `${input.locationCount} locations that charged for colour in this window.`,
      );
    }

    if (input.topProducts.length > 0) {
      const list = input.topProducts
        .map(
          (product) =>
            `${product.name} (${money(product.costCents, input.currency)} across ${product.formulaCount} ${plural(product.formulaCount, 'formula')})`,
        )
        .join(', ');
      parts.push(`Most of your colour spend went on ${list}.`);
    }

    if (input.wasteNeverCaptured) {
      parts.push(
        `I cannot tell you what waste is costing you: none of these formulas recorded any. ` +
          `That is a gap in what gets captured at save time rather than a sign there is no waste, ` +
          `so I have left it out rather than report it as zero.`,
      );
    }

    return parts.join('\n\n');
  }

  private evidence(fromIso: string, toIso: string) {
    return {
      source_type: 'lab.formulas',
      source_ref: `saved-formulas:${fromIso.slice(0, 10)}..${toIso.slice(0, 10)}`,
      as_of: toIso,
      entities_used: [],
    };
  }
}

/**
 * Keep the window inside what the service can safely read.
 *
 * `fetchFormulas` is unbounded, so an "all time" question would otherwise scan
 * every formula a salon has ever saved. The substitution is STATED rather than
 * applied silently — a tool that quietly narrows a window reports a different
 * number from the one the user asked for.
 */
function clampWindow(
  period: ReturnType<typeof periodFromInput>,
  nowMs: number,
): ReturnType<typeof periodFromInput> {
  const fromMs = Date.parse(period.fromIso);
  const maxMs = MAX_WINDOW_DAYS * 86_400_000;
  if (!Number.isFinite(fromMs) || nowMs - fromMs <= maxMs) return period;

  return {
    ...period,
    fromIso: new Date(nowMs - maxMs).toISOString(),
    label: `the last ${MAX_WINDOW_DAYS} days`,
    unsupportedReason:
      `Colour history is read formula by formula, so I cap it at ${MAX_WINDOW_DAYS} days. ` +
      `I used the last ${MAX_WINDOW_DAYS} days instead of the window you asked for.`,
  };
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
