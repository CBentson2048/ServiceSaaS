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
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { calculateBillableChargeCents } from '../../features/formulas/formulaCosting';
import type { BuiltFormulaItemInput } from '../../features/formulas/formulaDraftStore';
import { formulaDraftStore } from '../../features/formulas/formulaDraftStore';
import { getLabProductBillingSettings } from '../../features/formulas/formulasApi';
import {
  listLabInventoryProducts,
  listLabInventoryStockForSession,
} from '../../features/inventory/productsApi';
import { getActiveLabSession, logoutLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import {
  formatClock,
  formatGrams,
  formatMoney,
  getInventoryTier,
  initials,
  roleLabel,
  type StatusTone,
} from '../Home/dashboardHelpers';
import { featureFlags } from '../../config/featureFlags';
import { labTheme } from '../../theme/labTheme';
import { BrandMark } from '../shared/BrandMark';

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
// Responsive layout — mirrors the dashboard breakpoints so the Lab app behaves
// consistently across phone, iPad-portrait and iPad-landscape/desktop.
// ---------------------------------------------------------------------------

type LayoutMode = 'phone' | 'tablet' | 'wide';

interface BuildLayout {
  mode: LayoutMode;
  sidebarWidth: number;
  railWidth: number;
  pad: number;
  gap: number;
  showSidebar: boolean;
  twoColumn: boolean;
}

function getLayout(width: number): BuildLayout {
  if (width >= 1024) {
    const large = width >= 1280;
    return {
      mode: 'wide',
      sidebarWidth: large ? 248 : 216,
      railWidth: clampNumber(Math.round(width * 0.3), 320, 420),
      pad: large ? T.spacing.xl : T.spacing.base,
      gap: T.spacing.lg,
      showSidebar: true,
      twoColumn: true,
    };
  }
  if (width >= 700) {
    return {
      mode: 'tablet',
      sidebarWidth: 208,
      railWidth: 0,
      pad: T.spacing.base,
      gap: T.spacing.base,
      showSidebar: true,
      twoColumn: false,
    };
  }
  return {
    mode: 'phone',
    sidebarWidth: 0,
    railWidth: 0,
    pad: T.spacing.base,
    gap: T.spacing.base,
    showSidebar: false,
    twoColumn: false,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Sidebar navigation model (purple equivalent of the dashboard shell)
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

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function BuildFormulaScreen({ navigation, route }: BuildFormulaScreenProps): React.JSX.Element {
  const entryContext = route.params.entryContext;
  const sessionId = entryContext.labSessionId;

  const { width } = useWindowDimensions();
  const layout = getLayout(width);

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
    const markupCents = billableCents - materialCents;
    const hasMissingCost = lines.some((line) => line.costPerGramCents == null && line.grams > 0);
    return { totalGrams, materialCents, billableCents, markupCents, hasMissingCost };
  }, [lines, billing]);

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

  const goToRoute = useCallback(
    (target: NavTarget) => {
      if (target.kind !== 'route') return;
      navigation.navigate(target.route);
    },
    [navigation],
  );

  const handleSignOut = useCallback(async () => {
    try {
      await logoutLabSession(sessionId);
    } catch {
      // Best effort — always return the device to the lock screen.
    }
    navigation.reset({ index: 0, routes: [{ name: 'Auth' }] });
  }, [navigation, sessionId]);

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
    });

    // Navigate without an entryContext so the capture screen keeps the seeded
    // draft instead of resetting it.
    navigation.navigate('Formula');
  }, [canStartWeighing, entryContext, lines, navigation, sessionId]);

  const productGrid = (
    <ProductCatalogue
      products={products}
      stockByProductId={stockByProductId}
      selectedIds={selectedIds}
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
        totalGrams={totals.totalGrams}
        onGramsChange={updateGrams}
        onRemove={removeProduct}
      />
      <StylistNotesCard value={notes} onChange={setNotes} />
      <PricingBreakdownCard
        materialCents={totals.materialCents}
        markupCents={totals.markupCents}
        billableCents={totals.billableCents}
        markupLabel={markupLabel(billing)}
        hasMissingCost={totals.hasMissingCost}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />
      <TopBar session={session} online={session?.status === 'active'} />

      <View style={[styles.body, layout.showSidebar ? styles.bodyRow : styles.bodyColumn]}>
        {layout.showSidebar ? (
          <Sidebar width={layout.sidebarWidth} onNav={goToRoute} onSignOut={handleSignOut} />
        ) : null}

        <View style={styles.mainArea}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ padding: layout.pad, paddingBottom: T.spacing.xl }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[styles.contentWrap, { gap: layout.gap }]}>
              {!layout.showSidebar ? <NavScroller onNav={goToRoute} onSignOut={handleSignOut} /> : null}

              <Header
                clientName={entryContext.clientName}
                serviceType={entryContext.serviceType}
                onViewHistory={() => navigation.navigate('FormulaHistory')}
                onSaveTemplate={() => setNotice('Saving mixes as reusable templates is coming soon.')}
              />

              {notice ? <Text style={styles.notice}>{notice}</Text> : null}

              {layout.twoColumn ? (
                <View style={[styles.columns, { gap: layout.gap }]}>
                  <View style={styles.gridColumn}>{productGrid}</View>
                  <View style={[styles.rail, { width: layout.railWidth }]}>{selectionPanel}</View>
                </View>
              ) : (
                <View style={[styles.stack, { gap: layout.gap }]}>
                  {productGrid}
                  {selectionPanel}
                </View>
              )}

              <Footer now={now} scaleConnected={scaleConnected} online={session?.status === 'active'} />
            </View>
          </ScrollView>

          <BottomBar
            totalGrams={totals.totalGrams}
            chargeCents={totals.billableCents}
            ready={canStartWeighing}
            onStart={handleStartWeighing}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Chrome — top bar, sidebar, mobile nav, footer
