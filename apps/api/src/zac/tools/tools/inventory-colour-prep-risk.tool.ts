import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import type { ZacColourPrepRead, ZacSafePrepRequirement } from '../ports/zac-service-ports';
import { projectPrepRequirement } from '../ports/zac-service-ports';
import { formatStockQuantity } from '../coverage/zac-coverage';

/**
 * A ROLLING FOURTEEN DAYS, NOT A CALENDAR WEEK — and this is a correction, not
 * a preference.
 *
 * `resolveColourPrepWindow` makes `this_week` and `next_week` MONDAY-BASED
 * calendar weeks. Asked on Friday 2026-09-11, `this_week` resolves to
 * 2026-09-07..13 and catches NOTHING, while the live colour appointments sit on
 * the 15th, 17th and 24th. A calendar week is the right shape for a screen
 * someone opens every morning; it is the wrong shape for a question asked at an
 * arbitrary moment, because on a Friday afternoon it answers for a week that is
 * nearly over, and on a Sunday it skips tomorrow.
 *
 * So the tool passes an explicit `custom` window instead. The plan echoes back
 * `fromDate`/`toDate`/`timezone`, and the answer STATES the window it actually
 * covered — which is also how the at-most-one-day boundary difference between
 * ZAC's UTC dates and the salon's local dates gets disclosed rather than hidden.
 */
const DEFAULT_HORIZON_DAYS = 14;

/** Locations probed per call. Each is one round trip; five keeps a group answer bounded. */
const MAX_PREP_LOCATIONS = 5;

/** Products named in the prose. */
const NAMED_PRODUCT_COUNT = 4;

/**
 * Workstream 3 — PLANNED APPOINTMENT / STOCK CORRELATION.
 *
 * Wraps `ColourPrepService.getPlan`, which already walks
 * `booking.appointments` -> `service_categories.billing_category` ->
 * the client's latest saved `lab.formulas` -> `formula_items` ->
 * `inventory.location_stock`. ZAC rebuilds none of that: the walk is subtle
 * (which appointment statuses are still preparable, which formula status counts,
 * how the waste allowance uplifts a requirement) and a second implementation
 * would disagree with the Colour Prep screen the salon actually works from.
 *
 * THE HONESTY PROBLEM THIS TOOL HAS, AND HOW IT IS HANDLED.
 *
 * A prep plan has three kinds of "I do not know", and every one of them makes a
 * shortfall figure a LOWER BOUND rather than a measurement:
 *
 *   - `appointmentsWithoutFormula` — a client with no formula on file
 *     contributes ZERO required grams. On the live forward book one of the two
 *     upcoming colour appointments is exactly this. So the tool may say "you
 *     are short of X", but is FORBIDDEN from ever saying "you have enough"
 *     while that count is non-zero.
 *   - `unmapped_product` — a formula line never linked to a catalogue product.
 *     There is no stock record to check it against.
 *   - `not_stocked` — the product exists but has no shelf record here.
 *
 * The last two mean "I could not tell", and they are reported on their own line.
 * Folding them into a verdict, or rendering them as zero on hand, would turn
 * missing data into a confident shortage.
 *
 * PII: `plan.appointments` is NEVER read. `ColourPrepAppointment` carries
 * `clientName` as a client's full name and `stylistName` as a staff member's,
 * and a stock question needs neither. Only `plan.products`, `plan.summary` and
 * the window fields are touched — which is what makes `piiLevel: 'none'`
 * structurally true rather than merely asserted, and it is enforced by the WS3
 * boundary sweep.
 */
