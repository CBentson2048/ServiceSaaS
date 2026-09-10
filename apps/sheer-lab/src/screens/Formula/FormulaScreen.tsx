import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { InventoryProduct, LocationProductBillingSettings, PinUnlockResponse } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { formatMoney, formatUnitMoney, unitBillingFactor } from '../../features/formulas/formulaCosting';
import { getLabProductBillingSettings, saveDraftFormulaForLabSession } from '../../features/formulas/formulasApi';
import type {
  FormulaIngredientRow,
  FormulaRemixBaseline,
  FormulaRowCaptureStatus,
  FormulaRowMetadataUpdate,
  SavedFormulaRecord,
} from '../../features/formulas/formulaDraftTypes';
import { draftHasDurableContext, toLabCoreFormulaDraft } from '../../features/formulas/formulaDraftTypes';
import { useFormulaDraft } from '../../features/formulas/useFormulaDraft';
import { listLabInventoryProducts } from '../../features/inventory/productsApi';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import { formatClock } from '../Home/dashboardHelpers';
import { labTheme, tone as resolveTone, type ToneTriple } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import type { IconName } from '../../ui/icons/paths';
import { confirmDestructive } from '../../lib/confirm';
import { DecimalInput } from '../shared/DecimalInput';
import type { LayoutMode } from '../shared/LabShell';
import { LabShell, useLabLayout } from '../shared/LabShell';

const T = labTheme;
const C = T.colors;

/** Progress reads muted, success reads green, failure reads red. */
type NoticeTone = 'progress' | 'success' | 'danger';

type ManualInputState = Record<string, string>;
type FormulaScreenProps = NativeStackScreenProps<RootStackParamList, 'Formula'>;
type ChipTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

// ---------------------------------------------------------------------------
// Content metrics — the console's own numbers. Sidebar width, page padding and
// the content gap come from LabShell's `useLabLayout()`; only the dial size,
// the rail width and the two-column switch belong to this screen.
// ---------------------------------------------------------------------------

interface ConsoleMetrics {
  /** Width of the right-hand queue/progress rail; 0 when the columns stack. */
  railWidth: number;
  twoColumn: boolean;
  ringSize: number;
}

