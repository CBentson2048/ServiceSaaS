import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type {
  BusinessSlugAvailabilityResponse,
  OwnerOnboardingBootstrap,
  OwnerOnboardingRequest,
} from '@sheer/domain';
import {
  ApiRequestError,
  checkBusinessSlugAvailability,
  getOwnerOnboardingBootstrap,
  registerOwnerOnboarding,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { Stepper } from '../components/onboarding/Stepper';
import { SelectField, TextField } from '../components/onboarding/FormField';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const SLUG_HINT = '2-40 chars, lowercase letters, numbers, dashes';
const PASSWORD_MIN = 8;

type StepKey = 'owner' | 'business' | 'location' | 'review';

interface OwnerForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
}

interface BusinessForm {
  name: string;
  slug: string;
  defaultCurrency: string;
  defaultTimezone: string;
  countryCode: string;
}

interface LocationForm {
  name: string;
  slug: string;
  phone: string;
  email: string;
  timezone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

const STEPS: { key: StepKey; label: string; title: string; description: string }[] = [
  {
    key: 'owner',
    label: 'Owner',
    title: 'Tell us about you',
    description: 'You will sign in as the owner with full business access.',
  },
  {
    key: 'business',
    label: 'Business',
    title: 'Set up your business',
    description: 'These details power invoicing, scheduling, and online booking defaults.',
  },
  {
    key: 'location',
    label: 'First location',
    title: 'Add your first salon',
    description: 'You can add more locations later from the dashboard.',
  },
  {
    key: 'review',
    label: 'Review',
    title: 'Review and confirm',
    description: 'Double-check the details before creating your account.',
  },
];

function emptyOwner(): OwnerForm {
  return {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
  };
}

function emptyBusiness(): BusinessForm {
  return {
    name: '',
    slug: '',
    defaultCurrency: 'GBP',
    defaultTimezone: 'Europe/London',
    countryCode: 'GB',
  };
}

function emptyLocation(): LocationForm {
  return {
    name: '',
    slug: '',
    phone: '',
    email: '',
    timezone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: '',
  };
}

function autoSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function OwnerOnboardingPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<OwnerOnboardingBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [reachedStep, setReachedStep] = useState(0);
  const [owner, setOwner] = useState<OwnerForm>(emptyOwner);
  const [business, setBusiness] = useState<BusinessForm>(emptyBusiness);
  const [location, setLocation] = useState<LocationForm>(emptyLocation);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [slugStatus, setSlugStatus] = useState<BusinessSlugAvailabilityResponse | null>(null);
  const [isSlugChecking, setIsSlugChecking] = useState(false);
  const [businessSlugTouched, setBusinessSlugTouched] = useState(false);
  const [locationSlugTouched, setLocationSlugTouched] = useState(false);

