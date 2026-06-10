import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type {
  CreateStaffBookingResponse,
  CrmClientSummary,
  PublicBookingAvailabilitySlot,
  PublicBookingServiceSelectionResponse,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  StaffBookingPaymentMode,
  StaffBookingSource,
} from '@sheer/domain';
import {
  ApiRequestError,
  createStaffBooking,
  createStaffBookingClient,
  getStaffBookingAvailability,
  getStaffBookingSelection,
  getStaffBookingStylists,
  searchStaffBookingClients,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';

type CommPreference = 'whatsapp' | 'sms' | 'email';
const ANY_STYLIST = 'any';

const BOOKING_SOURCES: Array<{ value: StaffBookingSource; label: string }> = [
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'phone_booking', label: 'Phone booking' },
  { value: 'staff_booking', label: 'Manual / staff' },
];

const PAYMENT_MODES: Array<{ value: StaffBookingPaymentMode; label: string }> = [
  { value: 'pay_in_salon', label: 'Pay in salon' },
  { value: 'deposit_waived', label: 'Deposit waived' },
  { value: 'deposit_due', label: 'Deposit due (collect later)' },
  { value: 'paid_in_full', label: 'Paid in full' },
  { value: 'no_deposit', label: 'No deposit' },
];

interface NewClientForm {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  communicationPreference: CommPreference;
}

const emptyNewClient: NewClientForm = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  communicationPreference: 'whatsapp',
};

