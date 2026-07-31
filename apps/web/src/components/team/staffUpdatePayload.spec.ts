import { buildStaffUpdatePayload, type EditForm } from './staffUpdatePayload';

/**
 * The Team edit modal must never submit pay-determining fields for an actor
 * without `staff.pay.manage`.
 *
 * Regression context: the API now redacts those fields from its response for such
 * an actor, so the form initialises them to placeholders ('0', 'employed'). The
 * modal previously submitted them regardless, which meant every save by a
 * manager holding only `staff.manage` was rejected with 403 — they could not
 * change even a display name. Before the API guard existed, the same save
 * silently wrote contractedHours=0 and averageBillBenchmark=0. A zero benchmark
 * is the dangerous one: payroll accelerator conditions with
 * `basis = 'staff_benchmark'` then pass trivially, promoting the stylist to the
 * accelerator commission rate.
 */

/** Placeholder values, exactly as the form initialises them when the API redacts. */
const REDACTED_PLACEHOLDERS = {
  hourlyRate: '0',
  contractedHours: '0',
  averageBillBenchmark: '0',
  holidayEntitlementDays: '0',
  commissionFlatRatePercent: '0',
  colourAllowanceAmount: '0',
  serviceRevenueTargetAmount: '',
  employmentType: 'employed' as const,
};

function form(overrides: Partial<EditForm> = {}): EditForm {
  return {
    roles: ['stylist'],
    locationId: 'loc-1',
    managerLocationIds: [],
    membershipStatus: 'active',
    displayName: 'Jane',
    colorHex: '#8b5cf6',
    bio: 'Senior stylist',
    isBookable: true,
    leaveNotes: 'Back Tuesday',
    employmentStatus: 'active',
    commissionStructure: 'tiered',
    serviceRevenueTargetMode: 'flat',
    photoUrl: '',
    startDate: '2026-01-01',
    qCode: 'Q-1',
    securityLevelId: '',
    selectedServiceIds: [],
    servicePrices: {},
    ...REDACTED_PLACEHOLDERS,
    ...overrides,
  };
}

/** Every field the API treats as pay-determining. */
const PAY_FIELDS = [
  'hourlyRate',
  'contractedHours',
  'averageBillBenchmark',
  'employmentType',
  'holidayEntitlementDays',
  'commissionStructure',
  'commissionFlatRatePercent',
  'serviceRevenueTargetAmount',
  'serviceRevenueTargetMode',
  'colourAllowanceAmount',
] as const;

describe('buildStaffUpdatePayload — without staff.pay.manage', () => {
  const payload = buildStaffUpdatePayload(form(), {
    canManagePay: false,
    canManageSecurity: false,
  });

  it.each(PAY_FIELDS)('omits %s entirely', (field) => {
    expect(payload[field]).toBeUndefined();
  });

  it('never sends a zeroed pay figure that would overwrite real data', () => {
    // The regression: '0' placeholders reaching the API as real zeros.
    for (const field of PAY_FIELDS) {
      expect(payload[field]).not.toBe(0);
    }
  });

  it('never sends a zero average bill benchmark, which would unlock the accelerator', () => {
    expect(payload.averageBillBenchmark).toBeUndefined();
    expect('averageBillBenchmark' in payload && payload.averageBillBenchmark === 0).toBe(false);
  });

  it('still sends ordinary staff edits so a staff.manage save is not blocked', () => {
    expect(payload.displayName).toBe('Jane');
    expect(payload.colorHex).toBe('#8b5cf6');
    expect(payload.bio).toBe('Senior stylist');
    expect(payload.leaveNotes).toBe('Back Tuesday');
    expect(payload.isBookable).toBe(true);
    expect(payload.employmentStatus).toBe('active');
    expect(payload.membershipStatus).toBe('active');
    expect(payload.roles).toEqual(['stylist']);
    expect(payload.startDate).toBe('2026-01-01');
  });

  it('produces a payload the API pay-guard would accept (no pay key defined)', () => {
    // Mirrors changesPayDeterminingFields() on the API side: the guard fires when
    // ANY pay key is !== undefined. None may be.
    const anyPayKeyDefined = PAY_FIELDS.some((f) => payload[f] !== undefined);
    expect(anyPayKeyDefined).toBe(false);
  });

  it('omits securityLevelId without security.manage', () => {
    expect(payload.securityLevelId).toBeUndefined();
  });
});

describe('buildStaffUpdatePayload — with staff.pay.manage', () => {
  const payload = buildStaffUpdatePayload(
    form({
      hourlyRate: '12.21',
      contractedHours: '40',
      averageBillBenchmark: '65',
      holidayEntitlementDays: '28',
      commissionFlatRatePercent: '10',
      colourAllowanceAmount: '50',
      serviceRevenueTargetAmount: '1500',
      employmentType: 'self_employed',
    }),
    { canManagePay: true, canManageSecurity: true },
  );

  it('sends every pay-determining field', () => {
    expect(payload.hourlyRate).toBe(12.21);
    expect(payload.contractedHours).toBe(40);
    expect(payload.averageBillBenchmark).toBe(65);
    expect(payload.holidayEntitlementDays).toBe(28);
    expect(payload.commissionFlatRatePercent).toBe(10);
    expect(payload.colourAllowanceAmount).toBe(50);
    expect(payload.serviceRevenueTargetAmount).toBe(1500);
    expect(payload.employmentType).toBe('self_employed');
    expect(payload.commissionStructure).toBe('tiered');
    expect(payload.serviceRevenueTargetMode).toBe('flat');
  });

  it('sends a genuine zero when a pay manager really sets zero', () => {
    const zeroed = buildStaffUpdatePayload(form({ averageBillBenchmark: '0' }), {
      canManagePay: true,
      canManageSecurity: false,
    });
    expect(zeroed.averageBillBenchmark).toBe(0);
  });

  it('maps a blank Service Revenue Target to null, not 0', () => {
    expect(
      buildStaffUpdatePayload(form({ serviceRevenueTargetAmount: '  ' }), {
        canManagePay: true,
        canManageSecurity: false,
      }).serviceRevenueTargetAmount,
    ).toBeNull();
  });

  it('sends securityLevelId with security.manage', () => {
    expect(payload.securityLevelId).toBeNull(); // blank in the fixture => explicit clear
  });
});

describe('buildStaffUpdatePayload — non-stylist saves', () => {
  it('omits pay fields for a manager-only member even with pay permission', () => {
    const payload = buildStaffUpdatePayload(form({ roles: ['manager'], managerLocationIds: ['loc-1'] }), {
      canManagePay: true,
      canManageSecurity: false,
    });
    for (const field of PAY_FIELDS) {
      expect(payload[field]).toBeUndefined();
    }
    expect(payload.managerLocationIds).toEqual(['loc-1']);
  });
});
