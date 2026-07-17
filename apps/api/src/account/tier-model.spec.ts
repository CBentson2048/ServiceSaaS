import {
  BUSINESS_TIER_LABELS,
  BUSINESS_TIER_LIMITS,
  BUSINESS_TIER_ORDER,
  BUSINESS_TIER_TAGLINES,
  getBusinessTierLimits,
  getMessagingMonthlyCap,
  suggestTierUpgrade,
  type BusinessTier,
} from '@sheer/domain';

/**
 * The account tier model — Luke's final 3 public tiers (Wrike 4507280724,
 * 2026-07-17), sliced by bookable columns. Spark is the only hard-capped tier;
 * Pulse/Infinity allow extra (billable) columns.
 */
describe('business tier model', () => {
  it('defines exactly the three tiers, lowest → highest', () => {
    expect(BUSINESS_TIER_ORDER).toEqual(['spark', 'pulse', 'infinity']);
    expect(Object.keys(BUSINESS_TIER_LIMITS).sort()).toEqual(
      ['infinity', 'pulse', 'spark'].sort(),
    );
  });

  it('carries the public names and audience taglines', () => {
    expect(BUSINESS_TIER_LABELS).toEqual({
      spark: 'Spark',
      pulse: 'Pulse',
      infinity: 'Infinity',
    });
    expect(BUSINESS_TIER_TAGLINES.spark).toMatch(/independent/i);
    expect(BUSINESS_TIER_TAGLINES.pulse).toMatch(/single-location/i);
    expect(BUSINESS_TIER_TAGLINES.infinity).toMatch(/multi-location/i);
  });

  it('slices entitlements by bookable columns, single-vs-multi location', () => {
    expect(BUSINESS_TIER_LIMITS.spark).toMatchObject({
      maxLocations: 1,
      includedBookableColumnsPerLocation: 1,
      bookableColumnsHardCapped: true,
    });
    expect(BUSINESS_TIER_LIMITS.pulse).toMatchObject({
      maxLocations: 1,
      includedBookableColumnsPerLocation: 5,
      bookableColumnsHardCapped: false,
    });
    expect(BUSINESS_TIER_LIMITS.infinity).toMatchObject({
      maxLocations: null,
      includedBookableColumnsPerLocation: 10,
      bookableColumnsHardCapped: false,
    });
  });

  it('only Spark hard-caps bookable columns (extras are billable elsewhere)', () => {
    const hardCapped = BUSINESS_TIER_ORDER.filter(
      (t) => BUSINESS_TIER_LIMITS[t].bookableColumnsHardCapped,
    );
    expect(hardCapped).toEqual(['spark']);
  });

  it('only Infinity is multi-location', () => {
    const multiLocation = BUSINESS_TIER_ORDER.filter(
      (t) => BUSINESS_TIER_LIMITS[t].maxLocations === null,
    );
    expect(multiLocation).toEqual(['infinity']);
  });

  it('defaults unknown tiers to the safest (spark) limits', () => {
    expect(getBusinessTierLimits(null).tier).toBe('spark');
    expect(getBusinessTierLimits(undefined).tier).toBe('spark');
    expect(getBusinessTierLimits('bogus' as BusinessTier).tier).toBe('spark');
  });

  it('exposes per-tier monthly messaging caps', () => {
    expect(getMessagingMonthlyCap('spark')).toBe(100);
    expect(getMessagingMonthlyCap('pulse')).toBe(600);
    expect(getMessagingMonthlyCap('infinity')).toBe(1000);
  });

  describe('suggestTierUpgrade', () => {
    it('recommends Spark → Pulse when another bookable column is needed', () => {
      expect(suggestTierUpgrade('spark', 'columns')).toBe('pulse');
    });

    it('never recommends a columns upgrade on the soft-capped tiers', () => {
      expect(suggestTierUpgrade('pulse', 'columns')).toBeNull();
      expect(suggestTierUpgrade('infinity', 'columns')).toBeNull();
    });

    it('recommends Infinity for a second location (Spark and Pulse are single-location)', () => {
      expect(suggestTierUpgrade('spark', 'locations')).toBe('infinity');
      expect(suggestTierUpgrade('pulse', 'locations')).toBe('infinity');
      expect(suggestTierUpgrade('infinity', 'locations')).toBeNull();
    });
  });
});
