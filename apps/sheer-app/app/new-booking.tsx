import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type {
  CreateStaffBookingResponse,
  CrmClientSummary,
  PublicBookingAvailabilitySlot,
  PublicBookingServiceSelectionResponse,
  PublicBookingStylistSummary,
  StaffBookingPaymentMode,
  StaffBookingSource,
} from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { StylistTabBar } from '../src/navigation/StylistTabBar';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

type CommPreference = 'whatsapp' | 'sms' | 'email';
const ANY_STYLIST = 'any';

const BOOKING_SOURCES: Array<{ value: StaffBookingSource; label: string }> = [
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'phone_booking', label: 'Phone' },
  { value: 'staff_booking', label: 'Manual' },
];

const PAYMENT_MODES: Array<{ value: StaffBookingPaymentMode; label: string }> = [
  { value: 'pay_in_salon', label: 'Pay in salon' },
  { value: 'deposit_waived', label: 'Deposit waived' },
  { value: 'deposit_due', label: 'Deposit due' },
  { value: 'paid_in_full', label: 'Paid in full' },
  { value: 'no_deposit', label: 'No deposit' },
];

const COMM_PREFERENCES: Array<{ value: CommPreference; label: string }> = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
];

export default function NewBookingScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const locations = useMemo(() => auth.user?.locations ?? [], [auth.user?.locations]);
  const ownStaffProfileId = auth.user?.staffProfileId;

  const [locationId, setLocationId] = useState<string>(locations[0]?.id ?? '');

  // Client
  const [clientQuery, setClientQuery] = useState('');
  const [clientResults, setClientResults] = useState<CrmClientSummary[]>([]);
  const [searchingClients, setSearchingClients] = useState(false);
  const [selectedClient, setSelectedClient] = useState<CrmClientSummary | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [creatingClient, setCreatingClient] = useState(false);

  // Services
  const [selection, setSelection] = useState<PublicBookingServiceSelectionResponse | null>(null);
  const [loadingSelection, setLoadingSelection] = useState(false);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);

  // Stylist
  const [stylists, setStylists] = useState<PublicBookingStylistSummary[]>([]);
  const [stylistChoice, setStylistChoice] = useState<string>(ANY_STYLIST);
  const stylistTouched = useRef(false);

  // Date + time
  const [date, setDate] = useState<string>(toLocalIsoDate(new Date()));
  const [slots, setSlots] = useState<PublicBookingAvailabilitySlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<PublicBookingAvailabilitySlot | null>(null);

  // Details
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
  const totalDurationMinutes = selectedServices.reduce((sum, s) => sum + s.estimatedDurationMinutes, 0);
  const totalPriceAmount = selectedServices.reduce((sum, s) => sum + s.startingPriceAmount, 0);
  const totalDepositAmount = selectedServices.reduce((sum, s) => sum + s.depositRequiredAmount, 0);

  // Load services when the location changes.
  const loadSelection = useCallback(async () => {
    if (!accessToken || !locationId) return;
    setLoadingSelection(true);
    setError(null);
    try {
      const result = await api.getStaffBookingSelection(accessToken, { locationId });
      setSelection(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load services');
      setSelection(null);
    } finally {
      setLoadingSelection(false);
    }
  }, [accessToken, locationId]);

  useEffect(() => {
    setSelectedServiceIds([]);
    setStylists([]);
    setStylistChoice(ANY_STYLIST);
    stylistTouched.current = false;
    setSlots([]);
    setSelectedSlot(null);
    void loadSelection();
  }, [loadSelection]);

  // Debounced client search.
  useEffect(() => {
    if (!accessToken) return;
    const term = clientQuery.trim();
    if (term.length < 2) {
      setClientResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setSearchingClients(true);
      try {
        const result = await api.searchStaffBookingClients(accessToken, { q: term, locationId });
        setClientResults(result.clients);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Client search failed');
      } finally {
        setSearchingClients(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [accessToken, clientQuery, locationId]);

  // Load stylists when the service set changes.
  useEffect(() => {
    if (!accessToken || !locationId || selectedServiceIds.length === 0) {
      setStylists([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getStaffBookingStylists(accessToken, {
          locationId,
          serviceIds: selectedServiceIds,
        });
        if (cancelled) return;
        setStylists(result.stylists);
        // Default to the signed-in stylist booking their own client.
        if (!stylistTouched.current && ownStaffProfileId) {
          const self = result.stylists.find((s) => s.staffProfileId === ownStaffProfileId);
          if (self) setStylistChoice(self.staffProfileId);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load stylists');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, locationId, selectedServiceIds, ownStaffProfileId]);

  // Load availability when services / stylist / date change.
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
        const result = await api.getStaffBookingAvailability(accessToken, {
          locationId,
          serviceIds: selectedServiceIds,
          stylistId: stylistChoice === ANY_STYLIST ? undefined : stylistChoice,
          dateFrom: localDayStart(date),
          dateTo: localDayEnd(date),
        });
        if (!cancelled) setSlots(result.slots);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load availability');
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

  function selectClient(client: CrmClientSummary) {
    setSelectedClient(client);
    setClientResults([]);
    setClientQuery('');
    setShowNewClient(false);
    if (
      client.communicationPreference === 'whatsapp' ||
      client.communicationPreference === 'sms' ||
      client.communicationPreference === 'email'
    ) {
      setCommunicationPreference(client.communicationPreference);
    }
  }

  function toggleService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId],
    );
  }

  async function handleCreateClient() {
    if (!accessToken) return;
    if (!newFirstName.trim() || !newLastName.trim()) {
      setError('Client first and last name are required');
      return;
    }
    setCreatingClient(true);
    setError(null);
    try {
      const { client } = await api.createStaffBookingClient(accessToken, {
        firstName: newFirstName.trim(),
        lastName: newLastName.trim(),
        phone: newPhone.trim() || undefined,
        email: newEmail.trim() || undefined,
        primaryLocationId: locationId,
        communicationPreference,
        source: 'staff_booking',
      });
      selectClient(client);
      setNewFirstName('');
      setNewLastName('');
      setNewPhone('');
      setNewEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create client');
    } finally {
      setCreatingClient(false);
    }
  }

  async function handleSubmit() {
    if (!accessToken || !selectedClient || !selectedSlot || selectedServiceIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.createStaffBooking(accessToken, {
        locationId,
        serviceIds: selectedServiceIds,
        staffProfileId: selectedSlot.staffProfileId,
        selectedStartAt: selectedSlot.startAt,
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
      setError(err instanceof Error ? err.message : 'Could not create the booking');
    } finally {
      setSubmitting(false);
    }
  }

  function resetForAnother() {
    setCreated(null);
    setSelectedClient(null);
    setSelectedServiceIds([]);
    setStylistChoice(ANY_STYLIST);
    stylistTouched.current = false;
    setSlots([]);
    setSelectedSlot(null);
    setClientNote('');
    setInternalNote('');
    setBookingSource('walk_in');
    setPaymentMode('pay_in_salon');
    setSendConfirmation(true);
    setError(null);
  }

  const showTabs = auth.user?.role === 'stylist';
  const canSubmit = Boolean(selectedClient) && selectedServiceIds.length > 0 && Boolean(selectedSlot) && !submitting;
  const dateOptions = useMemo(() => buildDateOptions(14), []);

  if (created) {
    return (
      <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist']}>
        <Screen>
          <SectionHeader title="Appointment booked" subtitle={created.appointment.clientDisplayName} />
          <Card>
            <Text style={s.confirmTitle}>{created.appointment.serviceNames.join(', ')}</Text>
            <SummaryRow label="When" value={formatDateTime(created.appointment.scheduledStartAt)} />
            <SummaryRow label="With" value={created.appointment.stylistName} />
            <SummaryRow label="Source" value={labelFor(BOOKING_SOURCES, created.bookingSource)} />
            <SummaryRow label="Payment" value={labelFor(PAYMENT_MODES, created.paymentMode)} />
            <SummaryRow
              label="Deposit"
              value={formatMoney(created.depositRequiredAmount, created.appointment.currencyCode)}
            />
            <SummaryRow label="Confirmation" value={created.confirmationScheduled ? 'Requested' : 'Not sent'} />
          </Card>
          <AppButton label="Book another" onPress={resetForAnother} />
          <AppButton label="Back to schedule" variant="secondary" onPress={() => router.replace('/bookings')} />
        </Screen>
        {showTabs ? <StylistTabBar /> : null}
      </ProtectedScreen>
    );
  }

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist']}>
      <Screen>
        <SectionHeader title="New booking" subtitle="Book a walk-in, phone or in-salon client." />

        {locations.length > 1 ? (
          <Card>
            <Text style={s.label}>Location</Text>
            <ChipRow>
              {locations.map((location) => (
                <Chip
                  key={location.id}
                  label={location.name}
                  active={locationId === location.id}
                  onPress={() => setLocationId(location.id)}
                />
              ))}
            </ChipRow>
          </Card>
        ) : null}

        {error ? (
          <Card>
            <Text style={s.error}>{error}</Text>
          </Card>
        ) : null}

        {/* 1. Client */}
        <Card>
          <Text style={s.step}>1 · Client</Text>
          {selectedClient ? (
            <View style={s.selectedRow}>
              <View style={s.flex}>
                <Text style={s.clientName}>{selectedClient.displayName}</Text>
                <Text style={s.muted}>
                  {[selectedClient.phone, selectedClient.email, `#${selectedClient.clientCode}`]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <Pressable onPress={() => setSelectedClient(null)} style={({ pressed }) => pressed && s.pressed}>
                <Text style={s.link}>Change</Text>
              </Pressable>
            </View>
          ) : showNewClient ? (
            <View style={s.gap}>
              <Field label="First name" value={newFirstName} onChangeText={setNewFirstName} />
              <Field label="Last name" value={newLastName} onChangeText={setNewLastName} />
              <Field label="Phone" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" />
              <Field label="Email" value={newEmail} onChangeText={setNewEmail} keyboardType="email-address" />
              <View style={s.row}>
                <View style={s.flex}>
                  <AppButton label="Cancel" variant="secondary" onPress={() => setShowNewClient(false)} />
                </View>
                <View style={s.flex}>
                  <AppButton
                    label={creatingClient ? 'Creating…' : 'Create & select'}
                    disabled={creatingClient}
                    onPress={() => void handleCreateClient()}
                  />
                </View>
              </View>
            </View>
          ) : (
            <View style={s.gap}>
              <TextInput
                value={clientQuery}
                onChangeText={setClientQuery}
                placeholder="Search by name, phone or email"
                placeholderTextColor="rgba(255,255,255,0.45)"
                style={s.input}
                autoCapitalize="words"
              />
              {searchingClients ? <Text style={s.muted}>Searching…</Text> : null}
              {clientResults.map((client) => (
                <Pressable
                  key={client.id}
                  onPress={() => selectClient(client)}
                  style={({ pressed }) => [s.resultRow, pressed && s.pressed]}
                >
                  <Text style={s.resultName}>{client.displayName}</Text>
                  <Text style={s.muted}>{client.phone ?? client.email ?? `#${client.clientCode}`}</Text>
                </Pressable>
              ))}
              {clientQuery.trim().length >= 2 && !searchingClients && clientResults.length === 0 ? (
                <Text style={s.muted}>No matches. Add a new client below.</Text>
              ) : null}
              <AppButton label="New client" variant="secondary" onPress={() => setShowNewClient(true)} />
            </View>
          )}
        </Card>

        {/* 2. Services */}
        <Card>
          <Text style={s.step}>2 · Services</Text>
          {loadingSelection ? (
            <ActivityIndicator color={palette.brand[300]} />
          ) : (selection?.services.length ?? 0) === 0 ? (
            <Text style={s.muted}>No bookable services at this location.</Text>
          ) : (
            <View style={s.gap}>
              {selection?.services.map((service) => {
                const active = selectedServiceIds.includes(service.id);
                return (
                  <Pressable
                    key={service.id}
                    onPress={() => toggleService(service.id)}
                    style={({ pressed }) => [s.serviceRow, active && s.serviceRowActive, pressed && s.pressed]}
                  >
                    <View style={s.flex}>
                      <Text style={s.serviceName}>{service.name}</Text>
                      <Text style={s.muted}>
                        {service.estimatedDurationMinutes} min · {formatMoney(service.startingPriceAmount, service.currencyCode)}
                        {service.depositRequiredAmount > 0
                          ? ` · dep ${formatMoney(service.depositRequiredAmount, service.currencyCode)}`
                          : ''}
                      </Text>
                    </View>
                    <View style={[s.checkbox, active && s.checkboxActive]}>
                      {active ? <Text style={s.checkboxTick}>✓</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
              {selectedServiceIds.length > 0 ? (
                <Text style={s.totals}>
                  {selectedServiceIds.length} service{selectedServiceIds.length > 1 ? 's' : ''} · {totalDurationMinutes} min ·{' '}
                  {formatMoney(totalPriceAmount, currencyCode)}
                  {totalDepositAmount > 0 ? ` · deposit ${formatMoney(totalDepositAmount, currencyCode)}` : ''}
                </Text>
              ) : null}
            </View>
          )}
        </Card>

        {/* 3. Stylist */}
        <Card>
          <Text style={s.step}>3 · Stylist</Text>
          {selectedServiceIds.length === 0 ? (
            <Text style={s.muted}>Select a service first.</Text>
          ) : (
            <ChipRow>
              <Chip
                label="Any available"
                active={stylistChoice === ANY_STYLIST}
                onPress={() => {
                  stylistTouched.current = true;
                  setStylistChoice(ANY_STYLIST);
                }}
              />
              {stylists.map((stylist) => (
                <Chip
                  key={stylist.staffProfileId}
                  label={stylist.staffProfileId === ownStaffProfileId ? `${stylist.displayName} (you)` : stylist.displayName}
                  active={stylistChoice === stylist.staffProfileId}
                  onPress={() => {
                    stylistTouched.current = true;
                    setStylistChoice(stylist.staffProfileId);
                  }}
                />
              ))}
            </ChipRow>
          )}
        </Card>

        {/* 4. Date + time */}
        <Card>
          <Text style={s.step}>4 · Date & time</Text>
          {selectedServiceIds.length === 0 ? (
            <Text style={s.muted}>Select a service first.</Text>
          ) : (
            <View style={s.gap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.dateRow}>
                {dateOptions.map((option) => {
                  const active = option.value === date;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setDate(option.value)}
                      style={[s.datePill, active && s.datePillActive]}
                    >
                      <Text style={[s.dateWeekday, active && s.dateActiveText]}>{option.weekday}</Text>
                      <Text style={[s.dateDay, active && s.dateActiveText]}>{option.day}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              {loadingSlots ? (
                <ActivityIndicator color={palette.brand[300]} />
              ) : slots.length === 0 ? (
                <Text style={s.muted}>No availability this day. Try another date or stylist.</Text>
              ) : (
                <View style={s.slotWrap}>
                  {slots.map((slot) => {
                    const active = selectedSlot?.startAt === slot.startAt && selectedSlot?.staffProfileId === slot.staffProfileId;
                    return (
                      <Pressable
                        key={`${slot.startAt}-${slot.staffProfileId}`}
                        onPress={() => setSelectedSlot(slot)}
                        style={[s.slot, active && s.slotActive]}
                      >
                        <Text style={[s.slotText, active && s.dateActiveText]}>{formatTime(slot.startAt)}</Text>
                        {stylistChoice === ANY_STYLIST ? (
                          <Text style={[s.slotStylist, active && s.dateActiveText]}>{slot.stylistName}</Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          )}
        </Card>

        {/* 5. Details */}
        <Card>
          <Text style={s.step}>5 · Details</Text>
          <Text style={s.label}>Booking source</Text>
          <ChipRow>
            {BOOKING_SOURCES.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                active={bookingSource === option.value}
                onPress={() => setBookingSource(option.value)}
              />
            ))}
          </ChipRow>
          <Text style={s.label}>Payment</Text>
          <ChipRow>
            {PAYMENT_MODES.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                active={paymentMode === option.value}
                onPress={() => setPaymentMode(option.value)}
              />
            ))}
          </ChipRow>
          <Text style={s.label}>Confirmation channel</Text>
          <ChipRow>
            {COMM_PREFERENCES.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                active={communicationPreference === option.value}
                onPress={() => setCommunicationPreference(option.value)}
              />
            ))}
          </ChipRow>
          <Pressable onPress={() => setSendConfirmation((v) => !v)} style={s.toggleRow}>
            <View style={[s.checkbox, sendConfirmation && s.checkboxActive]}>
              {sendConfirmation ? <Text style={s.checkboxTick}>✓</Text> : null}
            </View>
            <Text style={s.toggleLabel}>Send client confirmation</Text>
          </Pressable>
          <Field label="Client note (may be shared)" value={clientNote} onChangeText={setClientNote} multiline />
          <Field label="Internal note (staff only)" value={internalNote} onChangeText={setInternalNote} multiline />
        </Card>

        <Card>
          <Text style={s.muted}>
            {selectedClient ? selectedClient.displayName : 'No client'} · {selectedServiceIds.length} service
            {selectedServiceIds.length === 1 ? '' : 's'} · {selectedSlot ? formatDateTime(selectedSlot.startAt) : 'no time'}
          </Text>
          <AppButton
            label={submitting ? 'Booking…' : 'Create booking'}
            disabled={!canSubmit}
            onPress={() => void handleSubmit()}
          />
        </Card>
      </Screen>
      {showTabs ? <StylistTabBar /> : null}
    </ProtectedScreen>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, active && s.chipActive]}>
      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={s.chipRow}>{children}</View>;
}

function Field({
  label,
  value,
  onChangeText,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
}) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        keyboardType={keyboardType ?? 'default'}
        placeholderTextColor="rgba(255,255,255,0.45)"
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'sentences'}
        style={[s.input, multiline && s.inputMultiline]}
      />
    </View>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.summaryRow}>
      <Text style={s.muted}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
    </View>
  );
}

function labelFor<T extends string>(options: Array<{ value: T; label: string }>, value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function toLocalIsoDate(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function localDayStart(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toISOString();
}

function localDayEnd(isoDate: string): string {
  return new Date(`${isoDate}T23:59:59.999`).toISOString();
}

function buildDateOptions(count: number): Array<{ value: string; weekday: string; day: string }> {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    return {
      value: toLocalIsoDate(date),
      weekday: index === 0 ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' }),
      day: String(date.getDate()),
    };
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMoney(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  pressed: { opacity: 0.7 },
  step: { color: palette.white, fontSize: 16, fontWeight: '800', marginBottom: spacing.xs },
  label: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  muted: { color: 'rgba(255,255,255,0.68)', fontSize: 13 },
  error: { color: palette.danger[300], fontWeight: '700' },
  link: { color: palette.brand[300], fontWeight: '800', fontSize: 13 },
  input: {
    minHeight: 44,
    borderRadius: radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    color: palette.white,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  field: { gap: spacing.xs },
  selectedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  clientName: { color: palette.white, fontSize: 16, fontWeight: '700' },
  resultRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  resultName: { color: palette.white, fontSize: 14, fontWeight: '700' },
  serviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  serviceRowActive: { borderColor: palette.brand[500], backgroundColor: 'rgba(196,160,245,0.14)' },
  serviceName: { color: palette.white, fontSize: 14, fontWeight: '700' },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxActive: { backgroundColor: palette.brand[500], borderColor: palette.brand[500] },
  checkboxTick: { color: palette.white, fontSize: 13, fontWeight: '900' },
  totals: { color: palette.brand[300], fontSize: 13, fontWeight: '800', marginTop: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  chipActive: { backgroundColor: 'rgba(196,160,245,0.22)', borderColor: 'rgba(196,160,245,0.5)' },
  chipText: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: palette.white },
  dateRow: { gap: spacing.sm, paddingVertical: spacing.xs, paddingRight: spacing.base },
  datePill: {
    width: 56,
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  datePillActive: { backgroundColor: palette.brand[500], borderColor: palette.brand[500] },
  dateWeekday: { color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  dateDay: { color: palette.white, fontSize: 16, fontWeight: '800' },
  dateActiveText: { color: palette.white },
  slotWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  slot: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
  },
  slotActive: { backgroundColor: palette.brand[500], borderColor: palette.brand[500] },
  slotText: { color: palette.white, fontSize: 14, fontWeight: '800' },
  slotStylist: { color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '700' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  toggleLabel: { color: palette.white, fontSize: 14, fontWeight: '600' },
  confirmTitle: { color: palette.white, fontSize: 16, fontWeight: '800', marginBottom: spacing.xs },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 3 },
  summaryValue: { color: palette.white, fontSize: 13, fontWeight: '700' },
});
