import {
  capConfidence,
  capConfidenceAcross,
  coverageOf,
  formatDate,
  formatStockQuantity,
  isMeasured,
  limitationsFor,
  moneyTotal,
  money,
  notConfigured,
  rate,
  recency,
  share,
  staleReading,
  toNullableNumber,
  unreadable,
} from './zac-coverage';

/**
 * These cases are not invented. Each mirrors a figure that exists on the
 * working database today (see docs/ZAC/phase-2-ws3-data-evidence.md), because
 * the point of this module is that THOSE numbers do not become confident zeros.
 */

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

describe('ZacCoverageReading — a zero denominator never becomes a zero', () => {
  it('refuses colour waste rather than reporting 0% (20 of 20 items record zero waste)', () => {
    // The real shape: there IS a denominator (revenue), but the numerator is
    // structurally absent — waste is never captured at save time. The honest
    // reading is not "0% waste"; it is "waste is not being measured".
    const reading = notConfigured(
      'no saved formula has ever recorded waste, so there is nothing to measure it from',
    );

    expect(toNullableNumber(reading)).toBeNull();
    expect(isMeasured(reading)).toBe(false);
    expect(limitationsFor(reading, 'colour waste')[0]).toContain('not something I can measure yet');
  });

  it("refuses AndrewHair's colour margin: charge 0 and cost 0 is not 0% margin", () => {
    const reading = rate({ numerator: 0, denominator: 0, sampleUnit: 'saved formulas', asOf: null });

    expect(reading.kind).toBe('zero_denominator');
    expect(toNullableNumber(reading)).toBeNull();
    // The sentence must say WHY zero was withheld, or a reader assumes a bug.
    expect(limitationsFor(reading, 'colour margin')[0]).toContain('rather than reporting it as zero');
  });

  it("measures Kensington's colour margin, which is a real 16.7%", () => {
    // charge £126.62, cost £105.51 -> margin £21.11 of £126.62 = 16.7%.
    const reading = rate({
      numerator: 12662 - 10551,
      denominator: 12662,
      sampleUnit: 'saved formulas',
      asOf: '2026-07-21T11:14:25.693Z',
    });

    expect(isMeasured(reading)).toBe(true);
    expect(toNullableNumber(reading)).toBe(16.7);
    expect(limitationsFor(reading, 'colour margin')).toEqual([]);
  });

  it('withholds a figure below the sample floor rather than dressing noise as certainty', () => {
    const reading = rate({
      numerator: 1,
      denominator: 1,
      sampleUnit: 'saved formulas',
      asOf: null,
      sampleFloor: 3,
    });

    expect(reading.kind).toBe('below_sample_floor');
    expect(toNullableNumber(reading)).toBeNull();
    expect(limitationsFor(reading, 'colour margin')[0]).toContain('below the 3 I need');
  });

  it('reports partial coverage as a lower bound rather than a precise figure', () => {
    const reading = rate({
      numerator: 6,
      denominator: 10,
      sampleUnit: 'products',
      asOf: null,
      covered: 6,
    });

    expect(toNullableNumber(reading)).toBe(60);
    expect(limitationsFor(reading, 'dead stock value')[0]).toContain('lower bound');
  });
});

describe('moneyTotal — a cost-less product must not silently sum as zero', () => {
  it('suppresses a dead-stock value when only 4 of 10 products record a cost', () => {
    const reading = moneyTotal({
      totalCents: 5000,
      covered: 4,
      total: 10,
      sampleUnit: 'products',
      asOf: '2026-08-26T00:00:00.000Z',
    });

    expect(reading.kind).toBe('below_sample_floor');
    expect(toNullableNumber(reading)).toBeNull();
  });

  it('reports a value when 6 of 10 products record a cost, flagged as a lower bound', () => {
    // The live Salon catalogue: 6 of 6 active products carry a cost at
    // Kensington, but across the business 6 of 10 do.
    const reading = moneyTotal({
      totalCents: 12_000,
      covered: 6,
      total: 10,
      sampleUnit: 'products',
      asOf: '2026-08-26T00:00:00.000Z',
    });

    expect(isMeasured(reading)).toBe(true);
    expect(toNullableNumber(reading)).toBe(12_000);
    expect(limitationsFor(reading, 'dead stock value')[0]).toContain('6 of 10 products');
  });

  it('refuses a total when there are no products at all', () => {
    const reading = moneyTotal({ totalCents: 0, covered: 0, total: 0, sampleUnit: 'products', asOf: null });
    expect(reading.kind).toBe('zero_denominator');
  });
});

describe('coverageOf', () => {
  it('reports that 2 of 10 products have a supplier attached', () => {
    const reading = coverageOf({ covered: 2, total: 10, sampleUnit: 'products', asOf: null });
    expect(toNullableNumber(reading)).toBe(20);
  });
});

describe('share is rate, named for the call site', () => {
  it('reports 6 of 6 Kensington products idle past their threshold', () => {
    expect(toNullableNumber(share({ numerator: 6, denominator: 6, sampleUnit: 'stock records', asOf: null }))).toBe(100);
  });
});