  const slugRequestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getOwnerOnboardingBootstrap()
      .then((data) => {
        if (cancelled) return;
        setBootstrap(data);
        setBusiness((prev) => ({
          ...prev,
          defaultCurrency: prev.defaultCurrency || data.defaultCurrency,
          defaultTimezone: prev.defaultTimezone || data.defaultTimezone,
          countryCode: prev.countryCode || data.defaultCountryCode,
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBootstrapError(
          err instanceof Error ? err.message : 'Could not load onboarding defaults',
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (businessSlugTouched) return;
    setBusiness((prev) => ({ ...prev, slug: autoSlug(prev.name) }));
  }, [business.name, businessSlugTouched]);

  useEffect(() => {
    if (locationSlugTouched) return;
    setLocation((prev) => ({ ...prev, slug: autoSlug(prev.name) }));
  }, [location.name, locationSlugTouched]);

  useEffect(() => {
    const slug = business.slug.trim();
    if (!slug || !SLUG_REGEX.test(slug)) {
      setSlugStatus(null);
      setIsSlugChecking(false);
      return;
    }
    setIsSlugChecking(true);
    const requestId = ++slugRequestId.current;
    const handle = window.setTimeout(() => {
      checkBusinessSlugAvailability(slug)
        .then((response) => {
          if (slugRequestId.current === requestId) {
            setSlugStatus(response);
          }
        })
        .catch(() => {
          if (slugRequestId.current === requestId) {
            setSlugStatus(null);
          }
        })
        .finally(() => {
          if (slugRequestId.current === requestId) {
            setIsSlugChecking(false);
          }
        });
    }, 350);
    return () => window.clearTimeout(handle);
  }, [business.slug]);

  const goTo = useCallback(
    (next: number) => {
      setStepIndex(next);
      setReachedStep((current) => Math.max(current, next));
      setSubmitError(null);
    },
    [],
  );

  const validateOwner = useCallback((): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!owner.firstName.trim()) next['owner.firstName'] = 'First name is required';
    if (!owner.lastName.trim()) next['owner.lastName'] = 'Last name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email.trim()))
      next['owner.email'] = 'Enter a valid email address';
    if (owner.password.length < PASSWORD_MIN)
      next['owner.password'] = `Password must be at least ${PASSWORD_MIN} characters`;
    if (owner.confirmPassword !== owner.password)
      next['owner.confirmPassword'] = 'Passwords do not match';
    return next;
  }, [owner]);

  const validateBusiness = useCallback((): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!business.name.trim()) next['business.name'] = 'Business name is required';
    const slug = business.slug.trim();
    if (!SLUG_REGEX.test(slug)) next['business.slug'] = SLUG_HINT;
    else if (slugStatus && !slugStatus.available)
      next['business.slug'] = slugStatus.reason ?? 'Slug is unavailable';
    if (!/^[A-Za-z]{3}$/.test(business.defaultCurrency.trim()))
      next['business.defaultCurrency'] = 'Pick a 3-letter currency code';
    if (!business.defaultTimezone.trim()) next['business.defaultTimezone'] = 'Timezone is required';
    if (!/^[A-Za-z]{2}$/.test(business.countryCode.trim()))
      next['business.countryCode'] = 'Pick a 2-letter country code';
    return next;
  }, [business, slugStatus]);