function consoleMetrics(width: number, mode: LayoutMode): ConsoleMetrics {
  if (mode === 'wide') {
    return {
      railWidth: clampNumber(Math.round(width * 0.3), 320, 400),
      twoColumn: true,
      ringSize: 256,
    };
  }
  if (mode === 'tablet') {
    return { railWidth: 0, twoColumn: false, ringSize: 264 };
  }
  return { railWidth: 0, twoColumn: false, ringSize: Math.min(248, Math.round(width * 0.62)) };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function FormulaScreen({ navigation, route }: FormulaScreenProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const layout = useLabLayout();
  const metrics = consoleMetrics(width, layout.mode);
  const ble = useBleScale();
  const scaleConnected = ble.status === 'connected';

  const {
    draft,
    addRow,
    removeRow,
    selectActiveRow,
    startRowReweigh,
    updateRowMetadata,
    applyBleWeight,
    applyManualWeight,
    setProductBilling,
    saveDraft,
    toSavePayload,
    loadDraft,
    getLatestFormulaForClient,
    duplicateFormula,
    startFromAppointmentContext,
  } = useFormulaDraft();

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [manualInputs, setManualInputs] = useState<ManualInputState>({});
  /**
   * The console notice, WITH A TONE.
   *
   * One muted 12pt grey line used to carry nine different outcomes: progress
   * ("Saving draft..."), success ("Draft saved to salon records"), and hard
   * failure ("Could not send the mix to the front desk"). The operator is
   * trained to ignore that strip, because it is where "Saving…" appears — so a
   * failed send-to-desk looked exactly like a completed one, on the screen that
   * moves money. Failure now reads as failure.
   */
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone }>({
    text: 'Local draft not saved yet',
    tone: 'progress',
  });
  const say = useCallback((text: string, tone: NoticeTone = 'progress') => {
    setNotice({ text, tone });
  }, []);
  const [savingDraft, setSavingDraft] = useState(false);
  const [previousFormula, setPreviousFormula] = useState<SavedFormulaRecord | undefined>();
  const [productSearch, setProductSearch] = useState('');
  const [productPickerRowId, setProductPickerRowId] = useState<string | undefined>();
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | undefined>();
  const [tareOffset, setTareOffset] = useState(0);
  const [billingSettings, setBillingSettings] = useState<LocationProductBillingSettings | null>(null);
  const [now, setNow] = useState<Date>(() => new Date());
  const lastAppliedBleReading = useRef<string | undefined>(undefined);

  const entryContext = route.params?.entryContext;
  const activeRow = draft.rows.find((row) => row.id === draft.activeIngredientId);
  const activeIndex = draft.rows.findIndex((row) => row.id === draft.activeIngredientId);
  const labCoreDraft = useMemo(() => toLabCoreFormulaDraft(draft), [draft]);
  const pickerRow = draft.rows.find((row) => row.id === productPickerRowId);

  const activeCaptured = activeRow?.capturedGrams;
  const activeWeightLabel = activeCaptured != null ? activeCaptured.toFixed(1) : '--.-';
  const activeTarget = activeRow?.plannedGrams;
  const ringState = resolveRingState(activeRow);
  const ringProgress =
    activeTarget && activeTarget > 0 && activeCaptured != null
      ? clampNumber(activeCaptured / activeTarget, 0, 1)
      : activeCaptured != null
        ? 1
        : 0;

  const sessionTotals = useMemo(() => {
    const totalTarget = draft.rows.reduce((sum, row) => sum + (row.plannedGrams ?? 0), 0);
    const totalCaptured = draft.rows.reduce((sum, row) => sum + (row.capturedGrams ?? 0), 0);
    const capturedCount = draft.rows.filter((row) => row.captureStatus === 'captured').length;
    const fraction =
      totalTarget > 0
        ? clampNumber(totalCaptured / totalTarget, 0, 1)
        : draft.rows.length > 0
          ? capturedCount / draft.rows.length
          : 0;
    return { totalTarget, totalCaptured, capturedCount, fraction };
  }, [draft.rows]);

  // Reset the local tare baseline whenever the active row changes — each
  // ingredient is weighed fresh.
  useEffect(() => {
    setTareOffset(0);
  }, [draft.activeIngredientId]);

  useEffect(() => {
    if (!entryContext) return;
    startFromAppointmentContext({
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
    });
  }, [entryContext, startFromAppointmentContext]);

  // Load the active session for the top-bar identity + sign-out.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await getActiveLabSession();
      if (!cancelled && loaded) setSession(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply live BLE readings to the active row, folding in the local tare offset
  // so the readout and the captured weight stay consistent.
  useEffect(() => {
    const reading = ble.liveWeight;
    if (!reading || reading.source !== 'ble') return;

    const readingKey = `${reading.capturedAt}:${reading.grams}`;
    if (lastAppliedBleReading.current === readingKey) return;

    lastAppliedBleReading.current = readingKey;
    const tared =
      tareOffset > 0 ? { ...reading, grams: Math.max(0, reading.grams - tareOffset) } : reading;
    applyBleWeight(tared);
  }, [applyBleWeight, ble.liveWeight, tareOffset]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const activeSession = entryContext?.labSessionId
        ? { sessionId: entryContext.labSessionId }
        : await getActiveLabSession();
      if (!activeSession) return;
      try {
        const settings = await getLabProductBillingSettings(activeSession.sessionId);
        if (!cancelled) {
          setProductBilling(settings);
          // Kept locally too so unit-price displays (product picker) can show
          // the billable £/g instead of the raw cost.
          setBillingSettings(settings);
        }
      } catch {
        // Leave the colour-charge preview at cost-only if the rule can't be loaded.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryContext?.labSessionId, setProductBilling]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const loadProducts = useCallback(
    async (search = productSearch): Promise<void> => {
      const activeSession = entryContext?.labSessionId
        ? { sessionId: entryContext.labSessionId }
        : await getActiveLabSession();
      if (!activeSession) {
        setProducts([]);
        setProductsError('Unlock Qlooqo Lab before selecting products.');
        return;
      }

      setProductsLoading(true);
      setProductsError(undefined);
      try {
        const response = await listLabInventoryProducts(activeSession.sessionId, {
          q: search.trim() || undefined,
        });
        setProducts(response.products);
      } catch (err: unknown) {
        setProductsError(err instanceof Error ? err.message : 'Could not load inventory products');
      } finally {
        setProductsLoading(false);
      }
    },
    [entryContext?.labSessionId, productSearch],
  );

  useEffect(() => {
    if (!productPickerRowId) return;
    const timeout = setTimeout(() => {
      void loadProducts(productSearch);
    }, 250);

    return () => clearTimeout(timeout);
  }, [loadProducts, productPickerRowId, productSearch]);

  function updateManualInput(rowId: string, value: string): void {
    setManualInputs((current) => ({ ...current, [rowId]: value }));
  }

  function submitManualWeight(rowId: string): void {
    const value = manualInputs[rowId]?.trim() ?? '';
    const grams = Number(value);
    if (value.length === 0 || Number.isNaN(grams)) return;

    applyManualWeight(rowId, grams);
    setManualInputs((current) => ({ ...current, [rowId]: '' }));
  }

  function openProductPicker(rowId: string): void {
    setProductPickerRowId(rowId);
    setProductSearch('');
    void loadProducts('');
  }

  function selectProductForRow(rowId: string, product: InventoryProduct): void {
    const costPerGramCents = product.defaultCostPerGramCents;
    updateRowMetadata(rowId, {
      identityMode: 'catalogue_product',
      productId: product.id,
      productName: product.name,
      displayName: formatProductDisplayName(product),
      brand: product.brand,
      shade: product.name,
      category: product.category,
      sku: product.sku,
      costBasis: {
        productId: product.id,
        source: costPerGramCents == null ? 'missing' : 'product_catalog',
        costPerGramCents,
        currencyCode: 'GBP',
      },
    });
    setProductPickerRowId(undefined);
  }

  function switchRowToManual(row: FormulaIngredientRow): void {
    updateRowMetadata(row.id, {
      identityMode: 'custom_manual',
      productId: undefined,
      productName: row.productName,
      displayName: undefined,
      brand: row.brand,
      shade: row.shade,
      category: undefined,
      sku: undefined,
      costBasis: {
        source: 'missing',
        currencyCode: row.costBasis.currencyCode,
      },
    });
  }

  function handleAddProduct(): void {
    const row = addRow();
    openProductPicker(row.id);
  }

  function handleTare(): void {
    if (!activeRow) return;
    setTareOffset(ble.liveWeight?.grams ?? 0);
    startRowReweigh(activeRow.id);
  }

  function handleReweigh(): void {
    if (!activeRow) return;
    setTareOffset(0);
    startRowReweigh(activeRow.id);
  }

  async function handleSaveDraft(): Promise<void> {
    setSavingDraft(true);
    say('Saving draft...');
    try {
      const saved = saveDraft();
      // Persist to the salon record whenever the draft belongs to a real
      // appointment/visit — the station's local copy is temporary UI only.
      if (draftHasDurableContext(saved)) {
        const active = await getActiveLabSession();
        if (active) {
          await saveDraftFormulaForLabSession(active.sessionId, toSavePayload());
          say(
            `Draft saved to salon records ${formatTime(saved.savedAt)} · ${saved.rows.length} rows · no billing or inventory changes yet`,
            'success',
          );
          return;
        }
      }
      say(
        `Draft saved on this station only ${formatTime(saved.savedAt)} · ${saved.rows.length} rows · no billing or inventory changes yet`,
        'success',
      );
    } catch (err: unknown) {
      // The local save above already succeeded — only the salon-record sync failed.
      const reason = err instanceof Error ? err.message : 'network error';
      say(`Draft kept on this station — could not sync to salon records (${reason})`, 'danger');
    } finally {
      setSavingDraft(false);
    }
  }

  function handleReviewAndBill(): void {
    if (!hasCapturedWeight) {
      say('Weigh at least one ingredient before reviewing the bill.', 'danger');
      return;
    }
    // Hand off to the Mix Finalized review screen, which owns billing and the
    // finalize call. The draft is shared via the store, so no params are needed.
    navigation.navigate('MixFinalized');
  }

  async function handleLoadDraft(): Promise<void> {
    // `loadDraft` replaces the live draft wholesale, so every gram captured
    // since the last manual save is gone — and this button sits immediately
    // beside "Save draft" on a four-button row. Captured weights are the one
    // irreversible thing on this screen, so ask first, and only when there is
    // in-flight work to lose.
    const capturedNow = draft.rows.filter((row) => row.capturedGrams != null).length;
    if (capturedNow > 0) {
      const confirmed = await confirmDestructive({
        title: 'Reopen the saved draft?',
        message:
          capturedNow === 1
            ? 'The 1 weight captured since the last save will be discarded and replaced by the saved draft.'
            : `The ${capturedNow} weights captured since the last save will be discarded and replaced by the saved draft.`,
        confirmLabel: 'Discard and reopen',
      });
      if (!confirmed) return;
    }
    const loaded = loadDraft();
    say(
      loaded ? `Draft reopened ${formatTime(loaded.savedAt)}` : 'No saved draft in this session',
      loaded ? 'success' : 'danger',
    );
  }

  function handleLastFormula(): void {
    const latest = getLatestFormulaForClient();
    setPreviousFormula(latest);
    say(
      latest
        ? `Loaded latest formula from ${new Date(latest.savedAt).toLocaleDateString()}`
        : 'No previous formula saved for this client yet',
      latest ? 'success' : 'progress',
    );
  }

  function handleDuplicatePreviousFormula(): void {
    if (!previousFormula) return;
    const duplicated = duplicateFormula(previousFormula.id);
    say(
      duplicated ? 'Duplicated previous formula into editable draft' : 'Could not duplicate that formula in this session',
      duplicated ? 'success' : 'danger',
    );
  }

  const isFinalized = draft.status === 'saved';
  const hasCapturedWeight = draft.rows.some((row) => row.capturedGrams != null);

  const consoleColumn = (
    <View style={[styles.column, { gap: layout.gap }]}>
      <ScaleConsoleCard
        ringSize={metrics.ringSize}
        weightLabel={activeWeightLabel}
        ringState={ringState}
        progress={ringProgress}
        target={activeTarget}
        hasActiveRow={Boolean(activeRow)}
        stable={ble.liveWeight?.stable}
        savedAt={draft.savedAt}
        onTare={handleTare}
        onReweigh={handleReweigh}
      />
      {activeRow ? (
        <ActiveIngredientCard
          row={activeRow}
          manualValue={manualInputs[activeRow.id] ?? ''}
          onMetadataChange={(metadata) => updateRowMetadata(activeRow.id, metadata)}
          onOpenProductPicker={() => openProductPicker(activeRow.id)}
          onUseManualIdentity={() => switchRowToManual(activeRow)}
          onManualChange={(value) => updateManualInput(activeRow.id, value)}
          onManualSubmit={() => submitManualWeight(activeRow.id)}
          onRemove={draft.rows.length > 1 ? () => removeRow(activeRow.id) : undefined}
        />
      ) : null}
      {previousFormula ? (
        <PreviousFormulaCard formula={previousFormula} onDuplicate={handleDuplicatePreviousFormula} />
      ) : null}
    </View>
  );

  const railColumn = (
    <View style={[styles.column, { gap: layout.gap }]}>
      <FormulaQueueCard
        rows={draft.rows}
        activeId={draft.activeIngredientId}
        activeIndex={activeIndex}
        onSelect={(rowId, captured) => {
          if (captured) startRowReweigh(rowId);
          else selectActiveRow(rowId);
        }}
        onLastFormula={handleLastFormula}
      />
      <SessionProgressCard
        fraction={sessionTotals.fraction}
        totalTarget={sessionTotals.totalTarget}
        totalCaptured={sessionTotals.totalCaptured}
        itemCount={labCoreDraft.items.length}
        remixBaseline={draft.remixBaseline}
      />
      <MixTipCard />
    </View>
  );

  // The notice strip and the live weighing bar both stay pinned below the
  // scroll area. The product picker rides along: it renders as an overlay, so
  // it belongs outside the scrolling content, exactly where it sat before.
  const pinnedBar = (
    <>
      <View style={styles.noticeBar}>
        <Text style={[styles.noticeText, NOTICE_TONE_STYLE[notice.tone]]} numberOfLines={2}>
          {notice.text}
        </Text>
      </View>

      <BottomBar
        totalCaptured={sessionTotals.totalCaptured}
        chargeCents={draft.billableChargeCents}
        pricesReady={billingSettings != null}
        currencyCode={draft.currencyCode}
        savingDraft={savingDraft}
        reviewDisabled={savingDraft || !hasCapturedWeight}
        finalized={isFinalized}
        onAddProduct={handleAddProduct}
        onSaveDraft={() => void handleSaveDraft()}
        onReopenDraft={() => void handleLoadDraft()}
        onReview={handleReviewAndBill}
      />

      <ProductPickerModal
        visible={Boolean(pickerRow)}
        products={products}
        loading={productsLoading}
        error={productsError}
        search={productSearch}
        row={pickerRow}
        unitFactor={unitBillingFactor(billingSettings)}
        onSearchChange={setProductSearch}
        onClose={() => setProductPickerRowId(undefined)}
        onRetry={() => void loadProducts(productSearch)}
        onSelect={(product) => {
          if (!pickerRow) return;
          selectProductForRow(pickerRow.id, product);
        }}
      />
    </>
  );

  return (
    <LabShell
      session={session}
      bleStatus={ble.status}
      labSessionId={entryContext?.labSessionId}
      footer={<Footer now={now} scaleConnected={scaleConnected} online={session?.status === 'active'} />}
      bottomBar={pinnedBar}
    >
      <ContextHeader
        formulaId={draft.id}
        title={activeRow ? formatRowDisplayName(activeRow) : 'Select an ingredient'}
        detail={activeRow?.developer}
        stepIndex={activeIndex}
        stepCount={draft.rows.length}
        scaleConnected={scaleConnected}
        scaleName={ble.connectedDevice?.name}
        scaleStatus={ble.error ?? ble.status}
      />

      {metrics.twoColumn ? (
        <View style={[styles.columns, { gap: layout.gap }]}>
          <View style={styles.consoleColumn}>{consoleColumn}</View>
          <View style={{ width: metrics.railWidth }}>{railColumn}</View>
        </View>
      ) : (
        <View style={[styles.column, { gap: layout.gap }]}>
          {consoleColumn}
          {railColumn}
        </View>
      )}
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Chrome — context header and footer (LabShell owns the top bar and nav)
// ---------------------------------------------------------------------------

function ContextHeader({
  formulaId,
  title,
  detail,
  stepIndex,
  stepCount,
  scaleConnected,
  scaleName,
  scaleStatus,
}: {
  formulaId: string;
  title: string;
  detail?: string;
  stepIndex: number;
  stepCount: number;
  scaleConnected: boolean;
  scaleName?: string;
  scaleStatus: string;
}): React.JSX.Element {
  const step = stepCount > 0 ? Math.max(1, stepIndex + 1) : 1;
  return (
    <View style={styles.contextHeader}>
      <View style={styles.contextText}>
        <View style={styles.contextMetaRow}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeText}>Step {step} of {Math.max(stepCount, 1)}</Text>
          </View>
          <Text style={styles.contextId}>Formula ID · {formatFormulaId(formulaId)}</Text>
        </View>
        <Text style={styles.contextTitle} numberOfLines={2}>
          {title}
          {detail ? <Text style={styles.contextTitleDetail}>  /  {detail}</Text> : null}
        </Text>
      </View>

      <View style={styles.scalePill}>
        <View style={[styles.scalePillDot, { backgroundColor: scaleConnected ? C.success.text : C.textMuted }]} />
        <View>
          <Text style={styles.scalePillLabel}>{(scaleName ?? 'Precision scale').toUpperCase()}</Text>
          <Text style={styles.scalePillStatus}>{scaleConnected ? 'Connected · live' : capitalize(scaleStatus)}</Text>
        </View>
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
// Scale console — the live readout dial + tare/reweigh
// ---------------------------------------------------------------------------

function ScaleConsoleCard({
  ringSize,
  weightLabel,
  ringState,
  progress,
  target,
  hasActiveRow,
  stable,
  savedAt,
  onTare,
  onReweigh,
}: {
  ringSize: number;
  weightLabel: string;
  ringState: RingState;
  progress: number;
  target?: number;
  hasActiveRow: boolean;
  stable?: boolean;
  savedAt?: string;
  onTare: () => void;
  onReweigh: () => void;
}): React.JSX.Element {
  const accent = ringStateColor(ringState);
  const caption =
    target && target > 0
      ? `of ${target.toFixed(1)} g target`
      : ringState === 'captured'
        ? 'Captured weight'
        : ringState === 'live'
          ? 'Live capture'
          : 'Place product on the scale';

  return (
    <View style={styles.consoleCard}>
      <ScaleDial size={ringSize} accent={accent} progress={progress} weightLabel={weightLabel} caption={caption} />

      <View style={styles.consoleButtons}>
        <ConsoleButton icon="minus" label="Tare" onPress={onTare} disabled={!hasActiveRow} />
        <ConsoleButton icon="refresh" label="Reweigh" onPress={onReweigh} disabled={!hasActiveRow} />
      </View>

      <View style={styles.consoleFooter}>
        <View style={styles.consoleFooterItem}>
          {savedAt ? <Icon name="check" size="xs" tone="muted" /> : null}
          <Text style={styles.consoleFooterText}>
            {/* NOT automatic. `saveDraft()` has exactly two call sites in the
                app and both are explicit button handlers, so this said "Saved
                automatically" over work that was only in memory — on the one
                screen where the operator's captured grams are irreversible. */}
            {savedAt ? `Draft saved ${formatTime(savedAt)}` : 'Not saved yet — use Save draft'}
          </Text>
        </View>
        <View style={styles.consoleFooterItem}>
          {stable ? <Icon name="scale" size="xs" tone="success" /> : null}
          <Text style={[styles.consoleFooterText, stable && styles.consoleFooterStable]}>
            {stable ? 'Stable weight detected' : 'Awaiting stable weight'}
          </Text>
        </View>
      </View>
    </View>
  );
}

function ScaleDial({
  size,
  accent,
  progress,
  weightLabel,
  caption,
}: {
  size: number;
  accent: string;
  progress: number;
  weightLabel: string;
  caption: string;
}): React.JSX.Element {
  const stroke = Math.max(10, Math.round(size * 0.055));
  const numberSize = Math.round(size * 0.27);
  return (
    <ProgressRing size={size} strokeWidth={stroke} progress={progress} color={accent} trackColor={C.border} holeColor={C.card}>
      <View style={styles.dialNumberRow}>
        <Text style={[styles.dialNumber, { fontSize: numberSize }]} numberOfLines={1} adjustsFontSizeToFit>
          {weightLabel}
        </Text>
        <Text style={styles.dialUnit}>g</Text>
      </View>
      <Text style={styles.dialCaption} numberOfLines={2}>
        {caption}
      </Text>
    </ProgressRing>
  );
}

/**
 * Pure-RN circular progress arc (no SVG). The filled wedge sweeps clockwise
 * from 12 o'clock by `progress` (0..1), drawn as two clipped half-discs that
 * rotate about the circle centre, with a centre "donut hole" punched out to
 * leave a ring. The unfilled remainder shows `trackColor`.
 */
function ProgressRing({
  size,
  strokeWidth,
  progress,
  color,
  trackColor,
  holeColor,
  children,
}: {
  size: number;
  strokeWidth: number;
  progress: number;
  color: string;
  trackColor: string;
  holeColor: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const half = size / 2;
  const angle = clampNumber(progress, 0, 1) * 360;
  const rotateRight = Math.min(angle, 180);
  const rotateLeft = Math.max(angle - 180, 0);
  const innerSize = size - strokeWidth * 2;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Track */}
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: half, backgroundColor: trackColor }} />

      {/* Right half — fills 0–50% */}
      <View style={[styles.ringClip, { width: half, height: size, left: half }]}>
        <View style={{ position: 'absolute', width: size, height: size, left: -half, transform: [{ rotate: `${rotateRight}deg` }] }}>
          <View
            style={{
              position: 'absolute',
              width: half,
              height: size,
              left: 0,
              backgroundColor: color,
              borderTopLeftRadius: half,
              borderBottomLeftRadius: half,
            }}
          />
        </View>
      </View>

      {/* Left half — fills 50–100% */}
      <View style={[styles.ringClip, { width: half, height: size, left: 0 }]}>
        <View style={{ position: 'absolute', width: size, height: size, left: 0, transform: [{ rotate: `${rotateLeft}deg` }] }}>
          <View
            style={{
              position: 'absolute',
              width: half,
              height: size,
              left: half,
              backgroundColor: color,
              borderTopRightRadius: half,
              borderBottomRightRadius: half,
            }}
          />
        </View>
      </View>

      {/* Donut hole */}
      <View style={{ position: 'absolute', width: innerSize, height: innerSize, borderRadius: innerSize / 2, backgroundColor: holeColor }} />

      {/* Centre content */}
      <View style={{ width: innerSize - 12, alignItems: 'center', justifyContent: 'center', gap: 4 }}>{children}</View>
    </View>
  );
}

function ConsoleButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.consoleButton,
        pressed && !disabled && styles.consoleButtonPressed,
        disabled && styles.consoleButtonDisabled,
      ]}
    >
      <Icon name={icon} size="sm" tone="primary" />
      <Text style={styles.consoleButtonLabel}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Active ingredient editor (for the selected row)
