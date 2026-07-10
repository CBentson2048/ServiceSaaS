import type { FormEvent} from 'react';
import { useEffect, useMemo, useState } from 'react';
import type {
  BusinessLocationSummary,
  InvitableRole,
  ManagedService,
  StaffCommissionStructure,
  StaffEmploymentStatus,
  StaffEmploymentType,
  StaffMember,
  UpdateStaffMemberRequest,
} from '@sheer/domain';
import {
  STAFF_COMMISSION_STRUCTURE_LABELS,
  STAFF_EMPLOYMENT_STATUS_LABELS,
  STAFF_EMPLOYMENT_TYPE_LABELS,
} from '@sheer/domain';
import { ApiRequestError, listSecurityLevels, listServices, updateStaffMember } from '../../auth/api';
import type { SecurityLevel } from '@sheer/domain';
import { SelectField, TextField } from '../onboarding/FormField';
import { Modal } from './Modal';

interface EditStaffModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (staff: StaffMember) => void;
  accessToken: string;
  staff: StaffMember | null;
  locations: BusinessLocationSummary[];
}

interface EditForm {
  roles: InvitableRole[];
  locationId: string;
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
  commissionStructure: StaffCommissionStructure;
  commissionFlatRatePercent: string;
  performanceTargetAmount: string;
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

// Formats a service's base price for use as the per-stylist input placeholder
// (the value that applies when the owner leaves the field blank). basePrice is
// in major currency units, so this does NOT use the cents-based formatMoney.
function formatBasePrice(service: ManagedService): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: service.currencyCode || 'GBP',
    }).format(service.basePrice);
  } catch {
    return String(service.basePrice);
  }
}

