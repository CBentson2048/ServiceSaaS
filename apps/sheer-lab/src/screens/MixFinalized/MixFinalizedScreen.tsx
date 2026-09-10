import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PinUnlockResponse } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import type { FormulaIngredientRow, FormulaRemixBaseline } from '../../features/formulas/formulaDraftTypes';
import { draftHasDurableContext } from '../../features/formulas/formulaDraftTypes';
import { formulaDraftStore } from '../../features/formulas/formulaDraftStore';
import { finalizeFormulaForLabSession, saveDraftFormulaForLabSession } from '../../features/formulas/formulasApi';
import { useFormulaDraft } from '../../features/formulas/useFormulaDraft';
import { getActiveLabSession, refreshActiveLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import { formatClock, formatMoney } from '../Home/dashboardHelpers';
import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import type { IconName } from '../../ui/icons/paths';
import { LabShell } from '../shared/LabShell';

const T = labTheme;
const C = T.colors;

type MixFinalizedScreenProps = NativeStackScreenProps<RootStackParamList, 'MixFinalized'>;

/** A captured ingredient projected onto the lab-report table row. */
interface ReportLine {
  id: string;
  shade: string;
  brand?: string;
  grams: number;
  costCents?: number;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function MixFinalizedScreen({ navigation }: MixFinalizedScreenProps): React.JSX.Element {
  const ble = useBleScale();
  const scaleConnected = ble.status === 'connected';

  const { draft, saveDraft, markFinalized, toSavePayload, toFinalSavePayload } = useFormulaDraft();

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [now] = useState<Date>(() => new Date());

  const [busy, setBusy] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [completed, setCompleted] = useState<{ totalCents: number; ref: string } | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = await getActiveLabSession();
      if (!cancelled && active) setSession(active);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const lines = useMemo<ReportLine[]>(
    () =>
      draft.rows
        .filter((row) => row.capturedGrams != null)
        .map((row) => ({
          id: row.id,
          shade: rowShade(row),
          brand: row.brand,
          grams: row.capturedGrams ?? 0,
          costCents: row.costCents,
        })),
    [draft.rows],
  );

  const totalWeightGrams = useMemo(
    () => lines.reduce((sum, line) => sum + line.grams, 0),
    [lines],
  );

  const reportRef = useMemo(() => formatReportRef(draft.id), [draft.id]);
  const durationLabel = useMemo(
    () => formatDuration(draft.createdAt, draft.finalizedAt ?? now.toISOString()),
    [draft.createdAt, draft.finalizedAt, now],
  );

  const handleSaveDraft = useCallback(async () => {
    if (savingDraft) return;
    setSavingDraft(true);
    setMessage('Saving draft…');
    try {
      const saved = saveDraft();
      // Persist to the salon record whenever the draft belongs to a real
      // appointment/visit — the station's local copy is temporary UI only.
      if (draftHasDurableContext(saved)) {
        const active = await getActiveLabSession();
        if (active) {
          await saveDraftFormulaForLabSession(active.sessionId, toSavePayload());
          setMessage(`Draft saved to salon records ${formatTime(saved.savedAt)} · no billing applied yet`);
          return;
        }
      }
      setMessage(`Draft saved on this station only ${formatTime(saved.savedAt)} · no billing applied yet`);
    } catch (err: unknown) {
      // The local save already succeeded — only the salon-record sync failed.
      const reason = err instanceof Error ? err.message : 'network error';
      setMessage(`Draft kept on this station — could not sync to salon records (${reason})`);
    } finally {
      setSavingDraft(false);
    }
  }, [saveDraft, savingDraft, toSavePayload]);

  const handleEdit = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleComplete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMessage('Sending billing and reconciling inventory…');
    try {
      const active = await refreshActiveLabSession();
      if (!active) {
        setMessage('Qlooqo Lab session expired. Unlock Qlooqo Lab again, then send to desk.');
        return;
      }
      const payload = {
        ...toFinalSavePayload(),
        labSessionId: active.sessionId,
      };
      const result = (await finalizeFormulaForLabSession(active.sessionId, payload)) as {
        billableChargeCents?: number;
      };
      markFinalized();
      // Prefer the server's authoritative charge (computed from the location's
      // billing rules) over the local preview, which degrades to raw cost when
      // the settings fetch failed.
      setCompleted({
        totalCents:
          typeof result?.billableChargeCents === 'number'
            ? result.billableChargeCents
            : draft.billableChargeCents,
        ref: reportRef,
      });
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : 'Could not send the mix to the front desk.');
    } finally {
      setBusy(false);
    }
  }, [busy, draft.billableChargeCents, markFinalized, reportRef, toFinalSavePayload]);

  const sessionLabReport = (
    <SessionLabReport
      reportRef={reportRef}
      clientName={draft.client.clientName}
      technique={draft.visit.serviceType}
      appointmentLabel={formatAppointmentLabel(draft.visit.startsAt, draft.visit.serviceType)}
      scaleConnected={scaleConnected}
      scaleName={ble.connectedDevice?.name}
      lines={lines}
      totalWeightGrams={totalWeightGrams}
      billableChargeCents={draft.billableChargeCents}
      priceFactor={draft.totalCostCents > 0 ? draft.billableChargeCents / draft.totalCostCents : 1}
      // Fail closed: with billing settings unloaded, billableChargeCents is
      // just the raw cost — show no £ figures rather than leak it.
      pricesReady={formulaDraftStore.isProductBillingReady()}
      durationLabel={durationLabel}
      currencyCode={draft.currencyCode}
      remixBaseline={draft.remixBaseline}
    />
  );

  const actions = (
    <SendToDeskActions
      hasMissingCost={draft.hasMissingCost}
      busy={busy}
      savingDraft={savingDraft}
      message={message}
      onComplete={() => void handleComplete()}
      onSaveDraft={() => void handleSaveDraft()}
      onEdit={handleEdit}
    />
  );

  return (
    <LabShell
      session={session}
      bleStatus={ble.status}
      labSessionId={draft.labSessionId}
      contentWidth="reading"
      footer={<Footer now={now} scaleConnected={scaleConnected} online={session?.status === 'active'} />}
    >
      <FinalizedHero />

      {completed ? (
        <CompletedPanel
          totalCents={completed.totalCents}
          reportRef={completed.ref}
          currencyCode={draft.currencyCode}
          clientName={draft.client.clientName}
          onDashboard={() => navigation.reset({ index: 0, routes: [{ name: 'Home' }] })}
          onNewMix={() => navigation.reset({ index: 0, routes: [{ name: 'NewMix' }] })}
        />
      ) : (
        <>
          {sessionLabReport}
          {actions}
        </>
      )}
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function FinalizedHero(): React.JSX.Element {
  return (
    <View style={styles.hero}>
      <View style={styles.heroBadge}>
        {/* Was a 26pt Unicode '✓'. The badge View already draws the filled
            success circle, so this is the bare tick rather than `checkCircle`,
            which would stroke a second ring inside it. */}
        <Icon name="check" size="lg" tone="success" />
      </View>
      <Text style={styles.heroTitle}>Mix Finalized</Text>
      <Text style={styles.heroSubtitle}>
        Formula accurately weighed and logged. Review the billing charges before sending to the front desk.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Session Lab Report (left card)
// ---------------------------------------------------------------------------

function SessionLabReport({
  reportRef,
  clientName,
  technique,
  appointmentLabel,
  scaleConnected,
  scaleName,
  lines,
  totalWeightGrams,
  billableChargeCents,
  priceFactor,
  pricesReady,
  durationLabel,
  currencyCode,
  remixBaseline,
}: {
  reportRef: string;
  clientName: string;
  technique: string;
  appointmentLabel?: string;
  scaleConnected: boolean;
  scaleName?: string;
  lines: ReportLine[];
  totalWeightGrams: number;
  billableChargeCents: number;
  /** Scales each line's internal cost to its billable share of the charge. */
  priceFactor: number;
  /** False until the location billing settings load — money renders as "—". */
  pricesReady: boolean;
  durationLabel: string;
  currencyCode: string;
  remixBaseline?: FormulaRemixBaseline;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <View style={styles.reportHead}>
        <View style={styles.reportHeadText}>
          <Text style={styles.cardEyebrow}>Session Lab Report</Text>
          <Text style={styles.reportRef}>REF: {reportRef}</Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.metaCol}>
          <Text style={styles.metaLabel}>Client</Text>
          <Text style={styles.metaValue} numberOfLines={1}>
            {clientName}
          </Text>
        </View>
        <View style={[styles.metaCol, styles.metaColEnd]}>
          <Text style={styles.metaLabel}>Technique</Text>
          <Text style={styles.metaValue} numberOfLines={1}>
            {technique}
          </Text>
        </View>
      </View>

      <View style={styles.subMetaRow}>
        {appointmentLabel ? <Text style={styles.subMeta}>{appointmentLabel}</Text> : <View />}
        <View style={styles.scaleBadge}>
          <View
            style={[styles.scaleDot, { backgroundColor: scaleConnected ? C.success.text : C.textMuted }]}
          />
          <Text style={styles.scaleBadgeText} numberOfLines={1}>
            {(scaleName ?? 'Scale 01').toUpperCase()} · {scaleConnected ? 'Connected' : 'Idle'}
          </Text>
        </View>
      </View>

      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.th, styles.colProduct]}>Product / Shade</Text>
          <Text style={[styles.th, styles.colQty]}>Actual Qty</Text>
          <Text style={[styles.th, styles.colCost]}>Price</Text>
        </View>
        {lines.length === 0 ? (
          <Text style={styles.emptyLine}>No weighed ingredients in this mix yet.</Text>
        ) : (
          lines.map((line) => (
            <View key={line.id} style={styles.tableRow}>
              <View style={styles.colProduct}>
                <Text style={styles.rowShade} numberOfLines={1}>
                  {line.shade}
                </Text>
                {line.brand ? (
                  <Text style={styles.rowBrand} numberOfLines={1}>
                    {line.brand.toUpperCase()}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.tdQty, styles.colQty]}>{formatGramsDecimal(line.grams)}</Text>
              <Text
                style={[styles.tdCost, styles.colCost, line.costCents == null && styles.tdMissing]}
                numberOfLines={1}
              >
                {/* Billable share, never the raw material cost. */}
                {!pricesReady || line.costCents == null
                  ? '—'
                  : formatMoney(Math.round(line.costCents * priceFactor), currencyCode)}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.statRow}>
        <StatTile
          icon="scale"
          value={formatGramsDecimal(totalWeightGrams)}
          label={remixBaseline ? 'Weighed in this remix' : 'Actual used weight'}
          caption={remixBaseline ? 'This Remix' : 'Total Weight'}
        />
        {remixBaseline ? (
          <StatTile
            icon="chart"
            value={formatGramsDecimal(remixBaseline.totalGrams + totalWeightGrams)}
            label={`Incl. previous mix (${formatGramsDecimal(remixBaseline.totalGrams)})`}
            caption="Total Used"
          />
        ) : null}
        <StatTile
          icon="currency"
          value={pricesReady ? formatMoney(billableChargeCents, currencyCode) : '—'}
          label="Colour charge for this mix"
          caption="Colour Charge"
        />
        <StatTile icon="clock" value={durationLabel} label="Total scale active time" caption="Mix Duration" />
      </View>

      <View style={styles.auditCard}>
        {/* Was 🛡️ — a full-colour emoji that ignored the card's tint and that
            VoiceOver announced as "shield" rather than the policy it marks. */}
        <Icon name="shield" size="sm" tone="primary" />
        <View style={styles.auditText}>
          <Text style={styles.auditTitle}>Audit policy active</Text>
          <Text style={styles.auditBody}>
            Every mix is logged for salon transparency — weighed quantities, product usage and timing. Manual
            weight overrides require a manager PIN on the audit trail.
          </Text>
        </View>
      </View>
    </View>
  );
}

function StatTile({
  icon,
  value,
  label,
  caption,
}: {
  icon: IconName;
  value: string;
  label: string;
  caption: string;
}): React.JSX.Element {
  return (
    <View style={styles.statTile}>
      <View style={styles.statCaptionRow}>
        <Icon name={icon} size="xs" tone="muted" />
        <Text style={styles.statCaption}>{caption}</Text>
      </View>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Send-to-desk actions (full-width, below the report)
// ---------------------------------------------------------------------------

function SendToDeskActions({
  hasMissingCost,
  busy,
  savingDraft,
  message,
  onComplete,
  onSaveDraft,
  onEdit,
}: {
  hasMissingCost: boolean;
  busy: boolean;
  savingDraft: boolean;
  message?: string;
  onComplete: () => void;
  onSaveDraft: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      {hasMissingCost ? (
        <Text style={styles.warning}>
          Some ingredients have no cost on record — they are excluded from the charge until set.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onComplete}
        style={({ pressed }) => [
          styles.primaryButton,
          pressed && !busy && styles.primaryButtonPressed,
          busy && styles.primaryButtonDisabled,
        ]}
      >
        {busy ? (
          <Text style={styles.primaryButtonText}>Sending…</Text>
        ) : (
          <View style={styles.primaryButtonContent}>
            <Icon name="check" size="sm" tone="inherit" color={C.textOnPrimary} />
            <Text style={styles.primaryButtonText}>Complete &amp; Send to Desk</Text>
          </View>
        )}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        disabled={busy || savingDraft}
        onPress={onSaveDraft}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}
      >
        <Text style={styles.secondaryButtonText}>{savingDraft ? 'Saving…' : 'Save Draft'}</Text>
      </Pressable>

      <Pressable accessibilityRole="button" disabled={busy} onPress={onEdit} style={styles.textButton}>
        <View style={styles.textButtonContent}>
          <Icon name="chevronLeft" size="xs" tone="secondary" />
          <Text style={styles.textButtonText}>Edit Formula</Text>
        </View>
      </Pressable>

      {message ? <Text style={styles.engineMessage}>{message}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Completed confirmation
// ---------------------------------------------------------------------------

function CompletedPanel({
  totalCents,
  reportRef,
  currencyCode,
  clientName,
  onDashboard,
  onNewMix,
}: {
  totalCents: number;
  reportRef: string;
  currencyCode: string;
  clientName: string;
  onDashboard: () => void;
  onNewMix: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.completedCard}>
      <View style={styles.completedBadge}>
        {/* Was a 30pt Unicode '✓' — same reasoning as the hero badge. */}
        <Icon name="check" size="lg" tone="success" />
      </View>
      <Text style={styles.completedTitle}>Sent to the front desk</Text>
      <Text style={styles.completedSubtitle}>
        {clientName}&apos;s colour charge of {formatMoney(totalCents, currencyCode)} is on the bill and inventory is
        reconciled.
      </Text>
      <Text style={styles.completedRef}>REF: {reportRef}</Text>
      <View style={styles.completedActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onDashboard}
          style={({ pressed }) => [styles.primaryButton, styles.completedPrimary, pressed && styles.primaryButtonPressed]}
        >
          <Text style={styles.primaryButtonText}>Back to Dashboard</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onNewMix}
          style={({ pressed }) => [styles.secondaryButton, styles.completedSecondary, pressed && styles.secondaryButtonPressed]}
        >
          <Text style={styles.secondaryButtonText}>Start New Mix</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Footer({
  now,
  scaleConnected,
  online,
}: {
  now: Date;
  scaleConnected: boolean;
  online: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.footer}>
      <View style={styles.footerSide}>
        <Text style={styles.footerText}>{formatClock(now)}</Text>
        <View style={[styles.dot, { backgroundColor: scaleConnected ? C.success.text : C.textMuted }]} />
        <Text style={styles.footerText}>{scaleConnected ? 'Scale live' : 'Scale idle'}</Text>
      </View>
      <View style={styles.footerSide}>
        <Text style={styles.footerText}>{appConfig.environment.toUpperCase()}</Text>
        <Text style={styles.footerTextStrong}>{online ? 'SYSTEM LIVE' : 'SESSION ENDED'}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function rowShade(row: FormulaIngredientRow): string {
  return row.shade?.trim() || row.productName.trim() || 'Untitled ingredient';
}

function formatGramsDecimal(grams: number): string {
  if (!Number.isFinite(grams)) return '—';
  return `${grams.toFixed(1)}g`;
}

function formatReportRef(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase().padStart(6, '0');
  return `#QL-${tail.slice(0, 5)}-${tail.slice(5) || '0'}`;
}

function formatAppointmentLabel(startsAt?: string, serviceType?: string): string | undefined {
  if (!startsAt) return undefined;
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return serviceType ? `Appointment: ${time} (${serviceType})` : `Appointment: ${time}`;
}

function formatTime(value?: string): string {
  if (!value) return 'just now';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const totalSeconds = Math.round((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({

  // Hero
  hero: { alignItems: 'center', gap: T.spacing.sm, paddingVertical: T.spacing.sm },
  heroBadge: {
    width: 56,
    height: 56,
    borderRadius: T.radius.full,
    backgroundColor: C.success.bg,
    borderWidth: 1,
    borderColor: C.success.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: { color: C.textPrimary, fontSize: 30, fontWeight: '900', letterSpacing: -0.5, textAlign: 'center' },
  heroSubtitle: {
    color: C.textMuted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 460,
  },

  // Card
  card: {
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: T.radius.cardLg,
    backgroundColor: C.card,
  },
  cardEyebrow: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },

  // Session lab report
  reportHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: T.spacing.sm },
  reportHeadText: { gap: 2, flexShrink: 1 },
  reportRef: { color: C.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: T.spacing.md,
    paddingTop: T.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  metaCol: { flex: 1, gap: 2 },
  metaColEnd: { alignItems: 'flex-end' },
  metaLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  metaValue: { color: C.textPrimary, fontSize: 17, fontWeight: '800' },

  subMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: T.spacing.sm },
  subMeta: { color: C.textMuted, fontSize: 12, fontWeight: '600' },
  scaleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 5,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
  },
  scaleDot: { width: 7, height: 7, borderRadius: T.radius.full },
  scaleBadgeText: { color: C.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },

  // Report table
  table: { gap: T.spacing.xs },
  tableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: T.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  th: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: T.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: T.spacing.xs,
  },
  colProduct: { flex: 2.4, gap: 2 },
  colQty: { flex: 1, textAlign: 'right' },
  colCost: { flex: 1, textAlign: 'right' },
  rowShade: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },
  rowBrand: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  tdQty: { color: C.textSecondary, fontSize: 14, fontWeight: '700' },
  tdCost: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },
  tdMissing: { color: C.warning.text },
  emptyLine: { color: C.textMuted, fontSize: 13, paddingVertical: T.spacing.md },

  // Stat tiles
  statRow: { flexDirection: 'row', gap: T.spacing.sm, flexWrap: 'wrap' },
  statTile: {
    flexGrow: 1,
    flexBasis: 110,
    gap: 6,
    padding: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
  },
  statCaptionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statCaption: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  statValue: { color: C.textPrimary, fontSize: 20, fontWeight: '900', letterSpacing: -0.5 },
  statLabel: { color: C.textMuted, fontSize: 11, fontWeight: '600' },

  // Audit note
  auditCard: {
    flexDirection: 'row',
    gap: T.spacing.sm,
    padding: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.primarySoft,
    backgroundColor: C.primarySoft,
  },
  auditText: { flex: 1, gap: 2 },
  auditTitle: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  auditBody: { color: C.textSecondary, fontSize: 12, lineHeight: 17 },

  warning: { color: C.warning.text, fontSize: 12, lineHeight: 17 },

  // Send-to-desk actions
  actions: { width: '100%', gap: T.spacing.sm },

  // Buttons
  primaryButton: {
    minHeight: 52,
    paddingHorizontal: T.spacing.lg,
    borderRadius: T.radius.inputLg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  primaryButtonPressed: { backgroundColor: C.primaryPressed },
  primaryButtonDisabled: { backgroundColor: C.surfaceAlt },
  primaryButtonText: { color: C.textOnPrimary, fontSize: 15, fontWeight: '900' },
  /** Tick + label row: an icon has no text baseline, so the label needs a row. */
  primaryButtonContent: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  secondaryButton: {
    minHeight: 48,
    paddingHorizontal: T.spacing.lg,
    borderRadius: T.radius.inputLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.card,
  },
  secondaryButtonPressed: { opacity: 0.7 },
  secondaryButtonText: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },
  textButton: { alignItems: 'center', paddingVertical: T.spacing.sm },
  textButtonText: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  textButtonContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  engineMessage: { color: C.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center' },

  // Completed panel
  completedCard: {
    alignItems: 'center',
    gap: T.spacing.md,
    padding: T.spacing.xl,
    borderRadius: T.radius.cardLg,
    borderWidth: 1,
    borderColor: C.success.border,
    backgroundColor: C.card,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  completedBadge: {
    width: 64,
    height: 64,
    borderRadius: T.radius.full,
    backgroundColor: C.success.bg,
    borderWidth: 1,
    borderColor: C.success.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completedTitle: { color: C.textPrimary, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  completedSubtitle: { color: C.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  completedRef: { color: C.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  completedActions: { alignSelf: 'stretch', gap: T.spacing.sm, marginTop: T.spacing.sm },
  completedPrimary: { alignSelf: 'stretch' },
  completedSecondary: { alignSelf: 'stretch' },

  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: T.spacing.md,
    marginTop: T.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: C.border,
    flexWrap: 'wrap',
    gap: T.spacing.sm,
  },
  footerSide: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  footerText: { color: C.textMuted, fontSize: 12 },
  footerTextStrong: { color: C.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  dot: { width: 8, height: 8, borderRadius: T.radius.full },

  // Pill
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 5,
    borderRadius: T.radius.full,
    borderWidth: 1,
  },
});
