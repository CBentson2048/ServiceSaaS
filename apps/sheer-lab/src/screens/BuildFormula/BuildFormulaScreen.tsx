import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  InventoryLocationStock,
  InventoryProduct,
  LocationProductBillingSettings,
  PinUnlockResponse,
} from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import {
  calculateBillableChargeCents,
  formatUnitMoney,
  unitBillingFactor,
} from '../../features/formulas/formulaCosting';
import type { BuiltFormulaItemInput } from '../../features/formulas/formulaDraftStore';
import { formulaDraftStore } from '../../features/formulas/formulaDraftStore';
import { getLabProductBillingSettings } from '../../features/formulas/formulasApi';
import {
  listLabInventoryProducts,
  listLabInventoryStockForSession,
} from '../../features/inventory/productsApi';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import {
  formatClock,
  formatGrams,
  formatMoney,
  getInventoryTier,
} from '../Home/dashboardHelpers';
import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import { LabShell, useLabLayout } from '../shared/LabShell';

const T = labTheme;
const C = T.colors;

type BuildFormulaScreenProps = NativeStackScreenProps<RootStackParamList, 'BuildFormula'>;

/** A product the stylist has added to the mix, with its editable target weight. */
interface SelectionEntry {
  product: InventoryProduct;
  gramsText: string;
}

/** A selection entry with its derived costs for the current render. */
interface SelectionLine extends SelectionEntry {
  grams: number;
  costPerGramCents?: number;
  totalCents?: number;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function BuildFormulaScreen({ navigation, route }: BuildFormulaScreenProps): React.JSX.Element {
  const entryContext = route.params.entryContext;
  const sessionId = entryContext.labSessionId;

  const layout = useLabLayout();
  // The catalogue/selection split is this screen's own concern, so the rail
  // width stays here — the shared breakpoint model has no notion of it.
  const { width } = useWindowDimensions();
  const railWidth = clampNumber(Math.round(width * 0.3), 320, 420);
  const twoColumn = layout.isWide;

  const ble = useBleScale();
  const scaleConnected = ble.status === 'connected';

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [stockByProductId, setStockByProductId] = useState<Map<string, InventoryLocationStock>>(new Map());
  const [billing, setBilling] = useState<LocationProductBillingSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);

  const [selection, setSelection] = useState<SelectionEntry[]>([]);
  const [notes, setNotes] = useState('');
  const [notice, setNotice] = useState<string | undefined>();
  const [now, setNow] = useState<Date>(() => new Date());

  // Session (for the avatar/name) + stock + billing — loaded once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = await getActiveLabSession();
      if (cancelled) return;
      if (active) setSession(active);

