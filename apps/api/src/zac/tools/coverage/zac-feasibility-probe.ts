/**
 * Phase 2 Workstream 3 — FEASIBILITY PROBES.
 *
 * The Phase 1 QLab/stock feasibility report set the rule these implement:
 *
 *   > Colour analytics are only meaningful where the salon ACTUALLY mixes
 *   > formulas in Qlooqo Lab; low-stock is only meaningful where products +
 *   > stock + thresholds are CONFIGURED. Both are likely sparse in early
 *   > production -> a data-population probe must gate any tool so ZAC never
 *   > confidently reports zeros.
 *
 * That was written before the data existed. It is now measurably true: of 11
 * businesses on the working database, TWO have any saved colour formula and ONE
 * has meaningful stock. For nine tenants out of eleven, "nothing configured" is
 * the correct answer to every QLab and stock question — and it is a completely
 * different sentence from "nothing is wrong".
 *
 * A probe runs BEFORE the reporting read and answers two questions:
 *   1. Is this capability set up at all here?
 *   2. How recent is the newest record behind it?
 *
 * DEGRADE, NEVER FAIL. Every probe read sits in its own try/catch and falls back
 * to an `unknown` field plus a limitation rather than failing the answer — the
 * secondary-read pattern the Workstream 2 tools already use. A probe that can
 * break the tool it protects is worse than no probe.
 *
 * CLOCK-FREE: `nowMs` is always a parameter.
 */
import type { AuthUser } from '@sheer/domain';
import type { ZacInventoryRead, ZacLabAnalyticsRead } from '../ports/zac-service-ports';
import { type ZacRecency, recency } from './zac-coverage';

/** What a probe concluded. Drives which branch the tool answers on. */
export type ZacProbeVerdict =
  /** Set up and carrying data — report normally. */
  | 'ready'
  /** Nothing is configured here. A configuration answer, never a zero. */
  | 'not_configured'
  /** Configured, but the newest record predates the window asked about. */
  | 'stale'
  /** The probe read failed. Distinct from "there is nothing there". */
  | 'unreadable';

export interface ZacStockProbe {
  verdict: ZacProbeVerdict;
  /** Active shelf records the actor can see. */
  stockRecords: number;
  /** Of those, how many carry a usable low-stock threshold (> 0). */
  thresholdsConfigured: number;
  /** Active products in the catalogue. */
  products: number;
  /** Of those, how many record a unit cost — the denominator for any value figure. */
  productsWithCost: number;
  /** Of those, how many have a supplier attached — the ceiling on orderability. */
  productsWithSupplier: number;
  /** How recent the stock ledger is. */
  ledger: ZacRecency;
  /** Sentences the tool must carry into `limitations`. */
  limitations: string[];
}

/**
 * Is stock set up here, and how recent is the ledger?
 *
 * THE THRESHOLD SUBTLETY. A threshold of `0` means NEVER LOW, not always low.
 * `effectiveLowStockThresholdGrams` resolves the per-location override over the
 * product default, so counting `> 0` is the only correct test — and a salon with
 * stock but no thresholds must be told "I cannot tell you what is running low",
 * not shown an empty list that reads as "nothing is running low".
 */
export async function probeStockCoverage(
  inventory: ZacInventoryRead,
  actor: AuthUser,
  options: { locationId?: string; windowFromIso: string; nowMs: number },
): Promise<ZacStockProbe> {
  const limitations: string[] = [];

  let stockRecords = 0;
  let thresholdsConfigured = 0;
  let stockReadFailed = false;
  try {
    const result = await inventory.listStock(actor, {
      ...(options.locationId === undefined ? {} : { locationId: options.locationId }),
    });
    const active = result.stock.filter((row) => row.isActive);
    stockRecords = active.length;
    thresholdsConfigured = active.filter((row) => row.effectiveLowStockThresholdGrams > 0).length;
  } catch {
    stockReadFailed = true;
  }

  let products = 0;
  let productsWithCost = 0;
  let productsWithSupplier = 0;
  try {
    const result = await inventory.listProducts(actor, {});
    const active = result.products.filter((row) => row.isActive);
    products = active.length;
    productsWithCost = active.filter((row) => row.defaultCostPerGramCents !== undefined).length;
    productsWithSupplier = active.filter((row) => row.supplierId !== undefined).length;
  } catch {
    // Not fatal: the catalogue only sets coverage denominators, and a tool can
    // still report shelf state without knowing how many products carry a cost.
    limitations.push(
      'I could not read your product catalogue, so I cannot say how much of this is backed by recorded costs.',
    );
  }

  // Ledger recency. `limit: 1` against a query already ordered created_at desc
  // makes this a point read rather than a scan.
  let ledger: ZacRecency = { newestIso: null, daysSince: null, predatesWindow: true };
  try {
    const result = await inventory.listMovements(actor, {
      ...(options.locationId === undefined ? {} : { locationId: options.locationId }),
      limit: 1,
    });
    ledger = recency(result.movements[0]?.createdAt ?? null, options.windowFromIso, options.nowMs);
  } catch {
    limitations.push('I could not check how recent your stock movements are, so treat any idle-stock figure with care.');
  }

  if (stockReadFailed) {
    return {
      verdict: 'unreadable',
      stockRecords,
      thresholdsConfigured,
      products,
      productsWithCost,
      productsWithSupplier,
      ledger,
      limitations: [...limitations, 'I could not read your stock levels just now.'],
    };
  }

  if (stockRecords === 0) {
    return {
      verdict: 'not_configured',
      stockRecords,
      thresholdsConfigured,
      products,
      productsWithCost,
      productsWithSupplier,
      ledger,
      limitations,
    };
  }

  if (thresholdsConfigured === 0) {
    limitations.push(
      'None of your stock records has a low-stock threshold set, so I cannot tell you what is running low — ' +
        'a threshold of zero means "never flag this", not "always flag this".',
    );
  }

  return {
    verdict: ledger.predatesWindow ? 'stale' : 'ready',
    stockRecords,
    thresholdsConfigured,
    products,
    productsWithCost,
    productsWithSupplier,
    ledger,
    limitations,
  };
}