export function EditStaffModal({
  open,
  onClose,
  onSaved,
  accessToken,
  staff,
  locations,
}: EditStaffModalProps) {
  const [form, setForm] = useState<EditForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [services, setServices] = useState<ManagedService[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [securityLevels, setSecurityLevels] = useState<SecurityLevel[]>([]);

  // Load the business's security levels so the owner can assign one to the member.
  useEffect(() => {
    if (!open || !accessToken) return;
    let cancelled = false;
    listSecurityLevels(accessToken)
      .then((result) => {
        if (!cancelled) setSecurityLevels(result.levels);
      })
      .catch(() => {
        if (!cancelled) setSecurityLevels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accessToken]);

  // Load the active service catalogue so a stylist's eligibility can be edited.
  useEffect(() => {
    if (!open || !accessToken) return;
    let cancelled = false;
    setServicesLoading(true);
    listServices(accessToken, {})
      .then((result) => {
        if (!cancelled) setServices(result.services);
      })
      .catch(() => {
        if (!cancelled) setServices([]);
      })
      .finally(() => {
        if (!cancelled) setServicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accessToken]);

  useEffect(() => {
    if (!open || !staff) {
      setForm(null);
      return;
    }
    const roles = staff.roles.filter(
      (r): r is InvitableRole => r === 'manager' || r === 'stylist',
    );
    // An owner editing themselves keeps owner access implicitly. Their staff
    // roles start from whatever they already hold (possibly none = owner-only),
    // and they pick which location the stylist role attaches to — auto-selected
    // for a single-location business, blank (forces a choice) when there's more.
    const editingOwner = staff.roles.includes('owner');
    setForm({
      roles: roles.length > 0 ? roles : editingOwner ? [] : ['stylist'],
      locationId:
        staff.location?.id ??
        (editingOwner && locations.length > 1 ? '' : locations[0]?.id ?? ''),
      membershipStatus:
        staff.membershipStatus === 'suspended' || staff.membershipStatus === 'revoked'
          ? staff.membershipStatus
          : 'active',
      displayName: staff.staffProfile?.displayName ?? '',
      colorHex: staff.staffProfile?.colorHex ?? '',
      bio: staff.staffProfile?.bio ?? '',
      isBookable: staff.staffProfile?.isBookable ?? true,
      hourlyRate: staff.staffProfile?.hourlyRate !== undefined ? String(staff.staffProfile.hourlyRate) : '0',
      contractedHours:
        staff.staffProfile?.contractedHours !== undefined ? String(staff.staffProfile.contractedHours) : '0',
      averageBillBenchmark:
        staff.staffProfile?.averageBillBenchmark !== undefined
          ? String(staff.staffProfile.averageBillBenchmark)
          : '0',
      leaveNotes: staff.staffProfile?.leaveNotes ?? '',
      employmentType: staff.staffProfile?.employmentType ?? 'employed',
      employmentStatus: staff.staffProfile?.employmentStatus ?? 'active',
      commissionStructure: staff.staffProfile?.commissionStructure ?? 'tiered',
      commissionFlatRatePercent:
        staff.staffProfile?.commissionFlatRatePercent !== undefined
          ? String(staff.staffProfile.commissionFlatRatePercent)
          : '0',
      performanceTargetAmount:
        staff.staffProfile?.performanceTargetAmount != null
          ? String(staff.staffProfile.performanceTargetAmount)
          : '',
      holidayEntitlementDays:
        staff.staffProfile?.holidayEntitlementDays !== undefined
          ? String(staff.staffProfile.holidayEntitlementDays)
          : '28',
      colourAllowanceAmount:
        staff.staffProfile?.colourAllowanceAmount !== undefined
          ? String(staff.staffProfile.colourAllowanceAmount)
          : '0',
      photoUrl: staff.staffProfile?.photoUrl ?? '',
      startDate: staff.staffProfile?.startDate ?? '',
      qCode: staff.staffProfile?.qCode ?? '',
      securityLevelId: staff.securityLevelId ?? '',
      selectedServiceIds: staff.staffProfile?.serviceIds ?? [],
      servicePrices: Object.fromEntries(
        (staff.staffProfile?.servicePricing ?? [])
          .filter((p) => p.priceAmount !== null)
          .map((p) => [p.serviceId, String(p.priceAmount)]),
      ),
    });
    setErrors({});
    setSubmitError(null);
  }, [open, staff, locations]);

  const locationOptions = useMemo(
    () =>
      locations.map((loc) => ({
        value: loc.id,
        label: loc.code ? `${loc.name} · ${loc.code}` : loc.name,
      })),
    [locations],
  );

  // Services grouped by category for the eligibility picker.
  const serviceGroups = useMemo(() => {
    const groups = new Map<string, ManagedService[]>();
    for (const service of services) {
      const key = service.category?.trim() || 'Uncategorised';
      const list = groups.get(key) ?? [];
      list.push(service);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [services]);

  if (!staff || !form) {
    return (
      <Modal open={open} onClose={onClose} title="Edit team member">
        <div className="text-[13px] text-text-secondary">Loading…</div>
      </Modal>
    );
  }

  // Owners editing themselves keep owner access; they can only add/drop the
  // stylist role at a location (Manager is redundant for an owner, so it's
  // hidden). An owner may also drop to owner-only (no staff roles).
  const isOwner = staff.roles.includes('owner');
  const roleOptions: InvitableRole[] = isOwner ? ['stylist'] : ['manager', 'stylist'];

  function validate(values: EditForm): Record<string, string> {
    const next: Record<string, string> = {};
    if (!isOwner && values.roles.length === 0) next.roles = 'Select at least one role';
    if (values.roles.length > 0 && !values.locationId) next.locationId = 'Pick a location';
    // The fields below are stylist-only: they're rendered AND submitted solely
    // when the stylist role is selected. Only validate them then, or a stale
    // (now-hidden) value would silently block an owner/manager-only save with no
    // visible error to correct.
    if (values.roles.includes('stylist')) {
      if (values.colorHex && !/^#[0-9A-Fa-f]{6}$/.test(values.colorHex.trim()))
        next.colorHex = 'Use a #RRGGBB hex colour';
      if (Number.isNaN(Number(values.hourlyRate)) || Number(values.hourlyRate) < 0)
        next.hourlyRate = 'Use a non-negative number';
      if (Number.isNaN(Number(values.contractedHours)) || Number(values.contractedHours) < 0 || Number(values.contractedHours) > 168)
        next.contractedHours = 'Use 0-168 hours';
      if (Number.isNaN(Number(values.averageBillBenchmark)) || Number(values.averageBillBenchmark) < 0)
        next.averageBillBenchmark = 'Use a non-negative number';
      if (
        Number.isNaN(Number(values.commissionFlatRatePercent)) ||
        Number(values.commissionFlatRatePercent) < 0 ||
        Number(values.commissionFlatRatePercent) > 100
      )
        next.commissionFlatRatePercent = 'Use 0-100';
      if (
        Number.isNaN(Number(values.holidayEntitlementDays)) ||
        Number(values.holidayEntitlementDays) < 0 ||
        Number(values.holidayEntitlementDays) > 366
      )
        next.holidayEntitlementDays = 'Use 0-366 days';
      if (Number.isNaN(Number(values.colourAllowanceAmount)) || Number(values.colourAllowanceAmount) < 0)
        next.colourAllowanceAmount = 'Use a non-negative number';
      if (
        values.performanceTargetAmount.trim() &&
        (Number.isNaN(Number(values.performanceTargetAmount)) || Number(values.performanceTargetAmount) < 0)
      )
        next.performanceTargetAmount = 'Use a non-negative number or leave blank';
      const badPrice = values.selectedServiceIds.some((id) => {
        const raw = values.servicePrices[id]?.trim();
        return raw ? Number.isNaN(Number(raw)) || Number(raw) < 0 : false;
      });
      if (badPrice) next.servicePrices = 'Enter valid, non-negative prices (leave blank to use the base price)';
    }
    return next;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !staff) return;
    const next = validate(form);
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setIsSubmitting(true);
    setSubmitError(null);
    const isStylist = form.roles.includes('stylist');
    const payload: UpdateStaffMemberRequest = {
      roles: form.roles,
      // Omit when blank so an owner-only save (no location picked yet) doesn't
      // trip the endpoint's UUID validation; validate() guarantees a location
      // whenever a role is selected.
      locationId: form.locationId || undefined,
      membershipStatus: form.membershipStatus,
      displayName: isStylist ? form.displayName.trim() || undefined : undefined,
      colorHex: isStylist ? form.colorHex.trim() || undefined : undefined,
      bio: isStylist ? form.bio.trim() || undefined : undefined,
      isBookable: isStylist ? form.isBookable : undefined,
      hourlyRate: isStylist ? Number(form.hourlyRate) : undefined,
      contractedHours: isStylist ? Number(form.contractedHours) : undefined,
      averageBillBenchmark: isStylist ? Number(form.averageBillBenchmark) : undefined,
      leaveNotes: isStylist ? form.leaveNotes.trim() || null : undefined,
      employmentType: isStylist ? form.employmentType : undefined,
      employmentStatus: isStylist ? form.employmentStatus : undefined,
      commissionStructure: isStylist ? form.commissionStructure : undefined,
      commissionFlatRatePercent: isStylist ? Number(form.commissionFlatRatePercent) : undefined,
      performanceTargetAmount: isStylist
        ? form.performanceTargetAmount.trim()
          ? Number(form.performanceTargetAmount)
          : null
        : undefined,
      holidayEntitlementDays: isStylist ? Number(form.holidayEntitlementDays) : undefined,
      colourAllowanceAmount: isStylist ? Number(form.colourAllowanceAmount) : undefined,
      photoUrl: isStylist ? form.photoUrl.trim() || null : undefined,
      startDate: isStylist ? form.startDate || null : undefined,
      securityLevelId: form.securityLevelId ? form.securityLevelId : null,
      serviceAssignments: isStylist
        ? form.selectedServiceIds.map((serviceId) => {
            const raw = form.servicePrices[serviceId]?.trim();
            return { serviceId, priceAmount: raw ? Number(raw) : null };
          })
        : undefined,
    };
    try {
      const result = await updateStaffMember(accessToken, staff.userProfileId, payload);
      onSaved(result.staff);
      onClose();
    } catch (error: unknown) {
      if (error instanceof ApiRequestError) setSubmitError(error.message);
      else if (error instanceof Error) setSubmitError(error.message);
      else setSubmitError('Could not update staff member');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isOwner ? 'Your stylist role' : `Edit ${staff.fullName || staff.email}`}
      description={
        isOwner
          ? 'Take the stylist role at one of your locations so you can be booked. You keep full owner access.'
          : 'Owners can change roles, location, and membership status.'
      }
      footer={
        <>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="edit-staff-form"
            disabled={isSubmitting}
            className="inline-flex h-9 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <form id="edit-staff-form" onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Roles</span>
            <div className="flex flex-wrap gap-2">
              {isOwner ? (
                <span
                  className="inline-flex items-center gap-2 rounded-pill border border-border-strong bg-surface-alt px-3 py-1.5 text-[13px] capitalize text-text-secondary"
                  title="Owner access can't be removed here"
                >
                  Owner
                </span>
              ) : null}
              {roleOptions.map((roleOption) => {
                const checked = form.roles.includes(roleOption);
                return (
                  <label
                    key={roleOption}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-pill border px-3 py-1.5 text-[13px] capitalize transition ${
                      checked
                        ? 'border-primary bg-primary-soft text-text-primary'
                        : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          roles: event.target.checked
                            ? [...form.roles, roleOption]
                            : form.roles.filter((r) => r !== roleOption),
                        })
                      }
                      className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                    />
                    {roleOption}
                  </label>
                );
              })}
            </div>
            {errors.roles ? (
              <p className="mt-1 text-[12px] text-danger">{errors.roles}</p>
            ) : (
              <p className="mt-1 text-[12px] text-text-secondary">
                {isOwner
                  ? 'Turn on Stylist to be bookable at the selected location. Turn it off to stay owner-only.'
                  : 'A member can hold both roles at their location.'}
              </p>
            )}
          </div>
          <SelectField
            label="Location"
            value={form.locationId}
            onValueChange={(v) => setForm({ ...form, locationId: v })}
            options={locationOptions}
            placeholder="Select a location"
            error={errors.locationId}
            hint={isOwner ? "The location you'll take appointments at as a stylist." : undefined}
          />
          {isOwner ? null : (
            <SelectField
              label="Membership status"
              value={form.membershipStatus}
              onValueChange={(v) =>
                setForm({ ...form, membershipStatus: v as EditForm['membershipStatus'] })
              }
              options={[
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
                { value: 'revoked', label: 'Revoked' },
              ]}
              className="sm:col-span-2"
              hint="Suspended team members keep their history but cannot sign in until reactivated."
            />
          )}
        </div>

        {isOwner ? null : (
          <SelectField
            label="Security level"
            value={form.securityLevelId}
            onValueChange={(v) => setForm({ ...form, securityLevelId: v })}
            options={[
              { value: '', label: 'Default (base role permissions)' },
              ...securityLevels.map((level) => ({
                value: level.id,
                label: level.isSystem ? `${level.name} (built-in)` : level.name,
              })),
            ]}
            hint="Controls what this member can see and do (reports, financials, settings). Manage levels under Team Hub → Security levels."
          />
        )}

        {form.roles.includes('stylist') ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Display name"
              value={form.displayName}
              onValueChange={(v) => setForm({ ...form, displayName: v })}
              optional
            />
            <TextField
              label="Calendar colour"
              value={form.colorHex}
              onValueChange={(v) => setForm({ ...form, colorHex: v })}
              hint="Hex colour like #A67CF5"
              error={errors.colorHex}
              optional
            />
            <TextField
              label="Bio"
              value={form.bio}
              onValueChange={(v) => setForm({ ...form, bio: v })}
              optional
              className="sm:col-span-2"
            />
            <TextField
              label="Hourly rate"
              value={form.hourlyRate}
              onValueChange={(v) => setForm({ ...form, hourlyRate: v })}
              error={errors.hourlyRate}
            />
            <TextField
              label="Contracted hours"
              value={form.contractedHours}
              onValueChange={(v) => setForm({ ...form, contractedHours: v })}
              error={errors.contractedHours}
            />
            <TextField
              label="Average bill benchmark"
              value={form.averageBillBenchmark}
              onValueChange={(v) => setForm({ ...form, averageBillBenchmark: v })}
              error={errors.averageBillBenchmark}
            />
            <TextField
              label="Leave / absence context"
              value={form.leaveNotes}
              onValueChange={(v) => setForm({ ...form, leaveNotes: v })}
              optional
            />

            <div className="sm:col-span-2 mt-1 border-t border-border pt-3">
              <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                Employment record
              </span>
            </div>
            {form.qCode ? (
              <div className="sm:col-span-2 flex items-center gap-2 text-[13px]">
                <span className="text-text-secondary">Q Code</span>
                <span className="rounded-input border border-border-strong bg-surface-alt px-2.5 py-1 font-mono font-semibold tracking-[0.15em] text-text-primary">
                  {form.qCode}
                </span>
                <span className="text-[12px] text-text-muted">Assigned automatically · never changes</span>
              </div>
            ) : null}
            <SelectField
              label="Employment type"
              value={form.employmentType}
              onValueChange={(v) => setForm({ ...form, employmentType: v as StaffEmploymentType })}
              options={Object.entries(STAFF_EMPLOYMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <SelectField
              label="Status"
              value={form.employmentStatus}
              onValueChange={(v) => setForm({ ...form, employmentStatus: v as StaffEmploymentStatus })}
              options={Object.entries(STAFF_EMPLOYMENT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
              hint="Employment status used by KPIs & P&L (separate from sign-in membership status)."
            />
            <SelectField
              label="Commission structure"
              value={form.commissionStructure}
              onValueChange={(v) =>
                setForm({ ...form, commissionStructure: v as StaffCommissionStructure })
              }
              options={Object.entries(STAFF_COMMISSION_STRUCTURE_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <TextField
              label="Flat commission rate (%)"
              value={form.commissionFlatRatePercent}
              onValueChange={(v) => setForm({ ...form, commissionFlatRatePercent: v })}
              error={errors.commissionFlatRatePercent}
              hint="Used when commission structure is Flat rate."
            />
            <TextField
              label="Start date"
              type="date"
              value={form.startDate}
              onValueChange={(v) => setForm({ ...form, startDate: v })}
              optional
            />
            <TextField
              label="Performance target"
              value={form.performanceTargetAmount}
              onValueChange={(v) => setForm({ ...form, performanceTargetAmount: v })}
              error={errors.performanceTargetAmount}
              hint="Leave blank to use the computed target."
              optional
            />
            <TextField
              label="Holiday entitlement (days)"
              value={form.holidayEntitlementDays}
              onValueChange={(v) => setForm({ ...form, holidayEntitlementDays: v })}
              error={errors.holidayEntitlementDays}
            />
            <TextField
              label="Colour allowance"
              value={form.colourAllowanceAmount}
              onValueChange={(v) => setForm({ ...form, colourAllowanceAmount: v })}
              error={errors.colourAllowanceAmount}
            />
            <TextField
              label="Provider photo URL"
              value={form.photoUrl}
              onValueChange={(v) => setForm({ ...form, photoUrl: v })}
              hint="Shown internally and in the client-facing Salon Suite."
              optional
              className="sm:col-span-2"
            />

            <label className="flex items-center gap-2 sm:col-span-2 text-[13px] text-text-secondary">
              <input
                type="checkbox"
                checked={form.isBookable}
                onChange={(event) => setForm({ ...form, isBookable: event.target.checked })}
                className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
              />
              Bookable on the schedule
            </label>

            <div className="sm:col-span-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-text-secondary">
                  Services this stylist can perform
                </span>
                {services.length > 0 ? (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-text-secondary">
                      {form.selectedServiceIds.length} selected
                    </span>
                    <button
                      type="button"
                      className="font-medium text-primary hover:text-primary-deep"
                      onClick={() =>
                        setForm({ ...form, selectedServiceIds: services.map((s) => s.id) })
                      }
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="font-medium text-text-secondary hover:text-text-primary"
                      onClick={() => setForm({ ...form, selectedServiceIds: [] })}
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
              </div>

              {servicesLoading ? (
                <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-4 text-[13px] text-text-secondary">
                  Loading services…
                </div>
              ) : services.length === 0 ? (
                <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-4 text-[13px] text-text-secondary">
                  No active services yet. Create services first, then assign them here.
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto rounded-input-lg border border-border-strong bg-surface">
                  {serviceGroups.map(([category, groupServices]) => (
                    <div key={category} className="border-b border-border last:border-b-0">
                      <div className="bg-surface-alt px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                        {category}
                      </div>
                      {groupServices.map((service) => {
                        const checked = form.selectedServiceIds.includes(service.id);
                        return (
                          <div
                            key={service.id}
                            className="flex items-center gap-2 px-3 py-2 text-[13px] text-text-primary transition hover:bg-surface-alt"
                          >
                            <label className="flex flex-1 cursor-pointer items-center gap-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  setForm({
                                    ...form,
                                    selectedServiceIds: event.target.checked
                                      ? [...form.selectedServiceIds, service.id]
                                      : form.selectedServiceIds.filter((id) => id !== service.id),
                                  })
                                }
                                className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                              />
                              <span className="flex-1">{service.name}</span>
                            </label>
                            {checked ? (
                              <input
                                inputMode="decimal"
                                value={form.servicePrices[service.id] ?? ''}
                                onChange={(event) =>
                                  setForm({
                                    ...form,
                                    servicePrices: {
                                      ...form.servicePrices,
                                      [service.id]: event.target.value.replace(/[^0-9.]/g, ''),
                                    },
                                  })
                                }
                                placeholder={formatBasePrice(service)}
                                title="Price for this stylist — leave blank to use the service base price"
                                className="h-7 w-24 rounded-input border border-border-strong bg-surface px-2 text-right text-[12px] text-text-primary focus:border-primary focus:outline-none"
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {!servicesLoading && services.length > 0 && form.selectedServiceIds.length === 0 ? (
                <p className="mt-1.5 text-[12px] text-warning">
                  No services selected — this stylist won&apos;t be bookable for anything until you pick at least one.
                </p>
              ) : !servicesLoading && services.length > 0 ? (
                <p className="mt-1.5 text-[12px] text-text-secondary">
                  Set a price for this stylist next to each service, or leave it blank to use the service base price.
                </p>
              ) : null}
              {errors.servicePrices ? (
                <p className="mt-1 text-[12px] text-danger">{errors.servicePrices}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {submitError ? (
          <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {submitError}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
