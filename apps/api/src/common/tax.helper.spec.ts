import {
  calculateAppointmentBillingTax,
  calculateTaxBreakdown,
  calculateTaxForCategory,
  defaultLocationTaxSettings,
  describeTaxedAmount,
  displayAmountCents,
  taxAppliesToCategory,
  taxOnNet,
  taxWithinGross,
  type LocationTaxSettings,
} from '@sheer/domain';

function settings(overrides: Partial<LocationTaxSettings> = {}): LocationTaxSettings {
  return {
    locationId: 'loc-1',
    taxEnabled: true,
    taxLabel: 'VAT',
    taxRatePercent: 20,
    appliesTo: 'both',
    displayMode: 'ex_tax',
    ...overrides,
  };
}

const gbp = (cents: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(cents / 100);

describe('taxOnNet', () => {
  it('adds rate on top of a net amount', () => {
    expect(taxOnNet(10000, 20)).toBe(2000);
  });
  it('rounds to the nearest minor unit', () => {
    expect(taxOnNet(199, 20)).toBe(40); // 39.8 -> 40
  });
  it('returns 0 for non-positive rate', () => {
    expect(taxOnNet(10000, 0)).toBe(0);
    expect(taxOnNet(10000, -5)).toBe(0);
  });
});

describe('taxWithinGross', () => {
  it('extracts the tax portion contained in a gross amount', () => {
    // £120 gross at 20% contains £20 tax
    expect(taxWithinGross(12000, 20)).toBe(2000);
  });
  it('round-trips with taxOnNet', () => {
    const net = 8000;
    const gross = net + taxOnNet(net, 20);
    expect(gross - taxWithinGross(gross, 20)).toBe(net);
  });
});

describe('calculateTaxBreakdown', () => {
  it('treats the amount as net when basis is net', () => {
    expect(calculateTaxBreakdown(10000, 20, 'net')).toEqual({
      netCents: 10000,
      taxCents: 2000,
      grossCents: 12000,
      ratePercent: 20,
      taxable: true,
    });
  });
  it('treats the amount as gross when basis is gross', () => {
    expect(calculateTaxBreakdown(12000, 20, 'gross')).toEqual({
      netCents: 10000,
      taxCents: 2000,
      grossCents: 12000,
      ratePercent: 20,
      taxable: true,
    });
  });
  it('is a no-op when the rate is 0', () => {
    expect(calculateTaxBreakdown(10000, 0, 'net')).toEqual({
      netCents: 10000,
      taxCents: 0,
      grossCents: 10000,
      ratePercent: 0,
      taxable: false,
    });
  });
});

describe('taxAppliesToCategory', () => {
  it('"both" covers everything', () => {
    expect(taxAppliesToCategory('both', 'service')).toBe(true);
    expect(taxAppliesToCategory('both', 'retail')).toBe(true);
  });
  it('"services" covers only services', () => {
    expect(taxAppliesToCategory('services', 'service')).toBe(true);
    expect(taxAppliesToCategory('services', 'retail')).toBe(false);
  });
  it('"retail" covers only retail', () => {
    expect(taxAppliesToCategory('retail', 'retail')).toBe(true);
    expect(taxAppliesToCategory('retail', 'service')).toBe(false);
  });
});

describe('calculateTaxForCategory', () => {
  it('applies tax on a service when appliesTo includes services', () => {
    const result = calculateTaxForCategory(10000, 'service', settings({ appliesTo: 'both' }));
    expect(result.taxCents).toBe(2000);
    expect(result.grossCents).toBe(12000);
    expect(result.taxable).toBe(true);
  });
  it('does not tax retail when appliesTo is services only', () => {
    const result = calculateTaxForCategory(10000, 'retail', settings({ appliesTo: 'services' }));
    expect(result.taxCents).toBe(0);
    expect(result.netCents).toBe(10000);
    expect(result.grossCents).toBe(10000);
    expect(result.taxable).toBe(false);
  });
  it('does not tax anything when tax is disabled', () => {
    const result = calculateTaxForCategory(10000, 'service', settings({ taxEnabled: false }));
    expect(result.taxCents).toBe(0);
    expect(result.taxable).toBe(false);
  });
  it('treats stored prices as inclusive when displayMode is inc_tax', () => {
    const result = calculateTaxForCategory(12000, 'service', settings({ displayMode: 'inc_tax' }));
    expect(result.netCents).toBe(10000);
    expect(result.taxCents).toBe(2000);
    expect(result.grossCents).toBe(12000);
  });
});

describe('calculateAppointmentBillingTax', () => {
  it('taxes services and product usage when appliesTo is both', () => {
    const tax = calculateAppointmentBillingTax(
      { serviceTotalCents: 10000, productUsageTotalCents: 5000 },
      settings({ appliesTo: 'both' }),
    );
    expect(tax.netCents).toBe(15000);
    expect(tax.taxCents).toBe(3000);
    expect(tax.grossCents).toBe(18000);
  });
  it('only taxes services when appliesTo is services', () => {
    const tax = calculateAppointmentBillingTax(
      { serviceTotalCents: 10000, productUsageTotalCents: 5000 },
      settings({ appliesTo: 'services' }),
    );
    expect(tax.taxCents).toBe(2000); // only the £100 service
    expect(tax.grossCents).toBe(17000); // 12000 + 5000 (product untaxed)
  });
  it('only taxes retail/product usage when appliesTo is retail', () => {
    const tax = calculateAppointmentBillingTax(
      { serviceTotalCents: 10000, productUsageTotalCents: 5000 },
      settings({ appliesTo: 'retail' }),
    );
    expect(tax.taxCents).toBe(1000); // only the £50 product usage
    expect(tax.grossCents).toBe(16000);
  });
  it('produces a disabled rollup when tax is off', () => {
    const tax = calculateAppointmentBillingTax(
      { serviceTotalCents: 10000, productUsageTotalCents: 5000 },
      settings({ taxEnabled: false }),
    );
    expect(tax.enabled).toBe(false);
    expect(tax.taxCents).toBe(0);
    expect(tax.netCents).toBe(15000);
    expect(tax.grossCents).toBe(15000);
  });
});

describe('displayAmountCents', () => {
  it('shows net for ex_tax', () => {
    expect(displayAmountCents(10000, settings({ displayMode: 'ex_tax' }), 'service')).toBe(10000);
  });
  it('shows gross for inc_tax (prices already include tax => unchanged)', () => {
    expect(displayAmountCents(12000, settings({ displayMode: 'inc_tax' }), 'service')).toBe(12000);
  });
  it('shows gross for both', () => {
    expect(displayAmountCents(10000, settings({ displayMode: 'both' }), 'service')).toBe(12000);
  });
});

describe('describeTaxedAmount', () => {
  it('formats ex_tax with the configured label', () => {
    const out = describeTaxedAmount(10000, settings({ displayMode: 'ex_tax' }), 'service', gbp);
    expect(out.label).toBe('£100.00 ex. VAT');
    expect(out.gross).toBe('£120.00');
  });
  it('formats inc_tax', () => {
    const out = describeTaxedAmount(12000, settings({ displayMode: 'inc_tax' }), 'service', gbp);
    expect(out.label).toBe('£120.00 inc. VAT');
    expect(out.net).toBe('£100.00');
  });
  it('formats both', () => {
    const out = describeTaxedAmount(10000, settings({ displayMode: 'both' }), 'service', gbp);
    expect(out.label).toBe('£100.00 + £20.00 VAT = £120.00');
  });
  it('falls back to the plain amount when not taxable', () => {
    const out = describeTaxedAmount(10000, settings({ taxEnabled: false }), 'service', gbp);
    expect(out.label).toBe('£100.00');
    expect(out.taxable).toBe(false);
  });
});

describe('defaultLocationTaxSettings', () => {
  it('is tax-disabled and jurisdiction-neutral', () => {
    const d = defaultLocationTaxSettings('loc-9');
    expect(d).toEqual({
      locationId: 'loc-9',
      taxEnabled: false,
      taxLabel: null,
      taxRatePercent: 0,
      appliesTo: 'both',
      displayMode: 'ex_tax',
    });
  });
});
