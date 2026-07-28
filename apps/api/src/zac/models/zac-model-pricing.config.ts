/**
 * Model pricing is configuration, never hardcoded vendor list prices (D33).
 * Real provider pricing arrives with the first live provider; the Week 1 stub is
 * free. Costs are USD; GBP business values stay separate, with any conversion
 * carrying an explicit FX assumption.
 */
export interface ZacModelPricing {
  usdPerMillionInputTokens: number;
  usdPerMillionOutputTokens: number;
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
