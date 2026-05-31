// ---------------------------------------------------------------------------
// Tax configuration — contracts + the single trusted tax logic layer.
//
// This module lives in @sheer/domain because it is consumed by every surface
// (the NestJS API, the web dashboard, and the Sheer Lab native app). All tax
// math and display logic must go through here — do NOT re-implement tax
// arithmetic in components or services.
//
// Conventions:
//  - All monetary amounts are integer minor units (pence/cents), matching the
//    rest of the platform.
//  - The model is jurisdiction-neutral: a label, a rate, what it applies to and
//    how it is displayed. Nothing here is hardcoded to UK VAT.
// ---------------------------------------------------------------------------

/** Which sales a tax applies to. */
export type TaxAppliesTo = 'services' | 'retail' | 'both';

/** How taxed amounts are presented to users. */
export type TaxDisplayMode = 'inc_tax' | 'ex_tax' | 'both';

/** Categories a billable amount can fall into for `appliesTo` gating. */
export type TaxableCategory = 'service' | 'retail';

/**
 * A location's tax configuration. The platform manages a single "primary"
 * configuration per location; the persistence layer maps this onto the
 * jurisdiction-neutral billing.tax_settings table.
 */
export interface LocationTaxSettings {
  locationId: string;
  /** Tax on/off toggle. When false, no tax is ever applied or displayed. */
  taxEnabled: boolean;
  /** Configurable label (e.g. "VAT", "GST", "Sales Tax"). Required when enabled. */
  taxLabel: string | null;
  /** Rate as a percentage, e.g. 20 = 20%. Always >= 0. */
  taxRatePercent: number;
  appliesTo: TaxAppliesTo;
  displayMode: TaxDisplayMode;
}

export interface GetLocationTaxSettingsResponse {
  settings: LocationTaxSettings;
}

export interface UpdateLocationTaxSettingsRequest {
  locationId: string;
  taxEnabled?: boolean;
  taxLabel?: string | null;
  taxRatePercent?: number;
  appliesTo?: TaxAppliesTo;
  displayMode?: TaxDisplayMode;
}

export interface UpdateLocationTaxSettingsResponse {
  settings: LocationTaxSettings;
}

/** A computed tax breakdown for a single amount. */
export interface TaxBreakdown {
  /** Tax-exclusive (net) amount. */
  netCents: number;
  /** The tax portion. */
  taxCents: number;
  /** Tax-inclusive (gross) amount. */
  grossCents: number;
  /** Rate actually applied (0 when not taxable). */
  ratePercent: number;
  /** Whether tax was applied at all. */
  taxable: boolean;
}

/** Tax rollup for an appointment / visit bill. */
export interface AppointmentBillingTax {
  enabled: boolean;
  label: string | null;
  ratePercent: number;
  appliesTo: TaxAppliesTo;
  displayMode: TaxDisplayMode;
  /** Combined tax-exclusive subtotal across all components. */
  netCents: number;
  /** Total tax across taxable components. */
  taxCents: number;
  /** Tax-inclusive total. */
  grossCents: number;
}

/** A safe, tax-disabled default used when a location has no configuration yet. */
export function defaultLocationTaxSettings(locationId: string): LocationTaxSettings {
  return {
    locationId,
    taxEnabled: false,
    taxLabel: null,
    taxRatePercent: 0,
    appliesTo: 'both',
    displayMode: 'ex_tax',
  };
}

