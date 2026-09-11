import type { AuthUser, DeadStockThresholdSource } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import type { ZacInventoryRead, ZacSafeDeadStock, ZacSafeStockLevel } from '../ports/zac-service-ports';
import { projectDeadStock, projectStockLevel } from '../ports/zac-service-ports';
import {
  capConfidenceAcross,
  formatDate,
  formatStockQuantity,
  isMeasured,
  limitationsFor,
  money,
  moneyTotal,
  toNullableNumber,
} from '../coverage/zac-coverage';
import { probeStockCoverage } from '../coverage/zac-feasibility-probe';

/**
 * Dead-stock rows carried into the payload. The SQL function's own ordering is
 * preserved, so this is a "worst first" truncation rather than an arbitrary one.
 * Hitting it exactly means the list is a LOWER BOUND, which the answer says.
 */
const MAX_DEAD_STOCK_ROWS = 25;

/** Items named in the prose. The rest stay in the structured payload. */
const NAMED_ITEM_COUNT = 4;

/**
 * Fraction of products that must record a cost before a money total is shown.
 *
 * `totalEstimatedValueCents` silently sums a cost-less product as ZERO, so a
 * value figure over a thinly-costed catalogue is not a smaller number — it is a
 * wrong one. On the live catalogue 6 of 10 products carry a cost, which clears
 * this bar; 4 of 10 would not.
 */
const MIN_COST_COVERAGE = 0.5;

/**
 * Workstream 3 — the STOCK domain.
 *
 * One tool, two questions an owner asks together: what is running out, and what
 * is sitting there not moving. Splitting them would double the twelve
 * enumeration sites a tool has to be threaded through for no gain in the answer.
 *
 * WHICH SOURCE IS AUTHORITATIVE, AND WHY IT MATTERS HERE.
 *
 *   - LOW STOCK is taken from `listStock({lowStockOnly: true})`, the LIVE
 *     computation over `location_stock`.
 *   - `listLowStock` reads the MATERIALISED `low_stock_alerts` table, which is
 *     maintained only by `adjust_location_stock` and `updateStockThreshold`;
 *     `initializeStock` and `setProductAvailability` write thresholds without
 *     touching it. On the working database the two disagree — 3 live-low rows
 *     against 2 open alert rows.
 *
 * So the live computation wins, and the divergence is REPORTED rather than
 * silently reconciled. Repairing the cache would be a write, and Phase 2 has
 * none.
 *
 * DEAD STOCK IS NEVER RE-DERIVED. `listDeadStock` wraps the SQL function
 * `inventory.dead_stock_report`, which owns the rules: outbound movements only
 * (a restock is not usage and must not reset the idle clock), zero-on-hand
 * excluded (that is "out of stock", not "dead stock"), and threshold precedence
 * product -> category -> location default. Reimplementing any of that in
 * TypeScript would give ZAC a second opinion that disagrees with the
 * Inventory screen.
 *
 * THE THRESHOLD IS PART OF THE FINDING. Every dead-stock row on the live
 * database is flagged against a `location_default` of 30 days — a value
 * Kensington deliberately set, against a platform default of 90. Against a
 * colour restock cadence of six to eight weeks, a 30-day threshold flags
 * essentially the whole shelf. Reporting "6 of 6 products are dead" without
 * naming the threshold presents a configuration choice as a business problem.
 *
 * POINT-IN-TIME, NOT PERIOD-AWARE. Shelf state is now. This tool is deliberately
 * absent from PERIOD_AWARE_TOOLS and says it describes today, rather than
 * pretending a window was applied to a quantity that has none.
 */