  const validateLocation = useCallback((): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!location.name.trim()) next['location.name'] = 'Location name is required';
    if (!SLUG_REGEX.test(location.slug.trim())) next['location.slug'] = SLUG_HINT;
    if (location.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(location.email.trim()))
      next['location.email'] = 'Enter a valid email address';
    return next;
  }, [location]);

  const validateForStep = useCallback(
    (key: StepKey): Record<string, string> => {
      switch (key) {
        case 'owner':
          return validateOwner();
        case 'business':
          return validateBusiness();
        case 'location':
          return validateLocation();
        case 'review':
          return {
            ...validateOwner(),
            ...validateBusiness(),
            ...validateLocation(),
          };
        default:
          return {};
      }
    },
    [validateOwner, validateBusiness, validateLocation],
  );

  const buildPayload = useCallback((): OwnerOnboardingRequest => {
    return {
      owner: {
        firstName: owner.firstName.trim(),
        lastName: owner.lastName.trim(),
        email: owner.email.trim().toLowerCase(),
        password: owner.password,
        phone: owner.phone.trim() || undefined,
      },
      business: {
        name: business.name.trim(),
        slug: business.slug.trim().toLowerCase(),
        defaultCurrency: business.defaultCurrency.trim().toUpperCase(),
        defaultTimezone: business.defaultTimezone.trim(),
        countryCode: business.countryCode.trim().toUpperCase(),
      },
      location: {
        name: location.name.trim(),
        slug: location.slug.trim().toLowerCase(),
        phone: location.phone.trim() || undefined,
        email: location.email.trim().toLowerCase() || undefined,
        timezone: location.timezone.trim() || undefined,
        addressLine1: location.addressLine1.trim() || undefined,
        addressLine2: location.addressLine2.trim() || undefined,
        city: location.city.trim() || undefined,
        region: location.region.trim() || undefined,
        postalCode: location.postalCode.trim() || undefined,
        countryCode: location.countryCode.trim().toUpperCase() || undefined,
      },
    };
  }, [owner, business, location]);

  const onContinue = useCallback(() => {
    const stepKey = STEPS[stepIndex].key;
    const stepErrors = validateForStep(stepKey);
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) return;
    if (stepIndex < STEPS.length - 1) goTo(stepIndex + 1);
  }, [stepIndex, validateForStep, goTo]);

  const onBack = useCallback(() => {
    if (stepIndex > 0) goTo(stepIndex - 1);
  }, [stepIndex, goTo]);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitError(null);

      const allErrors = validateForStep('review');
      setErrors(allErrors);
      if (Object.keys(allErrors).length > 0) {
        const firstErrorStep = STEPS.findIndex((step) =>
          Object.keys(allErrors).some((key) => key.startsWith(step.key + '.')),
        );
        if (firstErrorStep >= 0 && firstErrorStep !== stepIndex) goTo(firstErrorStep);
        return;
      }

      setIsSubmitting(true);
      try {
        const response = await registerOwnerOnboarding(buildPayload());
        if (response.session && response.user) {
          auth.applyAuthenticatedSession(response.session, response.user);
          navigate(response.redirectTo === '/' ? '/' : response.redirectTo, { replace: true });
          return;
        }
        navigate(response.redirectTo || '/login?onboarded=1', { replace: true });
      } catch (error: unknown) {
        if (error instanceof ApiRequestError) {
          setSubmitError(error.message);
          if (/email/i.test(error.message)) goTo(0);
          else if (/slug/i.test(error.message)) goTo(1);
        } else if (error instanceof Error) {
          setSubmitError(error.message);
        } else {
          setSubmitError('Account creation failed. Please try again.');
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [validateForStep, stepIndex, goTo, buildPayload, auth, navigate],
  );

  const slugTrailing = useMemo(() => {
    if (!business.slug) return null;
    if (isSlugChecking) return 'Checking…';
    if (!SLUG_REGEX.test(business.slug)) return null;
    if (!slugStatus) return null;
    return slugStatus.available ? (
      <span className="text-success">Available</span>
    ) : (
      <span className="text-danger">Taken</span>
    );
  }, [business.slug, isSlugChecking, slugStatus]);

  if (auth.user) {
    return <Navigate to="/" replace />;
  }

  const currentStep = STEPS[stepIndex];

  return (
    <main className="min-h-screen bg-bg px-4 py-8 text-text-primary sm:py-12">
      <section className="mx-auto w-full max-w-2xl overflow-hidden rounded-card-lg border border-border-strong bg-surface shadow-hero">
        <header className="border-b border-border bg-surface-alt px-6 py-6 sm:px-10">
          <div className="mb-5 flex items-center justify-between">
            <span className="text-xs font-semibold tracking-[0.38em] text-text-secondary">
              SH<span className="text-primary">EE</span>R
            </span>
            <Link to="/login" className="text-[12px] font-medium text-primary-deep hover:underline">
              Already have an account? Sign in
            </Link>
          </div>
          <Stepper
            steps={STEPS.map((step) => ({ key: step.key, label: step.label }))}
            activeIndex={stepIndex}
            completedThrough={reachedStep}
          />
          <div className="mt-6">
            <h1 className="text-[22px] font-semibold leading-7 text-text-primary">
              {currentStep.title}
            </h1>
            <p className="mt-1 text-[13px] text-text-secondary">{currentStep.description}</p>
          </div>
        </header>

        <form onSubmit={onSubmit} className="px-6 py-7 sm:px-10">
          {bootstrapError ? (
            <div className="mb-5 rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3 text-[13px] text-warning">
              Could not load onboarding defaults. The form will still work with sensible defaults.
            </div>
          ) : null}

          {currentStep.key === 'owner' ? (
            <OwnerStep value={owner} onChange={setOwner} errors={errors} />
          ) : null}

          {currentStep.key === 'business' ? (
            <BusinessStep
              value={business}
              onChange={(next) => {
                setBusinessSlugTouched(businessSlugTouched || next.slug !== business.slug);
                setBusiness(next);
              }}
              errors={errors}
              bootstrap={bootstrap}
              slugTrailing={slugTrailing}
              slugHint={SLUG_HINT}
            />
          ) : null}

          {currentStep.key === 'location' ? (
            <LocationStep
              value={location}
              onChange={(next) => {
                setLocationSlugTouched(locationSlugTouched || next.slug !== location.slug);
                setLocation(next);
              }}
              errors={errors}
              bootstrap={bootstrap}
              fallbackTimezone={business.defaultTimezone}
              slugHint={SLUG_HINT}
            />
          ) : null}

          {currentStep.key === 'review' ? (
            <ReviewStep owner={owner} business={business} location={location} />
          ) : null}

          {submitError ? (
            <div className="mt-5 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {submitError}
            </div>
          ) : null}

          <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            {stepIndex > 0 ? (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex h-10 items-center justify-center rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-semibold text-text-secondary transition hover:bg-surface-alt"
              >
                Back
              </button>
            ) : (
              <span />
            )}

            {stepIndex < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={onContinue}
                className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-6 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
              >
                Continue
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex h-10 items-center justify-center rounded-pill bg-primary px-6 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? 'Creating workspace…' : 'Create owner workspace'}
              </button>
            )}
          </div>
        </form>
      </section>
    </main>
  );
}

