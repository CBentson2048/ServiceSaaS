import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  PublicBookingLocationSummary,
  PublicBookingServiceSelectionResponse,
} from '@sheer/domain';
import {
  ApiRequestError,
  getPublicBookingSelection,
  listPublicBookingLocations,
} from '../auth/api';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import { writeClientBookingSelection } from './clientBookingFlow';

export function ClientBookingLocationPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const locationId = searchParams.get('locationId') ?? undefined;
  const businessSlug = searchParams.get('businessSlug') ?? undefined;
  const locationSlug = searchParams.get('locationSlug') ?? undefined;
  const [data, setData] = useState<PublicBookingServiceSelectionResponse | null>(null);
  const [locations, setLocations] = useState<PublicBookingLocationSummary[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<PublicBookingLocationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (locationId || (businessSlug && locationSlug)) {
          const result = await getPublicBookingSelection({ locationId, businessSlug, locationSlug });
          if (cancelled) return;
          setData(result);
          setSelectedLocation(result.location);
          writeInitialSelection(result.location);
        } else {
          const result = await listPublicBookingLocations();
          if (cancelled) return;
          setLocations(result.locations);
          if (result.locations.length === 1) {
            setSelectedLocation(result.locations[0]);
            writeInitialSelection(result.locations[0]);
            navigate(`/book/service?locationId=${encodeURIComponent(result.locations[0].id)}`, {
              replace: true,
            });
          }
        }
      } catch (err) {
        if (!cancelled) setError(toErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [businessSlug, locationId, locationSlug, navigate]);

  function chooseLocation(location: PublicBookingLocationSummary) {
    setSelectedLocation(location);
    writeInitialSelection(location);
  }

  function continueNext() {
    const id = selectedLocation?.id ?? data?.location.id;
    if (!id) return;
    navigate(`/book/service?locationId=${encodeURIComponent(id)}`);
  }

  return (
    <ClientBookingShell
      title="Choose a location"
      step="Step 1 of 5"
      footer={
        <AppButton
          size="lg"
          fullWidth
          disabled={!selectedLocation && !data}
          onClick={continueNext}
          className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
        >
          Continue
        </AppButton>
      }
    >
      <h1 className="text-[18px] font-semibold leading-6">Where would you like to book?</h1>
      <p className="mt-1 text-[12px] text-text-secondary">
        Select your salon location to see real services and availability.
      </p>
      {loading ? <InfoCard text="Loading location..." /> : null}
      {error ? <ErrorCard text={error} /> : null}
      {!loading && !error && locations.length === 0 && !data ? (
        <InfoCard text="No online-bookable locations are available yet." />
      ) : null}
      {data ? (
        <AppCard elevation="none" className="mt-5 border-primary bg-primary/5">
          <div className="text-[14px] font-semibold">{data.location.name}</div>
          <div className="mt-1 text-[12px] text-text-secondary">
            {data.services.length} online-bookable service{data.services.length === 1 ? '' : 's'}
          </div>
        </AppCard>
      ) : null}
      {locations.length > 0 ? (
        <div className="mt-5 grid gap-2 md:grid-cols-2">
          {locations.map((location) => (
            <button
              key={location.id}
              type="button"
              onClick={() => chooseLocation(location)}
              className="block w-full text-left"
            >
              <AppCard
                elevation="none"
                className={
                  selectedLocation?.id === location.id
                    ? 'border-[1.5px] border-primary bg-primary/5'
                    : 'border-[1.5px] border-border bg-surface'
                }
              >
                <div className="text-[14px] font-semibold">{location.name}</div>
                <div className="mt-1 text-[12px] text-text-secondary">
                  Online booking available
                </div>
              </AppCard>
            </button>
          ))}
        </div>
      ) : null}
    </ClientBookingShell>
  );
}

function writeInitialSelection(location: PublicBookingLocationSummary) {
  writeClientBookingSelection({
    locationId: location.id,
    location,
    serviceId: '',
    service: undefined,
    staffRequestMode: 'next_available',
  });
}

function InfoCard({ text }: { text: string }) {
  return <AppCard className="mt-5 text-center text-[13px] text-text-secondary">{text}</AppCard>;
}

function ErrorCard({ text }: { text: string }) {
  return <div className="mt-5 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">{text}</div>;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Could not load location';
}
