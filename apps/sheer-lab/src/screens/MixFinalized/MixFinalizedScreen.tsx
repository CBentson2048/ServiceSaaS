import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PinUnlockResponse } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import type { FormulaIngredientRow, FormulaRemixBaseline } from '../../features/formulas/formulaDraftTypes';
import { finalizeFormulaForLabSession } from '../../features/formulas/formulasApi';
import { useFormulaDraft } from '../../features/formulas/useFormulaDraft';
import { getActiveLabSession, logoutLabSession, refreshActiveLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import { formatClock, formatMoney } from '../Home/dashboardHelpers';
import { featureFlags } from '../../config/featureFlags';
import { labTheme } from '../../theme/labTheme';
import { TopBar } from '../shared/LabShell';

const T = labTheme;
const C = T.colors;

type MixFinalizedScreenProps = NativeStackScreenProps<RootStackParamList, 'MixFinalized'>;

// ---------------------------------------------------------------------------
// Responsive layout — mirrors the Formula / Build Formula breakpoints.
// ---------------------------------------------------------------------------

interface FinalizeLayout {
  mode: 'phone' | 'tablet' | 'wide';
  sidebarWidth: number;
  contentWidth: number;
  pad: number;
  gap: number;
  showSidebar: boolean;
}

function getLayout(width: number): FinalizeLayout {
  if (width >= 1024) {
    const large = width >= 1280;
    return {
      mode: 'wide',
      sidebarWidth: large ? 248 : 216,
      // Single full-width column, capped for readable line lengths on desktop.
      contentWidth: 920,
      pad: large ? T.spacing.xl : T.spacing.base,
      gap: T.spacing.lg,
      showSidebar: true,
    };
  }
  if (width >= 700) {
    return {
      mode: 'tablet',
      sidebarWidth: 208,
      contentWidth: 720,
      pad: T.spacing.base,
      gap: T.spacing.base,
      showSidebar: true,
    };
  }
  return {
    mode: 'phone',
    sidebarWidth: 0,
    contentWidth: 0,
    pad: T.spacing.base,
    gap: T.spacing.base,
    showSidebar: false,
  };
}

// ---------------------------------------------------------------------------
// Sidebar navigation model
// ---------------------------------------------------------------------------

type WorkingRoute = 'Home' | 'NewMix' | 'FormulaHistory';
type NavTarget = { kind: 'route'; route: WorkingRoute } | { kind: 'soon' } | { kind: 'current' };

interface NavEntry {
  key: string;
  label: string;
  glyph: string;
  target: NavTarget;
}

const NAV_ITEMS: NavEntry[] = ([
  { key: 'dashboard', label: 'Dashboard', glyph: '▦', target: { kind: 'route', route: 'Home' } },
  { key: 'new-mix', label: 'New Mix', glyph: '🧪', target: { kind: 'current' } },
  { key: 'history', label: 'History', glyph: '🕘', target: { kind: 'route', route: 'FormulaHistory' } },
  { key: 'inventory', label: 'Inventory', glyph: '📦', target: { kind: 'soon' } },
  { key: 'billing', label: 'Billing Rules', glyph: '🧾', target: { kind: 'soon' } },
  { key: 'audit', label: 'Audit Trail', glyph: '🛡️', target: { kind: 'soon' } },
  // Billing Rules and Audit Trail are hidden from the nav behind feature flags
  // for every role; their entries stay so the feature can be restored later.
] satisfies NavEntry[]).filter(
  (item) => (item.key !== 'billing' || featureFlags.billingRules) && (item.key !== 'audit' || featureFlags.auditTrail),
);

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
  const { width } = useWindowDimensions();
  const layout = getLayout(width);
  const ble = useBleScale();
  const scaleConnected = ble.status === 'connected';

  const { draft, saveDraft, markFinalized, toFinalSavePayload } = useFormulaDraft();

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [now] = useState<Date>(() => new Date());

  const [busy, setBusy] = useState(false);
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

  const goToRoute = useCallback(
    (target: NavTarget) => {
      if (target.kind !== 'route') return;
      navigation.navigate(target.route);
    },
    [navigation],
  );

  const handleSignOut = useCallback(async () => {
    const sid = session?.sessionId ?? draft.labSessionId;
    try {
      await logoutLabSession(sid);
    } catch {
      // Best effort — always return the device to the lock screen.
    }
    navigation.reset({ index: 0, routes: [{ name: 'Auth' }] });
  }, [draft.labSessionId, navigation, session?.sessionId]);

  const handleSaveDraft = useCallback(() => {
    const saved = saveDraft();
    setMessage(`Draft saved locally ${formatTime(saved.savedAt)} · no billing applied yet`);
  }, [saveDraft]);

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
      const chargeCents = draft.billableChargeCents;
      const payload = {
        ...toFinalSavePayload(),
        labSessionId: active.sessionId,
      };
      await finalizeFormulaForLabSession(active.sessionId, payload);
      markFinalized();
      setCompleted({ totalCents: chargeCents, ref: reportRef });
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
      totalCostCents={draft.totalCostCents}
      durationLabel={durationLabel}
      currencyCode={draft.currencyCode}
      remixBaseline={draft.remixBaseline}
    />
  );

  const actions = (
    <SendToDeskActions
      hasMissingCost={draft.hasMissingCost}
      busy={busy}
      message={message}
      onComplete={() => void handleComplete()}
      onSaveDraft={handleSaveDraft}
      onEdit={handleEdit}
    />
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />
      <TopBar session={session} bleStatus={ble.status} />

      <View style={[styles.body, layout.showSidebar ? styles.bodyRow : styles.bodyColumn]}>
        {layout.showSidebar ? (
          <Sidebar
            width={layout.sidebarWidth}
            onNav={goToRoute}
            onSignOut={handleSignOut}
            canManageOps={session?.role === 'owner' || session?.role === 'manager'}
          />
        ) : null}

        <View style={styles.mainArea}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ padding: layout.pad, paddingBottom: T.spacing.xl }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[styles.contentWrap, { gap: layout.gap, maxWidth: layout.contentWidth || undefined }]}>
              {!layout.showSidebar ? (
                <NavScroller
                  onNav={goToRoute}
                  onSignOut={handleSignOut}
                  canManageOps={session?.role === 'owner' || session?.role === 'manager'}
                />
              ) : null}

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

              <Footer now={now} scaleConnected={scaleConnected} online={session?.status === 'active'} />
            </View>
          </ScrollView>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function FinalizedHero(): React.JSX.Element {
  return (
    <View style={styles.hero}>
      <View style={styles.heroBadge}>
        <Text style={styles.heroBadgeGlyph}>✓</Text>
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
  totalCostCents,
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
  totalCostCents: number;
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
          <Text style={[styles.th, styles.colCost]}>Lab Cost</Text>
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
                {line.costCents == null ? '—' : formatMoney(line.costCents, currencyCode)}
              </Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.statRow}>
        <StatTile
          glyph="⚖"
          value={formatGramsDecimal(totalWeightGrams)}
          label={remixBaseline ? 'Weighed in this remix' : 'Actual used weight'}
          caption={remixBaseline ? 'This Remix' : 'Total Weight'}
        />
        {remixBaseline ? (
          <StatTile
            glyph="∑"
            value={formatGramsDecimal(remixBaseline.totalGrams + totalWeightGrams)}
            label={`Incl. previous mix (${formatGramsDecimal(remixBaseline.totalGrams)})`}
            caption="Total Used"
          />
        ) : null}
        <StatTile glyph="◷" value={formatMoney(totalCostCents, currencyCode)} label="Internal product cost" caption="Lab Cost" />
        <StatTile glyph="⏱" value={durationLabel} label="Total scale active time" caption="Mix Duration" />
      </View>

      <View style={styles.auditCard}>
        <Text style={styles.auditGlyph}>🛡️</Text>
        <View style={styles.auditText}>
          <Text style={styles.auditTitle}>Audit policy active</Text>
          <Text style={styles.auditBody}>
            Every mix is logged for salon transparency — weighed quantities, lab cost and timing. Manual weight
            overrides require a manager PIN on the audit trail.
          </Text>
        </View>
      </View>
    </View>
  );
}