export class InventoryColourPrepRiskTool implements ZacReadOnlyTool {
  readonly name = 'inventory.colour_prep_risk' as const;
  readonly domain = 'inventory' as const;
  readonly description =
    'Checks the colour appointments coming up against current stock, and reports what will fall short of what those formulas need.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  /** Mirrors ColourPrepController exactly — the same key its own screen requires. */
  readonly requiredPermissions = ['inventory.manage'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      locationId: {
        type: 'string',
        description: 'Optional single-location focus; must be inside the acting user scope.',
      },
      horizonDays: {
        type: 'number',
        description: 'How many days ahead to look. Defaults to 14.',
      },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Upcoming colour appointment counts, product requirements against current stock, and what could not be assessed.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 6 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(
    private readonly colourPrep: ZacColourPrepRead,
    /** Resolves which locations the actor may look at. Reads only; see the port. */
    private readonly locations: (actor: AuthUser) => Promise<{ id: string; name: string }[]>,
  ) {}

  async execute(
    actor: AuthUser,
    _context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const nowMs = Date.now();
    const horizonDays = resolveHorizon(input['horizonDays']);
    const requestedLocationId =
      typeof input['locationId'] === 'string' ? input['locationId'] : undefined;

    let targets: { id: string; name: string }[];
    try {
      const all = await this.locations(actor);
      targets = requestedLocationId
        ? all.filter((location) => location.id === requestedLocationId)
        : all;
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not work out which locations you can see.',
        rowCount: null,
      };
    }

    if (targets.length === 0) {
      return {
        status: 'ok',
        data: { locations_checked: 0 },
        explanation: 'No locations are in scope for this user.',
        rowCount: 0,
        presentation: {
          answer: 'I could not find a location to check colour preparation for.',
          evidence: [this.evidence(nowMs, horizonDays)],
          confidence: 'high',
          limitations: [],
          suggestedNextStep: null,
          responseType: 'Explanation',
        },
      };
    }

    const truncatedLocations = targets.length > MAX_PREP_LOCATIONS;
    const checked = targets.slice(0, MAX_PREP_LOCATIONS);

    // `custom` with explicit local dates. Concurrent, and independently
    // degrading: a Forbidden or NotFound at one site must not lose the others.
    const fromDate = isoDate(nowMs);
    const toDate = isoDate(nowMs + (horizonDays - 1) * 86_400_000);
    const results = await Promise.allSettled(
      checked.map((location) =>
        this.colourPrep.getPlan(actor, { locationId: location.id, range: 'custom', from: fromDate, to: toDate }),
      ),
    );

    const limitations: string[] = [];
    const sites: SitePrep[] = [];
    let unreadable = 0;

    results.forEach((result, index) => {
      const location = checked[index];
      if (!location) return;
      if (result.status !== 'fulfilled') {
        unreadable += 1;
        limitations.push(`I could not read the colour prep plan for ${location.name}.`);
        return;
      }
      const plan = result.value;
      sites.push({
        locationName: plan.locationName || location.name,
        // ONLY the PII-free fields. plan.appointments is never touched.
        appointmentCount: plan.summary.appointmentCount,
        appointmentsWithoutFormula: plan.summary.appointmentsWithoutFormula,
        shortfallProductCount: plan.summary.shortfallProductCount,
        lowStockProductCount: plan.summary.lowStockProductCount,
        unmappedProductCount: plan.summary.unmappedProductCount,
        wasteAllowancePercent: plan.wasteAllowancePercent,
        fromDate: plan.fromDate,
        toDate: plan.toDate,
        timezone: plan.timezone,
        products: plan.products.map(projectPrepRequirement),
      });
    });

    if (unreadable === checked.length) {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not read any colour prep plan just now.',
        rowCount: null,
      };
    }

    if (truncatedLocations) {
      limitations.push(
        `You have ${targets.length} locations; I checked ${checked.length}. Ask about one by name for the rest.`,
      );
    }

    const totals = sites.reduce(
      (acc, site) => ({
        colourAppointments: acc.colourAppointments + site.appointmentCount,
        withoutFormula: acc.withoutFormula + site.appointmentsWithoutFormula,
        shortfall: acc.shortfall + site.shortfallProductCount,
        lowStock: acc.lowStock + site.lowStockProductCount,
        unmapped: acc.unmapped + site.unmappedProductCount,
      }),
      { colourAppointments: 0, withoutFormula: 0, shortfall: 0, lowStock: 0, unmapped: 0 },
    );

    const notStocked = sites
      .flatMap((site) => site.products)
      .filter((product) => product.state === 'not_stocked').length;