      const [stockRes, billingRes] = await Promise.allSettled([
        listLabInventoryStockForSession(sessionId),
        getLabProductBillingSettings(sessionId),
      ]);
      if (cancelled) return;
      if (stockRes.status === 'fulfilled') {
        setStockByProductId(new Map(stockRes.value.stock.map((item) => [item.productId, item])));
      }
      if (billingRes.status === 'fulfilled') setBilling(billingRes.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Product catalogue — debounced on the search term (also performs the first load).
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await listLabInventoryProducts(sessionId, { q: search.trim() || undefined });
          if (cancelled) return;
          setProducts(res.products);
          setError(undefined);
        } catch (err: unknown) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Could not load the product catalogue.');
        } finally {
          if (!cancelled) {
            setSearching(false);
            setLoading(false);
          }
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [search, sessionId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const selectedIds = useMemo(() => new Set(selection.map((entry) => entry.product.id)), [selection]);

  const lines = useMemo<SelectionLine[]>(
    () =>
      selection.map((entry) => {
        const grams = parseGrams(entry.gramsText);
        const costPerGramCents = entry.product.defaultCostPerGramCents;
        const totalCents = costPerGramCents == null ? undefined : Math.round(grams * costPerGramCents);
        return { ...entry, grams, costPerGramCents, totalCents };
      }),
    [selection],
  );

  const totals = useMemo(() => {
    const totalGrams = lines.reduce((sum, line) => sum + line.grams, 0);
    const materialCents = lines.reduce((sum, line) => sum + (line.totalCents ?? 0), 0);
    const billableCents =
      materialCents > 0 ? calculateBillableChargeCents(materialCents, billing) : materialCents;
    const hasMissingCost = lines.some((line) => line.costPerGramCents == null && line.grams > 0);
    return { totalGrams, materialCents, billableCents, hasMissingCost };
  }, [lines, billing]);

  // Stylist-facing prices bake the location's billing rule in: raw material
  // cost and the markup split are internal (owner/manager) figures, so every
  // unit price and line total shown on this screen is the billable value.
  // unitFactor is the constant per-gram scaling (null when no per-gram price
  // may be shown — flat uplift, or billing settings not loaded — unit columns
  // then show "—" instead of leaking raw cost); lineFactor scales line totals,
  // distributing mix-level rules proportionally so the lines match the
  // Estimated Billing figure (within per-line rounding).
  // pricesReady fails CLOSED: until the location's billing settings load, no
  // £ amount is shown at all — a raw material total presented as a price is
  // exactly the leak this screen must prevent.
  const pricesReady = billing != null;
  const unitFactor = unitBillingFactor(billing);
  const lineFactor =
    unitFactor ?? (totals.materialCents > 0 ? totals.billableCents / totals.materialCents : 1);

  const canStartWeighing = selection.length > 0;

  const toggleProduct = useCallback((product: InventoryProduct) => {
    setSelection((current) => {
      if (current.some((entry) => entry.product.id === product.id)) {
        return current.filter((entry) => entry.product.id !== product.id);
      }
      return [...current, { product, gramsText: '' }];
    });
  }, []);

  const updateGrams = useCallback((productId: string, gramsText: string) => {
    setSelection((current) =>
      current.map((entry) => (entry.product.id === productId ? { ...entry, gramsText } : entry)),
    );
  }, []);

  const removeProduct = useCallback((productId: string) => {
    setSelection((current) => current.filter((entry) => entry.product.id !== productId));
  }, []);

  const handleStartWeighing = useCallback(() => {
    if (!canStartWeighing) return;
    const items: BuiltFormulaItemInput[] = lines.map((line) => ({
      productId: line.product.id,
      productName: line.product.name,
      brand: line.product.brand,
      shade: line.product.name,
      category: line.product.category,
      sku: line.product.sku,
      displayName: [line.product.brand, line.product.name].filter(Boolean).join(' · ') || line.product.name,
      costPerGramCents: line.costPerGramCents,
      plannedGrams: line.grams > 0 ? line.grams : undefined,
      currencyCode: 'GBP',
    }));

    formulaDraftStore.startBuiltFormula({
      labSessionId: sessionId,
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
      items,
      notes,
    });

    // Navigate without an entryContext so the capture screen keeps the seeded
    // draft instead of resetting it.
    navigation.navigate('Formula');
  }, [canStartWeighing, entryContext, lines, navigation, notes, sessionId]);

  const productGrid = (
    <ProductCatalogue
      products={products}
      stockByProductId={stockByProductId}
      selectedIds={selectedIds}
      unitFactor={unitFactor}
      loading={loading}
      searching={searching}
      error={error}
      search={search}
      onSearch={setSearch}
      onToggle={toggleProduct}
    />
  );

  const selectionPanel = (
    <View style={[styles.railColumn, { gap: layout.gap }]}>
      <CurrentSelectionCard
        lines={lines}
        unitFactor={unitFactor}
        lineFactor={lineFactor}
        pricesReady={pricesReady}
        totalGrams={totals.totalGrams}
        onGramsChange={updateGrams}
        onRemove={removeProduct}
      />
      <StylistNotesCard value={notes} onChange={setNotes} />
      <PricingBreakdownCard
        billableCents={totals.billableCents}
        pricesReady={pricesReady}
        hasMissingCost={totals.hasMissingCost}
      />
    </View>
  );

  return (
    <LabShell
      session={session}
      bleStatus={ble.status}
      labSessionId={entryContext.labSessionId}
      footer={<Footer now={now} scaleConnected={scaleConnected} online={session?.status === 'active'} />}
      bottomBar={
        <BottomBar
          totalGrams={totals.totalGrams}
          chargeCents={totals.billableCents}
          pricesReady={pricesReady}
          ready={canStartWeighing}
          onStart={handleStartWeighing}
        />
      }
    >
      <Header
        clientName={entryContext.clientName}
        serviceType={entryContext.serviceType}
        onViewHistory={() => navigation.navigate('FormulaHistory')}
        onSaveTemplate={() => setNotice('Saving mixes as reusable templates is coming soon.')}
      />

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      {twoColumn ? (
        <View style={[styles.columns, { gap: layout.gap }]}>
          <View style={styles.gridColumn}>{productGrid}</View>
          <View style={[styles.rail, { width: railWidth }]}>{selectionPanel}</View>
        </View>
      ) : (
        <View style={[styles.stack, { gap: layout.gap }]}>
          {productGrid}
          {selectionPanel}
        </View>
      )}
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Header + footer
// ---------------------------------------------------------------------------

function Header({
  clientName,
  serviceType,
  onViewHistory,
  onSaveTemplate,
}: {
  clientName: string;
  serviceType: string;
  onViewHistory: () => void;
  onSaveTemplate: () => void;
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
        <Text style={styles.title}>Build Formula</Text>
      </View>
      <View style={styles.headerActions}>
        <Pressable accessibilityRole="button" onPress={onViewHistory} style={styles.ghostButton}>
          <Icon name="history" size="xs" tone="primary" />
          <Text style={styles.ghostButtonText}>View History</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onSaveTemplate} style={styles.ghostButton}>
          <Icon name="plus" size="xs" tone="primary" />
          <Text style={styles.ghostButtonText}>Save Template</Text>
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
// Left column — product catalogue
// ---------------------------------------------------------------------------

function ProductCatalogue({
  products,
  stockByProductId,
  selectedIds,
  unitFactor,
  loading,
  searching,
  error,
  search,
  onSearch,
  onToggle,
}: {
  products: InventoryProduct[];
  stockByProductId: Map<string, InventoryLocationStock>;
  selectedIds: Set<string>;
  unitFactor: number | null;
  loading: boolean;
  searching: boolean;
  error?: string;
  search: string;
  onSearch: (value: string) => void;
  onToggle: (product: InventoryProduct) => void;
}): React.JSX.Element {
  return (
    <View style={styles.catalogue}>
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Icon name="search" size="sm" tone="muted" />
          <TextInput
            value={search}
            onChangeText={onSearch}
            autoCapitalize="none"
            placeholder="Search shade, code, or brand…"
            placeholderTextColor={C.inputPlaceholder}
            style={styles.searchInput}
          />
          {searching ? <ActivityIndicator size="small" color={C.primary} /> : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.gridLoading}>
          <ActivityIndicator color={C.primary} />
          <Text style={styles.muted}>Loading catalogue…</Text>
        </View>
      ) : error ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : products.length === 0 ? (
        <Text style={styles.muted}>
          {search ? 'No products match your search.' : 'No inventory products available for this location.'}
        </Text>
      ) : (
        <View style={styles.productGrid}>
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              stock={stockByProductId.get(product.id)}
              selected={selectedIds.has(product.id)}
              unitFactor={unitFactor}
              onPress={() => onToggle(product)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function ProductCard({
  product,
  stock,
  selected,
  unitFactor,
  onPress,
}: {
  product: InventoryProduct;
  stock?: InventoryLocationStock;
  selected: boolean;
  unitFactor: number | null;
  onPress: () => void;
}): React.JSX.Element {
  const code = productCode(product);
  const tier = stock ? getInventoryTier(stock) : undefined;
  const lowStock = tier ? tier.tone === 'warning' || tier.tone === 'danger' : false;
  // Billable price per gram; a rule with no per-gram price (fixed uplift)
  // shows no figure at all rather than leaking the raw cost.
  const costLabel =
    product.defaultCostPerGramCents == null
      ? 'No cost'
      : unitFactor == null
        ? null
        : `${formatUnitMoney(product.defaultCostPerGramCents * unitFactor)}/g`;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.productCard, selected && styles.productCardSelected]}
    >
      <View style={styles.productCardTop}>
        <Text style={styles.productBrand} numberOfLines={1}>
          {(product.brand ?? 'Product').toUpperCase()}
        </Text>
        {code ? (
          <View style={styles.codeBadge}>
            <Text style={styles.codeBadgeText}>{code}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.productName} numberOfLines={2}>
        {product.name}
      </Text>
      <View style={styles.productMetaRow}>
        <View style={styles.productStockRow}>
          {lowStock ? <Icon name="alert" size="xs" tone="warning" /> : null}
          <Text style={[styles.productStock, lowStock && styles.productStockLow]} numberOfLines={1}>
            Stock: {stock ? formatGrams(stock.quantityOnHandGrams) : '—'}
          </Text>
        </View>
        {selected ? (
          <View style={styles.addedTagRow}>
            <Icon name="check" size="xs" tone="brand" />
            <Text style={styles.addedTag}>Added</Text>
          </View>
        ) : null}
      </View>
      {costLabel != null ? (
        <Text style={[styles.productCost, product.defaultCostPerGramCents == null && styles.productCostMissing]}>
          {costLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Right column — current selection, notes, pricing
// ---------------------------------------------------------------------------

function CurrentSelectionCard({
  lines,
  unitFactor,
  lineFactor,
  pricesReady,
  totalGrams,
  onGramsChange,
  onRemove,
}: {
  lines: SelectionLine[];
  unitFactor: number | null;
  lineFactor: number;
  pricesReady: boolean;
  totalGrams: number;
  onGramsChange: (productId: string, value: string) => void;
  onRemove: (productId: string) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <View style={styles.selectionHeader}>
        <View style={styles.selectionHeaderText}>
          <Text style={styles.cardEyebrow}>Current Selection</Text>
          <Text style={styles.cardSub}>
            {lines.length} {lines.length === 1 ? 'product' : 'products'} added
          </Text>
        </View>
        <View style={styles.weightBadge}>
          <Text style={styles.weightBadgeText}>Total Weight {formatGrams(totalGrams)}</Text>
        </View>
      </View>

      {lines.length === 0 ? (
        <View style={styles.emptySelection}>
          <Icon name="flask" size="lg" tone="muted" />
          <Text style={styles.muted}>Tap products on the left to build the mix.</Text>
        </View>
      ) : (
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={[styles.th, styles.colProduct]}>Product / Shade</Text>
            <Text style={[styles.th, styles.colTarget]}>Target (g)</Text>
            <Text style={[styles.th, styles.colUnit]}>Unit £/g</Text>
            <Text style={[styles.th, styles.colTotal]}>Total</Text>
            <View style={styles.colRemove} />
          </View>
          {lines.map((line) => (
            <View key={line.product.id} style={styles.tableRow}>
              <View style={styles.colProduct}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {line.product.name}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {[line.product.brand, productCode(line.product)].filter(Boolean).join(' · ') || 'Inventory product'}
                </Text>
              </View>
              <View style={styles.colTarget}>
                <TextInput
                  value={line.gramsText}
                  onChangeText={(value) => onGramsChange(line.product.id, value)}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={C.inputPlaceholder}
                  style={styles.gramsInput}
                />
              </View>
              <Text style={[styles.td, styles.colUnit]} numberOfLines={1}>
                {line.costPerGramCents == null || unitFactor == null
                  ? '—'
                  : formatUnitMoney(line.costPerGramCents * unitFactor)}
              </Text>
              <Text
                style={[styles.tdStrong, styles.colTotal, line.costPerGramCents == null && styles.tdMissing]}
                numberOfLines={1}
              >
                {/* Fail closed: no £ figure until billing settings load. */}
                {!pricesReady
                  ? '—'
                  : line.totalCents == null
                    ? 'No cost'
                    : formatMoney(Math.round(line.totalCents * lineFactor))}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${line.product.name}`}
                onPress={() => onRemove(line.product.id)}
                hitSlop={8}
                style={styles.colRemove}
              >
                <Icon name="close" size="xs" tone="muted" />
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function StylistNotesCard({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>Stylist Notes</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        multiline
        placeholder="e.g. Applied to roots first, 15 min develop time…"
        placeholderTextColor={C.inputPlaceholder}
        style={styles.notesInput}
      />
    </View>
  );
}

// The material-cost/markup split is internal (owner/manager) data — the
// stylist-facing card shows only the final billable estimate, and nothing at
// all until the billing settings have loaded (fail closed).
function PricingBreakdownCard({
  billableCents,
  pricesReady,
  hasMissingCost,
}: {
  billableCents: number;
  pricesReady: boolean;
  hasMissingCost: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>Pricing Breakdown</Text>
      <View style={styles.pricingRow}>
        <Text style={styles.pricingTotalLabel}>Estimated Billing</Text>
        <Text style={styles.pricingTotalValue}>{pricesReady ? formatMoney(billableCents) : '—'}</Text>
      </View>
      {!pricesReady ? (
        <Text style={styles.pricingWarning}>Loading location pricing…</Text>
      ) : hasMissingCost ? (
        <Text style={styles.pricingWarning}>
          Some products have no cost on record — they are excluded from the estimate until set.
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pinned bottom bar — Start Weighing CTA
// ---------------------------------------------------------------------------

function BottomBar({
  totalGrams,
  chargeCents,
  pricesReady,
  ready,
  onStart,
}: {
  totalGrams: number;
  chargeCents: number;
  pricesReady: boolean;
  ready: boolean;
  onStart: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.bottomBar}>
      <View style={styles.bottomStatus}>
        <Text style={[styles.bottomEyebrow, ready && styles.bottomEyebrowReady]}>
          {ready ? 'READY FOR LAB' : 'ADD PRODUCTS'}
        </Text>
        <Text style={styles.bottomGrams}>{formatGrams(totalGrams)} Mixed Formula</Text>
      </View>
      <View style={styles.bottomCharge}>
        <Text style={styles.bottomChargeLabel}>CHARGE TOTAL</Text>
        <Text style={styles.bottomChargeValue}>{pricesReady ? formatMoney(chargeCents) : '—'}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={!ready}
        onPress={onStart}
        style={({ pressed }) => [
          styles.startButton,
          !ready && styles.startButtonDisabled,
          pressed && ready && styles.startButtonPressed,
        ]}
      >
        <Text style={styles.startButtonText}>Start Weighing</Text>
        <Icon name="arrowRight" size="sm" tone="inherit" color={C.textOnPrimary} />
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives + helpers
// ---------------------------------------------------------------------------


function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseGrams(value: string): number {
  const grams = Number(value);
  if (!Number.isFinite(grams) || grams < 0) return 0;
  return grams;
}

function productCode(product: InventoryProduct): string | undefined {
  const sku = product.sku?.trim();
  if (sku) return sku.slice(0, 6).toUpperCase();
  return undefined;
}

// unitBillingFactor / formatUnitMoney are shared from formulaCosting so every
// stylist-facing screen prices consistently.

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: T.spacing.md,
  },
  headerText: { gap: 4, minWidth: 240, flexShrink: 1 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  breadcrumbMuted: { color: C.textMuted, fontSize: 13 },
  breadcrumbStrong: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  breadcrumbSep: { color: C.textMuted, fontSize: 13 },
  title: { color: C.textPrimary, fontSize: 30, fontWeight: '900', letterSpacing: -0.5 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, flexWrap: 'wrap' },
  ghostButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  ghostButtonText: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  notice: { color: C.primary, fontSize: 13, fontWeight: '700' },

  // Columns
  columns: { flexDirection: 'row', alignItems: 'flex-start' },
  gridColumn: { flex: 1 },
  rail: {},
  railColumn: { width: '100%' },
  stack: { width: '100%' },

  // Catalogue
  catalogue: { gap: T.spacing.md },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.pill,
    paddingHorizontal: T.spacing.md,
    height: 46,
  },
  searchInput: { flex: 1, color: C.textPrimary, fontSize: 15, padding: 0 },
  gridLoading: { paddingVertical: T.spacing['2xl'], alignItems: 'center', gap: T.spacing.sm },
  productGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: T.spacing.md },
  productCard: {
    flexGrow: 1,
    flexBasis: 150,
    minWidth: 150,
    gap: 6,
    padding: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  productCardSelected: { borderColor: C.primary, backgroundColor: C.surfaceAlt },
  productCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: T.spacing.xs },
  productBrand: { flex: 1, color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  codeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: T.radius.sm,
    backgroundColor: C.primarySoft,
    borderWidth: 1,
    borderColor: C.border,
  },
  codeBadgeText: { color: C.primary, fontSize: 11, fontWeight: '800' },
  productName: { color: C.textPrimary, fontSize: 16, fontWeight: '800' },
  productMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: T.spacing.xs },
  productStockRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  productStock: { color: C.textSecondary, fontSize: 12, fontWeight: '600' },
  productStockLow: { color: C.warning.text, fontWeight: '800' },
  addedTagRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addedTag: { color: C.primary, fontSize: 11, fontWeight: '800' },
  productCost: { color: C.primary, fontSize: 13, fontWeight: '800' },
  productCostMissing: { color: C.warning.text },

  // Cards (right column)
  card: {
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderRadius: T.radius.cardLg,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  cardEyebrow: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  cardSub: { color: C.textSecondary, fontSize: 13 },
  selectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: T.spacing.sm },
  selectionHeaderText: { gap: 2, flexShrink: 1 },
  weightBadge: {
    paddingHorizontal: T.spacing.md,
    paddingVertical: 6,
    borderRadius: T.radius.pill,
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.border,
  },
  weightBadgeText: { color: C.textSecondary, fontSize: 12, fontWeight: '800' },

  // Empty selection
  emptySelection: { alignItems: 'center', gap: T.spacing.sm, paddingVertical: T.spacing.xl },

  // Selection table
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
  colTarget: { flex: 1.1, alignItems: 'flex-start' },
  colUnit: { flex: 1, textAlign: 'right' },
  colTotal: { flex: 1.1, textAlign: 'right' },
  colRemove: { width: 26, alignItems: 'flex-end' },
  rowName: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  rowMeta: { color: C.textMuted, fontSize: 11 },
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
  td: { color: C.textSecondary, fontSize: 13, fontWeight: '600' },
  tdStrong: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
  tdMissing: { color: C.warning.text },

  // Notes
  notesInput: {
    minHeight: 84,
    paddingHorizontal: T.spacing.md,
    paddingTop: T.spacing.sm,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.inputLg,
    backgroundColor: C.inputBg,
    color: C.textPrimary,
    fontSize: 14,
    textAlignVertical: 'top',
  },

  // Pricing
  pricingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pricingTotalLabel: { color: C.textPrimary, fontSize: 15, fontWeight: '800' },
  pricingTotalValue: { color: C.textPrimary, fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },
  pricingWarning: { color: C.warning.text, fontSize: 12, lineHeight: 17 },

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
  bottomCharge: { alignItems: 'flex-end', gap: 2 },
  bottomChargeLabel: { color: C.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  bottomChargeValue: { color: C.textPrimary, fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  startButton: {
    minHeight: 52,
    paddingHorizontal: T.spacing.xl,
    borderRadius: T.radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: T.spacing.sm,
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

  // Shared
  muted: { color: C.textMuted, fontSize: 13 },
  errorText: { color: C.danger.text, fontSize: 13, fontWeight: '600' },
});
