import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  BusinessLocationSummary,
  CreateStaffInvitationRequest,
  InvitableRole,
  StaffInvitationWithToken,
} from '@sheer/domain';
import { ApiRequestError, createStaffInvitation } from '../../auth/api';
import { SelectField, TextField } from '../onboarding/FormField';
import { Modal } from './Modal';

interface InviteStaffModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (invitation: StaffInvitationWithToken) => void;
  accessToken: string;
  locations: BusinessLocationSummary[];
}

interface InviteForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: InvitableRole;
  locationId: string;
  displayName: string;
  bio: string;
}

const EMPTY: InviteForm = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  role: 'stylist',
  locationId: '',
  displayName: '',
  bio: '',
};

const ROLE_OPTIONS: { value: InvitableRole; label: string; description: string }[] = [
  { value: 'manager', label: 'Manager', description: 'Manages a single location and its team.' },
  { value: 'stylist', label: 'Stylist', description: 'Bookable team member who serves clients.' },
];

export function InviteStaffModal({
  open,
  onClose,
  onCreated,
  accessToken,
  locations,
}: InviteStaffModalProps) {
  const [form, setForm] = useState<InviteForm>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdInvitation, setCreatedInvitation] = useState<StaffInvitationWithToken | null>(
    null,
  );

  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY, locationId: locations[0]?.id ?? '' });
      setErrors({});
      setSubmitError(null);
      setCreatedInvitation(null);
    }
  }, [open, locations]);

  const locationOptions = useMemo(
    () =>
      locations.map((loc) => ({
        value: loc.id,
        label: loc.code ? `${loc.name} · ${loc.code}` : loc.name,
      })),
    [locations],
  );

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!form.firstName.trim()) next.firstName = 'First name is required';
    if (!form.lastName.trim()) next.lastName = 'Last name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      next.email = 'Enter a valid email address';
    if (!form.locationId) next.locationId = 'Pick a location';
    return next;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setIsSubmitting(true);
    const payload: CreateStaffInvitationRequest = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim().toLowerCase(),
      phone: form.phone.trim() || undefined,
      role: form.role,
      locationId: form.locationId,
      displayName: form.role === 'stylist' ? form.displayName.trim() || undefined : undefined,
      bio: form.role === 'stylist' ? form.bio.trim() || undefined : undefined,
    };
    try {
      const created = await createStaffInvitation(accessToken, payload);
      setCreatedInvitation(created);
      onCreated(created);
    } catch (error: unknown) {
      if (error instanceof ApiRequestError) setSubmitError(error.message);
      else if (error instanceof Error) setSubmitError(error.message);
      else setSubmitError('Could not create invitation. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (createdInvitation) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Invitation sent"
        description="Share this link with your teammate. It works once and expires automatically."
        footer={
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-pill bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            onClick={onClose}
          >
            Done
          </button>
        }
      >
        <div className="space-y-4">
          <div className="rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
            Invitation created for {createdInvitation.email}.
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Invitation link
            </div>
            <div className="flex items-center gap-2 rounded-input-lg border border-border-strong bg-surface-alt px-3 py-2 text-[12px] font-mono text-text-primary">
              <code className="flex-1 truncate">{createdInvitation.inviteUrl}</code>
              <button
                type="button"
                className="rounded-input-lg border border-border-strong bg-surface px-3 py-1 text-[12px] font-medium text-text-secondary hover:text-text-primary"
                onClick={() =>
                  navigator.clipboard
                    .writeText(createdInvitation.inviteUrl)
                    .catch(() => undefined)
                }
              >
                Copy
              </button>
            </div>
            <p className="mt-2 text-[12px] text-text-secondary">
              The invitee opens this link, sets a password, and lands inside your business with the
              {createdInvitation.role === 'manager' ? ' manager ' : ' stylist '}role at the chosen
              location.
            </p>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite a team member"
      description="They'll be added to your business as soon as they accept."
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
            form="invite-staff-form"
            disabled={isSubmitting || locations.length === 0}
            className="inline-flex h-9 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Sending…' : 'Send invitation'}
          </button>
        </>
      }
    >
      {locations.length === 0 ? (
        <div className="rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3 text-[13px] text-warning">
          You need at least one location before you can invite staff.
        </div>
      ) : (
        <form id="invite-staff-form" onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First name"
              value={form.firstName}
              onValueChange={(v) => setForm({ ...form, firstName: v })}
              error={errors.firstName}
              required
            />
            <TextField
              label="Last name"
              value={form.lastName}
              onValueChange={(v) => setForm({ ...form, lastName: v })}
              error={errors.lastName}
              required
            />
            <TextField
              label="Email"
              type="email"
              value={form.email}
              onValueChange={(v) => setForm({ ...form, email: v })}
              error={errors.email}
              required
              className="sm:col-span-2"
            />
            <TextField
              label="Phone"
              type="tel"
              value={form.phone}
              onValueChange={(v) => setForm({ ...form, phone: v })}
              optional
              className="sm:col-span-2"
            />
            <SelectField
              label="Role"
              value={form.role}
              onValueChange={(v) => setForm({ ...form, role: v as InvitableRole })}
              options={ROLE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              hint={ROLE_OPTIONS.find((option) => option.value === form.role)?.description}
            />
            <SelectField
              label="Location"
              value={form.locationId}
              onValueChange={(v) => setForm({ ...form, locationId: v })}
              options={locationOptions}
              error={errors.locationId}
            />
          </div>
          {form.role === 'stylist' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Display name"
                value={form.displayName}
                onValueChange={(v) => setForm({ ...form, displayName: v })}
                hint="Shown to clients on the booking calendar"
                optional
              />
              <TextField
                label="Bio"
                value={form.bio}
                onValueChange={(v) => setForm({ ...form, bio: v })}
                optional
              />
            </div>
          ) : null}
          {submitError ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {submitError}
            </div>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
