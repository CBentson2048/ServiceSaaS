import type { ConfigService } from '@nestjs/config';

/**
 * Model pricing is configuration, never hardcoded vendor list prices (D33).
 * Live prices arrive via env (`ZAC_PRICE_*`), set from the provider's official
 * pricing page at deploy time. Costs are USD; GBP business values stay
 * separate, with any conversion carrying an explicit FX assumption.
 */
export interface ZacModelPricing {
  usdPerMillionInputTokens: number;
  usdPerMillionOutputTokens: number;
  /** Unset = derived from the input price (reads ≈ 0.1×, writes ≈ 1.25×). */
  usdPerMillionCacheReadTokens?: number;
  usdPerMillionCacheWriteTokens?: number;
}

export const ZAC_STUB_PRICING: ZacModelPricing = {
  usdPerMillionInputTokens: 0,
  usdPerMillionOutputTokens: 0,
};

export function estimateModelCostUsd(
  pricing: ZacModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * pricing.usdPerMillionInputTokens +
      outputTokens * pricing.usdPerMillionOutputTokens) /
    1_000_000
  );
}

export interface ZacModelUsageTokens {
  /** Uncached input tokens — the provider reports cache reads/writes separately. */
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Cache-aware cost estimate. Cache read/write prices fall back to the standard
 * multiples of the input price (a formula, not a vendor price) so an estimate
 * exists even when only the two base prices are configured.
 */
export function estimateLiveModelCostUsd(
  pricing: ZacModelPricing,
  usage: ZacModelUsageTokens,
): number {
  const cacheReadPrice =
    pricing.usdPerMillionCacheReadTokens ?? pricing.usdPerMillionInputTokens * 0.1;
  const cacheWritePrice =
    pricing.usdPerMillionCacheWriteTokens ?? pricing.usdPerMillionInputTokens * 1.25;

  return (
    (usage.inputTokens * pricing.usdPerMillionInputTokens +
      usage.outputTokens * pricing.usdPerMillionOutputTokens +
      usage.cacheReadInputTokens * cacheReadPrice +
      usage.cacheCreationInputTokens * cacheWritePrice) /
    1_000_000
  );
}

/**
 * Read the live-provider pricing constants from env. Missing/invalid values
 * resolve to 0 — cost estimation must never block an answer; the provider logs
 * a startup warning instead so unpriced deployments are visible.
 */
export function resolveZacModelPricing(config: ConfigService): ZacModelPricing {
  return {
    usdPerMillionInputTokens: parsePrice(config, 'ZAC_PRICE_INPUT_USD_PER_MTOK') ?? 0,
    usdPerMillionOutputTokens: parsePrice(config, 'ZAC_PRICE_OUTPUT_USD_PER_MTOK') ?? 0,
    usdPerMillionCacheReadTokens: parsePrice(config, 'ZAC_PRICE_CACHE_READ_USD_PER_MTOK'),
    usdPerMillionCacheWriteTokens: parsePrice(config, 'ZAC_PRICE_CACHE_WRITE_USD_PER_MTOK'),
  };
}

/**
 * Prices for the semantic ROUTING model, which is a different (cheaper) model
 * from the narration one. Without this the classification cost events would be
 * priced at the narration model's rates — a silently wrong number on the cost
 * spine, overstating routing spend by whatever the tier gap is.
 *
 * Falls back per-field to the narration prices, so a deployment that has not
 * configured router prices behaves exactly as before rather than reporting
 * zero. Whether the fallback is in use is visible in the logs at startup.
 */
export function resolveZacRouterPricing(
  config: ConfigService,
  narrationPricing: ZacModelPricing,
): { pricing: ZacModelPricing; configured: boolean } {
  const input = parsePrice(config, 'ZAC_ROUTER_PRICE_INPUT_USD_PER_MTOK');
  const output = parsePrice(config, 'ZAC_ROUTER_PRICE_OUTPUT_USD_PER_MTOK');
  const cacheRead = parsePrice(config, 'ZAC_ROUTER_PRICE_CACHE_READ_USD_PER_MTOK');
  const cacheWrite = parsePrice(config, 'ZAC_ROUTER_PRICE_CACHE_WRITE_USD_PER_MTOK');

  return {
    configured: input !== undefined && output !== undefined,
    pricing: {
      usdPerMillionInputTokens: input ?? narrationPricing.usdPerMillionInputTokens,
      usdPerMillionOutputTokens: output ?? narrationPricing.usdPerMillionOutputTokens,
      usdPerMillionCacheReadTokens: cacheRead ?? narrationPricing.usdPerMillionCacheReadTokens,
      usdPerMillionCacheWriteTokens: cacheWrite ?? narrationPricing.usdPerMillionCacheWriteTokens,
    },
  };
}

/**
 * Prices for the DEDICATED semantic provider (a different vendor from the
 * narration model, so no fallback to the narration prices — an OpenAI call
 * priced at Anthropic rates is not an estimate, it is a fabrication).
 * Unpriced deployments estimate 0 and log a startup warning, exactly like an
 * unpriced narration model.
 */
export function resolveZacSemanticPricing(config: ConfigService): {
  pricing: ZacModelPricing;
  configured: boolean;
} {
  const input = parsePrice(config, 'ZAC_SEMANTIC_PRICE_INPUT_USD_PER_MTOK');
  const output = parsePrice(config, 'ZAC_SEMANTIC_PRICE_OUTPUT_USD_PER_MTOK');
  return {
    configured: input !== undefined && output !== undefined,
    pricing: {
      usdPerMillionInputTokens: input ?? 0,
      usdPerMillionOutputTokens: output ?? 0,
      usdPerMillionCacheReadTokens: parsePrice(config, 'ZAC_SEMANTIC_PRICE_CACHE_READ_USD_PER_MTOK'),
      // OpenAI does not bill cache writes separately; leaving the write price
      // unset would fall back to the 1.25x input formula and invent a charge,
      // so it is pinned to the input rate (cache-write tokens are reported as
      // 0 by the provider anyway).
      usdPerMillionCacheWriteTokens:
        parsePrice(config, 'ZAC_SEMANTIC_PRICE_CACHE_WRITE_USD_PER_MTOK') ?? input ?? 0,
    },
  };
}

function parsePrice(config: ConfigService, key: string): number | undefined {
  const raw = config.get<string>(key);
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