export class InventoryStockStatusTool implements ZacReadOnlyTool {
  readonly name = 'inventory.stock_status' as const;
  readonly domain = 'inventory' as const;
  readonly description =
    'Reports what stock is at or below its low-stock threshold right now, and what has been sitting unused past its dead-stock threshold.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  /**
   * `inventory.manage` is a write-SOUNDING key that also gates every inventory
   * READ: `InventoryService.resolveLocationScope` calls `assertManagerOrOwner`,
   * which is a real `userHasPermission(actor, 'inventory.manage')` check, on
   * every read path this tool uses.
   *
   * So declaring anything weaker would be cosmetic — ZAC would advertise a
   * capability the service then throws on. Introducing a read-only
   * `inventory.view` key is a permission-model change (the Permission union,
   * PERMISSION_CATALOG, DEFAULT_ROLE_PERMISSIONS, a seed migration under the
   * 0074 rule, AND relaxing the service's own assertion) and belongs in its own
   * approved change request, not in a read-only phase.
   */
  readonly requiredPermissions = ['inventory.manage'] as const;
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
      'Live low-stock items, dead-stock items with their threshold provenance, and the ledger recency both are read against.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  // Shelf state changes on every sale and every formula saved, and "what am I
  // out of" is a question people ask mid-service. Short.
  readonly cachePolicy = { ttlSeconds: 120, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly inventory: ZacInventoryRead) {}

  async execute(
    actor: AuthUser,
    _context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const nowMs = Date.now();
    const locationId = typeof input['locationId'] === 'string' ? input['locationId'] : undefined;
    // Point-in-time: the "window" exists only so ledger recency has something
    // to be recent RELATIVE TO. Seven days is the span within which a salon
    // would expect to have touched stock at all.
    const windowFromIso = new Date(nowMs - 7 * 86_400_000).toISOString();

    const probe = await probeStockCoverage(this.inventory, actor, {
      ...(locationId === undefined ? {} : { locationId }),
      windowFromIso,
      nowMs,
    });

    if (probe.verdict === 'unreadable') {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not read your stock levels just now.',
        rowCount: null,
      };
    }

    if (probe.verdict === 'not_configured') {
      return {
        status: 'ok',
        data: { stock_records: 0, products: probe.products },
        explanation: 'No stock has been set up at the locations this user can see.',
        rowCount: 0,
        presentation: {
          answer:
            probe.products > 0
              ? `You have ${probe.products} ${plural(probe.products, 'product')} in your catalogue, but none of them has ` +
                `stock set up at a location I can see. Until a product is stocked against a location with an opening ` +
                `quantity, I cannot tell you what is running low or what is sitting unused.\n\n` +
                `This is about set-up rather than a stock problem.`
              : `You have no products set up, so there is no stock for me to report on. ` +
                `This is about set-up rather than a stock problem.`,
          evidence: [this.evidence(nowMs)],
          confidence: 'high',
          limitations: probe.limitations,
          suggestedNextStep: 'Set an opening quantity and a low-stock threshold per product in Inventory.',
          responseType: 'Explanation',
        },
      };
    }

    // Two independent sections. Either may fail without sinking the other —
    // an owner asking "what am I low on?" should still get the low-stock half
    // if the dead-stock RPC is unavailable.
    const [lowResult, deadResult, alertResult] = await Promise.allSettled([
      this.inventory.listStock(actor, {
        ...(locationId === undefined ? {} : { locationId }),
        lowStockOnly: true,
      }),
      this.inventory.listDeadStock(actor, locationId),
      this.inventory.listLowStock(actor, locationId),
    ]);

    const limitations: string[] = [...probe.limitations];

    // ---- Low stock, from the LIVE computation ------------------------------
    let lowStock: ZacSafeStockLevel[] = [];
    if (lowResult.status === 'fulfilled') {
      lowStock = lowResult.value.stock.filter((row) => row.isActive).map(projectStockLevel);
    } else {
      limitations.push('I could not read your current stock levels, so the low-stock list is missing.');
    }

    // ---- Dead stock, from the SQL function ---------------------------------
    let deadStock: ZacSafeDeadStock[] = [];
    let deadTotalValueCents = 0;
    let deadTruncated = false;
    if (deadResult.status === 'fulfilled') {
      const all = deadResult.value.items.map(projectDeadStock);
      deadTruncated = all.length > MAX_DEAD_STOCK_ROWS;
      deadStock = all.slice(0, MAX_DEAD_STOCK_ROWS);
      deadTotalValueCents = deadResult.value.totalEstimatedValueCents;
    } else {
      limitations.push('I could not read your dead-stock report, so idle stock is not covered here.');
    }

    // ---- The materialised cache, for RECONCILIATION only -------------------
    let openAlertCount: number | null = null;
    if (alertResult.status === 'fulfilled') {
      openAlertCount = alertResult.value.alerts.length;
    }

    // The money figure only if enough of the catalogue is costed. A cost-less
    // product sums as zero inside totalEstimatedValueCents, so this guards
    // against quoting a total that is silently short.
    const valueReading = moneyTotal({
      totalCents: deadTotalValueCents,
      covered: probe.productsWithCost,
      total: probe.products,
      sampleUnit: 'products',
      asOf: probe.ledger.newestIso,
      minCoverage: MIN_COST_COVERAGE,
    });

    limitations.push(...limitationsFor(valueReading, 'the value of idle stock'));

    // THE LEDGER SENTENCE. Prefixes every idle-stock claim, so a quiet ledger
    // is never mistaken for a purchasing problem.
    if (probe.ledger.newestIso !== null && probe.ledger.predatesWindow) {
      limitations.push(
        `Your stock ledger's most recent movement is ${formatDate(probe.ledger.newestIso)}, ` +
          `${probe.ledger.daysSince} days ago. If stock is being used without being recorded, ` +
          `items will look idle here when they are not.`,
      );
    }

    if (deadTruncated) {
      limitations.push(
        `I have listed the ${MAX_DEAD_STOCK_ROWS} longest-idle items; there are more, so treat this as a lower bound.`,
      );
    }

    if (openAlertCount !== null && openAlertCount !== lowStock.length) {
      limitations.push(
        `Your saved low-stock alerts show ${openAlertCount} open ${plural(openAlertCount, 'item')} while the live ` +
          `figures show ${lowStock.length}. I have used the live figures. The saved alerts only refresh when stock ` +
          `is adjusted or a threshold is edited, so they can lag.`,
      );
    }

    const answer = this.buildAnswer({
      lowStock,
      deadStock,
      deadTruncated,
      valueCents: isMeasured(valueReading) ? toNullableNumber(valueReading) : null,
      thresholdSources: summariseThresholds(deadStock),
      ledgerIso: probe.ledger.newestIso,
      thresholdsConfigured: probe.thresholdsConfigured,
      stockRecords: probe.stockRecords,
    });

    return {
      status: 'ok',
      data: {
        as_of: new Date(nowMs).toISOString(),
        stock_records: probe.stockRecords,
        thresholds_configured: probe.thresholdsConfigured,
        low_stock_count: lowStock.length,
        low_stock: lowStock,
        dead_stock_count: deadStock.length,
        dead_stock_truncated: deadTruncated,
        dead_stock: deadStock,
        // NULL, never 0, when too little of the catalogue records a cost.
        dead_stock_value_cents: isMeasured(valueReading) ? toNullableNumber(valueReading) : null,
        products_with_cost: probe.productsWithCost,
        products: probe.products,
        open_alert_rows: openAlertCount,
        ledger_newest_at: probe.ledger.newestIso,
      },
      explanation:
        'Low stock is the live calculation over your current shelf quantities; idle stock comes from QLOOQO’s dead-stock report. Neither is recalculated here.',
      rowCount: lowStock.length + deadStock.length,
      presentation: {
        answer,
        evidence: [this.evidence(nowMs)],
        confidence: capConfidenceAcross(
          deadResult.status === 'fulfilled' && lowResult.status === 'fulfilled' ? 'high' : 'medium',
          [valueReading],
        ),
        limitations,
        suggestedNextStep:
          deadStock.length > 0
            ? 'Open Inventory to review the idle items, or adjust the dead-stock threshold if it is flagging normal stock.'
            : 'Ask "what would I need to order?" for a reorder recommendation.',
        responseType: 'Insight',
      },
    };
  }

