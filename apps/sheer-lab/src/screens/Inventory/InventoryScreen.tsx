import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  InventoryCategory,
  InventoryLocationStock,
  InventoryProduct,
  InventoryStockMovement,
  PinUnlockResponse,
} from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import {
  adjustManagedStock,
  archiveManagedProduct,
  createManagedProduct,
  initializeManagedStock,
  listManagedCategories,
  listManagedLowStock,
  listManagedMovements,
  listManagedProducts,
  listManagedStock,
  updateManagedProduct,
} from '../../features/inventory/inventoryManagementApi';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { confirmDestructive } from '../../lib/confirm';
import { Banner } from '../../ui';
import { Icon } from '../../ui/icons/Icon';
import { LabShell, Pill, t, c, useLabLayout } from '../shared/LabShell';
import { formatGrams, formatMoney, formatRelativeTime, getInventoryTier, stockFill } from '../Home/dashboardHelpers';
import { ProductFormModal, type ProductSavePayload } from './ProductFormModal';
import { StockAdjustModal, type StockAdjustTarget, type StockAdjustValues } from './StockAdjustModal';

type InventoryScreenProps = NativeStackScreenProps<RootStackParamList, 'Inventory'>;

interface ProductRow {
  product: InventoryProduct;
  stock?: InventoryLocationStock;
}

