import type { AuthUser, PurchaseOrderStatus } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import type { ZacInventoryRead, ZacOrdersRead } from '../ports/zac-service-ports';
import { formatStockQuantity, money, moneyTotal, isMeasured, limitationsFor, toNullableNumber } from '../coverage/zac-coverage';

/** Locations checked per call — each is one preview round trip. */
const MAX_LOCATIONS = 5;

/** Products named in the prose. */
const NAMED_LINE_COUNT = 4;

/** Order statuses that mean "a person is already dealing with this". */
const IN_PREPARATION: PurchaseOrderStatus[] = ['draft', 'pending_approval', 'approved'];

/**
 * Workstream 3 — ORDER-RECOMMENDATION CONTEXT. **Advisory only.**
 *
 * WHAT THIS TOOL IS NOT ALLOWED TO DO, and how that is guaranteed.
 *
 * Phase 2's boundary is explicit: ZAC may recommend, prioritise and deep-link,
 * but must not "autonomously change bookings, clients, staff, stock, prices,
 * payments or send external messages". Ordering is the sharpest edge of that,
 * because the ordering module's own suggestion method — `OrdersService.generate`
 * — allocates a gapless purchase-order number, writes rows, records an audit
 * entry and EMAILS A SUPPLIER. Asking it "what would you order?" used to mean
 * ordering.
 *
 * So Workstream 3 added `OrdersService.previewReorder`: the same arithmetic,
 * shared through one private computation, with the write loop simply absent.
 * This tool reads that, and:
 *
 *   - its port (`ZacOrdersRead`) does not contain `generate`, `submit`,
 *     `cancel` or `send`, so calling one is a COMPILE ERROR;
 *   - the WS3 boundary sweep fails the build if this file so much as names one;
 *   - every sentence it produces is framed as a recommendation for a person,
 *     and it closes by pointing at the screen where a human clicks Generate.
 *
 * Upstream, the request-mode classifier already refuses an imperative ordering
 * request before any dispatch — "reorder" is a strong write verb and stock is
 * an operational object, so "Order this stock" resolves to a read-only boundary
 * refusal. This tool exists for the READ-shaped counterpart: "what would I need
 * to order?".
 *
 * THE HONESTY FLAG THAT MATTERS MOST. `previewReorder` returns `usageObserved`.
 * On the working database it is FALSE for every suggested line: each shortfall
 * is a top-up to a configured low-stock threshold with zero recorded outbound
 * movement behind it. Saying "based on your usage" over that would be an
 * invented justification, so the answer says which it is.
 *
 * PERMISSION. `orders.view`, deliberately not `orders.manage`. Someone trusted
 * to look at orders can be advised about them; preparing one is a separate,
 * higher permission and sending is higher still (migration 0094 makes
 * `orders.approve` the spend control). Advice should not require the power to
 * act on it. It is also a DIFFERENT key from the other three WS3 tools, so an
 * inventory-only manager never sees supplier or spend data.
 */
