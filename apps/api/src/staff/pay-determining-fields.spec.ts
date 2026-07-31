import type { UpdateStaffMemberRequest } from '@sheer/domain';
import { PAY_DETERMINING_STAFF_FIELDS, changesPayDeterminingFields } from './staff.service';

/**
 * Pay-determining staff fields must require `staff.pay.manage`, not merely
 * `staff.manage`.
 *
 * Four of these were previously writable — and readable — with only
 * `staff.manage`. That mattered once the Financial Rules Engine landed, because
 * `average_bill_benchmark` is read by payroll accelerator conditions with
 * `basis = 'staff_benchmark'` (migration 0071): a manager without any pay
 * permission could set a stylist's benchmark and move them from the standard
 * commission band onto the accelerator rate. `contracted_hours`,
 * `holiday_entitlement_days` and `employment_type` are the equivalent levers on
 * payable hours and on which stage pipeline applies.
 *
 * `assertSensitiveStaffFields` is private on StaffService, so the predicate is
 * exported and tested directly — the same approach `staleMembershipIds` takes in
 * staff.service.spec.ts for the other catastrophic guard in this file.
 */

const NEWLY_PROTECTED = [
  'contractedHours',
  'averageBillBenchmark',
  'employmentType',
  'holidayEntitlementDays',
] as const;

const ALREADY_PROTECTED = [
  'hourlyRate',
  'commissionStructure',
  'commissionFlatRatePercent',
  'serviceRevenueTargetAmount',
  'serviceRevenueTargetMode',
  'colourAllowanceAmount',
] as const;

/** A representative value per field; only presence matters to the predicate. */
const SAMPLE: Record<(typeof PAY_DETERMINING_STAFF_FIELDS)[number], unknown> = {
  hourlyRate: 12.21,
  commissionStructure: 'tiered',
  commissionFlatRatePercent: 10,
  serviceRevenueTargetAmount: 1500,
  serviceRevenueTargetMode: 'flat',
  colourAllowanceAmount: 50,
  contractedHours: 40,
  averageBillBenchmark: 65,
  employmentType: 'employed',
  holidayEntitlementDays: 28,
};

const update = (patch: Partial<UpdateStaffMemberRequest>): UpdateStaffMemberRequest =>
  patch as UpdateStaffMemberRequest;

describe('changesPayDeterminingFields', () => {
  it.each(PAY_DETERMINING_STAFF_FIELDS)('flags %s as pay-determining', (field) => {
    expect(changesPayDeterminingFields(update({ [field]: SAMPLE[field] }))).toBe(true);
  });

  it.each(NEWLY_PROTECTED)(
    '%s is protected — it feeds the Financial Rules Engine',
    (field) => {
      expect(PAY_DETERMINING_STAFF_FIELDS).toContain(field);
      expect(changesPayDeterminingFields(update({ [field]: SAMPLE[field] }))).toBe(true);
    },
  );

  it.each(ALREADY_PROTECTED)('%s remains protected', (field) => {
    expect(PAY_DETERMINING_STAFF_FIELDS).toContain(field);
    expect(changesPayDeterminingFields(update({ [field]: SAMPLE[field] }))).toBe(true);
  });

  it('does not flag an update that touches only non-pay fields', () => {
    expect(
      changesPayDeterminingFields(
        update({ leaveNotes: 'Back Tuesday', colorHex: '#8b5cf6', bio: 'Senior stylist' }),
      ),
    ).toBe(false);
  });

  it('does not flag an empty update', () => {
    expect(changesPayDeterminingFields(update({}))).toBe(false);
  });

  it('treats an explicit undefined as absent, matching PATCH semantics', () => {
    expect(changesPayDeterminingFields(update({ averageBillBenchmark: undefined }))).toBe(false);
  });

  it('flags a mixed update that hides one pay field among safe ones', () => {
    // The realistic attack shape: a bulk profile save with the benchmark tucked in.
    expect(
      changesPayDeterminingFields(
        update({ leaveNotes: 'Back Tuesday', averageBillBenchmark: 0 }),
      ),
    ).toBe(true);
  });

  it('flags a zero benchmark, which is the value that silently unlocks the accelerator', () => {
    // A zero benchmark makes any `staff_benchmark` accelerator condition pass
    // trivially (actual >= 0), so it must never be a falsy-skipped value.
    expect(changesPayDeterminingFields(update({ averageBillBenchmark: 0 }))).toBe(true);
    expect(changesPayDeterminingFields(update({ contractedHours: 0 }))).toBe(true);
    expect(changesPayDeterminingFields(update({ hourlyRate: 0 }))).toBe(true);
    expect(changesPayDeterminingFields(update({ holidayEntitlementDays: 0 }))).toBe(true);
  });

  it('covers exactly the ten known pay-determining fields', () => {
    // Tripwire: a new pay input added to the staff record without being added
    // here would be silently writable with only `staff.manage`.
    expect([...PAY_DETERMINING_STAFF_FIELDS].sort()).toEqual(
      [...NEWLY_PROTECTED, ...ALREADY_PROTECTED].sort(),
    );
  });
});