// ---------------------------------------------------------------------------

function ActiveIngredientCard({
  row,
  manualValue,
  onMetadataChange,
  onOpenProductPicker,
  onUseManualIdentity,
  onManualChange,
  onManualSubmit,
  onRemove,
}: {
  row: FormulaIngredientRow;
  manualValue: string;
  onMetadataChange: (metadata: FormulaRowMetadataUpdate) => void;
  onOpenProductPicker: () => void;
  onUseManualIdentity: () => void;
  onManualChange: (value: string) => void;
  onManualSubmit: () => void;
  onRemove?: () => void;
}): React.JSX.Element {
  const manualDisabled = manualValue.trim().length === 0 || Number.isNaN(Number(manualValue));
  const isManualIdentity = row.identityMode === 'custom_manual';
  const productMeta = [row.brand, row.category, row.sku ? `SKU ${row.sku}` : undefined].filter(Boolean).join(' · ');
  // No raw figure here — material cost is internal (owner/manager) data; the
  // stylist only needs to know whether a cost basis exists for billing.
  const costBasisLabel =
    row.costBasis.costPerGramCents == null ? 'No product cost on record' : 'Costed from inventory';

  return (
    <View style={styles.card}>
      <View style={styles.cardHeadRow}>
        <Text style={styles.cardEyebrow}>Active ingredient</Text>
        <StatusChip label={formatCaptureStatus(row.captureStatus)} tone={captureTone(row.captureStatus)} />
      </View>

      {isManualIdentity ? (
        <View style={styles.subCard}>
          <Text style={styles.fieldLabel}>Custom ingredient</Text>
          <TextInput
            onChangeText={(productName) => onMetadataChange({ ...row, productName })}
            placeholder="Custom ingredient name"
            placeholderTextColor={C.inputPlaceholder}
            style={styles.input}
            value={row.productName}
          />
          <View style={styles.metadataGrid}>
            <Field label="Brand / supplier" style={styles.fieldWide}>
              <TextInput
                onChangeText={(brand) => onMetadataChange({ ...row, brand })}
                placeholder="e.g. Wella"
                placeholderTextColor={C.inputPlaceholder}
                style={styles.input}
                value={row.brand ?? ''}
              />
            </Field>
            {/* POUNDS, not pence. This field used to take pence while the
                inventory product form takes pounds behind a £ prefix — both
                writing the same `costPerGramCents`. An operator who had just
                typed 0.12 there (twelve pence) and typed 0.12 here priced the
                ingredient at 0.12 PENCE per gram: a 100x under-charge, accepted
                in silence. One convention, and it is the one with the £ on it. */}
            <Field label="Cost / g (£)" style={styles.fieldNarrow}>
              <DecimalInput
                accessibilityLabel="Cost per gram in pounds"
                style={styles.input}
                value={
                  row.costBasis.source === 'manual_cost' && row.costBasis.costPerGramCents != null
                    ? row.costBasis.costPerGramCents / 100
                    : undefined
                }
                onChangeNumber={(pounds) =>
                  onMetadataChange({
                    ...row,
                    costBasis: {
                      source: pounds == null ? 'missing' : 'manual_cost',
                      costPerGramCents: pounds == null ? undefined : Math.round(pounds * 100),
                      currencyCode: row.costBasis.currencyCode,
                    },
                  })
                }
              />
            </Field>
          </View>
          <OutlineButton label="Select catalogue product instead" onPress={onOpenProductPicker} />
        </View>
      ) : (
        <View style={styles.subCard}>
          <Text style={styles.fieldLabel}>Product data</Text>
          <Text style={styles.productTitle}>{row.displayName ?? (row.productName || 'No product selected')}</Text>
          <Text style={styles.meta}>{productMeta || 'Brand / category / SKU autofills after selection.'}</Text>
          <Text style={row.costBasis.costPerGramCents == null ? styles.costMissing : styles.costBasis}>
            {costBasisLabel}
          </Text>
          <View style={styles.productActions}>
            <View style={styles.flexItem}>
              <OutlineButton label={row.productId ? 'Change product' : 'Select product'} onPress={onOpenProductPicker} />
            </View>
            <Pressable accessibilityRole="button" onPress={onUseManualIdentity} style={styles.textAction}>
              <Text style={styles.textActionLabel}>Custom ingredient</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.metadataGrid}>
        <Field label="Developer / metadata" style={styles.fieldWide}>
          <TextInput
            onChangeText={(developer) => onMetadataChange({ ...row, developer })}
            placeholder="e.g. 20 Vol (6%)"
            placeholderTextColor={C.inputPlaceholder}
            style={styles.input}
            value={row.developer ?? ''}
          />
        </Field>
        <Field label="Waste (g)" style={styles.fieldNarrow}>
          <DecimalInput
            accessibilityLabel="Waste in grams"
            style={styles.input}
            value={row.wasteGrams}
            onChangeNumber={(wasteGrams) => onMetadataChange({ ...row, wasteGrams })}
          />
        </Field>
      </View>

      <Field label="Manual override (g)">
        <View style={styles.manualRow}>
          <TextInput
            keyboardType="decimal-pad"
            onChangeText={onManualChange}
            placeholder="Manual grams"
            placeholderTextColor={C.inputPlaceholder}
            style={[styles.input, styles.flexItem]}
            value={manualValue}
          />
          <View style={styles.manualButton}>
            <OutlineButton label="Use manual" onPress={onManualSubmit} disabled={manualDisabled} />
          </View>
        </View>
      </Field>

      <Field label="Notes">
        <TextInput
          onChangeText={(notes) => onMetadataChange({ ...row, notes })}
          placeholder="Application notes…"
          placeholderTextColor={C.inputPlaceholder}
          style={styles.notesInput}
          multiline
          value={row.notes ?? ''}
        />
      </Field>

      {onRemove ? (
        <Pressable accessibilityRole="button" onPress={onRemove} style={styles.removeAction} hitSlop={6}>
          <Text style={styles.removeActionLabel}>Remove ingredient</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Formula queue rail
// ---------------------------------------------------------------------------

function FormulaQueueCard({
  rows,
  activeId,
  activeIndex,
  onSelect,
  onLastFormula,
}: {
  rows: FormulaIngredientRow[];
  activeId?: string;
  activeIndex: number;
  onSelect: (rowId: string, captured: boolean) => void;
  onLastFormula: () => void;
}): React.JSX.Element {
  const step = rows.length > 0 ? Math.max(1, activeIndex + 1) : 1;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeadRow}>
        <Text style={styles.cardEyebrow}>Formula queue</Text>
        <View style={styles.stepBadge}>
          <Text style={styles.stepBadgeText}>Step {step} of {Math.max(rows.length, 1)}</Text>
        </View>
      </View>

      <View style={styles.queueList}>
        {rows.map((row, index) => (
          <QueueRow
            key={row.id}
            row={row}
            index={index}
            active={row.id === activeId}
            onPress={() => onSelect(row.id, row.captureStatus === 'captured')}
          />
        ))}
      </View>

      <OutlineButton icon="history" label="Load last formula" onPress={onLastFormula} />
    </View>
  );
}

function QueueRow({
  row,
  index,
  active,
  onPress,
}: {
  row: FormulaIngredientRow;
  index: number;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const captured = row.captureStatus === 'captured';
  const live = active && row.captureStatus !== 'captured';
  const tone: ChipTone = captured ? 'success' : live ? 'brand' : 'neutral';
  const stepIcon: IconName | undefined = captured ? 'check' : live ? 'dot' : undefined;
  const palette = chipToneStyle(tone);
  const name = formatRowDisplayName(row);
  const sub = [row.brand, row.developer].filter(Boolean).join(' · ');
  const showActual = row.capturedGrams != null;
  const grams = showActual ? `${row.capturedGrams!.toFixed(1)}g` : row.plannedGrams != null ? `${row.plannedGrams.toFixed(0)}g` : '—';
  const gramsLabel = showActual ? 'Actual' : row.plannedGrams != null ? 'Target' : 'Set';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.queueRow, active && styles.queueRowActive]}
    >
      <View style={[styles.queueIcon, { backgroundColor: palette.bg, borderColor: palette.border }]}>
        {stepIcon ? (
          <Icon name={stepIcon} size="xs" tone="inherit" color={palette.text} />
        ) : (
          <Text style={[styles.queueIconText, { color: palette.text }]}>{String(index + 1)}</Text>
        )}
      </View>
      <View style={styles.queueInfo}>
        <Text style={styles.queueName} numberOfLines={1}>
          {name}
        </Text>
        {sub ? (
          <Text style={styles.queueSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <View style={styles.queueGrams}>
        <Text style={[styles.queueGramsValue, captured && styles.queueGramsCaptured]}>{grams}</Text>
        <Text style={styles.queueGramsLabel}>{gramsLabel}</Text>
      </View>
    </Pressable>
  );
}

function SessionProgressCard({
  fraction,
  totalTarget,
  totalCaptured,
  itemCount,
  remixBaseline,
}: {
  fraction: number;
  totalTarget: number;
  totalCaptured: number;
  itemCount: number;
  remixBaseline?: FormulaRemixBaseline;
}): React.JSX.Element {
  const pct = Math.round(fraction * 100);
  return (
    <View style={styles.card}>
      <View style={styles.cardHeadRow}>
        <Text style={styles.cardEyebrow}>Session progress</Text>
        <Text style={styles.progressPct}>{pct}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: C.primary }]} />
      </View>
      <View style={styles.sessionStatsRow}>
        <Text style={styles.sessionStat}>
          {totalCaptured.toFixed(1)} g captured · {itemCount} {itemCount === 1 ? 'item' : 'items'}
        </Text>
        {totalTarget > 0 ? (
          <Text style={styles.sessionStat}>Target {totalTarget.toFixed(1)} g</Text>
        ) : null}
      </View>
      {remixBaseline ? (
        <View style={styles.sessionStatsRow}>
          <Text style={styles.sessionStat}>Previous mix {remixBaseline.totalGrams.toFixed(1)} g</Text>
          <Text style={styles.sessionStatStrong}>
            Combined {(remixBaseline.totalGrams + totalCaptured).toFixed(1)} g
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function MixTipCard(): React.JSX.Element {
  return (
    <View style={styles.tipCard}>
      <View style={styles.tipHead}>
        <Icon name="info" size="sm" tone="primary" />
        <Text style={styles.tipTitle}>Mix tip</Text>
      </View>
      <Text style={styles.tipBody}>
        Pour slowly once you are within 5 g of the target to maximise precision and minimise chemical waste.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bottom action bar
// ---------------------------------------------------------------------------

function BottomBar({
  totalCaptured,
  chargeCents,
  pricesReady,
  currencyCode,
  savingDraft,
  reviewDisabled,
  finalized,
  onAddProduct,
  onSaveDraft,
  onReopenDraft,
  onReview,
}: {
  totalCaptured: number;
  chargeCents: number;
  /** False until the location billing settings load — money renders as "—". */
  pricesReady: boolean;
  currencyCode: string;
  savingDraft: boolean;
  reviewDisabled: boolean;
  finalized: boolean;
  onAddProduct: () => void;
  onSaveDraft: () => void;
  onReopenDraft: () => void;
  onReview: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.bottomBar}>
      <View style={styles.bottomSummary}>
        <Text style={styles.bottomGrams}>{totalCaptured.toFixed(1)} g</Text>
        {/* Fail closed: with billing settings unloaded the preview is raw cost. */}
        <Text style={styles.bottomCharge}>
          {pricesReady ? `${formatMoney(chargeCents, currencyCode)} charge` : '— charge'}
        </Text>
      </View>
      <View style={styles.bottomActions}>
        <BottomButton icon="plus" label="Add product" onPress={onAddProduct} />
        <BottomButton icon="archive" label={savingDraft ? 'Saving…' : 'Save draft'} onPress={onSaveDraft} disabled={savingDraft} />
        <BottomButton label="Reopen" onPress={onReopenDraft} />
        <Pressable
          accessibilityRole="button"
          disabled={reviewDisabled}
          onPress={onReview}
          style={({ pressed }) => [
            styles.completeButton,
            pressed && !reviewDisabled && styles.completeButtonPressed,
            reviewDisabled && styles.completeButtonDisabled,
          ]}
        >
          <Text style={styles.completeButtonText}>{finalized ? 'View Bill' : 'Review & Bill'}</Text>
          <Icon name="arrowRight" size="xs" tone="inherit" color={C.textOnPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

function BottomButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon?: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.bottomButton,
        pressed && !disabled && styles.bottomButtonPressed,
        disabled && styles.bottomButtonDisabled,
      ]}
    >
      {icon ? <Icon name={icon} size="xs" tone="secondary" /> : null}
      <Text style={styles.bottomButtonLabel}>{label}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Product picker modal
// ---------------------------------------------------------------------------

interface ProductPickerModalProps {
  visible: boolean;
  products: InventoryProduct[];
  loading: boolean;
  error?: string;
  search: string;
  row?: FormulaIngredientRow;
  unitFactor: number | null;
  onSearchChange: (value: string) => void;
  onClose: () => void;
  onRetry: () => void;
  onSelect: (product: InventoryProduct) => void;
}

function ProductPickerModal({
  visible,
  products,
  loading,
  error,
  search,
  row,
  unitFactor,
  onSearchChange,
  onClose,
  onRetry,
  onSelect,
}: ProductPickerModalProps): React.JSX.Element {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.productPicker}>
          <View style={styles.modalHandle} />
          <View style={styles.cardHeadRow}>
            <View style={styles.flexItem}>
              <Text style={styles.cardEyebrow}>Select product</Text>
              <Text style={styles.modalTitle}>{row?.productName || 'Inventory catalogue'}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.closeButton}
              hitSlop={8}
            >
              <Icon name="close" size="sm" tone="secondary" />
            </Pressable>
          </View>
          <TextInput
            autoCapitalize="none"
            onChangeText={onSearchChange}
            placeholder="Search brand, shade, SKU or category"
            placeholderTextColor={C.inputPlaceholder}
            style={styles.searchInput}
            value={search}
          />
          {loading ? <Text style={styles.meta}>Loading products...</Text> : null}
          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              <OutlineButton label="Retry" onPress={onRetry} />
            </View>
          ) : null}
          {!loading && !error && products.length === 0 ? (
            <Text style={styles.meta}>No matching inventory products. Use custom ingredient only if this is not catalogued.</Text>
          ) : null}
          <ScrollView contentContainerStyle={styles.productList} keyboardShouldPersistTaps="handled">
            {products.map((product) => (
              <ProductResult
                key={product.id}
                product={product}
                unitFactor={unitFactor}
                onPress={() => onSelect(product)}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ProductResult({
  product,
  unitFactor,
  onPress,
}: {
  product: InventoryProduct;
  unitFactor: number | null;
  onPress: () => void;
}): React.JSX.Element {
  const meta = [
    product.brand,
    product.category,
    product.sku ? `SKU ${product.sku}` : undefined,
    product.sizeValue ? `${product.sizeValue}${product.sizeUnit}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  // Billable £/g (never the raw cost); a rule with no per-gram price (fixed
  // uplift) shows neutral copy instead.
  const priceLabel =
    product.defaultCostPerGramCents == null
      ? 'Missing cost basis'
      : unitFactor == null
        ? 'Costed from inventory'
        : `${formatUnitMoney(product.defaultCostPerGramCents * unitFactor)}/g`;

  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.productResult}>
      <Text style={styles.productTitle}>{formatProductDisplayName(product)}</Text>
      <Text style={styles.meta}>{meta || 'Inventory product'}</Text>
      <Text style={product.defaultCostPerGramCents == null ? styles.costMissing : styles.costBasis}>
        {priceLabel}
      </Text>
    </Pressable>
  );
}

function PreviousFormulaCard({
  formula,
  onDuplicate,
}: {
  formula: SavedFormulaRecord;
  onDuplicate: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.previousCard}>
      <View style={styles.cardHeadRow}>
        <View style={styles.flexItem}>
          <Text style={styles.cardEyebrow}>Last formula</Text>
          <Text style={styles.modalTitle}>{new Date(formula.savedAt).toLocaleDateString()}</Text>
        </View>
        {/* Billable charge, not the internal material cost. */}
        <Text style={styles.previousTotal}>
          {formatMoney(formula.billableChargeCents ?? formula.totalCostCents, formula.currencyCode)}
        </Text>
      </View>
      {formula.rows.slice(0, 3).map((row) => (
        <Text key={row.id} style={styles.meta}>
          {formatRowDisplayName(row)} · {row.capturedGrams?.toFixed(1) ?? '--'} g
        </Text>
      ))}
      <OutlineButton label="Duplicate into current mix" onPress={onDuplicate} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

type RingState = 'waiting' | 'live' | 'on-target' | 'over' | 'captured';

function resolveRingState(row?: FormulaIngredientRow): RingState {
  if (!row || row.capturedGrams == null) return 'waiting';
  const captured = row.capturedGrams;
  const target = row.plannedGrams;
  if (row.captureStatus === 'captured') {
    if (target && target > 0 && captured > target + tolerance(target)) return 'over';
    return 'captured';
  }
  if (target && target > 0) {
    if (captured > target + tolerance(target)) return 'over';
    if (Math.abs(captured - target) <= tolerance(target)) return 'on-target';
  }
  return 'live';
}

function tolerance(target: number): number {
  return Math.max(1, target * 0.03);
}

function ringStateColor(state: RingState): string {
  switch (state) {
    case 'live':
      return C.primary;
    case 'on-target':
    case 'captured':
      return C.success.text;
    case 'over':
      return C.warning.text;
    default:
      return C.borderStrong;
  }
}

function chipToneStyle(tone: ChipTone): ToneTriple {
  // Delegates to the ONE implementation in src/theme/labTheme.ts. This was a
  // five-case switch, and it existed in four copies that had drifted apart on
  // `brand` and `neutral`.
  return resolveTone(tone);
}

function StatusChip({ label, tone }: { label: string; tone: ChipTone }): React.JSX.Element {
  const palette = chipToneStyle(tone);
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <View style={[styles.chipDot, { backgroundColor: palette.text }]} />
      <Text style={[styles.chipText, { color: palette.text }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function OutlineButton({
  label,
  onPress,
  icon,
  disabled,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.outlineButton,
        pressed && !disabled && styles.outlineButtonPressed,
        disabled && styles.outlineButtonDisabled,
      ]}
    >
      {icon ? <Icon name={icon} size="xs" tone="primary" /> : null}
      <Text style={styles.outlineButtonText}>{label}</Text>
    </Pressable>
  );
}

function Field({
  label,
  style,
  children,
}: {
  label: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatFormulaId(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
  return `#MIX-${tail || '0001'}`;
}

function capitalize(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function captureTone(status: FormulaRowCaptureStatus): ChipTone {
  if (status === 'captured') return 'success';
  if (status === 'live') return 'brand';
  return 'neutral';
}

function formatTime(value?: string): string {
  if (!value) return 'just now';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatProductDisplayName(product: InventoryProduct): string {
  return [product.brand, product.name].filter(Boolean).join(' · ') || product.name;
}

function formatRowDisplayName(row: FormulaIngredientRow): string {
  return row.displayName ?? (row.productName || 'Untitled ingredient');
}

function formatCaptureStatus(status: FormulaIngredientRow['captureStatus']): string {
  if (status === 'live') return 'Live capture';
  if (status === 'captured') return 'Captured';
  return 'Waiting for weight';
}

const styles = StyleSheet.create({
  column: { width: '100%' },

  columns: { flexDirection: 'row', alignItems: 'flex-start' },
  consoleColumn: { flex: 1 },

  // Context header
  contextHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: T.spacing.md,
    flexWrap: 'wrap',
  },
  contextText: { flex: 1, minWidth: 240, gap: 6 },
  contextMetaRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, flexWrap: 'wrap' },
  contextId: { color: C.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  contextTitle: { color: C.textPrimary, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  contextTitleDetail: { color: C.textMuted, fontSize: 22, fontWeight: '700' },
  stepBadge: {
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 4,
    borderRadius: T.radius.full,
    backgroundColor: C.primarySoft,
    borderWidth: 1,
    borderColor: C.primary,
  },
  stepBadgeText: { color: C.primary, fontSize: 11, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },
  scalePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    paddingVertical: T.spacing.sm,
    borderRadius: T.radius.pill,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  scalePillDot: { width: 8, height: 8, borderRadius: T.radius.full },
  scalePillLabel: { color: C.textPrimary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  scalePillStatus: { color: C.textMuted, fontSize: 11, fontWeight: '600' },

  // Cards
  card: {
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: T.radius.cardLg,
    backgroundColor: C.card,
  },
  cardHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.sm,
  },
  cardEyebrow: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  meta: { color: C.textSecondary, fontSize: 13 },

  // Scale console
  consoleCard: {
    gap: T.spacing.lg,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: C.primary,
    borderRadius: T.radius.cardLg,
    backgroundColor: C.card,
    alignItems: 'center',
  },
  ringClip: { position: 'absolute', top: 0, height: '100%', overflow: 'hidden' },
  dialNumberRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center' },
  dialNumber: { color: C.textPrimary, fontWeight: '800', letterSpacing: -2 },
  dialUnit: { color: C.textMuted, fontSize: 18, fontWeight: '700', paddingBottom: 6, marginLeft: 2 },
  dialCaption: { color: C.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center', paddingHorizontal: T.spacing.md },

  progressTrack: {
    alignSelf: 'stretch',
    height: 8,
    borderRadius: T.radius.full,
    backgroundColor: C.inputBg,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: T.radius.full },

  consoleButtons: { flexDirection: 'row', gap: T.spacing.md, alignSelf: 'stretch' },
  consoleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: T.spacing.sm,
    minHeight: 52,
    borderRadius: T.radius.inputLg,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.inputBg,
  },
  consoleButtonPressed: { opacity: 0.7 },
  consoleButtonDisabled: { opacity: 0.4 },
  consoleButtonLabel: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },
  consoleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    gap: T.spacing.sm,
    flexWrap: 'wrap',
  },
  consoleFooterItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  consoleFooterText: { color: C.textMuted, fontSize: 11, fontWeight: '700' },
  consoleFooterStable: { color: C.success.text },

  // Active ingredient editor
  subCard: {
    gap: 6,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: T.radius.card,
    backgroundColor: C.inputBg,
  },
  productTitle: { color: C.textPrimary, fontSize: 16, fontWeight: '800' },
  costBasis: { color: C.textSecondary, fontSize: 13, fontWeight: '600' },
  costMissing: { color: C.warning.text, fontSize: 13, fontWeight: '700' },
  productActions: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.md, marginTop: T.spacing.xs },
  textAction: { paddingVertical: T.spacing.xs },
  textActionLabel: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },

  field: { gap: 6 },
  fieldLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  metadataGrid: { flexDirection: 'row', gap: T.spacing.sm, flexWrap: 'wrap' },
  fieldWide: { flexGrow: 1, flexBasis: 200 },
  fieldNarrow: { flexGrow: 1, flexBasis: 96 },
  input: {
    minHeight: 48,
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.inputLg,
    backgroundColor: C.inputBg,
    color: C.textPrimary,
    fontSize: 15,
  },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  manualButton: { minWidth: 128 },
  flexItem: { flex: 1 },
  notesInput: {
    minHeight: 56,
    paddingHorizontal: T.spacing.md,
    paddingTop: T.spacing.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.inputLg,
    backgroundColor: C.inputBg,
    color: C.textPrimary,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  removeAction: { alignSelf: 'center', paddingVertical: T.spacing.sm, paddingHorizontal: T.spacing.md },
  removeActionLabel: { color: C.danger.text, fontSize: 13, fontWeight: '700' },

  // Queue
  queueList: { gap: T.spacing.sm },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    padding: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
  },
  queueRowActive: { borderColor: C.primary, backgroundColor: C.primarySoft },
  queueIcon: {
    width: 34,
    height: 34,
    borderRadius: T.radius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueIconText: { fontSize: 13, fontWeight: '800' },
  queueInfo: { flex: 1, gap: 2 },
  queueName: { color: C.textPrimary, fontSize: 14, fontWeight: '700' },
  queueSub: { color: C.textMuted, fontSize: 11 },
  queueGrams: { alignItems: 'flex-end' },
  queueGramsValue: { color: C.textSecondary, fontSize: 15, fontWeight: '800' },
  queueGramsCaptured: { color: C.success.text },
  queueGramsLabel: { color: C.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },

  // Session progress
  progressPct: { color: C.textPrimary, fontSize: 16, fontWeight: '800' },
  sessionStatsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: T.spacing.sm, flexWrap: 'wrap' },
  sessionStat: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase' },
  sessionStatStrong: { color: C.primary, fontSize: 11, fontWeight: '800', letterSpacing: 0.3, textTransform: 'uppercase' },

  // Mix tip
  tipCard: {
    gap: T.spacing.sm,
    padding: T.spacing.lg,
    borderRadius: T.radius.cardLg,
    borderWidth: 1,
    borderColor: C.primary,
    backgroundColor: C.primarySoft,
  },
  tipHead: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  tipTitle: { color: C.textPrimary, fontSize: 14, fontWeight: '800' },
  tipBody: { color: C.textSecondary, fontSize: 13, lineHeight: 19 },

  // Previous formula
  previousCard: {
    gap: T.spacing.sm,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: T.radius.cardLg,
    backgroundColor: C.card,
  },
  previousTotal: { color: C.primary, fontSize: 18, fontWeight: '800' },

  // Notice / status strip
  noticeBar: {
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.sm,
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  noticeText: { color: C.textMuted, fontSize: 12, fontWeight: '600' },
  // Only the colour changes: the strip keeps its size and position, so nothing
  // reflows as the tone changes mid-action.
  noticeSuccess: { color: C.successText },
  noticeDanger: { color: C.dangerText },

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
  bottomSummary: { flex: 1, minWidth: 120 },
  bottomGrams: { color: C.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  bottomCharge: { color: C.textMuted, fontSize: 12, fontWeight: '600' },
  bottomActions: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, flexWrap: 'wrap' },
  bottomButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 48,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.inputLg,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.card,
  },
  bottomButtonPressed: { opacity: 0.7 },
  bottomButtonDisabled: { opacity: 0.45 },
  bottomButtonLabel: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  completeButton: {
    flexDirection: 'row',
    gap: 6,
    minHeight: 48,
    paddingHorizontal: T.spacing.xl,
    borderRadius: T.radius.inputLg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  completeButtonPressed: { backgroundColor: C.primaryPressed },
  completeButtonDisabled: { backgroundColor: C.surfaceAlt },
  completeButtonText: { color: C.textOnPrimary, fontSize: 14, fontWeight: '900' },

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

  // Modal
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: C.overlay },
  productPicker: {
    maxHeight: '86%',
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderTopLeftRadius: T.radius.cardLg,
    borderTopRightRadius: T.radius.cardLg,
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderColor: C.border,
  },
  modalHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: T.radius.full, backgroundColor: C.borderStrong },
  modalTitle: { color: C.textPrimary, fontSize: 18, fontWeight: '800' },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchInput: {
    minHeight: 52,
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.inputLg,
    backgroundColor: C.inputBg,
    color: C.textPrimary,
    fontSize: 16,
  },
  productList: { gap: T.spacing.sm, paddingBottom: T.spacing.lg },
  productResult: {
    gap: 4,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: T.radius.card,
    backgroundColor: C.card,
  },
  errorCard: {
    gap: T.spacing.sm,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: C.danger.border,
    borderRadius: T.radius.card,
    backgroundColor: C.danger.bg,
  },
  errorText: { color: C.danger.text, fontSize: 14, fontWeight: '700' },

  // Chip
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 4,
    borderRadius: T.radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  chipDot: { width: 6, height: 6, borderRadius: T.radius.full },
  chipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },

  // Outline button
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.inputLg,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.card,
  },
  outlineButtonPressed: { opacity: 0.7 },
  outlineButtonDisabled: { opacity: 0.45 },
  outlineButtonText: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
});

const NOTICE_TONE_STYLE: Record<NoticeTone, TextStyle | undefined> = {
  progress: undefined,
  success: styles.noticeSuccess,
  danger: styles.noticeDanger,
};