describe('staleReading', () => {
  it('measures the gap to the newest costed formula (2026-07-21 -> 52 days)', () => {
    const reading = staleReading('2026-07-21T11:14:25.693Z', NOW, 'saved formulas');

    expect(reading).toMatchObject({ kind: 'stale', daysStale: 52 });
    expect(toNullableNumber(reading)).toBeNull();
    expect(limitationsFor(reading, 'colour margin')[0]).toContain('21 July 2026');
    expect(limitationsFor(reading, 'colour margin')[0]).toContain('52 days ago');
  });
});

describe('unreadable is distinct from empty', () => {
  it('says the read failed rather than implying there is nothing there', () => {
    const reading = unreadable('the stock service did not respond');
    expect(toNullableNumber(reading)).toBeNull();
    expect(limitationsFor(reading, 'stock levels')[0]).toContain('could not read');
  });
});

describe('capConfidence never raises, and unmeasured is never better than low', () => {
  const measuredFull = rate({ numerator: 1, denominator: 2, sampleUnit: 'x', asOf: null });
  const measuredPartial = rate({ numerator: 1, denominator: 10, sampleUnit: 'x', asOf: null, covered: 5 });

  it('keeps high when coverage is complete', () => {
    expect(capConfidence('high', measuredFull)).toBe('high');
  });

  it('lowers high to medium on partial coverage', () => {
    expect(capConfidence('high', measuredPartial)).toBe('medium');
  });

  it('never raises a caller that already doubts itself', () => {
    expect(capConfidence('low', measuredFull)).toBe('low');
    expect(capConfidence('medium', measuredFull)).toBe('medium');
  });

  it('drops anything unmeasured to low', () => {
    expect(capConfidence('high', notConfigured('nothing set up'))).toBe('low');
    expect(capConfidence('high', staleReading('2026-07-21T00:00:00.000Z', NOW, 'formulas'))).toBe('low');
  });

  it('takes the weakest across several readings', () => {
    expect(capConfidenceAcross('high', [measuredFull, measuredPartial])).toBe('medium');
    expect(capConfidenceAcross('high', [measuredFull, notConfigured('x')])).toBe('low');
    expect(capConfidenceAcross('high', [measuredFull, measuredFull])).toBe('high');
  });
});

describe('recency', () => {
  it('flags a ledger whose newest entry predates the window asked about', () => {
    // The live stock ledger stops 2026-08-26; a 7-day window starts 2026-09-04.
    const result = recency('2026-08-26T00:00:00.000Z', '2026-09-04T00:00:00.000Z', NOW);

    expect(result).toMatchObject({ daysSince: 16, predatesWindow: true });
  });

  it('does not flag a ledger inside the window', () => {
    const result = recency('2026-09-08T00:00:00.000Z', '2026-09-04T00:00:00.000Z', NOW);
    expect(result.predatesWindow).toBe(false);
  });

  it('treats no records at all as predating any window', () => {
    expect(recency(null, '2026-09-04T00:00:00.000Z', NOW)).toMatchObject({
      newestIso: null,
      daysSince: null,
      predatesWindow: true,
    });
  });

  it('does not crash on an unparseable timestamp', () => {
    expect(recency('not-a-date', '2026-09-04T00:00:00.000Z', NOW).predatesWindow).toBe(true);
  });
});

describe('formatStockQuantity respects the product stock unit', () => {
  it('renders grams and millilitres with their suffix', () => {
    expect(formatStockQuantity(319, 'gram')).toBe('319g');
    expect(formatStockQuantity(50.25, 'millilitre')).toBe('50.3ml');
  });

  it('counts whole items rather than appending g to a column named *_grams', () => {
    // The trap this closes: telling an owner they hold "6g" of a product they
    // count in bottles, because the column is named quantity_on_hand_grams.
    expect(formatStockQuantity(6, 'unit')).toBe('6 units');
    expect(formatStockQuantity(1, 'unit')).toBe('1 unit');
  });
});

describe('formatting helpers', () => {
  it('renders an unambiguous date', () => {
    expect(formatDate('2026-08-26T00:00:00.000Z')).toBe('26 August 2026');
  });

  it('passes through a value it cannot parse rather than inventing one', () => {
    expect(formatDate('whenever')).toBe('whenever');
  });

  it('renders money in the salon currency', () => {
    expect(money(12_662, 'GBP')).toBe('£126.62');
    expect(money(-500, 'GBP')).toBe('-£5.00');
    expect(money(1000, 'USD')).toBe('USD 10.00');
  });
});

describe('the module is clock-free', () => {
  it('takes nowMs as a parameter everywhere it needs the time', () => {
    // Every branch must be testable at a frozen instant; a hidden Date.now()
    // makes staleness untestable and the answers non-reproducible.
    const source = require('node:fs').readFileSync(require.resolve('./zac-coverage'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now\s*\(/);
  });
});