export function NewBookingPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const { locations, resolvedLocationId } = useLocationScope();

  // Deep-link prefill from the Appointment Book ("Add appointment" on a slot):
  // ?staffProfileId&staffName&startAt&locationId. Stylist + date are applied
  // immediately; the matching time slot is auto-selected once services are chosen.
  const [searchParams] = useSearchParams();
  const prefill = useMemo(() => {
    const startAt = searchParams.get('startAt') ?? undefined;
    const parsedStart = startAt ? new Date(startAt) : undefined;
    const validStart = parsedStart && !Number.isNaN(parsedStart.getTime()) ? parsedStart : undefined;
    return {
      staffProfileId: searchParams.get('staffProfileId') ?? undefined,
      staffName: searchParams.get('staffName') ?? undefined,
      locationId: searchParams.get('locationId') ?? undefined,
      date: validStart ? toLocalIsoDate(validStart) : undefined,
      time: validStart ? toLocalHm(validStart) : undefined,
    };
  }, [searchParams]);
  const prefillStylistApplied = useRef(false);
  const prefillSlotApplied = useRef(false);

  const [locationId, setLocationId] = useState<string>(prefill.locationId ?? resolvedLocationId);

  // Client selection
  const [clientQuery, setClientQuery] = useState('');
  const [clientResults, setClientResults] = useState<CrmClientSummary[]>([]);
  const [searchingClients, setSearchingClients] = useState(false);
  const [selectedClient, setSelectedClient] = useState<CrmClientSummary | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClient, setNewClient] = useState<NewClientForm>(emptyNewClient);
  const [creatingClient, setCreatingClient] = useState(false);

  // Services
  const [selection, setSelection] = useState<PublicBookingServiceSelectionResponse | null>(null);
  const [loadingSelection, setLoadingSelection] = useState(false);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);

  // Stylist
  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [stylistChoice, setStylistChoice] = useState<string>(ANY_STYLIST);

  // Date + time
  const [date, setDate] = useState<string>(() => prefill.date ?? todayIso());
  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<PublicBookingAvailabilitySlot | null>(null);

  // Booking details
  const [bookingSource, setBookingSource] = useState<StaffBookingSource>('walk_in');
  const [paymentMode, setPaymentMode] = useState<StaffBookingPaymentMode>('pay_in_salon');
  const [communicationPreference, setCommunicationPreference] = useState<CommPreference>('whatsapp');
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [clientNote, setClientNote] = useState('');
  const [internalNote, setInternalNote] = useState('');

  // Submit
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateStaffBookingResponse | null>(null);

  const currencyCode = selection?.location.currencyCode ?? 'GBP';

  const selectedServices = useMemo(
    () => (selection?.services ?? []).filter((service) => selectedServiceIds.includes(service.id)),
    [selection, selectedServiceIds],
  );
  const totalDurationMinutes = useMemo(
    () => selectedServices.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0),
    [selectedServices],
  );
  const totalPriceAmount = useMemo(
    () => selectedServices.reduce((sum, service) => sum + service.startingPriceAmount, 0),
    [selectedServices],
  );
  const totalDepositAmount = useMemo(
    () => selectedServices.reduce((sum, service) => sum + service.depositRequiredAmount, 0),
    [selectedServices],
  );

  // --- Load services whenever the location changes ---
  const loadSelection = useCallback(async () => {
    if (!accessToken || !locationId) return;
    setLoadingSelection(true);
    setError(null);
    try {
      const result = await getStaffBookingSelection(accessToken, { locationId });
      setSelection(result);
    } catch (err) {
      setError(messageFrom(err, 'Could not load services for this location'));
      setSelection(null);
    } finally {
      setLoadingSelection(false);
    }
  }, [accessToken, locationId]);

  useEffect(() => {
    setSelectedServiceIds([]);
    setStylists([]);
    setStylistChoice(ANY_STYLIST);
    setSlots([]);
    setSelectedSlot(null);
    void loadSelection();
  }, [loadSelection]);

  // --- Debounced client search ---
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!accessToken) return;
    const term = clientQuery.trim();
    if (term.length < 2) {
      setClientResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearchingClients(true);
      try {
        const result = await searchStaffBookingClients(accessToken, { q: term, locationId });
        setClientResults(result.clients);
      } catch (err) {
        setError(messageFrom(err, 'Client search failed'));
      } finally {
        setSearchingClients(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [accessToken, clientQuery, locationId]);

  // --- Load stylists when the service set changes ---
  useEffect(() => {
    if (!accessToken || !locationId || selectedServiceIds.length === 0) {
      setStylists([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await getStaffBookingStylists(accessToken, {
          locationId,
          serviceIds: selectedServiceIds,
        });
        if (cancelled) return;
        setStylists(result.stylists);
        // Lock the booking to the stylist whose column was clicked (once).
        if (
          !prefillStylistApplied.current &&
          prefill.staffProfileId &&
          result.stylists.some((stylist) => stylist.staffProfileId === prefill.staffProfileId)
        ) {
          prefillStylistApplied.current = true;
          setStylistChoice(prefill.staffProfileId);
        }
      } catch (err) {
        if (!cancelled) setError(messageFrom(err, 'Could not load stylists'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, locationId, selectedServiceIds]);

  // --- Load availability when services / stylist / date change ---
  useEffect(() => {
    setSelectedSlot(null);
    if (!accessToken || !locationId || selectedServiceIds.length === 0 || !date) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    void (async () => {
      try {
        const result = await getStaffBookingAvailability(accessToken, {
          locationId,
          serviceIds: selectedServiceIds,
          stylistId: stylistChoice === ANY_STYLIST ? undefined : stylistChoice,
          dateFrom: `${date}T00:00:00.000Z`,
          dateTo: `${date}T23:59:59.999Z`,
        });
        if (cancelled) return;
        setSlots(result.slots);
        // Auto-select the clicked time once, but only when the prefilled stylist
        // is the active one (so we pick that stylist's slot, not another's).
        if (
          !prefillSlotApplied.current &&
          prefill.time &&
          (!prefill.staffProfileId || stylistChoice === prefill.staffProfileId)
        ) {
          const match = result.slots.find((slot) => toLocalHm(new Date(slot.startAt)) === prefill.time);
          if (match) {
            prefillSlotApplied.current = true;
            setSelectedSlot(match);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageFrom(err, 'Could not load availability'));
          setSlots([]);
        }
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, locationId, selectedServiceIds, stylistChoice, date]);

  if (
    auth.status === 'authenticated' &&
    auth.user?.role !== 'owner' &&
    auth.user?.role !== 'manager'
  ) {
    return <Navigate to="/unauthorized" replace />;
  }

  function selectClient(client: CrmClientSummary) {
    setSelectedClient(client);
    setClientResults([]);
    setClientQuery('');
    setShowNewClient(false);
    if (client.communicationPreference === 'sms' || client.communicationPreference === 'email') {
      setCommunicationPreference(client.communicationPreference);
    } else if (client.communicationPreference === 'whatsapp') {
      setCommunicationPreference('whatsapp');
    }
  }

  function toggleService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId)
        ? current.filter((id) => id !== serviceId)
        : [...current, serviceId],
    );
  }

  async function handleCreateClient(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    if (!newClient.firstName.trim() || !newClient.lastName.trim()) {
      setError('Client first and last name are required');
      return;
    }
    setCreatingClient(true);
    setError(null);
    try {
      const { client } = await createStaffBookingClient(accessToken, {
        firstName: newClient.firstName.trim(),
        lastName: newClient.lastName.trim(),
        phone: newClient.phone.trim() || undefined,
        email: newClient.email.trim() || undefined,
        primaryLocationId: locationId,
        communicationPreference: newClient.communicationPreference,
        source: 'staff_booking',
      });
      selectClient(client);
      setNewClient(emptyNewClient);
    } catch (err) {
      setError(messageFrom(err, 'Could not create client'));
    } finally {
      setCreatingClient(false);
    }
  }

  async function handleSubmit() {
    if (!accessToken || !selectedClient || !selectedSlot || selectedServiceIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createStaffBooking(accessToken, {
        locationId,
        serviceIds: selectedServiceIds,
        staffProfileId: selectedSlot.staffProfileId,
        selectedStartAt: selectedSlot.startAt,
        // We always resolve a concrete stylist + slot in this flow, so the
        // booking is recorded against a specific staff member.
        staffRequestMode: 'specific_staff',
        clientProfileId: selectedClient.id,
        communicationPreference,
        bookingSource,
        paymentMode,
        clientNote: clientNote.trim() || undefined,
        internalNote: internalNote.trim() || undefined,
        sendConfirmation,
      });
      setCreated(result);
    } catch (err) {
      setError(messageFrom(err, 'Could not create the booking'));
    } finally {
      setSubmitting(false);
    }
  }

  function resetForAnother() {
    setCreated(null);
    setSelectedClient(null);
    setSelectedServiceIds([]);
    setStylistChoice(ANY_STYLIST);
    setSlots([]);
    setSelectedSlot(null);
    setClientNote('');
    setInternalNote('');
    setBookingSource('walk_in');
    setPaymentMode('pay_in_salon');
    setSendConfirmation(true);
    setError(null);
  }

  const canSubmit =
    Boolean(selectedClient) && selectedServiceIds.length > 0 && Boolean(selectedSlot) && !submitting;

  if (created) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-8">
        <div className="rounded-card-lg border border-success-border bg-success-soft p-6">
          <h1 className="text-[20px] font-semibold text-text-primary">Appointment booked</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            {created.appointment.clientDisplayName} · {created.appointment.serviceNames.join(', ')}
          </p>
          <dl className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2">
            <SummaryRow label="When" value={formatDateTime(created.appointment.scheduledStartAt)} />
            <SummaryRow label="With" value={created.appointment.stylistName} />
            <SummaryRow label="Source" value={labelForSource(created.bookingSource)} />
            <SummaryRow label="Payment" value={labelForPayment(created.paymentMode)} />
            <SummaryRow
              label="Deposit"
              value={formatMoney(created.depositRequiredAmount, created.appointment.currencyCode)}
            />
            <SummaryRow
              label="Confirmation"
              value={created.confirmationScheduled ? 'Requested' : 'Not sent'}
            />
          </dl>
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={resetForAnother}
              className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
            >
              Book another
            </button>
            <Link
              to="/bookings"
              className="inline-flex h-10 items-center rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
            >
              Go to appointment book
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">New booking</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Create an appointment for a walk-in, phone, or in-salon client.
          </p>
        </div>
        {locations.length > 1 ? (
          <label className="text-[12px] font-medium text-text-secondary">
            Location
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="mt-1 block h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-56"
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {prefill.staffProfileId && prefill.date ? (
        <div className="mb-4 rounded-input-lg border border-primary/30 bg-primary/5 px-4 py-3 text-[13px] text-text-primary">
          From the book:{' '}
          <span className="font-semibold">{prefill.staffName ?? 'selected stylist'}</span>
          {prefill.time ? (
            <>
              {' '}at <span className="font-semibold">{prefill.time}</span>
            </>
          ) : null}{' '}
          on {prefill.date}. Pick a client and services — the stylist and time are pre-selected.
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {/* 1. Client */}
      <Section step={1} title="Client" complete={Boolean(selectedClient)}>
        {selectedClient ? (
          <div className="flex items-center justify-between rounded-input-lg border border-border bg-surface-alt px-4 py-3">
            <div>
              <div className="text-[14px] font-medium text-text-primary">
                {selectedClient.displayName}
              </div>
              <div className="text-[12px] text-text-secondary">
                {[selectedClient.phone, selectedClient.email, `#${selectedClient.clientCode}`]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedClient(null)}
              className="text-[13px] font-medium text-primary hover:text-primary-deep"
            >
              Change
            </button>
          </div>
        ) : showNewClient ? (
          <form
            onSubmit={handleCreateClient}
            className="grid gap-3 rounded-input-lg border border-border bg-surface p-4 sm:grid-cols-2"
          >
            <TextInput
              label="First name"
              value={newClient.firstName}
              onChange={(value) => setNewClient((c) => ({ ...c, firstName: value }))}
              required
            />
            <TextInput
              label="Last name"
              value={newClient.lastName}
              onChange={(value) => setNewClient((c) => ({ ...c, lastName: value }))}
              required
            />
            <TextInput
              label="Phone"
              value={newClient.phone}
              onChange={(value) => setNewClient((c) => ({ ...c, phone: value }))}
            />
            <TextInput
              label="Email"
              type="email"
              value={newClient.email}
              onChange={(value) => setNewClient((c) => ({ ...c, email: value }))}
            />
            <div className="flex items-end justify-end gap-2 sm:col-span-2">
              <button
                type="button"
                onClick={() => setShowNewClient(false)}
                className="h-10 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingClient}
                className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
              >
                {creatingClient ? 'Creating…' : 'Create & select'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="search"
                placeholder="Search by name, phone or email"
                value={clientQuery}
                onChange={(event) => setClientQuery(event.target.value)}
                className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={() => {
                  setShowNewClient(true);
                  setNewClient(emptyNewClient);
                }}
                className="h-10 shrink-0 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
              >
                New client
              </button>
            </div>
            {searchingClients ? (
              <p className="mt-2 text-[12px] text-text-secondary">Searching…</p>
            ) : clientResults.length > 0 ? (
              <ul className="mt-2 divide-y divide-border overflow-hidden rounded-input-lg border border-border">
                {clientResults.map((client) => (
                  <li key={client.id}>
                    <button
                      type="button"
                      onClick={() => selectClient(client)}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-surface-alt"
                    >
                      <span className="text-[13px] font-medium text-text-primary">
                        {client.displayName}
                      </span>
                      <span className="text-[12px] text-text-secondary">
                        {client.phone ?? client.email ?? `#${client.clientCode}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : clientQuery.trim().length >= 2 ? (
              <p className="mt-2 text-[12px] text-text-secondary">
                No matching clients. Use “New client” to add one.
              </p>
            ) : null}
          </div>
        )}
      </Section>

      {/* 2. Services */}
      <Section step={2} title="Services" complete={selectedServiceIds.length > 0}>
        {loadingSelection ? (
          <p className="text-[13px] text-text-secondary">Loading services…</p>
        ) : (selection?.services.length ?? 0) === 0 ? (
          <p className="text-[13px] text-text-secondary">No bookable services at this location.</p>
        ) : (
          <>
            <ul className="grid gap-2 sm:grid-cols-2">
              {selection?.services.map((service) => (
                <li key={service.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-input-lg border px-3 py-2.5 transition ${
                      selectedServiceIds.includes(service.id)
                        ? 'border-primary bg-primary/5'
                        : 'border-border-strong bg-surface hover:bg-surface-alt'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedServiceIds.includes(service.id)}
                      onChange={() => toggleService(service.id)}
                      className="mt-0.5 h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
                    />
                    <span className="flex-1">
                      <span className="block text-[13px] font-medium text-text-primary">
                        {service.name}
                      </span>
                      <span className="block text-[12px] text-text-secondary">
                        {service.estimatedDurationMinutes} min ·{' '}
                        {formatMoney(service.startingPriceAmount, service.currencyCode)}
                        {service.depositRequiredAmount > 0
                          ? ` · deposit ${formatMoney(service.depositRequiredAmount, service.currencyCode)}`
                          : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {selectedServiceIds.length > 0 ? (
              <p className="mt-3 text-[12px] font-medium text-text-secondary">
                {selectedServiceIds.length} service{selectedServiceIds.length > 1 ? 's' : ''} ·{' '}
                {totalDurationMinutes} min · {formatMoney(totalPriceAmount, currencyCode)}
                {totalDepositAmount > 0
                  ? ` · deposit ${formatMoney(totalDepositAmount, currencyCode)}`
                  : ''}
              </p>
            ) : null}
          </>
        )}
      </Section>

      {/* 3. Stylist */}
      <Section step={3} title="Stylist" complete={selectedServiceIds.length > 0}>
        {selectedServiceIds.length === 0 ? (
          <p className="text-[13px] text-text-secondary">Select a service first.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <ChoiceChip
              active={stylistChoice === ANY_STYLIST}
              onClick={() => setStylistChoice(ANY_STYLIST)}
              label="Any available"
            />
            {stylists.map((stylist) => (
              <ChoiceChip
                key={stylist.staffProfileId}
                active={stylistChoice === stylist.staffProfileId}
                onClick={() => setStylistChoice(stylist.staffProfileId)}
                label={stylist.displayName}
                hint={stylist.nextAvailableAt ? `next ${formatDateTime(stylist.nextAvailableAt)}` : 'no slots'}
              />
            ))}
          </div>
        )}
      </Section>

      {/* 4. Date + time */}
      <Section step={4} title="Date & time" complete={Boolean(selectedSlot)}>
        {selectedServiceIds.length === 0 ? (
          <p className="text-[13px] text-text-secondary">Select a service first.</p>
        ) : (
          <>
            <input
              type="date"
              value={date}
              min={todayIso()}
              onChange={(event) => setDate(event.target.value)}
              className="h-10 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-3">
              {loadingSlots ? (
                <p className="text-[13px] text-text-secondary">Loading availability…</p>
              ) : slots.length === 0 ? (
                <p className="text-[13px] text-text-secondary">
                  No availability for this day. Try another date or stylist.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {slots.map((slot) => {
                    const active =
                      selectedSlot?.startAt === slot.startAt &&
                      selectedSlot?.staffProfileId === slot.staffProfileId;
                    return (
                      <button
                        key={`${slot.startAt}-${slot.staffProfileId}`}
                        type="button"
                        onClick={() => setSelectedSlot(slot)}
                        className={`rounded-input-lg border px-3 py-2 text-[13px] font-medium transition ${
                          active
                            ? 'border-primary bg-primary text-text-on-primary'
                            : 'border-border-strong bg-surface text-text-primary hover:bg-surface-alt'
                        }`}
                      >
                        {formatTime(slot.startAt)}
                        {stylistChoice === ANY_STYLIST ? (
                          <span
                            className={`ml-1.5 text-[11px] ${active ? 'text-text-on-primary/80' : 'text-text-secondary'}`}
                          >
                            {slot.stylistName}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </Section>

      {/* 5. Details */}
      <Section step={5} title="Booking details" complete>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Booking source"
            value={bookingSource}
            onChange={(value) => setBookingSource(value as StaffBookingSource)}
            options={BOOKING_SOURCES}
          />
          <SelectField
            label="Payment"
            value={paymentMode}
            onChange={(value) => setPaymentMode(value as StaffBookingPaymentMode)}
            options={PAYMENT_MODES}
          />
          <SelectField
            label="Confirmation channel"
            value={communicationPreference}
            onChange={(value) => setCommunicationPreference(value as CommPreference)}
            options={[
              { value: 'whatsapp', label: 'WhatsApp' },
              { value: 'sms', label: 'SMS' },
              { value: 'email', label: 'Email' },
            ]}
          />
          <label className="flex items-end gap-2 text-[12px] font-medium text-text-secondary">
            <input
              type="checkbox"
              checked={sendConfirmation}
              onChange={(event) => setSendConfirmation(event.target.checked)}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
            />
            Send client confirmation
          </label>
          <TextArea
            label="Client note (may be shared with the client)"
            value={clientNote}
            onChange={setClientNote}
          />
          <TextArea
            label="Internal note (staff only)"
            value={internalNote}
            onChange={setInternalNote}
          />
        </div>
      </Section>

      <div className="sticky bottom-0 mt-6 flex items-center justify-between gap-4 rounded-card-lg border border-border bg-surface px-4 py-3">
        <div className="text-[12px] text-text-secondary">
          {selectedClient ? selectedClient.displayName : 'No client'} ·{' '}
          {selectedServiceIds.length} service{selectedServiceIds.length === 1 ? '' : 's'} ·{' '}
          {selectedSlot ? formatDateTime(selectedSlot.startAt) : 'no time'}
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="h-11 rounded-pill bg-primary px-6 text-[14px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
        >
          {submitting ? 'Booking…' : 'Create booking'}
        </button>
      </div>
    </div>
  );
}

function Section({
  step,
  title,
  complete,
  children,
}: {
  step: number;
  title: string;
  complete?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 rounded-card-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <span
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold ${
            complete ? 'bg-success text-text-on-primary' : 'bg-surface-alt text-text-secondary'
          }`}
        >
          {step}
        </span>
        <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ChoiceChip({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-input-lg border px-3 py-2 text-left text-[13px] font-medium transition ${
        active
          ? 'border-primary bg-primary/5 text-text-primary'
          : 'border-border-strong bg-surface text-text-primary hover:bg-surface-alt'
      }`}
    >
      <span className="block">{label}</span>
      {hint ? <span className="block text-[11px] font-normal text-text-secondary">{hint}</span> : null}
    </button>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="text-[12px] font-medium text-text-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="text-[12px] font-medium text-text-secondary">
      {label}
      <input
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-[12px] font-medium text-text-secondary sm:col-span-2">
      {label}
      <textarea
        value={value}
        rows={2}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 rounded-input-lg bg-surface px-3 py-2">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="font-medium text-text-primary">{value}</dd>
    </div>
  );
}

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function toLocalIsoDate(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function toLocalHm(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function formatMoney(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode }).format(amount);
}

function labelForSource(source: StaffBookingSource): string {
  return BOOKING_SOURCES.find((entry) => entry.value === source)?.label ?? source;
}

function labelForPayment(mode: StaffBookingPaymentMode): string {
  return PAYMENT_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}
