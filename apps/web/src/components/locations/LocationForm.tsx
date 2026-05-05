import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { CreateLocationRequest, UpdateLocationRequest } from '@sheer/domain';
import { SelectField, TextField } from '../onboarding/FormField';

export interface LocationFormValues {
  name: string;
  slug: string;
  timezone: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

const DEFAULT_VALUES: LocationFormValues = {
  name: '',
  slug: '',
  timezone: 'Europe/London',
  phone: '',
  email: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  countryCode: 'GB',
};

const TIMEZONE_OPTIONS = [
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'Europe/Dublin', label: 'Europe/Dublin' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Europe/Rome', label: 'Europe/Rome' },
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'America/Toronto', label: 'America/Toronto' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
];

const COUNTRY_OPTIONS = [
  { value: 'GB', label: 'United Kingdom (GB)' },
  { value: 'IE', label: 'Ireland (IE)' },
  { value: 'FR', label: 'France (FR)' },
  { value: 'DE', label: 'Germany (DE)' },
  { value: 'ES', label: 'Spain (ES)' },
  { value: 'IT', label: 'Italy (IT)' },
  { value: 'NL', label: 'Netherlands (NL)' },
  { value: 'US', label: 'United States (US)' },
  { value: 'CA', label: 'Canada (CA)' },
  { value: 'AE', label: 'United Arab Emirates (AE)' },
  { value: 'AU', label: 'Australia (AU)' },
  { value: 'NZ', label: 'New Zealand (NZ)' },
];

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

interface LocationFormProps {
  initialValues?: Partial<LocationFormValues>;
  /** Hide the slug input on edit so it stays a deliberate operation. Pass `true` from EditLocationPage. */
  lockSlug?: boolean;
  submitLabel: string;
  pendingLabel?: string;
  onSubmit: (values: LocationFormValues) => Promise<void> | void;
  onCancel: () => void;
  externalError?: string | null;
}

export function LocationForm({
  initialValues,
  lockSlug = false,
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
  externalError,
}: LocationFormProps) {
  const initial = useMemo<LocationFormValues>(
    () => ({ ...DEFAULT_VALUES, ...initialValues }),
    [initialValues],
  );
  const [values, setValues] = useState<LocationFormValues>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof LocationFormValues, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValues(initial);
    setErrors({});
  }, [initial]);

  const setField = <K extends keyof LocationFormValues>(key: K, value: LocationFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  function validate(current: LocationFormValues): Partial<Record<keyof LocationFormValues, string>> {
    const next: Partial<Record<keyof LocationFormValues, string>> = {};
    if (!current.name.trim()) next.name = 'Location name is required';
    if (!lockSlug) {
      const slug = current.slug.trim().toLowerCase();
      if (!slug) next.slug = 'Slug is required';
      else if (!SLUG_REGEX.test(slug))
        next.slug = '2-40 lowercase chars (letters, numbers, dashes; no leading/trailing dash)';
    }
    if (!current.timezone.trim()) next.timezone = 'Timezone is required';
    if (current.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(current.email.trim())) {
      next.email = 'Enter a valid email or leave it blank';
    }
    return next;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = validate(values);
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      await onSubmit(values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="rounded-card-lg border border-border bg-surface px-5 py-5">
        <h2 className="text-[14px] font-semibold text-text-primary">Basics</h2>
        <p className="mt-1 text-[12px] text-text-secondary">
          The minimum needed to make a location bookable. Address details below are optional for
          now.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            value={values.name}
            onValueChange={(v) => setField('name', v)}
            error={errors.name}
            required
            autoComplete="off"
          />
          {lockSlug ? (
            <TextField
              label="Slug"
              value={values.slug}
              disabled
              hint="Slugs are stable identifiers and cannot be edited in this phase."
            />
          ) : (
            <TextField
              label="Slug"
              value={values.slug}
              onValueChange={(v) => setField('slug', v.toLowerCase())}
              error={errors.slug}
              hint="Used in URLs and unique within your business. Lowercase, dashes, no spaces."
              required
              autoComplete="off"
            />
          )}
          <SelectField
            label="Timezone"
            value={values.timezone}
            onValueChange={(v) => setField('timezone', v)}
            options={TIMEZONE_OPTIONS}
            error={errors.timezone}
          />
          <SelectField
            label="Country"
            value={values.countryCode}
            onValueChange={(v) => setField('countryCode', v)}
            options={COUNTRY_OPTIONS}
          />
          <TextField
            label="Phone"
            type="tel"
            value={values.phone}
            onValueChange={(v) => setField('phone', v)}
            optional
          />
          <TextField
            label="Email"
            type="email"
            value={values.email}
            onValueChange={(v) => setField('email', v)}
            error={errors.email}
            optional
          />
        </div>
      </section>

      <section className="rounded-card-lg border border-border bg-surface px-5 py-5">
        <h2 className="text-[14px] font-semibold text-text-primary">Address</h2>
        <p className="mt-1 text-[12px] text-text-secondary">
          Optional in this phase. You can fill it in later from the location detail page.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label="Address line 1"
            value={values.addressLine1}
            onValueChange={(v) => setField('addressLine1', v)}
            optional
            className="sm:col-span-2"
          />
          <TextField
            label="Address line 2"
            value={values.addressLine2}
            onValueChange={(v) => setField('addressLine2', v)}
            optional
            className="sm:col-span-2"
          />
          <TextField
            label="City"
            value={values.city}
            onValueChange={(v) => setField('city', v)}
            optional
          />
          <TextField
            label="Region / State"
            value={values.region}
            onValueChange={(v) => setField('region', v)}
            optional
          />
          <TextField
            label="Postal code"
            value={values.postalCode}
            onValueChange={(v) => setField('postalCode', v)}
            optional
          />
        </div>
      </section>

      {externalError ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {externalError}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-9 items-center justify-center rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? pendingLabel ?? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function toCreatePayload(values: LocationFormValues): CreateLocationRequest {
  return {
    name: values.name.trim(),
    slug: values.slug.trim().toLowerCase(),
    timezone: values.timezone.trim() || undefined,
    phone: values.phone.trim() || undefined,
    email: values.email.trim().toLowerCase() || undefined,
    addressLine1: values.addressLine1.trim() || undefined,
    addressLine2: values.addressLine2.trim() || undefined,
    city: values.city.trim() || undefined,
    region: values.region.trim() || undefined,
    postalCode: values.postalCode.trim() || undefined,
    countryCode: values.countryCode.trim().toUpperCase() || undefined,
  };
}

/**
 * Build a partial PATCH payload by diffing against the row that was loaded
 * into the form. We send `null` to clear optional fields; required fields are
 * just sent as the new trimmed string.
 */
export function toUpdatePayload(
  values: LocationFormValues,
  initial: LocationFormValues,
): UpdateLocationRequest {
  const patch: UpdateLocationRequest = {};
  if (values.name.trim() !== initial.name) patch.name = values.name.trim();
  if (values.timezone.trim() !== initial.timezone) patch.timezone = values.timezone.trim();
  if (values.countryCode.trim().toUpperCase() !== initial.countryCode.toUpperCase())
    patch.countryCode = values.countryCode.trim().toUpperCase();

  diffNullable(values.phone, initial.phone, (v) => (patch.phone = v));
  diffNullable(values.email, initial.email, (v) => (patch.email = v?.toLowerCase() ?? null));
  diffNullable(values.addressLine1, initial.addressLine1, (v) => (patch.addressLine1 = v));
  diffNullable(values.addressLine2, initial.addressLine2, (v) => (patch.addressLine2 = v));
  diffNullable(values.city, initial.city, (v) => (patch.city = v));
  diffNullable(values.region, initial.region, (v) => (patch.region = v));
  diffNullable(values.postalCode, initial.postalCode, (v) => (patch.postalCode = v));

  return patch;
}

function diffNullable(next: string, prev: string, set: (v: string | null) => void): void {
  const trimmedNext = next.trim();
  const trimmedPrev = prev.trim();
  if (trimmedNext === trimmedPrev) return;
  set(trimmedNext === '' ? null : trimmedNext);
}