export function InventoryScreen({ navigation }: InventoryScreenProps): React.JSX.Element {
  const ble = useBleScale();
  const layout = useLabLayout();
  const wide = layout.isWide;

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [stock, setStock] = useState<InventoryLocationStock[]>([]);
  const [movements, setMovements] = useState<InventoryStockMovement[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [lowStockCount, setLowStockCount] = useState(0);

  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  /**
   * A failure from a save/adjust/archive request, shown INSIDE the modal that
   * caused it. `error` renders in the screen's banner, which sits behind the
   * modal — so a rejected save used to be completely invisible: the button went
   * "Saving…", came back, and the reason was on a surface the operator could
   * not see. Repeated taps then repeated the failing request.
   */
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [forbidden, setForbidden] = useState(false);

  const [editing, setEditing] = useState<InventoryProduct | undefined>();
  const [showProductForm, setShowProductForm] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<StockAdjustTarget | undefined>();
  const [showAdjust, setShowAdjust] = useState(false);
  const [saving, setSaving] = useState(false);

  const canManage = session ? session.role === 'owner' || session.role === 'manager' : false;

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const active = await getActiveLabSession();
      if (!active) {
        navigation.replace('Auth');
        return;
      }
      setSession(active);

      // A PIN session for a stylist has no inventory access — surface that
      // clearly instead of firing requests that the API would 403.
      if (active.role !== 'owner' && active.role !== 'manager') {
        setForbidden(true);
        return;
      }
      setForbidden(false);

      const id = active.sessionId;
      const [productRes, stockRes, movementRes, categoryRes, lowStockRes] = await Promise.allSettled([
        listManagedProducts(id),
        listManagedStock(id),
        listManagedMovements(id, { limit: 20 }),
        listManagedCategories(id),
        listManagedLowStock(id),
      ]);

      if (productRes.status === 'fulfilled') setProducts(productRes.value.products);
      if (stockRes.status === 'fulfilled') setStock(stockRes.value.stock);
      if (movementRes.status === 'fulfilled') setMovements(movementRes.value.movements);
      if (categoryRes.status === 'fulfilled') setCategories(categoryRes.value.categories);
      if (lowStockRes.status === 'fulfilled') setLowStockCount(lowStockRes.value.alerts.length);

      // Was `[productRes, stockRes]` — so a failed movements, categories or
      // low-stock call left the screen looking fully loaded and healthy. The
      // worst of those is low-stock: "Low-stock alerts 0" after a failed alerts
      // call is the number the owner opens this screen to read.
      const sources = [
        ['products', productRes],
        ['stock levels', stockRes],
        ['stock movements', movementRes],
        ['categories', categoryRes],
        ['low-stock alerts', lowStockRes],
      ] as const;
      const failedNames = sources
        .filter(([, result]) => result.status === 'rejected')
        .map(([name]) => name);
      const failed = failedNames.length > 0;
      if (failed) {
        // Name what is stale. "Could not load inventory" over a screen showing
        // a full product table and "0 alerts" tells the operator nothing about
        // which number they should not trust.
        const reason = sources.find(([, r]) => r.status === 'rejected')?.[1] as
          | PromiseRejectedResult
          | undefined;
        const detail = reason?.reason instanceof Error ? `${reason.reason.message} ` : '';
        setError(`${detail}Could not load ${failedNames.join(', ')}. Pull to refresh.`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load inventory');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigation]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const stockByProduct = useMemo(() => {
    const map = new Map<string, InventoryLocationStock>();
    for (const item of stock) map.set(item.productId, item);
    return map;
  }, [stock]);

  const rows = useMemo<ProductRow[]>(() => {
    const term = search.trim().toLowerCase();
    return products
      .map((product) => ({ product, stock: stockByProduct.get(product.id) }))
      .filter(({ product, stock: row }) => {
        if (lowStockOnly && !(row?.isLowStock || (row && row.quantityOnHandGrams <= 0))) return false;
        if (!term) return true;
        return [product.name, product.brand, product.sku, product.category].filter(Boolean).join(' ').toLowerCase().includes(term);
      });
  }, [products, stockByProduct, search, lowStockOnly]);

  const costByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const product of products) map.set(product.id, product.defaultCostPerGramCents ?? 0);
    return map;
  }, [products]);
  const inventoryValueCents = useMemo(
    () => stock.reduce((total, item) => total + item.quantityOnHandGrams * (costByProduct.get(item.productId) ?? 0), 0),
    [stock, costByProduct],
  );
  const outOfStockCount = useMemo(() => stock.filter((item) => item.quantityOnHandGrams <= 0).length, [stock]);
  const activeProducts = useMemo(() => products.filter((p) => p.isActive), [products]);

  // ----- mutations ----------------------------------------------------------

  const handleSaveProduct = useCallback(
    async (payload: ProductSavePayload) => {
      if (!session) return;
      setSaving(true);
      setError(undefined);
      setSubmitError(undefined);
      setNotice(undefined);
      try {
        const body = {
          brand: payload.brand,
          name: payload.name,
          categoryId: payload.categoryId,
          sku: payload.sku,
          defaultCostPerGramCents: payload.defaultCostPerGramCents,
          retailPriceCents: payload.retailPriceCents,
          lowStockThresholdGrams: payload.lowStockThresholdGrams,
        };
        const result = editing
          ? await updateManagedProduct(session.sessionId, editing.id, body)
          : await createManagedProduct(session.sessionId, body);

        // New products with an opening quantity get a station stock record so
        // they immediately show on hand.
        if (!editing && session.locationId && payload.initialStockGrams && payload.initialStockGrams > 0) {
          await initializeManagedStock(session.sessionId, {
            locationId: session.locationId,
            productId: result.product.id,
            quantityOnHandGrams: payload.initialStockGrams,
            lowStockThresholdGrams: payload.lowStockThresholdGrams || null,
          });
        }
        setNotice(`${result.product.name} ${editing ? 'updated' : 'added'}.`);
        setShowProductForm(false);
        setEditing(undefined);
        await load();
      } catch (err: unknown) {
        setSubmitError(err instanceof Error ? err.message : 'Could not save product');
      } finally {
        setSaving(false);
      }
    },
    [session, editing, load],
  );

  const handleAdjust = useCallback(
    async (values: StockAdjustValues) => {
      if (!session || !adjustTarget) return;
      const { locationId } = session;
      if (!locationId) {
        setError('This station has no location assigned.');
        return;
      }
      setSaving(true);
      setError(undefined);
      setSubmitError(undefined);
      setNotice(undefined);
      try {
        if (!adjustTarget.isStocked) {
          await initializeManagedStock(session.sessionId, {
            locationId,
            productId: adjustTarget.productId,
            quantityOnHandGrams: values.quantityGrams,
          });
        } else {
          const delta = values.direction === 'inbound' ? values.quantityGrams : -values.quantityGrams;
          await adjustManagedStock(session.sessionId, {
            locationId,
            productId: adjustTarget.productId,
            quantityDeltaGrams: delta,
            movementType: delta > 0 ? 'restock' : 'manual_adjustment',
            reason: delta > 0 ? 'restock' : 'manual_adjustment',
            notes: values.reason,
          });
        }
        setNotice(`Stock updated for ${adjustTarget.productName}.`);
        setShowAdjust(false);
        setAdjustTarget(undefined);
        await load();
      } catch (err: unknown) {
        setSubmitError(err instanceof Error ? err.message : 'Could not update stock');
      } finally {
        setSaving(false);
      }
    },
    [session, adjustTarget, load],
  );

  const handleArchive = useCallback(
    async (product: InventoryProduct) => {
      if (!session) return;
      // Archiving removes the product from every picker at every station. It
      // used to fire from one tap on a ghost button beside Save.
      const confirmed = await confirmDestructive({
        title: `Archive ${product.name}?`,
        message:
          'It will stop appearing in product pickers at every station. Existing formulas that used it are unaffected.',
        confirmLabel: 'Archive',
      });
      if (!confirmed) return;
      setSaving(true);
      setError(undefined);
      setSubmitError(undefined);
      try {
        await archiveManagedProduct(session.sessionId, product.id);
        setNotice(`${product.name} archived.`);
        setShowProductForm(false);
        setEditing(undefined);
        await load();
      } catch (err: unknown) {
        setSubmitError(err instanceof Error ? err.message : 'Could not archive product');
      } finally {
        setSaving(false);
      }
    },
    [session, load],
  );

  // ----- handlers -----------------------------------------------------------

  const openAdd = () => {
    setEditing(undefined);
    setShowProductForm(true);
  };
  const openEdit = (product: InventoryProduct) => {
    setEditing(product);
    setShowProductForm(true);
  };
  const openAdjust = (row: ProductRow) => {
    setAdjustTarget({
      productId: row.product.id,
      productName: row.product.name,
      brand: row.product.brand,
      currentQuantityGrams: row.stock?.quantityOnHandGrams ?? 0,
      isStocked: Boolean(row.stock),
    });
    setShowAdjust(true);
  };

  // ----- render -------------------------------------------------------------

  if (forbidden) {
    return (
      <LabShell session={session} bleStatus={ble.status}>
        <View style={styles.lockCard}>
          <Icon name="lock" size="xl" tone="primary" />
          <Text style={styles.lockTitle}>Inventory is owner & manager only</Text>
          <Text style={styles.lockBody}>
            Ask an owner or manager to sign in on this station to manage products, stock and pricing.
          </Text>
        </View>
      </LabShell>
    );
  }

  return (
    <LabShell
      session={session}
      bleStatus={ble.status}
      refreshing={refreshing}
      onRefresh={handleRefresh}
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.h1}>Inventory</Text>
          <Text style={styles.sub}>Monitor stock, pricing and reorder thresholds for this location.</Text>
        </View>
        {canManage ? (
          <Pressable accessibilityRole="button" onPress={openAdd} style={styles.addBtn}>
            <View style={styles.addBtnRow}>
              <Icon name="plus" size="xs" tone="inherit" color={c.textOnPrimary} />
              <Text style={styles.addBtnLabel}>Add product</Text>
            </View>
          </Pressable>
        ) : null}
      </View>

      {/* THE first adoption of src/ui. This recipe — tone-coloured fill, tone
          border, 1px, input radius, md/sm padding — was hand-copied
          byte-for-byte into this screen and Billing Rules, and again (as
          `error`) into both Inventory modals, while five other screens rendered
          a bare coloured line in four different size/weight pairs. `Banner`
          renders the same block from the same tone triple and adds the tone
          icon, and a dismiss for the success notice, which previously stayed on
          screen after the state it described had been refetched. */}
      {notice ? <Banner message={notice} tone="success" onDismiss={() => setNotice(undefined)} /> : null}
      {error ? <Banner message={error} tone="danger" /> : null}

      {/* KPI strip */}
      <View style={styles.kpiRow}>
        <KpiCard label="Total products" value={String(activeProducts.length)} hint={`${stock.length} stocked here`} />
        <KpiCard label="Inventory value" value={formatMoney(inventoryValueCents)} hint="on-hand × cost/g" />
        <KpiCard
          label="Low-stock alerts"
          value={String(lowStockCount)}
          hint="at or below threshold"
          tone={lowStockCount > 0 ? 'warning' : undefined}
        />
        <KpiCard
          label="Out of stock"
          value={String(outOfStockCount).padStart(2, '0')}
          hint="records at zero"
          tone={outOfStockCount > 0 ? 'danger' : undefined}
        />
      </View>

      <View style={[styles.split, wide && styles.splitWide]}>
        {/* Product inventory table */}
        <View style={[styles.panel, styles.flex1]}>
          <View style={styles.panelHead}>
            <Text style={styles.panelTitle}>Product inventory</Text>
            <View style={styles.toolbar}>
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search name, brand or shade…"
                placeholderTextColor={c.textMuted}
                style={styles.searchInput}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => setLowStockOnly((v) => !v)}
                style={[styles.filterChip, lowStockOnly && styles.filterChipActive]}
              >
                <Text style={[styles.filterChipLabel, lowStockOnly && styles.filterChipLabelActive]}>Low stock</Text>
              </Pressable>
            </View>
          </View>

          {/* Column header (wide only) */}
          {wide ? (
            <View style={[styles.tr, styles.thead]}>
              <Text style={[styles.th, styles.colProduct]}>Product</Text>
              <Text style={[styles.th, styles.colCat]}>Category</Text>
              <Text style={[styles.th, styles.colStock]}>Stock level</Text>
              <Text style={[styles.th, styles.colPrice]}>Billing / g</Text>
              <Text style={[styles.th, styles.colActions]} />
            </View>
          ) : null}

          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : rows.length === 0 ? (
            <Text style={styles.empty}>{products.length === 0 ? 'No products yet.' : 'No products match your search.'}</Text>
          ) : (
            rows.map((row) => (
              <ProductRowView key={row.product.id} row={row} wide={wide} canManage={canManage} onEdit={openEdit} onAdjust={openAdjust} />
            ))
          )}
        </View>

        {/* Recent movement */}
        <View style={[styles.panel, wide ? styles.rail : undefined]}>
          <View style={styles.panelHead}>
            <Text style={styles.panelTitle}>Recent history</Text>
          </View>
          {movements.length === 0 ? (
            <Text style={styles.empty}>No stock movements yet.</Text>
          ) : (
            movements.slice(0, 12).map((movement) => <MovementRow key={movement.id} movement={movement} />)
          )}
        </View>
      </View>

      <ProductFormModal
        visible={showProductForm}
        product={editing}
        categories={categories}
        currentOnHandGrams={editing ? stockByProduct.get(editing.id)?.quantityOnHandGrams : undefined}
        saving={saving}
        submitError={submitError}
        onArchive={editing && session?.role === 'owner' ? () => void handleArchive(editing) : undefined}
        onClose={() => {
          setShowProductForm(false);
          setEditing(undefined);
          setSubmitError(undefined);
        }}
        onSave={handleSaveProduct}
      />
      <StockAdjustModal
        visible={showAdjust}
        item={adjustTarget}
        saving={saving}
        submitError={submitError}
        onClose={() => {
          setShowAdjust(false);
          setAdjustTarget(undefined);
          setSubmitError(undefined);
        }}
        onSubmit={handleAdjust}
      />
    </LabShell>
  );
}

