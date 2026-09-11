import type { StockUnit, UnorderableProduct } from '@sheer/domain';

/**
 * The READ-ONLY answer to "what would Generate order right now?".
 *
 * This exists because ZAC Phase 2 is read-only and human-led — it may
 * recommend, but must not order. Before it, the only implementation of the
 * reorder algorithm was `OrdersService.generate()`, which asserts
 * `orders.manage`, allocates gapless purchase-order numbers, writes rows and
 * emails suppliers. There was no way to ask the question without performing the
 * act.
 *
 * DELIBERATELY NOT A `dryRun` FLAG ON `generate()`. A boolean separating "tell
 * me" from "do it", on a method named for doing it, is one default-argument
 * change or one careless refactor away from ZAC creating real purchase orders
 * and emailing a supplier. A separate, differently-named method cannot be
 * reached by accident, and the write loop is simply absent from its body.
 *
 * There is no HTTP route for this. It is a service-level read consumed by the
 * ZAC tool layer; the ordering screens keep using `generate`.
 */

export interface ReorderPreviewLine {
  productId: string;
  productName: string;
  supplierId: string;
  supplierName: string;
  /** Base quantities in one orderable pack. */
  packSize: number;
  stockUnit: StockUnit;
  /** Packs to order, after pack-size, minimum-order-quantity and order-multiple rounding. */
  suggestedQuantity: number;
  /** The raw base-quantity gap the packs cover, before rounding. */
  shortfallBase: number;
  /** Base quantity on the shelf now. */
  onHandBase: number;
  /** Effective low-stock threshold in base quantities (0 = none set). */
  thresholdBase: number;
  /**
   * Outbound base quantity recorded in the trailing window.
   *
   * ZERO IS THE COMMON CASE and it changes the sentence. On the working
   * database every single suggested line has 0 here: the shortfall is a top-up
   * to a configured threshold, NOT a forecast from observed usage. Saying
   * "based on your usage" over a zero would be an invented justification.
   */
  outboundBaseInWindow: number;
  /** Cost of one pack; null when the product records no unit cost. */
  unitCostCents: number | null;
  /** packs × unit cost; null when the product records no unit cost — never 0. */
  lineTotalCents: number | null;
  /** True when minimum-order-quantity raised the pack count above the bare shortfall. */
  roundedUpByMinimumOrderQuantity: boolean;
  /** True when the supplier's order multiple raised the pack count. */
  roundedUpByOrderMultiple: boolean;
}

export interface ReorderPreview {
  locationId: string;
  /** Trailing weeks of outbound movements the forecast averaged over. */
  windowWeeks: number;
  /** Weeks of forecast usage the suggestion covers. */
  coverageWeeks: number;
  /** Inclusive start of the usage window, ISO. */
  windowFromIso: string;
  /**
   * True when ANY product recorded outbound movement in the window.
   *
   * The honesty flag for the whole preview. False means every suggestion here
   * is a threshold top-up with no usage behind it.
   */
  usageObserved: boolean;
  lines: ReorderPreviewLine[];
  /** Products that need stock but cannot be ordered, with the reason. */
  unorderable: UnorderableProduct[];
  /** Products whose cost is unrecorded, so no line total could be computed. */
  linesWithoutCost: number;
}
