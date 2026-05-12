import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  ClientBookingSelection,
  PublicBookingAvailabilitySlot,
  PublicBookingLocationSummary,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
} from '@sheer/domain';
import { cn } from '@sheer/utils';
import {
  ApiRequestError,
  getPublicBookingAvailability,
  getPublicBookingSelection,
  getPublicBookingStylists,
} from '../auth/api';
import { AppButton, AppCard } from '../design';
import { readClientBookingSelection, writeClientBookingSelection } from './clientBookingFlow';

type StylistChoice =
  | { mode: 'next_available' }
  | { mode: 'specific_staff'; staffProfileId: string };

export function ClientBookingServicePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const locationId = searchParams.get('locationId') ?? undefined;
  const businessSlug = searchParams.get('businessSlug') ?? undefined;
  const locationSlug = searchParams.get('locationSlug') ?? undefined;
  const initialSelection = readClientBookingSelection();

  const [location, setLocation] = useState<PublicBookingLocationSummary | null>(null);
  const [services, setServices] = useState<PublicBookingServiceSummary[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    initialSelection?.serviceId || null,
  );
  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [nextAvailableAt, setNextAvailableAt] = useState<string | undefined>();
  const [stylistChoice, setStylistChoice] = useState<StylistChoice | null>(
    initialSelection?.staffRequestMode === 'next_available'
        ? { mode: 'next_available' }
        : initialSelection?.staffProfileId
          ? { mode: 'specific_staff', staffProfileId: initialSelection.staffProfileId }
          : null,
  );
  const [loadingServices, setLoadingServices] = useState(true);
  const [loadingStylists, setLoadingStylists] = useState(false);
  const [resolvingNextAvailable, setResolvingNextAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedService = useMemo(
    () => services.find((service) => service.id === selectedServiceId) ?? null,
    [selectedServiceId, services],
  );

  const loadServices = useCallback(async () => {
    setLoadingServices(true);
    setError(null);
    try {
      const result = await getPublicBookingSelection({ locationId, businessSlug, locationSlug });
      setLocation(result.location);
      setServices(result.services);
      setSelectedServiceId((current) =>
        current && result.services.some((service) => service.id === current)
          ? current
          : result.services[0]?.id ?? null,
      );
    } catch (err) {
      setError(toErrorMessage(err, 'Could not load services'));
    } finally {
      setLoadingServices(false);
    }
  }, [businessSlug, locationId, locationSlug]);

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  useEffect(() => {
    if (!selectedServiceId) {
      setStylists([]);
      setNextAvailableAt(undefined);
      setStylistChoice(null);
      return;
    }

    const serviceId = selectedServiceId;
    let cancelled = false;
    async function loadStylists() {
      setLoadingStylists(true);
      setError(null);
      setStylistChoice(null);
      try {
        const result = await getPublicBookingStylists({
          locationId,
          businessSlug,
          locationSlug,
          serviceId,
        });
        if (cancelled) return;
        setStylists(result.stylists);
        setNextAvailableAt(result.nextAvailableAt);
      } catch (err) {
        if (!cancelled) setError(toErrorMessage(err, 'Could not load stylists'));
      } finally {
        if (!cancelled) setLoadingStylists(false);
      }
    }
    void loadStylists();
    return () => {
      cancelled = true;
    };
  }, [businessSlug, locationId, locationSlug, selectedServiceId]);

  function selectService(serviceId: string) {
    setSelectedServiceId(serviceId);
    setStylistChoice(null);
  }

  async function handleContinue() {
    if (!location || !selectedService || !stylistChoice) return;

    if (stylistChoice.mode === 'next_available') {
      await continueWithNextAvailable(location, selectedService);
      return;
    }

    const selection: ClientBookingSelection = {
      locationId: location.id,
      location,
      serviceId: selectedService.id,
      service: selectedService,
      staffRequestMode: stylistChoice.mode,
      staffProfileId: stylistChoice.staffProfileId,
      nextAvailableAt,
      selectedSlot: undefined,
      client: undefined,
      communicationPreference: undefined,
      account: undefined,
      appointment: undefined,
    };
    writeClientBookingSelection(selection);
    navigate('/book/date-time');
  }

  async function continueWithNextAvailable(
    currentLocation: PublicBookingLocationSummary,
    currentService: PublicBookingServiceSummary,
  ) {
    setResolvingNextAvailable(true);
    setError(null);
    try {
      const { dateFrom, dateTo } = nextAvailableSearchRange();
      const result = await getPublicBookingAvailability({
        locationId: currentLocation.id,
        serviceId: currentService.id,
        nextAvailable: true,
        dateFrom,
        dateTo,
      });
      const selectedSlot = earliestSlot(result.slots);
      if (!selectedSlot) {
        setError('No next available slot was found for this service. Try a specific stylist or another date.');
        return;
      }

      const selection: ClientBookingSelection = {
        locationId: currentLocation.id,
        location: currentLocation,
        serviceId: currentService.id,
        service: currentService,
        staffRequestMode: 'next_available',
        staffProfileId: selectedSlot.staffProfileId,
        nextAvailableAt: selectedSlot.startAt,
        selectedSlot,
        client: undefined,
        communicationPreference: undefined,
        account: undefined,
        appointment: undefined,
      };
      writeClientBookingSelection(selection);
      navigate('/login?booking=1');
    } catch (err) {
      setError(toErrorMessage(err, 'Could not resolve next available slot'));
    } finally {
      setResolvingNextAvailable(false);
    }
  }

  const canContinue = Boolean(
    selectedService &&
      stylistChoice &&
      !resolvingNextAvailable,
  );

  return (
    <div className="min-h-screen bg-[#f7f4ff] text-text-primary">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col bg-[#fbf9ff] shadow-hero sm:my-6 sm:min-h-[720px] sm:rounded-[28px] lg:min-h-[760px]">
        <header className="rounded-b-none bg-[#1C1628] px-4 pb-2 pt-3 text-white sm:rounded-t-[28px] lg:px-6">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-[13px] font-medium text-white/85"
            >
              Back
            </button>
            <div className="text-[13px] font-semibold">Choose a service</div>
            <div className="text-[11px] text-white/55">Step 2 of 6</div>
          </div>
          <div className="mt-3 h-1 rounded-full bg-white/12">
            <div className="h-1 w-1/3 rounded-full bg-primary" />
          </div>
        </header>

        <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="flex-1 px-4 pb-28 pt-5 lg:px-6 lg:pb-8 lg:pt-6">
          <section>
            <h1 className="text-[18px] font-semibold leading-6">What would you like?</h1>
            <p className="mt-1 text-[12px] text-text-secondary">
              {location ? location.name : 'Choose from available services'}
            </p>
          </section>

          {error ? (
            <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </div>
          ) : null}

          <section className="mt-5">
            {loadingServices ? (
              <LoadingCard label="Loading services..." />
            ) : services.length === 0 ? (
              <EmptyBlock
                title="No services available"
                body="This location does not have online-bookable services yet."
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {services.map((service) => (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    selected={service.id === selectedServiceId}
                    onSelect={() => selectService(service.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="mt-6">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Choose your stylist</div>
            {!selectedService ? (
              <EmptyBlock title="Select a service first" body="Stylists appear after a service is selected." />
            ) : loadingStylists ? (
              <LoadingCard label="Loading stylists..." />
            ) : stylists.length === 0 ? (
              <EmptyBlock
                title="No eligible stylists"
                body="There are no bookable stylists for this location right now."
              />
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {location?.allowNextAvailable ? (
                  <ChoiceCard
                    selected={stylistChoice?.mode === 'next_available'}
                    onSelect={() => setStylistChoice({ mode: 'next_available' })}
                    avatarLabel="NA"
                    title="Next available"
                    subtitle={
                      nextAvailableAt
                        ? `Earliest slot ${formatAvailability(nextAvailableAt)}`
                        : 'No rota-backed slot found yet'
                    }
                    accent={nextAvailableAt ? 'Best availability' : undefined}
                  />
                ) : null}

                {stylists.map((stylist) => (
                  <ChoiceCard
                    key={stylist.staffProfileId}
                    selected={
                      stylistChoice?.mode === 'specific_staff' &&
                      stylistChoice.staffProfileId === stylist.staffProfileId
                    }
                    onSelect={() =>
                      setStylistChoice({
                        mode: 'specific_staff',
                        staffProfileId: stylist.staffProfileId,
                      })
                    }
                    avatarLabel={initials(stylist.displayName)}
                    title={stylist.displayName}
                    subtitle={
                      stylist.nextAvailableAt
                        ? `Next available ${formatAvailability(stylist.nextAvailableAt)}`
                        : 'No rota-backed slot found yet'
                    }
                    accent={stylist.bio}
                    colorHex={stylist.colorHex}
                  />
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="hidden border-l border-border bg-surface/55 px-5 py-6 lg:block">
          <div className="sticky top-6 space-y-4">
            <ServiceSummary
              locationName={location?.name}
              serviceName={selectedService?.name}
              stylistLabel={selectedStylistLabel(stylistChoice, stylists)}
              nextAvailableAt={nextAvailableAt}
            />
            <AppButton
              size="lg"
              fullWidth
              disabled={!canContinue}
              loading={resolvingNextAvailable}
              onClick={() => void handleContinue()}
              className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
            >
              {stylistChoice?.mode === 'next_available' ? 'Find next available' : 'Continue'}
            </AppButton>
          </div>
        </aside>
        </div>

        <div className="sticky bottom-0 border-t border-border bg-[#fbf9ff]/95 px-4 py-4 backdrop-blur sm:rounded-b-[28px] lg:hidden">
          <AppButton
            size="lg"
            fullWidth
            disabled={!canContinue}
            loading={resolvingNextAvailable}
            onClick={() => void handleContinue()}
            className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
          >
            {stylistChoice?.mode === 'next_available' ? 'Find next available' : 'Continue'}
          </AppButton>
        </div>
      </div>
    </div>
  );
}

function ServiceCard({
  service,
  selected,
  onSelect,
}: {
  service: PublicBookingServiceSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" onClick={onSelect} className="text-left">
      <AppCard
        padding="sm"
        elevation="none"
        className={cn(
          'min-h-[112px] border-[1.5px] transition-colors',
          selected ? 'border-primary bg-primary/8' : 'border-border bg-surface',
        )}
      >
        <div className="text-[22px]" aria-hidden>
          {service.category ? service.category.slice(0, 1).toUpperCase() : 'S'}
        </div>
        <div className="mt-3 text-[14px] font-semibold">{service.name}</div>
        <div className="mt-1 text-[11px] text-text-secondary">
          {formatDuration(service.estimatedDurationMinutes)}
        </div>
        <div className="mt-1 text-[12px] font-medium text-primary">
          {formatPrice(service.startingPriceAmount, service.currencyCode)}
        </div>
      </AppCard>
    </button>
  );
}

function ChoiceCard({
  selected,
  onSelect,
  avatarLabel,
  title,
  subtitle,
  accent,
  colorHex,
}: {
  selected: boolean;
  onSelect: () => void;
  avatarLabel: string;
  title: string;
  subtitle: string;
  accent?: string;
  colorHex?: string;
}) {
  return (
    <button type="button" onClick={onSelect} className="block w-full text-left">
      <AppCard
        padding="sm"
        elevation="none"
        className={cn(
          'flex items-center gap-3 border-[1.5px] transition-colors',
          selected ? 'border-primary bg-primary/5' : 'border-border bg-surface',
        )}
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
          style={{ backgroundColor: colorHex || '#A67CF5' }}
        >
          {avatarLabel}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{title}</div>
          <div className="truncate text-[11px] text-text-secondary">{subtitle}</div>
          {accent ? <div className="mt-0.5 truncate text-[11px] text-primary">{accent}</div> : null}
        </div>
      </AppCard>
    </button>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <AppCard elevation="none" className="border-border bg-surface text-center text-[13px] text-text-secondary">
      {label}
    </AppCard>
  );
}

function EmptyBlock({ title, body }: { title: string; body: string }) {
  return (
    <AppCard elevation="none" className="border-dashed text-center">
      <div className="text-[14px] font-semibold">{title}</div>
      <div className="mt-1 text-[12px] text-text-secondary">{body}</div>
    </AppCard>
  );
}

function ServiceSummary({
  locationName,
  serviceName,
  stylistLabel,
  nextAvailableAt,
}: {
  locationName?: string;
  serviceName?: string;
  stylistLabel?: string;
  nextAvailableAt?: string;
}) {
  const rows = [
    ['Location', locationName],
    ['Service', serviceName],
    ['Stylist', stylistLabel],
    ['Earliest', nextAvailableAt ? formatAvailability(nextAvailableAt) : undefined],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <AppCard elevation="none" className="border-border bg-white/75">
      <div className="text-[13px] font-semibold">Booking summary</div>
      {rows.length > 0 ? (
        <div className="mt-3 space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="border-b border-border pb-2 last:border-0 last:pb-0">
              <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
              <div className="mt-0.5 text-[12px] font-medium">{value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-text-secondary">
          Select a service and stylist to continue.
        </div>
      )}
    </AppCard>
  );
}

function selectedStylistLabel(
  choice: StylistChoice | null,
  stylists: PublicBookingStylistSummary[],
): string | undefined {
  if (!choice) return undefined;
  if (choice.mode === 'next_available') return 'Next available';
  return stylists.find((stylist) => stylist.staffProfileId === choice.staffProfileId)?.displayName;
}

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function nextAvailableSearchRange(): { dateFrom: string; dateTo: string } {
  const dateFrom = new Date();
  const dateTo = new Date(dateFrom);
  dateTo.setDate(dateTo.getDate() + 60);
  return {
    dateFrom: toIsoDate(dateFrom),
    dateTo: toIsoDate(dateTo),
  };
}

function earliestSlot(slots: PublicBookingAvailabilitySlot[]): PublicBookingAvailabilitySlot | undefined {
  return [...slots].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())[0];
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function formatPrice(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

function formatAvailability(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