export class InventoryReorderAdvisoryTool implements ZacReadOnlyTool {
  readonly name = 'inventory.reorder_advisory' as const;
  readonly domain = 'inventory' as const;
  readonly description =
    'Reports which products are below where your own reorder settings say they should be, and what an order would contain. Advisory only — it never places an order.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['orders.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      locationId: {
        type: 'string',
        description: 'Optional single-location focus; must be inside the acting user scope.',
      },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Suggested order lines with the shortfall behind each, products that cannot be ordered and why, and any order already in preparation.',
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
    private readonly orders: ZacOrdersRead,
    private readonly inventory: ZacInventoryRead,
    private readonly locations: (actor: AuthUser) => Promise<{ id: string; name: string }[]>,
  ) {}

  async execute(
    actor: AuthUser,
    _context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const nowMs = Date.now();
    const requestedLocationId =
      typeof input['locationId'] === 'string' ? input['locationId'] : undefined;

    let targets: { id: string; name: string }[];
    try {
      const all = await this.locations(actor);
      targets = requestedLocationId ? all.filter((l) => l.id === requestedLocationId) : all;
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
          answer: 'I could not find a location to check reorder levels for.',
          evidence: [this.evidence(nowMs)],
          confidence: 'high',
          limitations: [],
          suggestedNextStep: null,
          responseType: 'Explanation',
        },
      };
    }

    const truncated = targets.length > MAX_LOCATIONS;
    const checked = targets.slice(0, MAX_LOCATIONS);

    const previews = await Promise.allSettled(
      checked.map((location) => this.orders.previewReorder(actor, location.id)),
    );

    const limitations: string[] = [];
    const sites: SiteAdvice[] = [];
    let unreadable = 0;

    previews.forEach((result, index) => {
      const location = checked[index];
      if (!location) return;
      if (result.status !== 'fulfilled') {
        unreadable += 1;
        limitations.push(`I could not work out reorder levels for ${location.name}.`);
        return;
      }
      sites.push({ locationName: location.name, preview: result.value });
    });

    if (unreadable === checked.length) {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not work out reorder levels just now.',
        rowCount: null,
      };
    }

    if (truncated) {
      limitations.push(
        `You have ${targets.length} locations; I checked ${checked.length}. Ask about one by name for the rest.`,
      );
    }

    const lines = sites.flatMap((site) =>
      site.preview.lines.map((line) => ({ site: site.locationName, line })),
    );
    const unorderable = sites.flatMap((site) =>
      site.preview.unorderable.map((product) => ({ site: site.locationName, product })),
    );
    /**
     * Usage behind THE LINES BEING SUGGESTED — not usage anywhere at the site.
     *
     * `preview.usageObserved` is a per-LOCATION flag: true when any product at
     * that location moved in the window. That is the wrong denominator for this
     * sentence, and on real data it produces a false claim.
     *
     * Salon, 2026-09-11: Kensington has genuine outbound usage (132-150g) but
     * NO shortfall, while the two actual suggestions sit at Pinner and Primrose
     * Hill with zero recorded usage each. Taking `some()` across sites made the
     * answer say "at the rate you got through stock" about two lines that are
     * pure threshold top-ups — the precise invention this flag exists to stop.
     *
     * Reading it off the suggested lines ties the justification to the thing
     * being justified.
     */
    const anyUsageObserved = lines.some((entry) => entry.line.outboundBaseInWindow > 0);
    const windowWeeks = sites[0]?.preview.windowWeeks ?? 8;
    const coverageWeeks = sites[0]?.preview.coverageWeeks ?? 4;

    // ---- Orders already in preparation -------------------------------------
    // So ZAC never advises ordering something a person has already drafted.
    let inPreparation: { orderNumber: string; status: PurchaseOrderStatus; supplierName: string }[] = [];
    try {
      const open = await this.orders.list(actor, {
        ...(requestedLocationId === undefined ? {} : { locationId: requestedLocationId }),
      });
      inPreparation = open.orders
        .filter((order) => IN_PREPARATION.includes(order.status))
        .map((order) => ({
          orderNumber: order.orderNumber,
          status: order.status,
          supplierName: order.supplierName ?? 'a supplier',
        }));
    } catch {
      limitations.push(
        'I could not check whether an order is already being prepared, so some of this may already be in hand.',
      );
    }

    // ---- Supplier coverage: the real finding on a thin catalogue -----------
    let productsWithSupplier: number | null = null;
    let productCount: number | null = null;
    try {
      const catalogue = await this.inventory.listProducts(actor, {});
      const active = catalogue.products.filter((product) => product.isActive);
      productCount = active.length;
      productsWithSupplier = active.filter((product) => product.supplierId !== undefined).length;
    } catch {
      // Secondary read: never sinks the answer.
    }

    // ---- Cost coverage on the total ---------------------------------------
    const withCost = lines.filter((entry) => entry.line.lineTotalCents !== null);
    const subtotalReading = moneyTotal({
      totalCents: withCost.reduce((total, entry) => total + (entry.line.lineTotalCents ?? 0), 0),
      covered: withCost.length,
      total: lines.length,
      sampleUnit: 'suggested lines',
      asOf: new Date(nowMs).toISOString(),
    });
    if (lines.length > 0) limitations.push(...limitationsFor(subtotalReading, 'the estimated order value'));

    // THE HONESTY SENTENCE about what drove the suggestion.
    if (lines.length > 0 && !anyUsageObserved) {
      limitations.push(
        `No product usage was recorded in the last ${windowWeeks} weeks, so these are top-ups to the low-stock ` +
          `thresholds you set, not forecasts from what you actually got through.`,
      );
    }
    if (lines.length > 0) {
      limitations.push(
        'Usage counts what was deducted from stock. Reversed deductions are not netted off, so consumption may be overstated.',
      );
      limitations.push(
        'Supplier lead times are not part of this calculation — it covers the weeks of stock your settings ask for, not when a delivery would arrive.',
      );
    }

    return {
      status: 'ok',
      data: {
        as_of: new Date(nowMs).toISOString(),
        locations_checked: sites.length,
        usage_window_weeks: windowWeeks,
        coverage_weeks: coverageWeeks,
        usage_observed: anyUsageObserved,
        suggested_line_count: lines.length,
        estimated_value_cents: isMeasured(subtotalReading) ? toNullableNumber(subtotalReading) : null,
        unorderable_count: unorderable.length,
        products: productCount,
        products_with_supplier: productsWithSupplier,
        orders_in_preparation: inPreparation.length,
        suggested_lines: lines.map((entry) => ({
          location_name: entry.site,
          product_name: entry.line.productName,
          supplier_name: entry.line.supplierName,
          suggested_packs: entry.line.suggestedQuantity,
          pack_size: entry.line.packSize,
          stock_unit: entry.line.stockUnit,
          shortfall_base: entry.line.shortfallBase,
          on_hand_base: entry.line.onHandBase,
          threshold_base: entry.line.thresholdBase,
          outbound_base_in_window: entry.line.outboundBaseInWindow,
          line_total_cents: entry.line.lineTotalCents,
        })),
        unorderable: unorderable.map((entry) => ({
          location_name: entry.site,
          product_name: entry.product.productName,
          reason: entry.product.reason,
        })),
      },
      explanation:
        'These are the quantities QLOOQO’s own reorder calculation would suggest, read without creating anything.',
      rowCount: lines.length,
      presentation: {
        answer: this.buildAnswer({
          lines,
          unorderable,
          sites,
          anyUsageObserved,
          windowWeeks,
          coverageWeeks,
          subtotalCents: isMeasured(subtotalReading) ? toNullableNumber(subtotalReading) : null,
          inPreparation,
          productCount,
          productsWithSupplier,
        }),
        evidence: [this.evidence(nowMs)],
        confidence: unreadable > 0 ? 'medium' : 'high',
        limitations,
        // Always ends with a person doing the acting.
        suggestedNextStep:
          lines.length > 0
            ? 'Open Purchase orders in QLOOQO to review and generate this order — I have not created anything.'
            : unorderable.length > 0
              ? 'Attach a supplier to those products in Inventory so they can be ordered.'
              : null,
        // Being below your own reorder point is a RISK — you are heading for a
        // stock-out. With nothing to order it is simply an observation.
        responseType: lines.length > 0 || unorderable.length > 0 ? 'Risk' : 'Insight',
      },
    };
  }

  private buildAnswer(input: {
    lines: { site: string; line: SiteAdvice['preview']['lines'][number] }[];
    unorderable: { site: string; product: { productName: string; reason: string } }[];
    sites: SiteAdvice[];
    anyUsageObserved: boolean;
    windowWeeks: number;
    coverageWeeks: number;
    subtotalCents: number | null;
    inPreparation: { orderNumber: string; status: PurchaseOrderStatus; supplierName: string }[];
    productCount: number | null;
    productsWithSupplier: number | null;
  }): string {
    const parts: string[] = [];

    if (input.lines.length === 0 && input.unorderable.length === 0) {
      parts.push(
        `Nothing is below its reorder point at ${describeSites(input.sites)}. Your settings aim to keep ` +
          `${input.coverageWeeks} weeks of stock on the shelf, and everything currently clears that.`,
      );
    } else if (input.lines.length > 0) {
      const named = input.lines
        .slice(0, NAMED_LINE_COUNT)
        .map(
          (entry) =>
            `${entry.line.suggestedQuantity} × ${entry.line.productName} at ${entry.site} ` +
            `(${formatStockQuantity(entry.line.onHandBase, entry.line.stockUnit)} on hand against a ` +
            `${formatStockQuantity(entry.line.thresholdBase, entry.line.stockUnit)} threshold)`,
        );
      const rest = input.lines.length - named.length;
      const valuePhrase = input.subtotalCents === null ? '' : `, about ${money(input.subtotalCents, 'GBP')} in total`;

      parts.push(
        `If you were ordering today, ${input.lines.length} ${plural(input.lines.length, 'product')} would be on it` +
          `${valuePhrase}: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`,
      );

      parts.push(
        input.anyUsageObserved
          ? `That covers ${input.coverageWeeks} weeks at the rate you got through stock over the last ${input.windowWeeks} weeks.`
          : `Nothing was recorded as used in the last ${input.windowWeeks} weeks, so these are top-ups to the ` +
            `low-stock thresholds you set rather than a forecast from your actual usage.`,
      );
    }

    if (input.unorderable.length > 0) {
      const noSupplier = input.unorderable.filter((entry) => entry.product.reason === 'no_supplier');
      const noPack = input.unorderable.filter((entry) => entry.product.reason === 'no_pack_size');
      if (noSupplier.length > 0) {
        parts.push(
          `${noSupplier.length} ${plural(noSupplier.length, 'product')} ${noSupplier.length === 1 ? 'needs' : 'need'} ` +
            `stock but ${noSupplier.length === 1 ? 'has' : 'have'} no supplier attached, so ${noSupplier.length === 1 ? 'it' : 'they'} ` +
            `cannot go on an order: ${noSupplier.slice(0, NAMED_LINE_COUNT).map((entry) => `${entry.product.productName} at ${entry.site}`).join(', ')}.`,
        );
      }
      if (noPack.length > 0) {
        parts.push(
          `${noPack.length} ${plural(noPack.length, 'product')} ${noPack.length === 1 ? 'has' : 'have'} no pack size ` +
            `recorded, so I cannot work out how much to order rather than guess.`,
        );
      }
    }

    if (
      input.productsWithSupplier !== null &&
      input.productCount !== null &&
      input.productCount > 0 &&
      input.productsWithSupplier < input.productCount
    ) {
      parts.push(
        `More broadly, ${input.productCount - input.productsWithSupplier} of your ${input.productCount} active ` +
          `${plural(input.productCount, 'product')} ${input.productCount - input.productsWithSupplier === 1 ? 'has' : 'have'} ` +
          `no supplier attached. Until they do, they can never appear on an order form.`,
      );
    }

    if (input.inPreparation.length > 0) {
      const named = input.inPreparation
        .slice(0, 3)
        .map((order) => `${order.orderNumber} for ${order.supplierName} (${order.status.replace(/_/g, ' ')})`);
      parts.push(`Worth knowing before you act: ${named.join(', ')} ${input.inPreparation.length === 1 ? 'is' : 'are'} already in progress.`);
    }

    if (input.lines.length > 0) {
      // The closing frame. Never "I have ordered" — always a person deciding.
      parts.push(
        `This is a suggestion to review, not an order. Nothing has been created or sent — generating an order ` +
          `is done by a person from Purchase orders in QLOOQO.`,
      );
    }

    return parts.join('\n\n');
  }

  private evidence(nowMs: number) {
    return {
      source_type: 'inventory.location_stock+inventory.reorder_usage',
      source_ref: 'reorder-preview',
      as_of: new Date(nowMs).toISOString(),
      entities_used: [],
    };
  }
}

interface SiteAdvice {
  locationName: string;
  preview: Awaited<ReturnType<ZacOrdersRead['previewReorder']>>;
}

function describeSites(sites: SiteAdvice[]): string {
  if (sites.length === 0) return 'your locations';
  if (sites.length === 1) return sites[0]!.locationName;
  if (sites.length === 2) return `${sites[0]!.locationName} and ${sites[1]!.locationName}`;
  return `any of your ${sites.length} locations`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
