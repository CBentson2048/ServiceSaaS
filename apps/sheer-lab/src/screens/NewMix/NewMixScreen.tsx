import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PinUnlockResponse, StaffBookingSummary } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { listTodaysLabAppointmentsForSession } from '../../features/appointments/appointmentsApi';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { getLabSessionBillingBreakdown } from '../../features/formulas/formulasApi';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { Icon } from '../../ui/icons/Icon';
import { formatTimeOfDay } from '../Home/dashboardHelpers';
import { c, initials, LabShell, Pill, t } from '../shared/LabShell';

type NewMixScreenProps = NativeStackScreenProps<RootStackParamList, 'NewMix'>;

const STEPS = ['Client', 'Service', 'Formula', 'Weigh', 'Complete'];

export function NewMixScreen({ navigation }: NewMixScreenProps): React.JSX.Element {
  const ble = useBleScale();
  const bleConnected = ble.status === 'connected';

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const [query, setQuery] = useState('');
  // Only appointment-backed clients can be selected for now. Walk-in is shown
  // but disabled ("Soon"): a formula cannot be finalized without an
  // appointment/visit on the backend, so we don't let users into a dead-end.
  const [selected, setSelected] = useState<StaffBookingSummary | undefined>();
  // The service is one of the selected appointment's booked services (read from
  // the booking), not a generic taxonomy.
  const [service, setService] = useState<string | undefined>();
  // Appointments that already have a finalized mix (a saved formula / product
  // usage recorded). Formulas are tracked per appointment/visit on the backend,
  // not per individual service, so this flag is appointment-scoped.
  const [mixedByAppt, setMixedByAppt] = useState<Record<string, boolean>>({});
  // Appointments we've already probed for an existing mix — kept in a ref so it
  // can't land in the effect deps and re-trigger / cancel the in-flight fetch.
  const probedMixRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const activeSession = await getActiveLabSession();
        if (!activeSession) {
          navigation.replace('Auth');
          return;
        }
        if (cancelled) return;
        setSession(activeSession);
        const response = await listTodaysLabAppointmentsForSession(activeSession.sessionId);
        if (!cancelled) setBookings(response.bookings);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load today's appointments");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigation]);

  const filteredBookings = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return bookings;
    return bookings.filter((b) =>
      [b.clientDisplayName, ...b.serviceNames].join(' ').toLowerCase().includes(term),
    );
  }, [bookings, query]);

  const selectedAppointmentId = selected?.id;
  const canStart = Boolean(selected && service);
  const alreadyMixed = selectedAppointmentId ? Boolean(mixedByAppt[selectedAppointmentId]) : false;

  // Probe the selected appointment for an existing finalized mix so the action
  // button can offer "Re-build Formula" instead of "Start Formula Build".
  useEffect(() => {
    const apptId = selected?.id;
    const sid = session?.sessionId;
    if (!apptId || !sid) return;
    if (probedMixRef.current.has(apptId)) return;
    probedMixRef.current.add(apptId);

    let cancelled = false;
    void (async () => {
      try {
        const breakdown = await getLabSessionBillingBreakdown(sid, apptId);
        const mixed = breakdown.productUsage.length > 0 || breakdown.billingLineItem != null;
        if (!cancelled) setMixedByAppt((current) => ({ ...current, [apptId]: mixed }));
      } catch {
        // Leave the flag unset on failure so the button defaults to "Start";
        // allow a later reselect to retry.
        probedMixRef.current.delete(apptId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id, session?.sessionId]);

  // Stepper progress: client (1) → service (2) → then the mixing steps live on
  // the Formula screen, so step 3 lights up as the next destination.
  const activeStep = selected ? (service ? 3 : 2) : 1;

  const selectAppointment = useCallback((booking: StaffBookingSummary) => {
    setSelected(booking);
    // Auto-select when the booking has a single service; otherwise let the
    // stylist choose which booked service this mix is for.
    setService(booking.serviceNames.length === 1 ? booking.serviceNames[0] : undefined);
  }, []);

  const startFormulaBuild = useCallback(() => {
    if (!session || !selected || !service) return;
    navigation.navigate('BuildFormula', {
      entryContext: {
        labSessionId: session.sessionId,
        appointmentId: selected.id,
        clientProfileId: selected.clientProfileId,
        clientName: selected.clientDisplayName,
        serviceType: service,
        startsAt: selected.startsAt,
        patchTest: selected.patchTest,
      },
    });
  }, [navigation, selected, service, session]);

  const footer = (
    <View style={styles.footer}>
      <Text style={styles.footerText}>
        PRECISION MIXING · QLOOQO LAB SYSTEM · SCALE CONNECTIVITY: {bleConnected ? 'OPTIMAL' : 'OFFLINE'}
      </Text>
    </View>
  );

  return (
    <LabShell session={session} bleStatus={ble.status} footer={footer}>
      <Stepper activeStep={activeStep} />

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <ClientStep
        loading={loading}
        bookings={filteredBookings}
        totalCount={bookings.length}
        query={query}
        onQuery={setQuery}
        selectedAppointmentId={selectedAppointmentId}
        onSelectAppointment={selectAppointment}
      />

      <ServiceStep booking={selected} service={service} onSelect={setService} />

      <ActionBar
        stylistName={session?.displayName}
        canStart={canStart}
        alreadyMixed={alreadyMixed}
        onCancel={() => navigation.goBack()}
        onStart={startFormulaBuild}
      />
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

function Stepper({ activeStep }: { activeStep: number }): React.JSX.Element {
  return (
    <View style={styles.stepper}>
      {STEPS.map((label, index) => {
        const step = index + 1;
        const state = step < activeStep ? 'done' : step === activeStep ? 'active' : 'todo';
        return (
          <View key={label} style={styles.stepItem}>
            <View style={styles.stepRow}>
              {index > 0 ? <View style={[styles.connector, step <= activeStep && styles.connectorOn]} /> : <View style={styles.connectorSpacer} />}
              <View style={[styles.stepNode, state !== 'todo' ? styles.stepNodeOn : styles.stepNodeTodo]}>
                {state === 'done' ? (
                  <Icon name="check" size="xs" tone="inherit" color={c.textOnPrimary} />
                ) : (
                  <Text style={[styles.stepNodeText, state !== 'todo' && styles.stepNodeTextOn]}>
                    {String(step)}
                  </Text>
                )}
              </View>
              {index < STEPS.length - 1 ? (
                <View style={[styles.connector, step < activeStep && styles.connectorOn]} />
              ) : (
                <View style={styles.connectorSpacer} />
              )}
            </View>
            <Text style={[styles.stepLabel, state === 'active' && styles.stepLabelActive]} numberOfLines={1}>
              {label.toUpperCase()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — client
// ---------------------------------------------------------------------------

function ClientStep({
  loading,
  bookings,
  totalCount,
  query,
  onQuery,
  selectedAppointmentId,
  onSelectAppointment,
}: {
  loading: boolean;
  bookings: StaffBookingSummary[];
  totalCount: number;
  query: string;
  onQuery: (value: string) => void;
  selectedAppointmentId?: string;
  onSelectAppointment: (booking: StaffBookingSummary) => void;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionHeadText}>
          <Text style={styles.stepTitle}>Step 1: Select Client</Text>
          <Text style={styles.stepSubtitle}>Select an existing appointment or create a walk-in session.</Text>
        </View>
        <View style={styles.searchBox}>
          <Icon name="search" size="sm" tone="muted" />
          <TextInput
            value={query}
            onChangeText={onQuery}
            placeholder="Search today's clients…"
            placeholderTextColor={c.inputPlaceholder}
            style={styles.searchInput}
          />
        </View>
      </View>

      <View style={styles.clientRow}>
        <View style={styles.appointmentsCard}>
          <View style={styles.appointmentsHead}>
            <Text style={styles.eyebrow}>Today&apos;s Appointments</Text>
            <Pill label={`${totalCount} ${totalCount === 1 ? 'booking' : 'bookings'}`} tone="neutral" subtle />
          </View>

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : bookings.length === 0 ? (
            <Text style={styles.muted}>{query ? 'No matching clients today.' : 'No appointments scheduled today.'}</Text>
          ) : (
            <View style={styles.appointmentList}>
              {bookings.map((booking) => {
                const isSelected = booking.id === selectedAppointmentId;
                return (
                  <Pressable
                    key={booking.id}
                    accessibilityRole="button"
                    onPress={() => onSelectAppointment(booking)}
                    style={[styles.appointmentRow, isSelected && styles.appointmentRowSelected]}
                  >
                    <View style={styles.appointmentAvatar}>
                      <Text style={styles.appointmentAvatarText}>{initials(booking.clientDisplayName)}</Text>
                    </View>
                    <View style={styles.appointmentInfo}>
                      <Text style={styles.appointmentName} numberOfLines={1}>
                        {booking.clientDisplayName}
                      </Text>
                      <Text style={styles.appointmentMeta} numberOfLines={1}>
                        {formatTimeOfDay(booking.startsAt)} · {booking.serviceNames.join(' + ') || 'Colour service'}
                      </Text>
                    </View>
                    <View style={[styles.radio, isSelected && styles.radioOn]}>
                      {isSelected ? <View style={styles.radioDot} /> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <View style={[styles.walkinCard, styles.walkinCardDisabled]}>
          <View style={styles.walkinHead}>
            <View style={styles.walkinTitleRow}>
              <Icon name="plus" size="sm" tone="primary" />
              <Text style={styles.walkinTitle}>New Walk-in</Text>
            </View>
            <Pill label="Soon" tone="neutral" subtle />
          </View>
          <Text style={styles.muted}>Walk-in mixes need a client record before they can be billed and saved — coming soon.</Text>
          <Text style={styles.fieldLabel}>CLIENT NAME</Text>
          <View style={[styles.input, styles.inputDisabled]}>
            <Text style={styles.inputPlaceholderText}>e.g. Guest Customer</Text>
          </View>
          <View style={[styles.walkinButton, styles.buttonDisabled]}>
            <Icon name="plus" size="xs" tone="inherit" color={c.textOnPrimary} />
            <Text style={styles.walkinButtonText}>Create Session</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — booked service (read from the selected appointment)
// ---------------------------------------------------------------------------

function ServiceStep({
  booking,
  service,
  onSelect,
}: {
  booking?: StaffBookingSummary;
  service?: string;
  onSelect: (name: string) => void;
}): React.JSX.Element {
  const services = booking?.serviceNames ?? [];
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeadText}>
        <Text style={styles.stepTitle}>Step 2: Select Service</Text>
        <Text style={styles.stepSubtitle}>
          {booking
            ? `Booked services for ${booking.clientDisplayName} — pick the one this mix is for.`
            : 'Choose a client above to load their booked services.'}
        </Text>
      </View>

      {!booking ? (
        <Text style={styles.muted}>No client selected yet.</Text>
      ) : services.length === 0 ? (
        <Text style={styles.muted}>This appointment has no booked services listed.</Text>
      ) : (
        <View style={styles.serviceGrid}>
          {services.map((name, index) => {
            const isSelected = name === service;
            return (
              <Pressable
                key={`${name}-${index}`}
                accessibilityRole="button"
                onPress={() => onSelect(name)}
                style={[styles.serviceTile, isSelected && styles.serviceTileSelected]}
              >
                <View style={styles.serviceIcon}>
                  <Icon name="flask" size={22} tone="brand" />
                </View>
                <Text style={styles.serviceLabel} numberOfLines={2}>
                  {name.toUpperCase()}
                </Text>
                {isSelected ? <Icon name="check" size="xs" tone="brand" /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

function ActionBar({
  stylistName,
  canStart,
  alreadyMixed,
  onCancel,
  onStart,
}: {
  stylistName?: string;
  canStart: boolean;
  alreadyMixed: boolean;
  onCancel: () => void;
  onStart: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.actionBar}>
      <View>
        <Text style={styles.eyebrow}>Active Stylist</Text>
        <View style={styles.stylistRow}>
          <View style={styles.liveDot} />
          <Text style={styles.stylistName}>{stylistName ?? '—'}</Text>
        </View>
      </View>
      <View style={styles.actionButtons}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancelButton}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!canStart}
          onPress={onStart}
          style={[styles.startButton, !canStart && styles.buttonDisabled]}
        >
          <Text style={styles.startText}>{alreadyMixed ? 'Re-build Formula' : 'Start Formula Build'}</Text>
          <Icon name="arrowRight" size="xs" tone="inherit" color={c.textOnPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const card = {
  backgroundColor: c.surface,
  borderRadius: t.radius.cardLg,
  borderWidth: 1,
  borderColor: c.border,
  padding: t.spacing.lg,
  ...t.cardShadow,
} as const;

const styles = StyleSheet.create({
  errorText: { color: c.dangerText, fontSize: t.typography.fontSize.small, fontWeight: '600' },

  // Stepper
  stepper: {
    ...card,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: t.spacing.md,
  },
  stepItem: { flex: 1, alignItems: 'center', gap: 6 },
  stepRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', justifyContent: 'center' },
  stepNode: {
    width: 34,
    height: 34,
    borderRadius: t.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  stepNodeOn: { backgroundColor: c.primary, borderColor: c.primary },
  stepNodeTodo: { backgroundColor: c.surface, borderColor: c.borderStrong },
  stepNodeText: { fontSize: t.typography.fontSize.small, fontWeight: '700', color: c.textMuted },
  stepNodeTextOn: { color: c.textOnPrimary },
  connector: { flex: 1, height: 2, backgroundColor: c.border },
  connectorOn: { backgroundColor: c.primary },
  connectorSpacer: { flex: 1, height: 2 },
  stepLabel: { fontSize: t.typography.fontSize.micro, fontWeight: '700', letterSpacing: 0.5, color: c.textMuted },
  stepLabelActive: { color: c.textPrimary },

  // Sections
  section: { gap: t.spacing.md },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.spacing.md, flexWrap: 'wrap' },
  sectionHeadText: { flex: 1, gap: 2, minWidth: 220 },
  stepTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.title, fontWeight: '700' },
  stepSubtitle: { color: c.textSecondary, fontSize: t.typography.fontSize.small },
  eyebrow: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  muted: { color: c.textMuted, fontSize: t.typography.fontSize.small },
  center: { paddingVertical: t.spacing.xl, alignItems: 'center' },

  // Search
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: t.radius.pill,
    paddingHorizontal: t.spacing.md,
    height: 40,
    minWidth: 220,
  },
  searchInput: { flex: 1, color: c.textPrimary, fontSize: t.typography.fontSize.small, padding: 0 },

  // Client step
  clientRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.md, alignItems: 'flex-start' },
  appointmentsCard: { ...card, flexGrow: 1, flexBasis: 320, gap: t.spacing.md },
  appointmentsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  appointmentList: { gap: t.spacing.sm },
  appointmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    padding: t.spacing.md,
    borderRadius: t.radius.card,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  appointmentRowSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
  appointmentAvatar: {
    width: 40,
    height: 40,
    borderRadius: t.radius.full,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  appointmentAvatarText: { color: c.primary, fontWeight: '700', fontSize: t.typography.fontSize.small },
  appointmentInfo: { flex: 1, gap: 2 },
  appointmentName: { color: c.textPrimary, fontSize: t.typography.fontSize.body, fontWeight: '700' },
  appointmentMeta: { color: c.textSecondary, fontSize: t.typography.fontSize.caption },
  radio: {
    width: 22,
    height: 22,
    borderRadius: t.radius.full,
    borderWidth: 2,
    borderColor: c.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: c.primary },
  radioDot: { width: 10, height: 10, borderRadius: t.radius.full, backgroundColor: c.primary },

  // Walk-in (currently disabled / "Soon")
  walkinCard: { ...card, flexGrow: 1, flexBasis: 240, gap: t.spacing.sm, backgroundColor: c.surfaceAlt },
  walkinCardDisabled: { opacity: 0.6 },
  walkinHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  walkinTitleRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
  walkinTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.bodyLg, fontWeight: '700' },
  fieldLabel: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: t.spacing.xs,
  },
  input: {
    height: 42,
    borderWidth: 1,
    borderColor: c.inputBorder,
    backgroundColor: c.inputBg,
    borderRadius: t.radius.inputLg,
    paddingHorizontal: t.spacing.md,
    justifyContent: 'center',
  },
  inputDisabled: { backgroundColor: c.surfaceAlt },
  inputPlaceholderText: { color: c.inputPlaceholder, fontSize: t.typography.fontSize.small },
  walkinButton: {
    marginTop: t.spacing.xs,
    height: 42,
    borderRadius: t.radius.inputLg,
    backgroundColor: c.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.xs,
  },
  walkinButtonText: { color: c.textOnPrimary, fontSize: t.typography.fontSize.small, fontWeight: '700' },

  // Service step
  serviceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.md },
  serviceTile: {
    ...card,
    flexGrow: 1,
    flexBasis: 108,
    minWidth: 104,
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingVertical: t.spacing.lg,
    paddingHorizontal: t.spacing.sm,
  },
  serviceTileSelected: { borderColor: c.primary, backgroundColor: c.primarySoft },
  serviceIcon: {
    width: 48,
    height: 48,
    borderRadius: t.radius.card,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primarySoft,
    borderColor: c.primarySoft,
  },
  serviceLabel: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 0.5,
    textAlign: 'center',
  },

  // Action bar
  actionBar: {
    ...card,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.spacing.md,
    flexWrap: 'wrap',
  },
  stylistRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, marginTop: 2 },
  liveDot: { width: 8, height: 8, borderRadius: t.radius.full, backgroundColor: c.successText },
  stylistName: { color: c.textPrimary, fontSize: t.typography.fontSize.body, fontWeight: '700' },
  actionButtons: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  cancelButton: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm },
  cancelText: { color: c.textSecondary, fontSize: t.typography.fontSize.small, fontWeight: '700' },
  startButton: {
    backgroundColor: c.primary,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderRadius: t.radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
  },
  startText: { color: c.textOnPrimary, fontSize: t.typography.fontSize.small, fontWeight: '700' },
  // Solid muted fill (not opacity) so the primary CTA never blends toward white
  // against the light card behind it — it stays a visibly dark button.
  buttonDisabled: { backgroundColor: c.textSecondary },

  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: t.spacing.md,
    marginTop: t.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  footerText: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
});
