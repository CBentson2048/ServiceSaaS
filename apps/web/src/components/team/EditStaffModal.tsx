import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  BusinessLocationSummary,
  InvitableRole,
  StaffMember,
  UpdateStaffMemberRequest,
} from '@sheer/domain';
import { ApiRequestError, updateStaffMember } from '../../auth/api';
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
  role: InvitableRole;
  locationId: string;
  membershipStatus: 'active' | 'suspended' | 'revoked';
  displayName: string;
  colorHex: string;
  bio: string;
  isBookable: boolean;
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

  useEffect(() => {
    if (!open || !staff) {
      setForm(null);
      return;
    }
    const role: InvitableRole =
      staff.role === 'manager' || staff.role === 'stylist' ? staff.role : 'stylist';
    setForm({
      role,
      locationId: staff.location?.id ?? locations[0]?.id ?? '',
      membershipStatus:
        staff.membershipStatus === 'suspended' || staff.membershipStatus === 'revoked'
          ? staff.membershipStatus
          : 'active',
      displayName: staff.staffProfile?.displayName ?? '',
      colorHex: staff.staffProfile?.colorHex ?? '',
      bio: staff.staffProfile?.bio ?? '',
      isBookable: staff.staffProfile?.isBookable ?? true,
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

  if (!staff || !form) {
    return (
      <Modal open={open} onClose={onClose} title="Edit team member">
        <div className="text-[13px] text-text-secondary">Loading…</div>
      </Modal>
    );
  }

  function validate(values: EditForm): Record<string, string> {
    const next: Record<string, string> = {};
    if (!values.locationId) next.locationId = 'Pick a location';
    if (values.colorHex && !/^#[0-9A-Fa-f]{6}$/.test(values.colorHex.trim()))
      next.colorHex = 'Use a #RRGGBB hex colour';
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
    const payload: UpdateStaffMemberRequest = {
      role: form.role,
      locationId: form.locationId,
      membershipStatus: form.membershipStatus,
      displayName: form.role === 'stylist' ? form.displayName.trim() || undefined : undefined,
      colorHex: form.role === 'stylist' ? form.colorHex.trim() || undefined : undefined,
      bio: form.role === 'stylist' ? form.bio.trim() || undefined : undefined,
      isBookable: form.role === 'stylist' ? form.isBookable : undefined,
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
      title={`Edit ${staff.fullName || staff.email}`}
      description="Owners can change role, location, and membership status."
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
          <SelectField
            label="Role"
            value={form.role}
            onValueChange={(v) => setForm({ ...form, role: v as InvitableRole })}
            options={[
              { value: 'manager', label: 'Manager' },
              { value: 'stylist', label: 'Stylist' },
            ]}
          />
          <SelectField
            label="Location"
            value={form.locationId}
            onValueChange={(v) => setForm({ ...form, locationId: v })}
            options={locationOptions}
            error={errors.locationId}
          />
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
        </div>

        {form.role === 'stylist' ? (
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
            <label className="flex items-center gap-2 sm:col-span-2 text-[13px] text-text-secondary">
              <input
                type="checkbox"
                checked={form.isBookable}
                onChange={(event) => setForm({ ...form, isBookable: event.target.checked })}
                className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
              />
              Bookable on the schedule
            </label>
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
