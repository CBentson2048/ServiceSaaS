import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { BusinessLocation } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { ApiRequestError, getLocation, updateLocation } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import {
  LocationForm,
  toUpdatePayload,
  type LocationFormValues,
} from '../components/locations/LocationForm';

export function EditLocationPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const accessToken = auth.session?.accessToken;
  const [location, setLocation] = useState<BusinessLocation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!accessToken || !params.id) return;
      setLoading(true);
      setLoadError(null);
      try {
        const { location: loaded } = await getLocation(accessToken, params.id);
        if (!cancelled) setLocation(loaded);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setLoadError(err.message);
        else if (err instanceof Error) setLoadError(err.message);
        else setLoadError('Could not load location');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken, params.id]);

  const initialValues = useMemo<Partial<LocationFormValues> | undefined>(() => {
    if (!location) return undefined;
    return {
      name: location.name,
      slug: location.slug,
      timezone: location.timezone,
      phone: location.phone ?? '',
      email: location.email ?? '',
      addressLine1: location.addressLine1 ?? '',
      addressLine2: location.addressLine2 ?? '',
      city: location.city ?? '',
      region: location.region ?? '',
      postalCode: location.postalCode ?? '',
      countryCode: location.countryCode,
    };
  }, [location]);

  if (auth.status === 'authenticated' && !userHasPermission(auth.user, 'locations.manage')) {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleSubmit(values: LocationFormValues) {
    if (!accessToken || !location || !initialValues) return;
    setSubmitError(null);
    try {
      const patch = toUpdatePayload(values, {
        name: location.name,
        slug: location.slug,
        timezone: location.timezone,
        phone: location.phone ?? '',
        email: location.email ?? '',
        addressLine1: location.addressLine1 ?? '',
        addressLine2: location.addressLine2 ?? '',
        city: location.city ?? '',
        region: location.region ?? '',
        postalCode: location.postalCode ?? '',
        countryCode: location.countryCode,
      });

      if (Object.keys(patch).length === 0) {
        navigate(`/locations/${location.id}`, { replace: true });
        return;
      }

      const { location: updated } = await updateLocation(accessToken, location.id, patch);
      setLocation(updated);
      navigate(`/locations/${updated.id}`, { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setSubmitError(err.message);
      else if (err instanceof Error) setSubmitError(err.message);
      else setSubmitError('Could not update location. Please try again.');
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-8">
      <nav className="mb-4 text-[12px] text-text-secondary">
        <Link to="/locations" className="hover:text-text-primary">
          Locations
        </Link>
        <span className="mx-1.5">/</span>
        {location ? (
          <Link to={`/locations/${location.id}`} className="hover:text-text-primary">
            {location.name}
          </Link>
        ) : (
          <span>Loading…</span>
        )}
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">Edit</span>
      </nav>

      <header className="mb-6">
        <h1 className="text-[22px] font-semibold leading-7 text-text-primary">
          Edit location
        </h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          Update the basics for this salon. The slug is fixed in this phase to avoid breaking
          historic links.
        </p>
      </header>

      {loading ? (
        <div className="rounded-card-lg border border-border bg-surface px-5 py-8 text-center text-[13px] text-text-secondary">
          Loading location…
        </div>
      ) : loadError ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {loadError}
        </div>
      ) : location && initialValues ? (
        <LocationForm
          initialValues={initialValues}
          lockSlug
          submitLabel="Save changes"
          pendingLabel="Saving…"
          onSubmit={handleSubmit}
          onCancel={() => navigate(`/locations/${location.id}`)}
          externalError={submitError}
        />
      ) : null}
    </div>
  );
}
