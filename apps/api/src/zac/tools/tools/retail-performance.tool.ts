import type { AuthUser, RetailSale, RetailSalesListResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import type { RetailSalesService } from '../../../retail-sales/retail-sales.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { periodFromInput } from '../zac-period';

/** A trading month — retail is too sparse to read weekly. */
const DEFAULT_RANGE_DAYS = 30;

/**
 * The row ceiling ZAC asks for. Hitting it exactly means the window was cut
 * short, and every figure derived from it is then a LOWER BOUND — which the
 * answer says, rather than quietly under-reporting the month.
 */
const MAX_SALE_ROWS = 1000;

/** Products named in the answer. Keeps a long tail out of the prose. */
const TOP_PRODUCT_COUNT = 3;

/**
 * Expanded Intelligence — the RETAIL domain.
 *
 * Reads the guarded `RetailSalesService.list` (owner/manager, `report.
 * financials.view`, location-scoped by the service itself) and reports what
 * the salon actually sold: value, volume, average sale and the products
 * leading it.
 *
 * TWO FIGURES ARE COMPUTED, BOTH AS PLAIN ARITHMETIC ON RECORDED NUMBERS.
 *
 * Retail attachment — retail sales per completed paid visit — needs the
 * dashboard's visit count as its denominator. That second read is attempted
 * and allowed to fail: an actor with retail access but no dashboard permission
 * still gets the retail figures, with the attach rate simply absent rather
 * than the whole answer refused.
 *
 * Retail margin is stated ONLY from sales that carry a recorded `unitCostCents`
 * (the pricing-provenance snapshot taken at the till). Sales rung up before
 * that snapshot existed have no cost, so they are excluded from the margin and
 * the coverage is reported alongside it. This is not a profitability view of
 * the business — service cost is not tracked at all — and the answer says so,
 * because a retail margin presented as "profit" is the exact false claim the
 * ZAC evidence rules exist to prevent.
 */
export class RetailPerformanceTool implements ZacReadOnlyTool {
  readonly name = 'report.retail_performance' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Summarises retail sales value, volume, leading products and retail attachment per visit.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.financials.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Retail totals, leading products, attachment rate and cost-covered margin.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(
    private readonly retailSales: RetailSalesService,
    private readonly dashboard: DashboardService,
  ) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period = periodFromInput(input, DEFAULT_RANGE_DAYS);
    const to = new Date(period.toIso);
    const from = new Date(period.fromIso);

    let retail: RetailSalesListResponse;
    try {
      retail = await this.retailSales.list(actor, {
        locationId: context.locationId ?? undefined,
        from: from.toISOString(),
        to: to.toISOString(),
        limit: MAX_SALE_ROWS,
      });
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your retail sales just now, so I have no retail figures to share.',
        rowCount: null,
      };
    }

    const sales = retail.sales;
    const truncated = sales.length >= MAX_SALE_ROWS;
    const currency = retail.currencyCode;

    // The visit denominator for attachment. Deliberately optional: retail
    // access and dashboard access are separate permissions, and losing one
    // must not cost the actor the other.
    const completedPaidVisits = await this.completedPaidVisits(actor, context, from, to);

    if (sales.length === 0) {
      return {
        status: 'ok',
        data: {
          range_start: retail.rangeStart ?? from.toISOString(),
          range_end: retail.rangeEnd ?? to.toISOString(),
          sale_count: 0,
          total_amount_cents: 0,
          currency_code: currency,
          completed_paid_visits: completedPaidVisits,
        },
        explanation: 'No retail sales were recorded in the reporting window.',
        rowCount: 0,
        presentation: {
          answer: `No retail sales were recorded in ${period.label}. If products are being sold, they may be going through as part of the bill rather than as retail sales.`,
          evidence: [this.evidence(retail, to)],
          confidence: 'high',
          limitations: [
            'Only sales recorded as retail at the till appear here.',
            'An empty window is not proof that nothing was sold — it may mean nothing was rung up as retail.',
          ],
          suggestedNextStep:
            'Ask "What are my top services?" to see the service side of the same period.',
          responseType: 'Explanation',
        },
      };
    }

    const unitCount = sales.reduce((sum, sale) => sum + sale.quantity, 0);
    const totalCents = retail.totalAmountCents;
    const averageSaleCents = Math.round(totalCents / sales.length);
    const attachRatePercent =
      completedPaidVisits !== null && completedPaidVisits > 0
        ? Math.round((sales.length / completedPaidVisits) * 100)
        : null;

    const topProducts = this.rankProducts(sales).slice(0, TOP_PRODUCT_COUNT);
    const margin = this.margin(sales);

    const answer = [
      `Retail took ${formatMoney(totalCents, currency)} over ${period.label} from ${sales.length} ${sales.length === 1 ? 'sale' : 'sales'} (${unitCount} ${unitCount === 1 ? 'item' : 'items'}), averaging ${formatMoney(averageSaleCents, currency)} a sale.`,
      attachRatePercent !== null
        ? `That is roughly ${attachRatePercent} retail ${attachRatePercent === 1 ? 'sale' : 'sales'} per 100 paid visits.`
        : '',
      topProducts.length > 0
        ? `Leading products: ${topProducts.map((product) => `${product.product_name} (${formatMoney(product.revenue_cents, currency)})`).join(', ')}.`
        : '',
      margin
        ? `On the ${margin.covered_sale_count} ${margin.covered_sale_count === 1 ? 'sale that carries' : 'sales that carry'} a recorded cost, gross margin was ${margin.margin_percent}%.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    const limitations = [
      'Only sales recorded as retail at the till are counted — products added to a service bill are not.',
      `Figures cover ${period.label} and the locations you can see.`,
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
    ];
    if (attachRatePercent === null) {
      limitations.push(
        'Retail attachment per visit is not shown: the visit count it needs comes from dashboard KPIs, which are not available to this answer.',
      );
    }
    if (margin) {
      limitations.push(
        `Margin covers ${margin.coverage_percent}% of retail value — only sales with a cost recorded at the till. It is retail gross margin, not business profit: service costs are not tracked.`,
      );
    } else {
      limitations.push(
        'No retail margin is shown: none of these sales carries a recorded product cost.',
      );
    }
    if (truncated) {
      limitations.push(
        `Only the ${MAX_SALE_ROWS} most recent sales were read, so these totals are a lower bound for the period.`,
      );
    }

    return {
      status: 'ok',
      data: {
        range_start: retail.rangeStart ?? from.toISOString(),
        range_end: retail.rangeEnd ?? to.toISOString(),
        sale_count: sales.length,
        unit_count: unitCount,
        total_amount_cents: totalCents,
        average_sale_cents: averageSaleCents,
        currency_code: currency,
        completed_paid_visits: completedPaidVisits,
        attach_rate_percent: attachRatePercent,
        top_products: topProducts,
        margin,
        truncated,
      },
      explanation: 'Read from your guarded retail sales service with your own permissions and scope.',
      rowCount: sales.length,
      presentation: {
        answer,
        evidence: [this.evidence(retail, to)],
        confidence: truncated ? 'low' : 'medium',
        limitations,
        suggestedNextStep:
          'Ask "Which stylists are below target?" to see who needs support on retail.',
        responseType: 'Insight',
      },
    };
  }

  /**
   * Completed paid visits for the same window, or null when the dashboard is
   * not readable by this actor. Null is a genuine "not measured" — never 0,
   * which would turn a missing denominator into a 0% attach rate.
   */
  private async completedPaidVisits(
    actor: AuthUser,
    context: ZacActingContext,
    from: Date,
    to: Date,
  ): Promise<number | null> {
    try {
      const kpis = await this.dashboard.kpis(actor, {
        locationId: context.locationId ?? undefined,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      return kpis.summary.completedPaidBookings;
    } catch {
      return null;
    }
  }

  /** Products by revenue. Product names only — no client, staff or sale ids. */
  private rankProducts(
    sales: RetailSale[],
  ): { product_name: string; units: number; revenue_cents: number }[] {
    const byProduct = new Map<string, { product_name: string; units: number; revenue_cents: number }>();
    for (const sale of sales) {
      const name = sale.productName ?? 'Unnamed product';
      const row = byProduct.get(name) ?? { product_name: name, units: 0, revenue_cents: 0 };
      row.units += sale.quantity;
      row.revenue_cents += sale.totalAmountCents;
      byProduct.set(name, row);
    }
    return [...byProduct.values()].sort((a, b) => b.revenue_cents - a.revenue_cents);
  }

  /**
   * Gross margin over the sales that actually recorded a cost. Returns null
   * when none did — an uncovered margin is not a zero margin.
   */
  private margin(sales: RetailSale[]): {
    covered_sale_count: number;
    covered_revenue_cents: number;
    cost_cents: number;
    margin_cents: number;
    margin_percent: number;
    coverage_percent: number;
  } | null {
    const covered = sales.filter((sale) => typeof sale.unitCostCents === 'number');
    if (covered.length === 0) return null;

    const coveredRevenue = covered.reduce((sum, sale) => sum + sale.totalAmountCents, 0);
    const cost = covered.reduce((sum, sale) => sum + (sale.unitCostCents ?? 0) * sale.quantity, 0);
    const totalRevenue = sales.reduce((sum, sale) => sum + sale.totalAmountCents, 0);
    if (coveredRevenue <= 0) return null;

    return {
      covered_sale_count: covered.length,
      covered_revenue_cents: coveredRevenue,
      cost_cents: cost,
      margin_cents: coveredRevenue - cost,
      margin_percent: Math.round(((coveredRevenue - cost) / coveredRevenue) * 100),
      coverage_percent: totalRevenue > 0 ? Math.round((coveredRevenue / totalRevenue) * 100) : 0,
    };
  }

  private evidence(retail: RetailSalesListResponse, to: Date) {
    return {
      source_type: 'billing.retail_sales',
      source_ref: 'RetailSalesService.list',
      as_of: retail.rangeEnd ?? to.toISOString(),
      entities_used: [],
    };
  }
}

function formatMoney(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