function safeCents(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function safeRate(ratePercent: number): number {
  return Number.isFinite(ratePercent) && ratePercent > 0 ? ratePercent : 0;
}

/** Does the configured `appliesTo` cover the given category? */
export function taxAppliesToCategory(appliesTo: TaxAppliesTo, category: TaxableCategory): boolean {
  switch (appliesTo) {
    case 'both':
      return true;
    case 'services':
      return category === 'service';
    case 'retail':
      return category === 'retail';
    default:
      return false;
  }
}

/** Tax added on top of a net (tax-exclusive) amount. */
export function taxOnNet(netCents: number, ratePercent: number): number {
  const rate = safeRate(ratePercent);
  if (rate === 0) return 0;
  return Math.round((safeCents(netCents) * rate) / 100);
}

/** The tax portion contained within a gross (tax-inclusive) amount. */
export function taxWithinGross(grossCents: number, ratePercent: number): number {
  const rate = safeRate(ratePercent);
  if (rate === 0) return 0;
  // gross = net * (1 + r/100)  =>  tax = gross * r / (100 + r)
  return Math.round((safeCents(grossCents) * rate) / (100 + rate));
}

/**
 * Compute a net/tax/gross breakdown for a single amount.
 * `basis` declares whether the input already includes tax ('gross') or not ('net').
 */
export function calculateTaxBreakdown(
  amountCents: number,
  ratePercent: number,
  basis: 'net' | 'gross',
): TaxBreakdown {
  const amount = safeCents(amountCents);
  const rate = safeRate(ratePercent);
  if (rate === 0) {
    return { netCents: amount, taxCents: 0, grossCents: amount, ratePercent: 0, taxable: false };
  }
  if (basis === 'gross') {
    const taxCents = taxWithinGross(amount, rate);
    return { netCents: amount - taxCents, taxCents, grossCents: amount, ratePercent: rate, taxable: true };
  }
  const taxCents = taxOnNet(amount, rate);
  return { netCents: amount, taxCents, grossCents: amount + taxCents, ratePercent: rate, taxable: true };
}

/**
 * Breakdown for a category amount honouring the full settings:
 *  - returns a no-tax breakdown when tax is disabled or doesn't apply to the category;
 *  - treats stored prices as tax-inclusive when displayMode = 'inc_tax', otherwise
 *    tax-exclusive (consistent with the legacy is_price_inclusive flag).
 */
export function calculateTaxForCategory(
  amountCents: number,
  category: TaxableCategory,
  settings: LocationTaxSettings,
): TaxBreakdown {
  if (!settings.taxEnabled || !taxAppliesToCategory(settings.appliesTo, category)) {
    const amount = safeCents(amountCents);
    return { netCents: amount, taxCents: 0, grossCents: amount, ratePercent: 0, taxable: false };
  }
  const basis = settings.displayMode === 'inc_tax' ? 'gross' : 'net';
  return calculateTaxBreakdown(amountCents, settings.taxRatePercent, basis);
}

/**
 * Roll up tax for an appointment bill. Service totals are taxed as 'service' and
 * product-usage totals as 'retail', each gated by the configured `appliesTo`.
 */
export function calculateAppointmentBillingTax(
  parts: { serviceTotalCents: number; productUsageTotalCents: number },
  settings: LocationTaxSettings,
): AppointmentBillingTax {
  const service = calculateTaxForCategory(parts.serviceTotalCents, 'service', settings);
  const product = calculateTaxForCategory(parts.productUsageTotalCents, 'retail', settings);
  return {
    enabled: settings.taxEnabled,
    label: settings.taxLabel,
    ratePercent: settings.taxRatePercent,
    appliesTo: settings.appliesTo,
    displayMode: settings.displayMode,
    netCents: service.netCents + product.netCents,
    taxCents: service.taxCents + product.taxCents,
    grossCents: service.grossCents + product.grossCents,
  };
}

/**
 * The single headline figure (in cents) to display for a base amount under the
 * configured display mode: net for 'ex_tax', gross for 'inc_tax'/'both'.
 */
export function displayAmountCents(
  baseCents: number,
  settings: LocationTaxSettings,
  category: TaxableCategory,
): number {
  const breakdown = calculateTaxForCategory(baseCents, category, settings);
  return settings.displayMode === 'ex_tax' ? breakdown.netCents : breakdown.grossCents;
}

/**
 * Human-readable rendering of a base amount honouring the display mode. Callers
 * pass their own currency formatter so each surface keeps its locale/currency.
 */
export function describeTaxedAmount(
  baseCents: number,
  settings: LocationTaxSettings,
  category: TaxableCategory,
  formatMoney: (cents: number) => string,
): { label: string; net: string; tax: string; gross: string; taxable: boolean } {
  const breakdown = calculateTaxForCategory(baseCents, category, settings);
  const net = formatMoney(breakdown.netCents);
  const tax = formatMoney(breakdown.taxCents);
  const gross = formatMoney(breakdown.grossCents);
  const taxWord = settings.taxLabel?.trim() || 'tax';

  if (!breakdown.taxable) {
    return { label: gross, net, tax, gross, taxable: false };
  }
  switch (settings.displayMode) {
    case 'inc_tax':
      return { label: `${gross} inc. ${taxWord}`, net, tax, gross, taxable: true };
    case 'ex_tax':
      return { label: `${net} ex. ${taxWord}`, net, tax, gross, taxable: true };
    case 'both':
    default:
      return { label: `${net} + ${tax} ${taxWord} = ${gross}`, net, tax, gross, taxable: true };
  }
}
