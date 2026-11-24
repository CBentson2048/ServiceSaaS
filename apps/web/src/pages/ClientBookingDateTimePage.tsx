import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { PublicBookingAvailabilitySlot, PublicBookingStylistSummary } from '@sheer/domain';
import { applyStylistServicePrices } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { ApiRequestError, getPublicBookingAvailability } from '../auth/api';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import {
  readClientBookingSelection,
  updateClientBookingSelection,
} from './clientBookingFlow';

export function ClientBookingDateTimePage() {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  const [dateFrom, setDateFrom] = useState(() => toDateInput(new Date()));
  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  // Per-stylist pricing for the bookable stylists, so the picked slot's stylist
  // re-prices the services to match what the server will charge.
  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<PublicBookingAvailabilitySlot | null>(
    selection?.selectedSlot ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locationId = selection?.locationId;
  const serviceIds = selection?.serviceIds ?? [];
  const serviceIdsKey = serviceIds.join(',');
  const staffRequestMode = selection?.staffRequestMode;
  const staffProfileId = selection?.staffProfileId;

  useEffect(() => {
    if (!locationId || serviceIds.length === 0) return;
    const currentLocationId = locationId;
    const currentServiceIds = serviceIdsKey.split(',').filter(Boolean);
    const { dateFromIso, dateToIso } = selectedDayRange(dateFrom);
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await getPublicBookingAvailability({
          locationId: currentLocationId,
          serviceIds: currentServiceIds,
          stylistId:
            staffRequestMode === 'specific_staff'
              ? staffProfileId
              : undefined,
          nextAvailable: staffRequestMode === 'next_available',
          dateFrom: dateFromIso,
          dateTo: dateToIso,
        });
        if (cancelled) return;
        setSlots(result.slots);
        setStylists(result.stylists ?? []);
        setSelectedSlot((current) =>
          current && result.slots.some((slot) => sameSlot(slot, current)) ? current : null,
        );
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
  }, [dateFrom, locationId, serviceIdsKey, staffProfileId, staffRequestMode]);

  if (!selection?.locationId || serviceIds.length === 0) return <Navigate to="/book/location" replace />;

  function continueNext() {
    if (!selectedSlot || !selection) return;
    // Re-price the services to the stylist actually resolved for this slot so the
    // review total + deposit match what the server will charge. No-op when that
    // stylist has no per-service overrides.
    const resolved = stylists.find((stylist) => stylist.staffProfileId === selectedSlot.staffProfileId);
    updateClientBookingSelection({
      selectedSlot,
      staffProfileId: selectedSlot.staffProfileId,
      services: applyStylistServicePrices(selection.services ?? [], resolved?.servicePrices),
    });
    navigate('/login?booking=1');
  }

  return (
    <ClientBookingShell
      title="Choose a time"
      step="Step 3 of 6"
      footer={
        <AppButton
          size="lg"
          fullWidth
          disabled={!selectedSlot}
          onClick={continueNext}
          className="min-h-12"
        >
          Continue
        </AppButton>
      }
    >
      <h1 className="text-[18px] font-semibold leading-6">Pick a date and time</h1>
      <p className="mt-1 text-[12px] text-text-secondary">
        Only real rota-backed slots are shown.
      </p>
      <input
        type="date"
        value={dateFrom}
        onChange={(event) => {
          setDateFrom(event.target.value);
          setSelectedSlot(null);
        }}
        className="mt-4 h-11 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
      />
      {error ? <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div> : null}
      {loading ? <AppCard className="mt-4 text-center text-[13px] text-text-secondary">Loading availability...</AppCard> : null}
      {!loading && slots.length === 0 ? (
        <AppCard className="mt-4 border-dashed text-center">
          <div className="text-[14px] font-semibold">No slots available</div>
          <div className="mt-1 text-[12px] text-text-secondary">Try a different day or stylist.</div>
        </AppCard>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
        {slots.map((slot) => (
          <button key={`${slot.staffProfileId}-${slot.startAt}`} type="button" onClick={() => setSelectedSlot(slot)} className="text-left">
            <AppCard
              elevation="none"
              padding="sm"
              className={cn(
                'border-[1.5px]',
                selectedSlot?.startAt === slot.startAt && selectedSlot.staffProfileId === slot.staffProfileId
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-surface',
              )}
            >
              <div className="text-[13px] font-semibold">{formatTime(slot.startAt)}</div>
              <div className="mt-1 text-[11px] text-text-secondary">{formatDate(slot.startAt)}</div>
              <div className="mt-1 truncate text-[11px] text-primary">{slot.stylistName}</div>
            </AppCard>
          </button>
        ))}
      </div>
    </ClientBookingShell>
  );
}

function sameSlot(a: PublicBookingAvailabilitySlot, b: PublicBookingAvailabilitySlot): boolean {
  return a.startAt === b.startAt && a.staffProfileId === b.staffProfileId;
}

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function selectedDayRange(date: string): { dateFromIso: string; dateToIso: string } {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    dateFromIso: start.toISOString(),
    dateToIso: end.toISOString(),
  };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function toErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Could not load availability';
}
