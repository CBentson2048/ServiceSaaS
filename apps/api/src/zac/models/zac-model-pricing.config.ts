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
  const parse = (key: string): number | undefined => {
    const raw = config.get<string>(key);
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };

  return {
    usdPerMillionInputTokens: parse('ZAC_PRICE_INPUT_USD_PER_MTOK') ?? 0,
    usdPerMillionOutputTokens: parse('ZAC_PRICE_OUTPUT_USD_PER_MTOK') ?? 0,
    usdPerMillionCacheReadTokens: parse('ZAC_PRICE_CACHE_READ_USD_PER_MTOK'),
    usdPerMillionCacheWriteTokens: parse('ZAC_PRICE_CACHE_WRITE_USD_PER_MTOK'),
  };
}
