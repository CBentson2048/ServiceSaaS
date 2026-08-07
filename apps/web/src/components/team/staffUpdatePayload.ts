import type {
  InvitableRole,
  StaffEmploymentStatus,
  StaffEmploymentType,
  StaffServiceRevenueTargetMode,
  UpdateStaffMemberRequest,
} from '@sheer/domain';

/** Form state backing the Team edit modal. Text inputs stay strings until submit. */
export interface EditForm {
  roles: InvitableRole[];
  locationId: string;
  managerLocationIds: string[];
  membershipStatus: 'active' | 'suspended' | 'revoked';
  displayName: string;
  colorHex: string;
  bio: string;
  isBookable: boolean;
  hourlyRate: string;
  contractedHours: string;
  averageBillBenchmark: string;
  leaveNotes: string;
  employmentType: StaffEmploymentType;
  employmentStatus: StaffEmploymentStatus;
  serviceRevenueTargetAmount: string;
  serviceRevenueTargetMode: StaffServiceRevenueTargetMode;
  holidayEntitlementDays: string;
  colourAllowanceAmount: string;
  photoUrl: string;
  startDate: string;
  qCode: string;
  securityLevelId: string;
  selectedServiceIds: string[];
  // serviceId -> price text input. Absent/blank means inherit the service base price.
  servicePrices: Record<string, string>;
}

/**
 * Build the PATCH body for a Team staff edit.
 *
 * Extracted from EditStaffModal as a pure function so the permission gating can
 * be unit-tested. The gating is the point: pay-determining fields must be
 * OMITTED entirely — not sent as zero — when the actor lacks `staff.pay.manage`.
 *
 * Why omission and not zero: the API redacts these fields from its response for
 * such an actor, so the form initialises them to placeholders ('0', 'employed').
 * Submitting those placeholders would either be rejected by the API's
 * pay-field guard (a 403 on an otherwise ordinary save) or, before that guard
 * existed, would silently overwrite a stylist's real contracted hours and
 * average bill benchmark with zero. A zero benchmark is the dangerous case: it
 * makes payroll accelerator conditions with `basis = 'staff_benchmark'` pass
 * trivially, promoting the stylist to the accelerator commission rate.
 */
export interface StaffUpdatePayloadOptions {
  /** Actor holds `staff.pay.manage`. */
  canManagePay: boolean;
  /** Actor holds `security.manage`. */
  canManageSecurity: boolean;
  /**
   * True when the Service Revenue Target fields are hidden because the member's
   * assigned pay plan provably reads no target (no `percent_of_service_target`
   * band basis, no `target_met` accelerator condition). Hidden fields must be
   * OMITTED, not submitted: their form state can be stale relative to what the
   * owner last saw on screen. Defaults to false (fields shown → submitted).
   */
  serviceTargetHidden?: boolean;
}

export function buildStaffUpdatePayload(
  form: EditForm,
  { canManagePay, canManageSecurity, serviceTargetHidden = false }: StaffUpdatePayloadOptions,
): UpdateStaffMemberRequest {
  const isStylist = form.roles.includes('stylist');
  /** Stylist-only AND pay-gated. */
  const pay = isStylist && canManagePay;

  return {
    roles: form.roles,
    // Omit when blank so an owner-only save (no location picked yet) doesn't
    // trip the endpoint's UUID validation; validate() guarantees a location
    // whenever a role is selected.
    locationId: form.locationId || undefined,
    // Managers may oversee several salons; send the ticked set. Omit for
    // non-managers so the endpoint leaves manager rows untouched.
    managerLocationIds: form.roles.includes('manager') ? form.managerLocationIds : undefined,
    membershipStatus: form.membershipStatus,
    displayName: isStylist ? form.displayName.trim() || undefined : undefined,
    colorHex: isStylist ? form.colorHex.trim() || undefined : undefined,
    bio: isStylist ? form.bio.trim() || undefined : undefined,
    isBookable: isStylist ? form.isBookable : undefined,
    leaveNotes: isStylist ? form.leaveNotes.trim() || null : undefined,
    employmentStatus: isStylist ? form.employmentStatus : undefined,
    photoUrl: isStylist ? form.photoUrl.trim() || null : undefined,
    startDate: isStylist ? form.startDate || null : undefined,

    // --- Pay-determining. Every one of these must stay behind `pay`. ---------
    hourlyRate: pay ? Number(form.hourlyRate) : undefined,
    contractedHours: pay ? Number(form.contractedHours) : undefined,
    averageBillBenchmark: pay ? Number(form.averageBillBenchmark) : undefined,
    employmentType: pay ? form.employmentType : undefined,
    // Hidden for the self-employed (no holiday pay), so a stale value must not
    // be written back. Hybrid keeps it: the employed part accrues holiday.
    holidayEntitlementDays:
      pay && form.employmentType !== 'self_employed'
        ? Number(form.holidayEntitlementDays)
        : undefined,
    serviceRevenueTargetAmount:
      pay && !serviceTargetHidden
        ? form.serviceRevenueTargetAmount.trim()
          ? Number(form.serviceRevenueTargetAmount)
          : null
        : undefined,
    serviceRevenueTargetMode: pay && !serviceTargetHidden ? form.serviceRevenueTargetMode : undefined,
    colourAllowanceAmount: pay ? Number(form.colourAllowanceAmount) : undefined,
    // ------------------------------------------------------------------------

    securityLevelId: canManageSecurity ? (form.securityLevelId ? form.securityLevelId : null) : undefined,
    serviceAssignments: isStylist
      ? form.selectedServiceIds.map((serviceId) => {
          const raw = form.servicePrices[serviceId]?.trim();
          return { serviceId, priceAmount: raw ? Number(raw) : null };
        })
      : undefined,
  };
}
