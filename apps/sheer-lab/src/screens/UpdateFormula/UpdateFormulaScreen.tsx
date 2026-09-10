import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PinUnlockResponse } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { formulaDraftStore } from '../../features/formulas/formulaDraftStore';
import type { SavedFormulaRecord } from '../../features/formulas/formulaDraftTypes';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import { formatClock, formatGrams } from '../Home/dashboardHelpers';
import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import { LabShell } from '../shared/LabShell';

const T = labTheme;
const C = T.colors;

type UpdateFormulaScreenProps = NativeStackScreenProps<RootStackParamList, 'UpdateFormula'>;

type PercentChoice = '20' | '30' | '50' | '75' | '100' | 'custom';
const PERCENT_PRESETS: PercentChoice[] = ['20', '30', '50', '75', '100', 'custom'];

/** One source ingredient projected to its remix target for the current render. */
interface RemixLine {
  rowId: string;
  name: string;
  meta?: string;
  previousGrams: number;
  targetGrams: number;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function UpdateFormulaScreen({ navigation, route }: UpdateFormulaScreenProps): React.JSX.Element {
  const { entryContext, sourceFormulaId } = route.params;

  const ble = useBleScale();
  const scaleConnected = ble.status === 'connected';

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [now, setNow] = useState<Date>(() => new Date());
  const [source] = useState<SavedFormulaRecord | undefined>(() =>
    formulaDraftStore.getSavedFormulaById(sourceFormulaId),
  );

  // Remix configuration (the two stylist-facing toggles + percentage).
  const [allowRemix, setAllowRemix] = useState(false);
  const [percentChoice, setPercentChoice] = useState<PercentChoice>('50');
  const [customPercent, setCustomPercent] = useState('');
  const [allowAdjust, setAllowAdjust] = useState(false);
  // Per source-row target overrides (only honoured while adjustment is allowed).
  const [overrides, setOverrides] = useState<Record<string, string>>({});

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

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // The effective remix percentage. With remixing off the formula is re-made in
  // full (100%); "custom" reads the free-text field.
  const effectivePercent = useMemo(() => {
    if (!allowRemix) return 100;
    if (percentChoice === 'custom') {
      const parsed = Number(customPercent);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return Number(percentChoice);
  }, [allowRemix, percentChoice, customPercent]);

  const baselineTotalGrams = useMemo(
    () => (source?.rows ?? []).reduce((sum, row) => sum + (row.capturedGrams ?? 0), 0),
    [source],
  );

  const lines = useMemo<RemixLine[]>(() => {
    if (!source) return [];
    return source.rows.map((row) => {
      const previousGrams = row.capturedGrams ?? 0;
      const computed = scaleGrams(previousGrams, effectivePercent);
      const override = allowAdjust ? overrides[row.id] : undefined;
      const parsed = override != null ? Number(override) : NaN;
      const targetGrams = override != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : computed;
      return {
        rowId: row.id,
        name: row.displayName?.trim() || row.productName?.trim() || 'Ingredient',
        meta: [row.brand, row.developer].filter(Boolean).join(' · ') || undefined,
        previousGrams,
        targetGrams,
      };
    });
  }, [source, effectivePercent, allowAdjust, overrides]);

  const newTotalGrams = useMemo(() => lines.reduce((sum, line) => sum + line.targetGrams, 0), [lines]);
  const combinedTotalGrams = baselineTotalGrams + newTotalGrams;

  const canStart = effectivePercent > 0 && newTotalGrams > 0;

  // Changing the percentage resets manual overrides so the inputs show the fresh
  // computed defaults (avoids stale targets after a percentage change).
  const selectPercent = useCallback((choice: PercentChoice) => {
    setPercentChoice(choice);
    setOverrides({});
  }, []);

  const onCustomPercent = useCallback((value: string) => {
    setCustomPercent(value);
    setOverrides({});
  }, []);

  const onOverride = useCallback((rowId: string, value: string) => {
    setOverrides((current) => ({ ...current, [rowId]: value }));
  }, []);

  const handleStartWeighing = useCallback(() => {
    if (!source || !canStart) return;
    const targetGramsByRowId: Record<string, number> = {};
    for (const line of lines) targetGramsByRowId[line.rowId] = line.targetGrams;

    formulaDraftStore.startRemixFromFormula({
      sourceFormulaId: source.id,
      percent: effectivePercent,
      labSessionId: entryContext.labSessionId,
      appointmentId: entryContext.appointmentId,
      client: {
        clientProfileId: entryContext.clientProfileId,
        clientName: entryContext.clientName,
      },
      visit: {
        appointmentId: entryContext.appointmentId,
        serviceType: entryContext.serviceType,
        startsAt: entryContext.startsAt,
      },
      patchTest: entryContext.patchTest ?? { status: 'unknown' },
      targetGramsByRowId,
    });

    // Navigate without an entryContext so the weigh screen keeps the seeded
    // remix draft instead of resetting it (same pattern as Build Formula).
    navigation.navigate('Formula');
  }, [canStart, effectivePercent, entryContext, lines, navigation, source]);

  return (
    <LabShell
      session={session}
      bleStatus={ble.status}
      labSessionId={entryContext.labSessionId}
      contentWidth="reading"
      footer={<Footer now={now} scaleConnected={scaleConnected} online={session?.status === 'active'} />}
      bottomBar={
        source ? (
          <BottomBar
            newTotalGrams={newTotalGrams}
            combinedTotalGrams={combinedTotalGrams}
            ready={canStart}
            onStart={handleStartWeighing}
          />
        ) : null
      }
    >
      <Header
        clientName={entryContext.clientName}
        serviceType={entryContext.serviceType}
        savedAt={source?.savedAt}
      />

      {!source ? (
        <View style={styles.card}>
          <Text style={styles.cardEyebrow}>Previous formula unavailable</Text>
          <Text style={styles.muted}>
            The last formula for this client is not available on this device. Open it from the original mix to update
            it.
          </Text>
          <Pressable accessibilityRole="button" onPress={() => navigation.goBack()} style={styles.secondaryButton}>
            <Icon name="chevronLeft" size="xs" tone="primary" />
            <Text style={styles.secondaryButtonText}>Back to History</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <PreviousFormulaCard lines={lines} baselineTotalGrams={baselineTotalGrams} />

          <RemixOptionsCard
            allowRemix={allowRemix}
            onToggleRemix={() => setAllowRemix((v) => !v)}
            percentChoice={percentChoice}
            onSelectPercent={selectPercent}
            customPercent={customPercent}
            onCustomPercent={onCustomPercent}
            allowAdjust={allowAdjust}
            onToggleAdjust={() => setAllowAdjust((v) => !v)}
            effectivePercent={effectivePercent}
          />

          <RemixTargetsCard lines={lines} editable={allowAdjust} overrides={overrides} onOverride={onOverride} />

          <CombinedTotalCard
            baselineTotalGrams={baselineTotalGrams}
            newTotalGrams={newTotalGrams}
            combinedTotalGrams={combinedTotalGrams}
          />
        </>
      )}
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  clientName,
  serviceType,
  savedAt,
}: {
  clientName: string;
  serviceType: string;
  savedAt?: string;
}): React.JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <View style={styles.breadcrumb}>
          <Text style={styles.breadcrumbMuted}>Client: </Text>
          <Text style={styles.breadcrumbStrong}>{clientName}</Text>
          <Text style={styles.breadcrumbSep}> › </Text>
          <Text style={styles.breadcrumbStrong}>{serviceType}</Text>
        </View>
        <Text style={styles.title}>Update Formula</Text>
        <Text style={styles.subtitle}>
          {savedAt
            ? `Continuing from the last formula saved ${formatSavedAt(savedAt)}.`
            : 'Continuing from the last saved formula.'}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Previous formula (read-only summary)
// ---------------------------------------------------------------------------

function PreviousFormulaCard({
  lines,
  baselineTotalGrams,
}: {
  lines: RemixLine[];
  baselineTotalGrams: number;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <View style={styles.selectionHeader}>
        <Text style={styles.cardEyebrow}>Previous formula</Text>
        <View style={styles.weightBadge}>
          <Text style={styles.weightBadgeText}>Used {formatGrams(baselineTotalGrams)}</Text>
        </View>
      </View>
      <View style={styles.table}>
        {lines.map((line) => (
          <View key={line.rowId} style={styles.tableRow}>
            <View style={styles.colProduct}>
              <Text style={styles.rowName} numberOfLines={1}>
                {line.name}
              </Text>
              {line.meta ? (
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {line.meta}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.tdStrong, styles.colNum]}>{formatGramsDecimal(line.previousGrams)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Remix options — the two checkboxes + percentage chips
// ---------------------------------------------------------------------------

function RemixOptionsCard({
  allowRemix,
  onToggleRemix,
  percentChoice,
  onSelectPercent,
  customPercent,
  onCustomPercent,
  allowAdjust,
  onToggleAdjust,
  effectivePercent,
}: {
  allowRemix: boolean;
  onToggleRemix: () => void;
  percentChoice: PercentChoice;
  onSelectPercent: (choice: PercentChoice) => void;
  customPercent: string;
  onCustomPercent: (value: string) => void;
  allowAdjust: boolean;
  onToggleAdjust: () => void;
  effectivePercent: number;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>Remix options</Text>

      <CheckboxRow
        checked={allowRemix}
        onToggle={onToggleRemix}
        label="Allow percentage remixing"
        hint={allowRemix ? 'Re-mix a percentage of the previous amounts.' : 'Off — re-make the full previous formula (100%).'}
      />

      {allowRemix ? (
        <View style={styles.percentBlock}>
          <View style={styles.chipRow}>
            {PERCENT_PRESETS.map((choice) => {
              const selected = choice === percentChoice;
              const chipLabel = choice === 'custom' ? 'Custom %' : `${choice}%`;
              return (
                <Pressable
                  key={choice}
                  accessibilityRole="button"
                  onPress={() => onSelectPercent(choice)}
                  style={[styles.percentChip, selected && styles.percentChipSelected]}
                >
                  <Text style={[styles.percentChipText, selected && styles.percentChipTextSelected]}>{chipLabel}</Text>
                </Pressable>
              );
            })}
          </View>
          {percentChoice === 'custom' ? (
            <View style={styles.customRow}>
              <TextInput
                value={customPercent}
                onChangeText={onCustomPercent}
                keyboardType="decimal-pad"
                placeholder="Enter %"
                placeholderTextColor={C.inputPlaceholder}
                style={styles.customInput}
              />
              <Text style={styles.customSuffix}>% of previous mix</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <CheckboxRow
        checked={allowAdjust}
        onToggle={onToggleAdjust}
        label="Allow percentage adjustment before mixing"
        hint="Fine-tune each ingredient's target weight before you start weighing."
      />

      <Text style={styles.effectiveNote}>
        {effectivePercent > 0
          ? `Targets set to ${formatPercentLabel(effectivePercent)} of the previous mix.`
          : 'Enter a valid percentage to continue.'}
      </Text>
    </View>
  );
}

function CheckboxRow({
  checked,
  onToggle,
  label,
  hint,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={styles.checkboxRow}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <Icon name="check" size="xs" tone="inherit" color={C.textOnPrimary} /> : null}
      </View>
      <View style={styles.checkboxText}>
        <Text style={styles.checkboxLabel}>{label}</Text>
        {hint ? <Text style={styles.checkboxHint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Remix targets (computed / editable per ingredient)
// ---------------------------------------------------------------------------

function RemixTargetsCard({
  lines,
  editable,
  overrides,
  onOverride,
}: {
  lines: RemixLine[];
  editable: boolean;
  overrides: Record<string, string>;
  onOverride: (rowId: string, value: string) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>New mix targets</Text>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.th, styles.colProduct]}>Ingredient</Text>
          <Text style={[styles.th, styles.colNum]}>Previous</Text>
          <Text style={[styles.th, styles.colTarget]}>Target (g)</Text>
        </View>
        {lines.map((line) => (
          <View key={line.rowId} style={styles.tableRow}>
            <View style={styles.colProduct}>
              <Text style={styles.rowName} numberOfLines={1}>
                {line.name}
              </Text>
              {line.meta ? (
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {line.meta}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.td, styles.colNum]}>{formatGramsDecimal(line.previousGrams)}</Text>
            <View style={styles.colTarget}>
              {editable ? (
                <TextInput
                  value={overrides[line.rowId] ?? formatGramsValue(line.targetGrams)}
                  onChangeText={(value) => onOverride(line.rowId, value)}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={C.inputPlaceholder}
                  style={styles.gramsInput}
                />
              ) : (
                <Text style={styles.targetLocked}>{formatGramsDecimal(line.targetGrams)}</Text>
              )}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Combined total (the "sum" requirement, previewed before weighing)
// ---------------------------------------------------------------------------

function CombinedTotalCard({
  baselineTotalGrams,
  newTotalGrams,
  combinedTotalGrams,
}: {
  baselineTotalGrams: number;
  newTotalGrams: number;
  combinedTotalGrams: number;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>Total product used</Text>
      <View style={styles.pricingRow}>
        <Text style={styles.pricingLabel}>Previous mix</Text>
        <Text style={styles.pricingValue}>{formatGrams(baselineTotalGrams)}</Text>
      </View>
      <View style={styles.pricingRow}>
        <Text style={styles.pricingLabel}>This remix (target)</Text>
        <Text style={[styles.pricingValue, styles.pricingValueBrand]}>+{formatGrams(newTotalGrams)}</Text>
      </View>
      <View style={styles.pricingDivider} />
      <View style={styles.pricingRow}>
        <Text style={styles.pricingTotalLabel}>Combined total</Text>
        <Text style={styles.pricingTotalValue}>{formatGrams(combinedTotalGrams)}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pinned bottom bar — Start Weighing CTA
// ---------------------------------------------------------------------------

function BottomBar({
  newTotalGrams,
  combinedTotalGrams,
  ready,
  onStart,
}: {
  newTotalGrams: number;
  combinedTotalGrams: number;
  ready: boolean;
  onStart: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.bottomBar}>
      <View style={styles.bottomStatus}>
        <Text style={[styles.bottomEyebrow, ready && styles.bottomEyebrowReady]}>{ready ? 'READY TO RE-MIX' : 'SET A TARGET'}</Text>
        <Text style={styles.bottomGrams}>{formatGrams(newTotalGrams)} new target</Text>
      </View>
      <View style={styles.bottomCombined}>
        <Text style={styles.bottomCombinedLabel}>COMBINED TOTAL</Text>
        <Text style={styles.bottomCombinedValue}>{formatGrams(combinedTotalGrams)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={!ready}
        onPress={onStart}
        style={({ pressed }) => [styles.startButton, !ready && styles.startButtonDisabled, pressed && ready && styles.startButtonPressed]}
      >
        <Text style={styles.startButtonText}>Start Weighing</Text>
        <Icon name="arrowRight" size="xs" tone="inherit" color={C.textOnPrimary} />
      </Pressable>
    </View>
  );
}

function Footer({ now, scaleConnected, online }: { now: Date; scaleConnected: boolean; online: boolean }): React.JSX.Element {
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
// Helpers
// ---------------------------------------------------------------------------

/** Scale a previous actual weight by a remix percentage, to 0.1 g precision. */
function scaleGrams(grams: number, percent: number): number {
  if (grams <= 0 || percent <= 0) return 0;
  return Math.round(((grams * percent) / 100) * 10) / 10;
}

function formatGramsDecimal(grams: number): string {
  if (!Number.isFinite(grams)) return '—';
  return `${grams.toFixed(1)}g`;
}

function formatGramsValue(grams: number): string {
  if (!Number.isFinite(grams) || grams <= 0) return '';
  return String(Math.round(grams * 10) / 10);
}

function formatPercentLabel(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`;
}

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return 'earlier';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Header
  header: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: T.spacing.md },
  headerText: { gap: 4, minWidth: 240, flexShrink: 1 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  breadcrumbMuted: { color: C.textMuted, fontSize: 13 },
  breadcrumbStrong: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  breadcrumbSep: { color: C.textMuted, fontSize: 13 },
  title: { color: C.textPrimary, fontSize: 30, fontWeight: '900', letterSpacing: -0.5 },
  subtitle: { color: C.textMuted, fontSize: 13 },

  // Cards
  card: {
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderRadius: T.radius.cardLg,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  cardEyebrow: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  muted: { color: C.textMuted, fontSize: 13, lineHeight: 19 },
  selectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: T.spacing.sm },
  weightBadge: {
    paddingHorizontal: T.spacing.md,
    paddingVertical: 6,
    borderRadius: T.radius.pill,
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.border,
  },
  weightBadgeText: { color: C.textSecondary, fontSize: 12, fontWeight: '800' },

  // Table
  table: { gap: T.spacing.xs },
  tableHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: T.spacing.sm, borderBottomWidth: 1, borderBottomColor: C.border },
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
  colNum: { flex: 1, textAlign: 'right' },
  colTarget: { flex: 1.2, alignItems: 'flex-end' },
  rowName: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  rowMeta: { color: C.textMuted, fontSize: 11 },
  td: { color: C.textSecondary, fontSize: 13, fontWeight: '600' },
  tdStrong: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  targetLocked: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },
  gramsInput: {
    alignSelf: 'stretch',
    minHeight: 38,
    paddingHorizontal: T.spacing.sm,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.input,
    backgroundColor: C.inputBg,
    color: C.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },

  // Checkbox rows
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: T.spacing.md },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: T.radius.sm,
    borderWidth: 2,
    borderColor: C.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: { backgroundColor: C.primary, borderColor: C.primary },
  checkboxText: { flex: 1, gap: 2 },
  checkboxLabel: { color: C.textPrimary, fontSize: 14, fontWeight: '700' },
  checkboxHint: { color: C.textMuted, fontSize: 12, lineHeight: 17 },

  // Percentage chips
  percentBlock: { gap: T.spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: T.spacing.sm },
  percentChip: {
    paddingHorizontal: T.spacing.md,
    paddingVertical: T.spacing.sm,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.inputBg,
  },
  percentChipSelected: { backgroundColor: C.primarySoft, borderColor: C.primary },
  percentChipText: { color: C.textSecondary, fontSize: 13, fontWeight: '800' },
  percentChipTextSelected: { color: C.primary },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  customInput: {
    width: 120,
    minHeight: 42,
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.inputLg,
    backgroundColor: C.inputBg,
    color: C.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  customSuffix: { color: C.textMuted, fontSize: 13 },
  effectiveNote: { color: C.textSecondary, fontSize: 12, fontWeight: '600' },

  // Pricing / totals
  pricingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pricingLabel: { color: C.textSecondary, fontSize: 14, fontWeight: '600' },
  pricingValue: { color: C.textPrimary, fontSize: 14, fontWeight: '700' },
  pricingValueBrand: { color: C.primary },
  pricingDivider: { height: 1, backgroundColor: C.border },
  pricingTotalLabel: { color: C.textPrimary, fontSize: 15, fontWeight: '800' },
  pricingTotalValue: { color: C.textPrimary, fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },

  // Buttons
  secondaryButton: {
    flexDirection: 'row',
    gap: 6,
    minHeight: 48,
    paddingHorizontal: T.spacing.lg,
    borderRadius: T.radius.inputLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.card,
  },
  secondaryButtonText: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },

  // Bottom bar
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderTopColor: C.border,
    flexWrap: 'wrap',
  },
  bottomStatus: { flex: 1, minWidth: 150, gap: 2 },
  bottomEyebrow: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  bottomEyebrowReady: { color: C.success.text },
  bottomGrams: { color: C.textPrimary, fontSize: 18, fontWeight: '900' },
  bottomCombined: { alignItems: 'flex-end', gap: 2 },
  bottomCombinedLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  bottomCombinedValue: { color: C.textPrimary, fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  startButton: {
    flexDirection: 'row',
    gap: 6,
    minHeight: 52,
    paddingHorizontal: T.spacing.xl,
    borderRadius: T.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  startButtonPressed: { backgroundColor: C.primaryPressed },
  startButtonDisabled: { backgroundColor: C.surfaceAlt },
  startButtonText: { color: C.textOnPrimary, fontSize: 15, fontWeight: '900' },

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
});
