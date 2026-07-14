import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  ClientBookingSelection,
  PublicBookingAvailabilitySlot,
  PublicBookingFinishingRequirement,
  PublicBookingLocationSummary,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  PublicBookingUpgradeSuggestion,
} from '@sheer/domain';
import { applyStylistServicePrices } from '@sheer/domain';
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
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>(
    initialSelection?.serviceIds ?? [],
  );
  const [finishingRequirements, setFinishingRequirements] = useState<PublicBookingFinishingRequirement[]>([]);
  const [upgradeSuggestions, setUpgradeSuggestions] = useState<PublicBookingUpgradeSuggestion[]>([]);
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

  const selectedServices = useMemo(
    () => selectedServiceIds.map((id) => services.find((service) => service.id === id)).filter((service): service is PublicBookingServiceSummary => Boolean(service)),
    [selectedServiceIds, services],
  );
  // The specific stylist the user picked (if any). "Next available" / no choice has no per-stylist prices.
  const selectedStylist = useMemo<PublicBookingStylistSummary | null>(
    () =>
      stylistChoice?.mode === 'specific_staff'
        ? stylists.find((stylist) => stylist.staffProfileId === stylistChoice.staffProfileId) ?? null
        : null,
    [stylistChoice, stylists],
  );
  // When a specific stylist is selected, every displayed price + total uses THAT stylist's per-service
  // price; otherwise (any-available / next-available / nothing picked) base prices are kept.
  const pricedSelectedServices = useMemo(
    () => applyStylistServicePrices(selectedServices, selectedStylist?.servicePrices),
    [selectedServices, selectedStylist],
  );
  // Per-service-id effective price (selected stylist's price when one is chosen, base price otherwise),
  // used to render each service card's price including unselected cards.
  const pricedServices = useMemo(
    () => applyStylistServicePrices(services, selectedStylist?.servicePrices),
    [services, selectedStylist],
  );
  const priceByServiceId = useMemo(
    () => new Map(pricedServices.map((service) => [service.id, service.startingPriceAmount])),
    [pricedServices],
  );
  const selectedServiceIdSet = useMemo(() => new Set(selectedServiceIds), [selectedServiceIds]);
  // Group the catalogue under category headers, ordered by the salon-configured
  // category order; services keep their (sort_order) order within each category.
  const groupedServices = useMemo(() => groupServicesByCategory(services), [services]);
  const totalDurationMinutes = selectedServices.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0);
  // Estimated total uses the selected stylist's prices when one is chosen, base prices otherwise.
  const totalPriceAmount = pricedSelectedServices.reduce((sum, service) => sum + service.startingPriceAmount, 0);
  const applicableRequirements = useMemo(
    () => finishingRequirements.filter((rule) => selectedServiceIdSet.has(rule.triggerServiceId)),
    [finishingRequirements, selectedServiceIdSet],
  );
  const unmetRequirements = useMemo(
    () =>
      applicableRequirements.filter(
        (rule) => !rule.requiredServiceIds.some((serviceId) => selectedServiceIdSet.has(serviceId)),
      ),
    [applicableRequirements, selectedServiceIdSet],
  );
  const applicableUpgrades = useMemo(
    () =>
      upgradeSuggestions.filter(
        (suggestion) =>
          selectedServiceIdSet.has(suggestion.triggerServiceId) &&
          !selectedServiceIdSet.has(suggestion.suggestedServiceId),
      ),
    [selectedServiceIdSet, upgradeSuggestions],
  );

  const loadServices = useCallback(async () => {
    setLoadingServices(true);
    setError(null);
    try {
      const result = await getPublicBookingSelection({ locationId, businessSlug, locationSlug });
      setLocation(result.location);
      setServices(result.services);
      setFinishingRequirements(result.finishingRequirements);
      setUpgradeSuggestions(result.upgradeSuggestions);
      setSelectedServiceIds((current) =>
        current.filter((serviceId) => result.services.some((service) => service.id === serviceId)),
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
    if (selectedServiceIds.length === 0 || unmetRequirements.length > 0) {
      setStylists([]);
      setNextAvailableAt(undefined);
      setStylistChoice(null);
      return;
    }

    const serviceIds = selectedServiceIds;
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
          serviceIds,
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
  }, [businessSlug, locationId, locationSlug, selectedServiceIds, unmetRequirements.length]);

  function selectService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId],
    );
    setStylistChoice(null);
  }

  function addService(serviceId: string) {
    setSelectedServiceIds((current) => (current.includes(serviceId) ? current : [...current, serviceId]));
    setStylistChoice(null);
  }

  async function handleContinue() {
    if (!location || selectedServices.length === 0 || unmetRequirements.length > 0 || !stylistChoice) return;

    if (stylistChoice.mode === 'next_available') {
      await continueWithNextAvailable(location, selectedServices);
      return;
    }

    const selection: ClientBookingSelection = {
      locationId: location.id,
      location,
      serviceIds: selectedServices.map((service) => service.id),
      // Persist the selected stylist's per-service prices so downstream steps (review) show the stylist's total.
      services: pricedSelectedServices,
      finishingRequirements,
      upgradeSuggestions,
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
    currentServices: PublicBookingServiceSummary[],
  ) {
    setResolvingNextAvailable(true);
    setError(null);
    try {
      const { dateFrom, dateTo } = nextAvailableSearchRange();
      const result = await getPublicBookingAvailability({
        locationId: currentLocation.id,
        serviceIds: currentServices.map((service) => service.id),
        nextAvailable: true,
        dateFrom,
        dateTo,
      });
      const selectedSlot = earliestSlot(result.slots);
      if (!selectedSlot) {
        setError('No next available slot was found for this service. Try a specific stylist or another date.');
        return;
      }

      // Re-price to the stylist actually resolved for this slot so the review
      // total + deposit match what the server will charge (next-available skips
      // the date-time page, so this is the only place to apply it).
      const resolvedStylist = result.stylists?.find(
        (stylist) => stylist.staffProfileId === selectedSlot.staffProfileId,
      );
      const pricedServices = applyStylistServicePrices(currentServices, resolvedStylist?.servicePrices);

      const selection: ClientBookingSelection = {
        locationId: currentLocation.id,
        location: currentLocation,
        serviceIds: currentServices.map((service) => service.id),
        services: pricedServices,
        finishingRequirements,
        upgradeSuggestions,
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
    selectedServices.length > 0 &&
      unmetRequirements.length === 0 &&
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
              <div className="space-y-5">
                {groupedServices.map((group) => {
                  // Hide the header only when the whole catalogue is uncategorised.
                  const showHeader = groupedServices.length > 1 || group.key !== UNCATEGORISED_KEY;
                  return (
                    <div key={group.key}>
                      {showHeader ? (
                        <div className="mb-2 flex items-center gap-2">
                          {group.colorHex ? (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: group.colorHex }}
                              aria-hidden
                            />
                          ) : null}
                          <h3 className="text-[13px] font-semibold text-text-primary">{group.name}</h3>
                        </div>
                      ) : null}
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                        {group.services.map((service) => (
                          <ServiceCard
                            key={service.id}
                            service={service}
                            // Display the selected stylist's per-service price when one is chosen; base price otherwise.
                            priceAmount={priceByServiceId.get(service.id) ?? service.startingPriceAmount}
                            selected={selectedServiceIdSet.has(service.id)}
                            onSelect={() => selectService(service.id)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="mt-6">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Finishing and upgrades</div>
            {unmetRequirements.length > 0 ? (
              <div className="space-y-3">
                {unmetRequirements.map((rule) => (
                  <AppCard key={rule.id} elevation="none" className="border-primary/30 bg-primary/5">
                    <div className="text-[13px] font-semibold">{rule.title}</div>
                    <p className="mt-1 text-[12px] text-text-secondary">
                      {rule.description ?? 'Choose one finishing service to continue.'}
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {rule.requiredServices.map((service) => (
                        <button
                          key={service.id}
                          type="button"
                          onClick={() => addService(service.id)}
                          className="rounded-input-lg border border-border bg-surface px-3 py-2 text-left text-[12px] font-medium text-text-primary"
                        >
                          Add {service.name}
                        </button>
                      ))}
                    </div>
                  </AppCard>
                ))}
              </div>
            ) : applicableUpgrades.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">
                {applicableUpgrades.map((suggestion) => (
                  <AppCard key={suggestion.id} elevation="none" className="border-border bg-surface">
                    <div className="text-[13px] font-semibold">{suggestion.title}</div>
                    <p className="mt-1 text-[12px] text-text-secondary">{suggestion.description}</p>
                    <button
                      type="button"
                      onClick={() => addService(suggestion.suggestedServiceId)}
                      className="mt-3 rounded-pill bg-primary px-3 py-1.5 text-[12px] font-semibold text-text-on-primary"
                    >
                      Add {suggestion.service.name}
                    </button>
                  </AppCard>
                ))}
              </div>
            ) : (
              <AppCard elevation="none" className="border-dashed text-center text-[12px] text-text-secondary">
                Select services to see relevant finishing requirements and optional upgrades.
              </AppCard>
            )}
          </section>

          <section className="mt-6">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">Choose your stylist</div>
            {selectedServices.length === 0 ? (
              <EmptyBlock title="Select at least one service first" body="Stylists appear after services are selected." />
            ) : unmetRequirements.length > 0 ? (
              <EmptyBlock title="Finishing service required" body="Add one of the required finishing services before choosing a stylist." />
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
                    photoUrl={stylist.photoUrl}
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
              serviceNames={selectedServices.map((service) => service.name)}
              totalDurationMinutes={totalDurationMinutes}
              totalPriceAmount={totalPriceAmount}
              currencyCode={location?.currencyCode}
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

const UNCATEGORISED_KEY = '__uncategorised';

interface ServiceGroup {
  key: string;
  name: string;
  colorHex?: string;
  sortOrder: number;
  services: PublicBookingServiceSummary[];
}

// Buckets services under their category, ordered by the salon-configured category
// order (uncategorised last). Service order within a category is preserved from
// the API (service sort_order), so the configured sequence is respected.
function groupServicesByCategory(services: PublicBookingServiceSummary[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  for (const service of services) {
    const key = service.serviceCategoryId ?? UNCATEGORISED_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: service.category ?? 'Other',
        colorHex: service.categoryColorHex,
        sortOrder: service.categorySortOrder ?? Number.MAX_SAFE_INTEGER,
        services: [],
      };
      groups.set(key, group);
    }
    group.services.push(service);
  }
  return Array.from(groups.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

function ServiceCard({
  service,
  priceAmount,
  selected,
  onSelect,
}: {
  service: PublicBookingServiceSummary;
  priceAmount: number;
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
          {/* Uses the selected stylist's per-service price when one is chosen; base price otherwise. */}
          {formatPrice(priceAmount, service.currencyCode)}
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
  photoUrl,
}: {
  selected: boolean;
  onSelect: () => void;
  avatarLabel: string;
  title: string;
  subtitle: string;
  accent?: string;
  colorHex?: string;
  photoUrl?: string;
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
        {photoUrl ? (
          <img
            src={photoUrl}
            alt={title}
            className="h-9 w-9 shrink-0 rounded-full object-cover"
            loading="lazy"
          />
        ) : (
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
            style={{ backgroundColor: colorHex || '#A67CF5' }}
          >
            {avatarLabel}
          </div>
        )}
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
  serviceNames,
  totalDurationMinutes,
  totalPriceAmount,
  currencyCode,
  stylistLabel,
  nextAvailableAt,
}: {
  locationName?: string;
  serviceNames: string[];
  totalDurationMinutes: number;
  totalPriceAmount: number;
  currencyCode?: string;
  stylistLabel?: string;
  nextAvailableAt?: string;
}) {
  const rows = [
    ['Location', locationName],
    ['Services', serviceNames.length > 0 ? serviceNames.join(', ') : undefined],
    ['Duration', totalDurationMinutes > 0 ? formatDuration(totalDurationMinutes) : undefined],
    [
      'Estimated total',
      currencyCode && totalPriceAmount > 0 ? formatPrice(totalPriceAmount, currencyCode) : undefined,
    ],
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