export interface ZacColourProbe {
  verdict: ZacProbeVerdict;
  /** Formulas saved inside the window the tool is reporting on. */
  formulasInWindow: number;
  /** Formulas saved over the long baseline — "has this salon EVER mixed colour?". */
  formulasInBaseline: number;
  /** Days the baseline covers, so the answer can name it. */
  baselineDays: number;
  /**
   * True when NO formula in the baseline recorded any waste.
   *
   * On the working database this is true everywhere: all 20 `lab.formula_items`
   * record `waste_grams = 0` and `waste_cost_cents = 0`, and
   * `inventory.waste_events` holds 0 rows and is never SELECTed. So colour waste
   * has no surviving numerator anywhere in the platform, and the tool must say
   * "waste is not being captured when formulas are saved" and SUPPRESS the
   * percentage — rendering "0% waste" would tell an owner they run a perfect
   * colour bar.
   */
  wasteNeverCaptured: boolean;
  limitations: string[];
}

/**
 * Has this salon ever mixed colour, and did any of it record waste?
 *
 * Runs a SECOND `summary` call over a long baseline alongside the tool's own
 * window. That is deliberate: without it, "no colour work in the last 90 days"
 * is indistinguishable from "this salon does not use Qlooqo Lab", and those need
 * different answers. The baseline is what turns an empty window into a
 * STALENESS statement instead of an absence one.
 *
 * `summary` is always called with an explicit custom `from`/`to`. Its presets
 * resolve in the API host's local timezone while ZAC works in UTC, so passing a
 * preset would silently shift the window.
 */
export async function probeColourCoverage(
  lab: ZacLabAnalyticsRead,
  actor: AuthUser,
  options: {
    locationId?: string;
    windowFromIso: string;
    windowToIso: string;
    nowMs: number;
    /** How far back "have they ever?" reaches. */
    baselineDays: number;
  },
): Promise<ZacColourProbe> {
  const limitations: string[] = [];
  const baselineFromIso = new Date(options.nowMs - options.baselineDays * 86_400_000).toISOString();

  let formulasInWindow = 0;
  let formulasInBaseline = 0;
  let wasteNeverCaptured = true;

  try {
    const windowSummary = await lab.summary(
      actor,
      'custom',
      options.locationId,
      options.windowFromIso,
      options.windowToIso,
    );
    formulasInWindow = windowSummary.summary.formulasMixed;
  } catch {
    return {
      verdict: 'unreadable',
      formulasInWindow: 0,
      formulasInBaseline: 0,
      baselineDays: options.baselineDays,
      wasteNeverCaptured: true,
      limitations: ['I could not read your colour analytics just now.'],
    };
  }

  try {
    const baseline = await lab.summary(
      actor,
      'custom',
      options.locationId,
      baselineFromIso,
      new Date(options.nowMs).toISOString(),
    );
    formulasInBaseline = baseline.summary.formulasMixed;
    wasteNeverCaptured = baseline.summary.wasteCostCents <= 0;
  } catch {
    // Degrade rather than fail: without the baseline the tool loses the ability
    // to distinguish stale from never-configured, so it must say so.
    limitations.push(
      'I could not check your longer colour history, so I cannot tell whether a quiet period here is unusual.',
    );
    return {
      verdict: formulasInWindow > 0 ? 'ready' : 'stale',
      formulasInWindow,
      formulasInBaseline: 0,
      baselineDays: options.baselineDays,
      wasteNeverCaptured: true,
      limitations,
    };
  }

  if (formulasInBaseline === 0) {
    return {
      verdict: 'not_configured',
      formulasInWindow,
      formulasInBaseline,
      baselineDays: options.baselineDays,
      wasteNeverCaptured,
      limitations,
    };
  }

  return {
    verdict: formulasInWindow > 0 ? 'ready' : 'stale',
    formulasInWindow,
    formulasInBaseline,
    baselineDays: options.baselineDays,
    wasteNeverCaptured,
    limitations,
  };
}