function ProductRowView({
  row,
  wide,
  canManage,
  onEdit,
  onAdjust,
}: {
  row: ProductRow;
  wide: boolean;
  canManage: boolean;
  onEdit: (product: InventoryProduct) => void;
  onAdjust: (row: ProductRow) => void;
}): React.JSX.Element {
  const { product, stock } = row;
  const tier = stock ? getInventoryTier(stock) : undefined;
  const fill = stock ? stockFill(stock) : 0;

  return (
    <View style={[styles.tr, !wide && styles.trStacked]}>
      <View style={styles.colProduct}>
        <Text style={styles.productName} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={styles.productMeta} numberOfLines={1}>
          {[product.brand, product.sku].filter(Boolean).join(' · ') || '—'}
        </Text>
      </View>

      <View style={styles.colCat}>
        {product.category ? (
          <View style={styles.catChip}>
            <Text style={styles.catChipLabel}>{product.category}</Text>
          </View>
        ) : (
          <Text style={styles.muted}>—</Text>
        )}
      </View>

      <View style={styles.colStock}>
        {stock ? (
          <>
            <View style={styles.stockTopRow}>
              <Text style={styles.stockValue}>{formatGrams(stock.quantityOnHandGrams)}</Text>
              {tier ? <Pill label={tier.label} tone={tier.tone} subtle /> : null}
            </View>
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${Math.round(fill * 100)}%`, backgroundColor: tierColor(tier?.tone) }]} />
            </View>
          </>
        ) : (
          <Text style={styles.muted}>Not stocked here</Text>
        )}
      </View>

      <View style={styles.colPrice}>
        <Text style={styles.price}>{product.retailPriceCents === undefined ? '—' : `${formatMoney(product.retailPriceCents)}/g`}</Text>
      </View>

      <View style={[styles.colActions, styles.actions]}>
        {canManage ? (
          <>
            <Pressable accessibilityRole="button" onPress={() => onAdjust(row)} style={styles.rowBtn}>
              <Text style={styles.rowBtnLabel}>{stock ? 'Adjust' : 'Stock'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => onEdit(product)} style={[styles.rowBtn, styles.rowBtnPrimary]}>
              <Text style={[styles.rowBtnLabel, styles.rowBtnPrimaryLabel]}>Edit</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

function MovementRow({ movement }: { movement: InventoryStockMovement }): React.JSX.Element {
  const positive = movement.quantityDeltaGrams > 0;
  return (
    <View style={styles.moveRow}>
      <View style={[styles.moveDot, { backgroundColor: positive ? c.successText : movement.quantityDeltaGrams < 0 ? c.dangerText : c.textMuted }]} />
      <View style={{ flex: 1 }}>
        <View style={styles.moveTop}>
          <Text style={styles.moveName} numberOfLines={1}>
            {movement.productName}
          </Text>
          <Text style={[styles.moveDelta, { color: positive ? c.successText : c.dangerText }]}>
            {positive ? '+' : ''}
            {formatGrams(movement.quantityDeltaGrams)}
          </Text>
        </View>
        <Text style={styles.moveMeta} numberOfLines={1}>
          {movementLabel(movement.movementType)} · {formatRelativeTime(movement.createdAt)}
        </Text>
      </View>
    </View>
  );
}

function movementLabel(type: InventoryStockMovement['movementType']): string {
  switch (type) {
    case 'opening_balance':
      return 'Opening balance';
    case 'restock':
      return 'Restock';
    case 'manual_adjustment':
      return 'Manual adjustment';
    case 'correction':
      return 'Correction';
    case 'retail_sale':
      return 'Retail sale';
    case 'formula_usage':
      return 'Formula usage';
    case 'formula_waste':
      return 'Formula waste';
    case 'formula_reversal':
      return 'Formula reversal';
    default:
      return 'Movement';
  }
}

function tierColor(tone?: 'success' | 'warning' | 'danger' | 'neutral' | 'brand'): string {
  switch (tone) {
    case 'success':
      return c.successText;
    case 'warning':
      return c.warningText;
    case 'danger':
      return c.dangerText;
    default:
      return c.primary;
  }
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warning' | 'danger';
}): React.JSX.Element {
  const accent = tone === 'danger' ? c.dangerText : tone === 'warning' ? c.warningText : c.textPrimary;
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={[styles.kpiValue, { color: accent }]}>{value}</Text>
      {hint ? <Text style={styles.kpiHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.md },
  h1: { color: c.textPrimary, fontSize: t.typography.fontSize.heading, fontWeight: '700' },
  sub: { color: c.textSecondary, fontSize: t.typography.fontSize.small, marginTop: 2 },
  addBtn: { backgroundColor: c.primary, paddingHorizontal: t.spacing.base, minHeight: 42, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center' },
  addBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addBtnLabel: { color: c.textOnPrimary, fontWeight: '800', fontSize: t.typography.fontSize.small },


  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.base },
  kpiCard: {
    flexGrow: 1,
    flexBasis: 150,
    minWidth: 150,
    backgroundColor: c.surface,
    borderRadius: t.radius.cardLg,
    borderWidth: 1,
    borderColor: c.border,
    padding: t.spacing.base,
  },
  kpiLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.caption, fontWeight: '600' },
  kpiValue: { fontSize: t.typography.fontSize.heading, fontWeight: '800', marginTop: 6 },
  kpiHint: { color: c.textMuted, fontSize: t.typography.fontSize.micro, marginTop: 4 },

  split: { gap: t.spacing.base },
  splitWide: { flexDirection: 'row', alignItems: 'flex-start' },
  flex1: { flex: 1 },
  rail: { width: 340, flexGrow: 0, flexShrink: 0 },

  panel: { backgroundColor: c.surface, borderRadius: t.radius.cardLg, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  panelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    flexWrap: 'wrap',
  },
  panelTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.bodyLg, fontWeight: '700' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexShrink: 1 },
  searchInput: {
    minWidth: 160,
    flexShrink: 1,
    height: 38,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: t.radius.input,
    paddingHorizontal: t.spacing.md,
    color: c.textPrimary,
    fontSize: t.typography.fontSize.small,
    backgroundColor: c.surface,
  },
  filterChip: { height: 38, paddingHorizontal: t.spacing.md, borderRadius: t.radius.input, borderWidth: 1, borderColor: c.borderStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  filterChipActive: { backgroundColor: c.primarySoft, borderColor: c.primary },
  filterChipLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.small, fontWeight: '600' },
  filterChipLabelActive: { color: c.primary },

  thead: { backgroundColor: c.surfaceAlt, paddingVertical: t.spacing.sm },
  th: { color: c.textMuted, fontSize: t.typography.fontSize.micro, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  trStacked: { flexWrap: 'wrap' },
  colProduct: { flex: 2.4, minWidth: 140 },
  colCat: { flex: 1.4, minWidth: 90 },
  colStock: { flex: 1.8, minWidth: 130 },
  colPrice: { flex: 1, minWidth: 70 },
  colActions: { flex: 1.4, minWidth: 120 },

  productName: { color: c.textPrimary, fontSize: t.typography.fontSize.body, fontWeight: '600' },
  productMeta: { color: c.textMuted, fontSize: t.typography.fontSize.caption, marginTop: 2 },
  catChip: { alignSelf: 'flex-start', borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt, borderRadius: t.radius.sm, paddingHorizontal: t.spacing.sm, paddingVertical: 3 },
  catChipLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.caption },
  muted: { color: c.textMuted, fontSize: t.typography.fontSize.small },

  stockTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm },
  stockValue: { color: c.textPrimary, fontSize: t.typography.fontSize.body, fontWeight: '700' },
  bar: { height: 6, borderRadius: 3, backgroundColor: c.surfaceAlt, marginTop: 6, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },

  price: { color: c.textSecondary, fontSize: t.typography.fontSize.small, fontWeight: '600' },

  actions: { flexDirection: 'row', gap: t.spacing.sm, justifyContent: 'flex-end' },
  rowBtn: { paddingHorizontal: t.spacing.md, height: 34, borderRadius: t.radius.full, borderWidth: 1, borderColor: c.borderStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface },
  rowBtnLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.caption, fontWeight: '700' },
  rowBtnPrimary: { backgroundColor: c.primarySoft, borderColor: c.primary },
  rowBtnPrimaryLabel: { color: c.primary },

  moveRow: { flexDirection: 'row', gap: t.spacing.sm, paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border },
  moveDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  moveTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm },
  moveName: { color: c.textPrimary, fontSize: t.typography.fontSize.small, fontWeight: '600', flex: 1 },
  moveDelta: { fontSize: t.typography.fontSize.small, fontWeight: '800' },
  moveMeta: { color: c.textMuted, fontSize: t.typography.fontSize.caption, marginTop: 2 },

  loading: { padding: t.spacing['2xl'], alignItems: 'center' },
  empty: { color: c.textMuted, fontSize: t.typography.fontSize.small, textAlign: 'center', padding: t.spacing.xl },

  lockCard: { alignItems: 'center', justifyContent: 'center', gap: t.spacing.sm, padding: t.spacing['2xl'], backgroundColor: c.surface, borderRadius: t.radius.cardLg, borderWidth: 1, borderColor: c.border },
  lockTitle: { color: c.textPrimary, fontSize: t.typography.fontSize.subtitle, fontWeight: '700', textAlign: 'center' },
  lockBody: { color: c.textSecondary, fontSize: t.typography.fontSize.small, textAlign: 'center', maxWidth: 320 },
});