  private buildAnswer(input: {
    lowStock: ZacSafeStockLevel[];
    deadStock: ZacSafeDeadStock[];
    deadTruncated: boolean;
    valueCents: number | null;
    thresholdSources: Record<DeadStockThresholdSource, number>;
    ledgerIso: string | null;
    thresholdsConfigured: number;
    stockRecords: number;
  }): string {
    const parts: string[] = [];

    // ---- Low stock ---------------------------------------------------------
    if (input.thresholdsConfigured === 0) {
      parts.push(
        `I cannot tell you what is running low: none of your ${input.stockRecords} stock ` +
          `${plural(input.stockRecords, 'record')} has a low-stock threshold set. A threshold of zero means ` +
          `"never flag this", so an empty list here would not mean everything is fine.`,
      );
    } else if (input.lowStock.length === 0) {
      parts.push(
        `Nothing is at or below its low-stock threshold right now, across ${input.thresholdsConfigured} ` +
          `${plural(input.thresholdsConfigured, 'item')} with a threshold set.`,
      );
    } else {
      const named = input.lowStock
        .slice(0, NAMED_ITEM_COUNT)
        .map(
          (row) =>
            `${row.productName} at ${row.locationName} (${formatStockQuantity(row.quantityOnHandGrams, 'gram')} left, ` +
            `threshold ${formatStockQuantity(row.effectiveLowStockThresholdGrams, 'gram')})`,
        );
      const rest = input.lowStock.length - named.length;
      parts.push(
        `${input.lowStock.length} ${plural(input.lowStock.length, 'item')} ${input.lowStock.length === 1 ? 'is' : 'are'} ` +
          `at or below ${input.lowStock.length === 1 ? 'its' : 'their'} low-stock threshold: ${named.join(', ')}` +
          `${rest > 0 ? `, and ${rest} more` : ''}.`,
      );
      const empty = input.lowStock.filter((row) => row.quantityOnHandGrams <= 0);
      if (empty.length > 0) {
        parts.push(
          `${empty.length} of ${input.lowStock.length === 1 ? 'those' : 'them'} ` +
            `${empty.length === 1 ? 'has' : 'have'} run out completely.`,
        );
      }
    }

    // ---- Dead stock --------------------------------------------------------
    if (input.deadStock.length === 0) {
      parts.push('Nothing has been sitting unused past its dead-stock threshold.');
    } else {
      const named = input.deadStock
        .slice(0, NAMED_ITEM_COUNT)
        .map(
          (row) =>
            `${row.productName} at ${row.locationName} (${formatStockQuantity(row.quantityOnHandGrams, row.stockUnit)}, ` +
            `${row.daysIdle} days idle)`,
        );
      const rest = input.deadStock.length - named.length;
      const valuePhrase = input.valueCents === null ? '' : `, worth about ${money(input.valueCents, 'GBP')}`;
      parts.push(
        `${input.deadStock.length}${input.deadTruncated ? '+' : ''} ${plural(input.deadStock.length, 'item')} ` +
          `${input.deadStock.length === 1 ? 'has' : 'have'} had no stock leave the shelf for longer than ` +
          `${input.deadStock.length === 1 ? 'its' : 'their'} threshold${valuePhrase}: ${named.join(', ')}` +
          `${rest > 0 ? `, and ${rest} more` : ''}.`,
      );

      // The threshold is part of the finding, not a footnote.
      const fromLocationDefault = input.thresholdSources.location_default;
      if (fromLocationDefault === input.deadStock.length && input.deadStock.length > 1) {
        const days = input.deadStock[0]?.thresholdDays;
        parts.push(
          `All of those are measured against your location's default of ${days} days — no product or category ` +
            `sets its own. If ${days} days is short for how you actually work through colour, the threshold is ` +
            `the thing to change before the stock is.`,
        );
      }
    }

    if (input.ledgerIso !== null) {
      parts.push(`Both figures are read against a stock ledger whose most recent movement is ${formatDate(input.ledgerIso)}.`);
    }

    return parts.join('\n\n');
  }

  private evidence(nowMs: number) {
    return {
      source_type: 'inventory.location_stock',
      source_ref: 'live-stock-and-dead-stock-report',
      as_of: new Date(nowMs).toISOString(),
      entities_used: [],
    };
  }
}

function summariseThresholds(rows: ZacSafeDeadStock[]): Record<DeadStockThresholdSource, number> {
  const counts: Record<DeadStockThresholdSource, number> = {
    product: 0,
    category: 0,
    location_default: 0,
  };
  for (const row of rows) counts[row.thresholdSource] += 1;
  return counts;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
