import { useState } from 'react';
import { userHasPermission } from '@sheer/domain';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiRequestError, createLocation } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import {
  LocationForm,
  toCreatePayload,
  type LocationFormValues,
} from '../components/locations/LocationForm';

export function CreateLocationPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const accessToken = auth.session?.accessToken;
  const [error, setError] = useState<string | null>(null);

  if (auth.status === 'authenticated' && !userHasPermission(auth.user, 'locations.manage')) {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleSubmit(values: LocationFormValues) {
    if (!accessToken) return;
    setError(null);
    try {
      const payload = toCreatePayload(values);
      const { location } = await createLocation(accessToken, payload);
      navigate(`/locations/${location.id}`, { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not create location. Please try again.');
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-8">
      <nav className="mb-4 text-[12px] text-text-secondary">
        <Link to="/locations" className="hover:text-text-primary">
          Locations
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">New location</span>
      </nav>

      <header className="mb-6">
        <h1 className="text-[22px] font-semibold leading-7 text-text-primary">New location</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          A location is a physical salon that owns its own staff, calendar, and rota.
        </p>
      </header>

      <LocationForm
        submitLabel="Create location"
        pendingLabel="Creating…"
        onSubmit={handleSubmit}
        onCancel={() => navigate('/locations')}
        externalError={error}
      />
    </div>
  );
}