    // ---- No colour booked: a true answer, not a failure --------------------
    if (totals.colourAppointments === 0) {
      return {
        status: 'ok',
        data: {
          horizon_days: horizonDays,
          locations_checked: sites.length,
          appointments: 0,
          window_from: sites[0]?.fromDate ?? fromDate,
          window_to: sites[0]?.toDate ?? toDate,
        },
        explanation: 'No colour appointments are booked in the horizon.',
        rowCount: 0,
        presentation: {
          answer:
            `No colour work is booked in the next ${horizonDays} days at ${describeSites(sites)}, ` +
            `so there is nothing to prepare for.\n\n` +
            `I only count appointments whose service is set up as colour work. If colour is booked under a ` +
            `service category that is not linked to a colour billing category, it will not show up here.`,
          evidence: [this.evidence(nowMs, horizonDays)],
          confidence: 'high',
          limitations,
          suggestedNextStep: 'Ask "what stock am I running low on?" for current shelf levels instead.',
          responseType: 'Explanation',
        },
      };
    }

    // The rule that keeps this tool honest. Stated here, once, and enforced by
    // never emitting a sufficiency sentence while it holds.
    const canClaimSufficiency = totals.withoutFormula === 0 && totals.unmapped === 0 && notStocked === 0;

    if (totals.withoutFormula > 0) {
      limitations.push(
        `${totals.withoutFormula} of the ${totals.colourAppointments} colour ${plural(totals.colourAppointments, 'appointment')} ` +
          `${totals.withoutFormula === 1 ? 'has' : 'have'} no formula on file, so ${totals.withoutFormula === 1 ? 'it needs' : 'they need'} ` +
          `nothing counted against stock yet. Anything I say about shortfalls is therefore a lower bound.`,
      );
    }
    if (totals.unmapped > 0) {
      limitations.push(
        `${totals.unmapped} formula ${plural(totals.unmapped, 'line')} ${totals.unmapped === 1 ? 'is' : 'are'} not linked ` +
          `to a catalogue product, so I cannot check ${totals.unmapped === 1 ? 'it' : 'them'} against stock at all.`,
      );
    }
    if (notStocked > 0) {
      limitations.push(
        `${notStocked} required ${plural(notStocked, 'product')} ${notStocked === 1 ? 'has' : 'have'} no stock record at ` +
          `the location, so I cannot say whether ${notStocked === 1 ? 'it is' : 'they are'} there.`,
      );
    }

    const allowance = sites[0]?.wasteAllowancePercent;
    if (allowance !== undefined && allowance > 0) {
      limitations.push(
        `Requirements include your ${allowance}% waste allowance — a planning uplift you configured, not measured waste.`,
      );
    }

    const shortfalls = sites
      .flatMap((site) => site.products.map((product) => ({ site: site.locationName, product })))
      .filter((entry) => entry.product.state === 'shortfall')
      .sort((a, b) => b.product.shortfallGrams - a.product.shortfallGrams);