// ---------------------------------------------------------------------------

function TopBar({ session, online }: { session?: PinUnlockResponse; online: boolean }): React.JSX.Element {
  return (
    <View style={styles.topBar}>
      <View style={styles.topSideLeft}>
        <Pill label={online ? 'Connected' : 'Offline'} tone={online ? 'success' : 'neutral'} />
      </View>

      <View style={styles.brandRow}>
        <BrandMark size={30} />
        <Text style={styles.brandText}>QLOOQO LAB</Text>
      </View>

      <View style={styles.topSideRight}>
        {session ? (
          <View style={styles.userRow}>
            <View style={styles.userText}>
              <Text style={styles.userName} numberOfLines={1}>
                {session.displayName}
              </Text>
              <Text style={styles.userRole}>{roleLabel(session.role)}</Text>
            </View>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(session.displayName)}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Sidebar({
  width,
  onNav,
  onSignOut,
}: {
  width: number;
  onNav: (target: NavTarget) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.sidebar, { width }]}>
      <View style={styles.sidebarNav}>
        {NAV_ITEMS.map((item) => {
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
}: {
  onNav: (target: NavTarget) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.navScroller}
      style={styles.navScrollerWrap}
    >
      {NAV_ITEMS.map((item) => {
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
          <Text style={styles.ghostButtonText}>🕘 View History</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onSaveTemplate} style={styles.ghostButton}>
          <Text style={styles.ghostButtonText}>＋ Save Template</Text>
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
          <Text style={styles.searchGlyph}>⌕</Text>
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
  onPress,
}: {
  product: InventoryProduct;
  stock?: InventoryLocationStock;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const code = productCode(product);
  const tier = stock ? getInventoryTier(stock) : undefined;
  const lowStock = tier ? tier.tone === 'warning' || tier.tone === 'danger' : false;
  const costLabel =
    product.defaultCostPerGramCents == null ? 'No cost' : `${formatMoney(product.defaultCostPerGramCents)}/g`;

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
        <Text style={[styles.productStock, lowStock && styles.productStockLow]} numberOfLines={1}>
          {lowStock ? '⚠ ' : ''}
          Stock: {stock ? formatGrams(stock.quantityOnHandGrams) : '—'}
        </Text>
        {selected ? <Text style={styles.addedTag}>✓ Added</Text> : null}
      </View>
      <Text style={[styles.productCost, product.defaultCostPerGramCents == null && styles.productCostMissing]}>
        {costLabel}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Right column — current selection, notes, pricing
// ---------------------------------------------------------------------------

function CurrentSelectionCard({
  lines,
  totalGrams,
  onGramsChange,
  onRemove,
}: {
  lines: SelectionLine[];
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
          <Text style={styles.emptySelectionGlyph}>🧪</Text>
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
                {line.costPerGramCents == null ? '—' : formatMoney(line.costPerGramCents)}
              </Text>
              <Text
                style={[styles.tdStrong, styles.colTotal, line.costPerGramCents == null && styles.tdMissing]}
                numberOfLines={1}
              >
                {line.totalCents == null ? 'No cost' : formatMoney(line.totalCents)}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => onRemove(line.product.id)}
                hitSlop={8}
                style={styles.colRemove}
              >
                <Text style={styles.removeGlyph}>✕</Text>
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

function PricingBreakdownCard({
  materialCents,
  markupCents,
  billableCents,
  markupLabel: markupLabelText,
  hasMissingCost,
}: {
  materialCents: number;
  markupCents: number;
  billableCents: number;
  markupLabel: string | null;
  hasMissingCost: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>Pricing Breakdown</Text>
      <View style={styles.pricingRow}>
        <Text style={styles.pricingLabel}>Material Cost</Text>
        <Text style={styles.pricingValue}>{formatMoney(materialCents)}</Text>
      </View>
      {markupLabelText && markupCents !== 0 ? (
        <View style={styles.pricingRow}>
          <Text style={styles.pricingLabel}>{markupLabelText}</Text>
          <Text style={[styles.pricingValue, styles.pricingValueBrand]}>+{formatMoney(markupCents)}</Text>
        </View>
      ) : null}
      <View style={styles.pricingDivider} />
      <View style={styles.pricingRow}>
        <Text style={styles.pricingTotalLabel}>Estimated Billing</Text>
        <Text style={styles.pricingTotalValue}>{formatMoney(billableCents)}</Text>
      </View>
      {hasMissingCost ? (
        <Text style={styles.pricingWarning}>
          Some products have no cost on record — their material cost is excluded until set.
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
  ready,
  onStart,
}: {
  totalGrams: number;
  chargeCents: number;
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
        <Text style={styles.bottomChargeValue}>{formatMoney(chargeCents)}</Text>
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
        <Text style={styles.startButtonText}>Start Weighing →</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives + helpers
// ---------------------------------------------------------------------------

function Pill({ label, tone }: { label: string; tone: StatusTone }): React.JSX.Element {
  const palette = toneStyle(tone);
  return (
    <View style={[styles.pill, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <View style={[styles.pillDot, { backgroundColor: palette.text }]} />
      <Text style={[styles.pillText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

function toneStyle(tone: StatusTone): { text: string; bg: string; border: string } {
  switch (tone) {
    case 'success':
      return { text: C.success.text, bg: C.success.bg, border: C.success.border };
    case 'warning':
      return { text: C.warning.text, bg: C.warning.bg, border: C.warning.border };
    case 'danger':
      return { text: C.danger.text, bg: C.danger.bg, border: C.danger.border };
    case 'brand':
      return { text: C.primary, bg: C.primarySoft, border: C.primarySoft };
    default:
      return { text: C.textSecondary, bg: C.surfaceAlt, border: C.border };
  }
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

function markupLabel(billing: LocationProductBillingSettings | null): string | null {
  if (!billing || !billing.productBillingEnabled) return null;
  switch (billing.productBillingRule) {
    case 'cost_plus_markup_percent':
      return billing.productMarkupPercent == null ? null : `Markup (+${billing.productMarkupPercent}%)`;
    case 'fixed_uplift':
      return billing.productFixedUpliftAmount == null
        ? null
        : `Uplift (+${formatMoney(Math.round(billing.productFixedUpliftAmount * 100))})`;
    default:
      return null;
  }
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
  contentWrap: { width: '100%', maxWidth: 1600, alignSelf: 'center' },

  // Top bar (three sections: status · brand · user)
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
  searchGlyph: { color: C.textMuted, fontSize: 18 },
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
  productStock: { color: C.textSecondary, fontSize: 12, fontWeight: '600' },
  productStockLow: { color: C.warning.text, fontWeight: '800' },
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
  emptySelectionGlyph: { fontSize: 28 },

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
  removeGlyph: { color: C.textMuted, fontSize: 14, fontWeight: '800' },

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
  pricingLabel: { color: C.textSecondary, fontSize: 14, fontWeight: '600' },
  pricingValue: { color: C.textPrimary, fontSize: 14, fontWeight: '700' },
  pricingValueBrand: { color: C.primary },
  pricingDivider: { height: 1, backgroundColor: C.border },
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

  // Shared
  muted: { color: C.textMuted, fontSize: 13 },
  errorText: { color: C.danger.text, fontSize: 13, fontWeight: '600' },
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