function OwnerStep({
  value,
  onChange,
  errors,
}: {
  value: OwnerForm;
  onChange: (next: OwnerForm) => void;
  errors: Record<string, string>;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="First name"
        autoComplete="given-name"
        value={value.firstName}
        onValueChange={(v) => onChange({ ...value, firstName: v })}
        error={errors['owner.firstName']}
        required
      />
      <TextField
        label="Last name"
        autoComplete="family-name"
        value={value.lastName}
        onValueChange={(v) => onChange({ ...value, lastName: v })}
        error={errors['owner.lastName']}
        required
      />
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        value={value.email}
        onValueChange={(v) => onChange({ ...value, email: v })}
        error={errors['owner.email']}
        required
        className="sm:col-span-2"
      />
      <TextField
        label="Phone"
        type="tel"
        autoComplete="tel"
        value={value.phone}
        onValueChange={(v) => onChange({ ...value, phone: v })}
        error={errors['owner.phone']}
        optional
        className="sm:col-span-2"
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        value={value.password}
        onValueChange={(v) => onChange({ ...value, password: v })}
        hint={`At least ${PASSWORD_MIN} characters`}
        error={errors['owner.password']}
        required
      />
      <TextField
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        value={value.confirmPassword}
        onValueChange={(v) => onChange({ ...value, confirmPassword: v })}
        error={errors['owner.confirmPassword']}
        required
      />
    </div>
  );
}

function BusinessStep({
  value,
  onChange,
  errors,
  bootstrap,
  slugTrailing,
  slugHint,
}: {
  value: BusinessForm;
  onChange: (next: BusinessForm) => void;
  errors: Record<string, string>;
  bootstrap: OwnerOnboardingBootstrap | null;
  slugTrailing: React.ReactNode;
  slugHint: string;
}) {
  const currencies = bootstrap?.currencies ?? [{ code: value.defaultCurrency, label: value.defaultCurrency }];
  const timezones = bootstrap?.timezones ?? [{ value: value.defaultTimezone, label: value.defaultTimezone }];
  const countries = bootstrap?.countries ?? [{ code: value.countryCode, label: value.countryCode }];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="Business name"
        value={value.name}
        onValueChange={(v) => onChange({ ...value, name: v })}
        error={errors['business.name']}
        required
        className="sm:col-span-2"
      />
      <TextField
        label="Business slug"
        value={value.slug}
        onValueChange={(v) =>
          onChange({ ...value, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })
        }
        hint={slugHint}
        trailing={slugTrailing}
        error={errors['business.slug']}
        required
        className="sm:col-span-2"
      />
      <SelectField
        label="Default currency"
        value={value.defaultCurrency}
        onValueChange={(v) => onChange({ ...value, defaultCurrency: v })}
        options={currencies.map((c) => ({ value: c.code, label: `${c.code} – ${c.label}` }))}
        error={errors['business.defaultCurrency']}
      />
      <SelectField
        label="Country"
        value={value.countryCode}
        onValueChange={(v) => onChange({ ...value, countryCode: v })}
        options={countries.map((c) => ({ value: c.code, label: `${c.code} – ${c.label}` }))}
        error={errors['business.countryCode']}
      />
      <SelectField
        label="Timezone"
        value={value.defaultTimezone}
        onValueChange={(v) => onChange({ ...value, defaultTimezone: v })}
        options={timezones.map((t) => ({ value: t.value, label: t.label }))}
        error={errors['business.defaultTimezone']}
        className="sm:col-span-2"
      />
    </div>
  );
}