    return {
      status: 'ok',
      data: {
        horizon_days: horizonDays,
        locations_checked: sites.length,
        window_from: sites[0]?.fromDate ?? fromDate,
        window_to: sites[0]?.toDate ?? toDate,
        timezone: sites[0]?.timezone ?? null,
        appointments: totals.colourAppointments,
        appointments_without_formula: totals.withoutFormula,
        shortfall_product_count: totals.shortfall,
        low_stock_product_count: totals.lowStock,
        unmapped_product_count: totals.unmapped,
        not_stocked_product_count: notStocked,
        // Explicitly published so no downstream consumer has to re-derive it.
        sufficiency_claimable: canClaimSufficiency,
        by_location: sites.map((site) => ({
          location_name: site.locationName,
          appointments: site.appointmentCount,
          appointments_without_formula: site.appointmentsWithoutFormula,
          shortfall_product_count: site.shortfallProductCount,
          products: site.products,
        })),
      },
      explanation:
        'Upcoming colour appointments are matched to each client’s latest saved formula and checked against current stock by QLOOQO’s Colour Prep; nothing is recalculated here.',
      rowCount: totals.colourAppointments,
      presentation: {
        answer: this.buildAnswer({ totals, shortfalls, sites, horizonDays, canClaimSufficiency, notStocked }),
        evidence: [this.evidence(nowMs, horizonDays)],
        confidence: unreadable > 0 ? 'medium' : canClaimSufficiency ? 'high' : 'medium',
        limitations,
        suggestedNextStep:
          shortfalls.length > 0
            ? 'Ask "what would I need to order?" to see what covering these would take.'
            : totals.withoutFormula > 0
              ? 'The appointments with no formula on file will need a consultation before they can be prepped.'
              : 'Open Colour Prep for the appointment-by-appointment breakdown.',
        // Being short for work already in the diary is a RISK: the appointment
        // is booked and the client is coming either way.
        responseType: shortfalls.length > 0 ? 'Risk' : 'Insight',
      },
    };
  }

  private buildAnswer(input: {
    totals: { colourAppointments: number; withoutFormula: number; shortfall: number; lowStock: number; unmapped: number };
    shortfalls: { site: string; product: ZacSafePrepRequirement }[];
    sites: SitePrep[];
    horizonDays: number;
    canClaimSufficiency: boolean;
    notStocked: number;
  }): string {
    const parts: string[] = [];
    const window = input.sites[0];
    const windowPhrase = window
      ? `between ${window.fromDate} and ${window.toDate}`
      : `in the next ${input.horizonDays} days`;

    parts.push(
      `You have ${input.totals.colourAppointments} colour ${plural(input.totals.colourAppointments, 'appointment')} booked ` +
        `${windowPhrase} at ${describeSites(input.sites)}.`,
    );

    if (input.shortfalls.length > 0) {
      const named = input.shortfalls
        .slice(0, NAMED_PRODUCT_COUNT)
        .map(
          (entry) =>
            `${entry.product.productName} at ${entry.site} (short by ` +
            `${formatStockQuantity(entry.product.shortfallGrams, entry.product.stockUnit)})`,
        );
      const rest = input.shortfalls.length - named.length;
      parts.push(
        `${input.shortfalls.length} ${plural(input.shortfalls.length, 'product')} will not cover what those ` +
          `formulas need: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`,
      );
    } else if (input.canClaimSufficiency) {
      // The ONLY branch permitted to say this, and only when nothing was
      // unknown: no missing formula, no unmapped line, no unstocked product.
      parts.push(
        `Every product those formulas need is in stock in the quantity required, including your waste allowance.`,
      );
    } else {
      // Shortfall-free but not knowable — say exactly that instead.
      parts.push(
        `Nothing I could check falls short. I have stopped short of saying you are covered, though, because ` +
          `part of the picture is missing.`,
      );
    }

    if (input.totals.withoutFormula > 0) {
      parts.push(
        `${input.totals.withoutFormula} of ${input.totals.colourAppointments === input.totals.withoutFormula ? 'them' : 'those appointments'} ` +
          `${input.totals.withoutFormula === 1 ? 'has' : 'have'} no formula on file, so nothing has been set aside for ` +
          `${input.totals.withoutFormula === 1 ? 'it' : 'them'} — ${input.totals.withoutFormula === 1 ? 'that client' : 'those clients'} ` +
          `will need a consultation before you can prepare properly.`,
      );
    }

    if (input.totals.lowStock > 0 && input.shortfalls.length === 0) {
      parts.push(
        `${input.totals.lowStock} ${plural(input.totals.lowStock, 'product')} will cover the work but ` +
          `${input.totals.lowStock === 1 ? 'drops' : 'drop'} below its low-stock threshold doing so.`,
      );
    }

    return parts.join('\n\n');
  }

  private evidence(nowMs: number, horizonDays: number) {
    return {
      source_type: 'colour_prep(booking+lab+inventory)',
      source_ref: `colour-prep:${horizonDays}d`,
      as_of: new Date(nowMs).toISOString(),
      entities_used: [],
    };
  }
}

interface SitePrep {
  locationName: string;
  appointmentCount: number;
  appointmentsWithoutFormula: number;
  shortfallProductCount: number;
  lowStockProductCount: number;
  unmappedProductCount: number;
  wasteAllowancePercent: number;
  fromDate: string;
  toDate: string;
  timezone: string;
  products: ZacSafePrepRequirement[];
}

function describeSites(sites: SitePrep[]): string {
  if (sites.length === 0) return 'your locations';
  if (sites.length === 1) return sites[0]!.locationName;
  if (sites.length === 2) return `${sites[0]!.locationName} and ${sites[1]!.locationName}`;
  return `${sites.length} locations`;
}

function resolveHorizon(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_HORIZON_DAYS;
  // A forward book beyond a couple of months is speculative, and a sub-day
  // horizon answers a question nobody asked.
  return Math.min(60, Math.max(1, Math.round(raw)));
}

/** Local calendar date for the ColourPrep `custom` range. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