function StatTile({
  glyph,
  value,
  label,
  caption,
}: {
  glyph: string;
  value: string;
  label: string;
  caption: string;
}): React.JSX.Element {
  return (
    <View style={styles.statTile}>
      <View style={styles.statCaptionRow}>
        <Text style={styles.statGlyph}>{glyph}</Text>
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
  message,
  onComplete,
  onSaveDraft,
  onEdit,
}: {
  hasMissingCost: boolean;
  busy: boolean;
  message?: string;
  onComplete: () => void;
  onSaveDraft: () => void;
  onEdit: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.actions}>
      {hasMissingCost ? (
        <Text style={styles.warning}>
          Some ingredients have no cost on record — their lab cost is excluded from the charge.
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
        <Text style={styles.primaryButtonText}>{busy ? 'Sending…' : '✓  Complete & Send to Desk'}</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={onSaveDraft}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}
      >
        <Text style={styles.secondaryButtonText}>Save Draft</Text>
      </Pressable>

      <Pressable accessibilityRole="button" disabled={busy} onPress={onEdit} style={styles.textButton}>
        <Text style={styles.textButtonText}>‹ Edit Formula</Text>
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
        <Text style={styles.completedBadgeGlyph}>✓</Text>
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

// ---------------------------------------------------------------------------
// Chrome — top bar, sidebar, mobile nav, footer
// ---------------------------------------------------------------------------


function Sidebar({
  width,
  onNav,
  onSignOut,
  canManageOps,
}: {
  width: number;
  onNav: (target: NavTarget) => void;
  onSignOut: () => void;
  canManageOps: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.sidebar, { width }]}>
      <View style={styles.sidebarNav}>
        {NAV_ITEMS.filter((item) => item.key !== 'inventory' || canManageOps).map((item) => {
          const active = item.target.kind === 'current';
          const soon = item.target.kind === 'soon';
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              disabled={soon || active}
              onPress={() => onNav(item.target)}
              style={[styles.navItem, active && styles.navItemActive, soon && styles.navItemSoon]}
            >
              <Text style={styles.navGlyph}>{item.glyph}</Text>
              <Text style={[styles.navLabel, active && styles.navLabelActive]} numberOfLines={1}>
                {item.label}
              </Text>
              {soon ? <Text style={styles.soonTag}>Soon</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.signOut}>
        <Text style={styles.signOutGlyph}>⏻</Text>
        <Text style={styles.signOutLabel}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

function NavScroller({
  onNav,
  onSignOut,
  canManageOps,
}: {
  onNav: (target: NavTarget) => void;
  onSignOut: () => void;
  canManageOps: boolean;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.navScroller}
      style={styles.navScrollerWrap}
    >
      {NAV_ITEMS.filter((item) => item.key !== 'inventory' || canManageOps).map((item) => {
        const active = item.target.kind === 'current';
        const soon = item.target.kind === 'soon';
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            disabled={soon || active}
            onPress={() => onNav(item.target)}
            style={[styles.navChip, active && styles.navChipActive, soon && styles.navItemSoon]}
          >
            <Text style={styles.navGlyph}>{item.glyph}</Text>
            <Text style={[styles.navChipLabel, active && styles.navLabelActive]}>{item.label}</Text>
            {soon ? <Text style={styles.soonTag}>Soon</Text> : null}
          </Pressable>
        );
      })}
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.navChip}>
        <Text style={styles.navGlyph}>⏻</Text>
        <Text style={styles.navChipLabel}>Sign Out</Text>
      </Pressable>
    </ScrollView>
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
  screen: { flex: 1, backgroundColor: C.background },
  body: { flex: 1 },
  bodyRow: { flexDirection: 'row' },
  bodyColumn: { flexDirection: 'column' },
  mainArea: { flex: 1 },
  scroll: { flex: 1 },
  contentWrap: { width: '100%', alignSelf: 'center' },


  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.spacing.base,
    paddingVertical: T.spacing.md,
    backgroundColor: C.surface,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  topSideLeft: { flex: 1, alignItems: 'flex-start' },
  topSideRight: { flex: 1, alignItems: 'flex-end' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  brandText: { color: C.textPrimary, fontSize: 17, fontWeight: '800', letterSpacing: 1 },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, maxWidth: 220 },
  userText: { alignItems: 'flex-end' },
  userName: { color: C.textPrimary, fontWeight: '700', fontSize: 13 },
  userRole: { color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: T.radius.full,
    backgroundColor: C.primarySoft,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: C.primary, fontWeight: '800', fontSize: 13 },

  // Sidebar
  sidebar: {
    backgroundColor: C.surface,
    borderRightWidth: 1,
    borderRightColor: C.border,
    paddingVertical: T.spacing.lg,
    paddingHorizontal: T.spacing.md,
    justifyContent: 'space-between',
  },
  sidebarNav: { gap: T.spacing.xs },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.card,
  },
  // Active item reads as a solid brand pill with white text (was a soft fill).
  navItemActive: { backgroundColor: C.sidebarActive },
  navItemSoon: { opacity: 0.5 },
  navGlyph: { fontSize: 16 },
  navLabel: { flex: 1, color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  navLabelActive: { color: C.sidebarActiveText },
  soonTag: { color: C.textMuted, fontSize: 11, fontWeight: '700' },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
  },
  signOutGlyph: { fontSize: 16, color: C.danger.text },
  signOutLabel: { color: C.textPrimary, fontWeight: '700', fontSize: 13 },

  // Mobile nav scroller
  navScrollerWrap: { marginBottom: T.spacing.xs },
  navScroller: { flexDirection: 'row', gap: T.spacing.sm, paddingVertical: T.spacing.xs },
  navChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.xs,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  navChipActive: { backgroundColor: C.primarySoft, borderColor: C.primary },
  navChipLabel: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },

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
  heroBadgeGlyph: { color: C.success.text, fontSize: 26, fontWeight: '900' },
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
  statGlyph: { color: C.textMuted, fontSize: 13 },
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
  auditGlyph: { fontSize: 16 },
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
  completedBadgeGlyph: { color: C.success.text, fontSize: 30, fontWeight: '900' },
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
  pillDot: { width: 7, height: 7, borderRadius: T.radius.full },
  pillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
});