function LocationStep({
  value,
  onChange,
  errors,
  bootstrap,
  fallbackTimezone,
  slugHint,
}: {
  value: LocationForm;
  onChange: (next: LocationForm) => void;
  errors: Record<string, string>;
  bootstrap: OwnerOnboardingBootstrap | null;
  fallbackTimezone: string;
  slugHint: string;
}) {
  const timezones = bootstrap?.timezones ?? [{ value: fallbackTimezone, label: fallbackTimezone }];
  const countries = bootstrap?.countries ?? [];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="Location name"
        value={value.name}
        onValueChange={(v) => onChange({ ...value, name: v })}
        error={errors['location.name']}
        required
      />
      <TextField
        label="Location slug"
        value={value.slug}
        onValueChange={(v) =>
          onChange({ ...value, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })
        }
        hint={slugHint}
        error={errors['location.slug']}
        required
      />
      <TextField
        label="Phone"
        type="tel"
        value={value.phone}
        onValueChange={(v) => onChange({ ...value, phone: v })}
        optional
      />
      <TextField
        label="Email"
        type="email"
        value={value.email}
        onValueChange={(v) => onChange({ ...value, email: v })}
        error={errors['location.email']}
        optional
      />
      <SelectField
        label="Timezone"
        value={value.timezone || fallbackTimezone}
        onValueChange={(v) => onChange({ ...value, timezone: v })}
        options={timezones.map((t) => ({ value: t.value, label: t.label }))}
        optional
        className="sm:col-span-2"
      />
      <TextField
        label="Address line 1"
        value={value.addressLine1}
        onValueChange={(v) => onChange({ ...value, addressLine1: v })}
        optional
        className="sm:col-span-2"
      />
      <TextField
        label="Address line 2"
        value={value.addressLine2}
        onValueChange={(v) => onChange({ ...value, addressLine2: v })}
        optional
        className="sm:col-span-2"
      />
      <TextField
        label="City"
        value={value.city}
        onValueChange={(v) => onChange({ ...value, city: v })}
        optional
      />
      <TextField
        label="Region"
        value={value.region}
        onValueChange={(v) => onChange({ ...value, region: v })}
        optional
      />
      <TextField
        label="Postal code"
        value={value.postalCode}
        onValueChange={(v) => onChange({ ...value, postalCode: v })}
        optional
      />
      <SelectField
        label="Country"
        value={value.countryCode}
        onValueChange={(v) => onChange({ ...value, countryCode: v })}
        placeholder="Inherit from business"
        options={[
          { value: '', label: 'Inherit from business' },
          ...countries.map((c) => ({ value: c.code, label: `${c.code} – ${c.label}` })),
        ]}
        optional
      />
    </div>
  );
}

function ReviewStep({
  owner,
  business,
  location,
}: {
  owner: OwnerForm;
  business: BusinessForm;
  location: LocationForm;
}) {
  return (
    <div className="space-y-4">
      <ReviewCard title="Owner">
        <ReviewRow label="Name" value={`${owner.firstName} ${owner.lastName}`.trim() || '—'} />
        <ReviewRow label="Email" value={owner.email || '—'} />
        <ReviewRow label="Phone" value={owner.phone || '—'} />
      </ReviewCard>

      <ReviewCard title="Business">
        <ReviewRow label="Name" value={business.name || '—'} />
        <ReviewRow label="Slug" value={business.slug || '—'} mono />
        <ReviewRow label="Currency" value={business.defaultCurrency || '—'} />
        <ReviewRow label="Timezone" value={business.defaultTimezone || '—'} />
        <ReviewRow label="Country" value={business.countryCode || '—'} />
      </ReviewCard>

      <ReviewCard title="First location">
        <ReviewRow label="Name" value={location.name || '—'} />
        <ReviewRow label="Slug" value={location.slug || '—'} mono />
        <ReviewRow label="Timezone" value={location.timezone || business.defaultTimezone || '—'} />
        <ReviewRow label="Phone" value={location.phone || '—'} />
        <ReviewRow label="Email" value={location.email || '—'} />
        <ReviewRow
          label="Address"
          value={
            [
              location.addressLine1,
              location.addressLine2,
              [location.city, location.region].filter(Boolean).join(', '),
              location.postalCode,
              location.countryCode || business.countryCode,
            ]
              .filter(Boolean)
              .join(' · ') || '—'
          }
        />
      </ReviewCard>
    </div>
  );
}

function ReviewCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface-alt px-4 py-4">
      <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {title}
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">{children}</dl>
    </div>
  );
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted">{label}</dt>
      <dd className={`mt-0.5 text-[13px] text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
