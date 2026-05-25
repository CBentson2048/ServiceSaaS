import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { InventoryProduct } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { formatMoney } from '../../features/formulas/formulaCosting';
import { finalizeFormulaForLabSession } from '../../features/formulas/formulasApi';
import type {
  FormulaIngredientRow,
  FormulaRowMetadataUpdate,
  SavedFormulaRecord,
} from '../../features/formulas/formulaDraftTypes';
import { toLabCoreFormulaDraft } from '../../features/formulas/formulaDraftTypes';
import { useFormulaDraft } from '../../features/formulas/useFormulaDraft';
import { listLabInventoryProducts } from '../../features/inventory/productsApi';
import { getActiveLabSession, refreshActiveLabSession } from '../../features/sheer-lab/labSession';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';

type ManualInputState = Record<string, string>;
type FormulaScreenProps = NativeStackScreenProps<RootStackParamList, 'Formula'>;

export function FormulaScreen({ route }: FormulaScreenProps): React.JSX.Element {
  const ble = useBleScale();
  const {
    draft,
    addRow,
    removeRow,
    selectActiveRow,
    updateRowMetadata,
    applyBleWeight,
    applyManualWeight,
    saveDraft,
    markFinalized,
    loadDraft,
    toFinalSavePayload,
    getLatestFormulaForClient,
    duplicateFormula,
    startFromAppointmentContext,
  } = useFormulaDraft();
  const [manualInputs, setManualInputs] = useState<ManualInputState>({});
  const [draftMessage, setDraftMessage] = useState('Local draft not saved yet');
  const [savingDraft, setSavingDraft] = useState(false);
  const [savingFinal, setSavingFinal] = useState(false);
  const [previousFormula, setPreviousFormula] = useState<SavedFormulaRecord | undefined>();
  const [productSearch, setProductSearch] = useState('');
  const [productPickerRowId, setProductPickerRowId] = useState<string | undefined>();
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | undefined>();
  const lastAppliedBleReading = useRef<string | undefined>(undefined);

  const activeRow = draft.rows.find((row) => row.id === draft.activeIngredientId);
  const activeWeightLabel = activeRow?.capturedGrams != null ? activeRow.capturedGrams.toFixed(1) : '--.-';
  const labCoreDraft = useMemo(() => toLabCoreFormulaDraft(draft), [draft]);
  const entryContext = route.params?.entryContext;
  const pickerRow = draft.rows.find((row) => row.id === productPickerRowId);

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

  useEffect(() => {
    const reading = ble.liveWeight;
    if (!reading || reading.source !== 'ble') return;

    const readingKey = `${reading.capturedAt}:${reading.grams}`;
    if (lastAppliedBleReading.current === readingKey) return;

    lastAppliedBleReading.current = readingKey;
    applyBleWeight(reading);
  }, [applyBleWeight, ble.liveWeight]);

  const loadProducts = useCallback(
    async (search = productSearch): Promise<void> => {
      const activeSession = entryContext?.labSessionId
        ? { sessionId: entryContext.labSessionId }
        : await getActiveLabSession();
      if (!activeSession) {
        setProducts([]);
        setProductsError('Unlock Sheer Lab before selecting products.');
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
    selectActiveRow(rowId);
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

  async function handleSaveDraft(): Promise<void> {
    setSavingDraft(true);
    setDraftMessage('Saving local draft...');
    try {
      const saved = saveDraft();
      setDraftMessage(
        `Draft saved locally ${formatTime(saved.savedAt)} · ${saved.rows.length} rows · no billing or inventory changes yet`,
      );
    } catch (err: unknown) {
      setDraftMessage(err instanceof Error ? err.message : 'Could not save local draft');
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleSaveFinal(): Promise<void> {
    setSavingFinal(true);
    setDraftMessage('Finalizing formula, billing, inventory, and waste...');
    try {
      const activeSession = await refreshActiveLabSession();
      if (!activeSession) {
        setDraftMessage('Sheer Lab session expired. Unlock Sheer Lab again, then tap Save Final.');
        return;
      }
      const payload = {
        ...toFinalSavePayload(),
        labSessionId: activeSession.sessionId,
      };
      await finalizeFormulaForLabSession(activeSession.sessionId, payload);
      const finalized = markFinalized();
      setDraftMessage(
        `Final formula saved ${formatTime(finalized.finalizedAt)} · ${formatMoney(
          finalized.billableChargeCents,
          finalized.currencyCode,
        )} colour charge applied · inventory reconciled`,
      );
    } catch (err: unknown) {
      setDraftMessage(err instanceof Error ? err.message : 'Could not finalize formula');
    } finally {
      setSavingFinal(false);
    }
  }

  function handleLoadDraft(): void {
    const loaded = loadDraft();
    setDraftMessage(loaded ? `Draft reopened ${formatTime(loaded.savedAt)}` : 'No saved draft in this session');
  }

  function handleLastFormula(): void {
    const latest = getLatestFormulaForClient();
    setPreviousFormula(latest);
    setDraftMessage(
      latest
        ? `Loaded latest formula from ${new Date(latest.savedAt).toLocaleDateString()}`
        : 'No previous formula saved for this client yet',
    );
  }

  function handleDuplicatePreviousFormula(): void {
    if (!previousFormula) return;

    const duplicated = duplicateFormula(previousFormula.id);
    setDraftMessage(
      duplicated
        ? `Duplicated previous formula into editable draft`
        : 'Could not duplicate that formula in this session',
    );
  }

  return (
    <LabScreen title="Capture formula" eyebrow="Ingredient capture">
      <ConnectionStatusBar
        status={ble.status}
        deviceName={ble.connectedDevice?.name}
        weight={ble.liveWeight}
        error={ble.error}
      />
      <View style={styles.clientBar}>
        <View style={styles.clientHeader}>
          <View>
            <Text style={styles.label}>Client</Text>
            <Text style={styles.clientName}>{draft.client.clientName}</Text>
          </View>
          <Pressable accessibilityRole="button" onPress={handleLastFormula} style={styles.lastFormulaButton}>
            <Text style={styles.lastFormulaText}>Last formula</Text>
          </Pressable>
        </View>
        <Text style={styles.serviceText}>{draft.visit.serviceType}</Text>
        <Text style={styles.meta}>
          Patch test: {formatPatchTest(draft.patchTest.status, draft.patchTest.performedAt)}
        </Text>
      </View>
      <View style={styles.captureCard}>
        <Text style={styles.label}>Capturing into</Text>
        <Text style={styles.captureTitle}>
          {activeRow ? formatRowDisplayName(activeRow) : 'Select an ingredient row'}
        </Text>
        <Text style={styles.weight}>{activeWeightLabel} g</Text>
        <Text style={styles.meta}>
          Source: {activeRow?.weightSource ?? 'waiting'} · Draft items: {labCoreDraft.items.length}
        </Text>
      </View>
      {previousFormula ? (
        <PreviousFormulaCard formula={previousFormula} onDuplicate={handleDuplicatePreviousFormula} />
      ) : null}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Ingredients</Text>
        <LabButton label="Add row" onPress={addRow} variant="secondary" />
      </View>
      {draft.rows.map((row) => (
        <IngredientRow
          key={row.id}
          row={row}
          active={row.id === draft.activeIngredientId}
          manualValue={manualInputs[row.id] ?? ''}
          canRemove={draft.rows.length > 1}
          onSelect={() => selectActiveRow(row.id)}
          onRemove={() => removeRow(row.id)}
          onMetadataChange={(metadata) => updateRowMetadata(row.id, metadata)}
          onOpenProductPicker={() => openProductPicker(row.id)}
          onUseManualIdentity={() => switchRowToManual(row)}
          onManualChange={(value) => updateManualInput(row.id, value)}
          onManualSubmit={() => submitManualWeight(row.id)}
        />
      ))}
      <ProductPickerModal
        visible={Boolean(pickerRow)}
        products={products}
        loading={productsLoading}
        error={productsError}
        search={productSearch}
        row={pickerRow}
        onSearchChange={setProductSearch}
        onClose={() => setProductPickerRowId(undefined)}
        onRetry={() => void loadProducts(productSearch)}
        onSelect={(product) => {
          if (!pickerRow) return;
          selectProductForRow(pickerRow.id, product);
        }}
      />
      <View style={styles.chargeCard}>
        <Text style={styles.sectionTitle}>Colour charge</Text>
        <Text style={styles.chargeTotal}>{formatMoney(draft.billableChargeCents, draft.currencyCode)}</Text>
        <Text style={styles.meta}>
          Actual cost {formatMoney(draft.totalCostCents, draft.currencyCode)} · Waste{' '}
          {formatMoney(draft.totalWasteCostCents, draft.currencyCode)}
        </Text>
        <Text style={styles.meta}>
          {draft.status === 'saved'
            ? `Finalized ${formatTime(draft.finalizedAt)}. Billing and inventory have been reconciled.`
            : draft.hasMissingCost
              ? 'Some weighted rows are missing cost per gram.'
              : 'Save Final applies billing, inventory usage, waste, and low-stock reconciliation.'}
        </Text>
      </View>
      <LabButton label={savingDraft ? 'Saving...' : 'Save draft'} onPress={() => void handleSaveDraft()} disabled={savingDraft} />
      <LabButton
        label={savingFinal ? 'Finalizing...' : 'Save Final'}
        onPress={() => void handleSaveFinal()}
        disabled={savingFinal || savingDraft || draft.status === 'saved'}
      />
      <LabButton label="Reopen saved draft" onPress={handleLoadDraft} variant="secondary" />
      <Text style={styles.meta}>{draftMessage}</Text>
    </LabScreen>
  );
}

interface IngredientRowProps {
  row: FormulaIngredientRow;
  active: boolean;
  manualValue: string;
  canRemove: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onMetadataChange: (metadata: FormulaRowMetadataUpdate) => void;
  onOpenProductPicker: () => void;
  onUseManualIdentity: () => void;
  onManualChange: (value: string) => void;
  onManualSubmit: () => void;
}

function IngredientRow({
  row,
  active,
  manualValue,
  canRemove,
  onSelect,
  onRemove,
  onMetadataChange,
  onOpenProductPicker,
  onUseManualIdentity,
  onManualChange,
  onManualSubmit,
}: IngredientRowProps): React.JSX.Element {
  const manualDisabled = manualValue.trim().length === 0 || Number.isNaN(Number(manualValue));
  const weightLabel = row.capturedGrams != null ? `${row.capturedGrams.toFixed(1)} g` : 'No weight yet';
  const sourceLabel = row.weightSource === 'ble' ? 'BLE scale' : row.weightSource === 'manual' ? 'Manual' : 'Waiting';
  const costLabel =
    row.costCents != null
      ? formatMoney(row.costCents, row.costBasis.currencyCode)
      : row.costBasis.costPerGramCents == null
        ? 'Missing cost'
        : formatMoney(0, row.costBasis.currencyCode);
  const productMeta = [row.brand, row.category, row.sku ? `SKU ${row.sku}` : undefined].filter(Boolean).join(' · ');
  const costBasisLabel =
    row.costBasis.costPerGramCents == null
      ? 'No product cost on record'
      : `${row.costBasis.costPerGramCents}p/g from inventory`;
  const isManualIdentity = row.identityMode === 'custom_manual';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={[styles.ingredientRow, active && styles.activeIngredientRow]}
    >
      <View style={styles.rowHeader}>
        <View style={styles.rowTitleBlock}>
          <Text style={styles.activePill}>{active ? 'Active capture' : 'Tap to capture'}</Text>
          {isManualIdentity ? (
            <TextInput
              onChangeText={(productName) => onMetadataChange({ ...row, productName })}
              placeholder="Custom ingredient name"
              placeholderTextColor={labTheme.colors.textMuted}
              style={styles.productInput}
              value={row.productName}
            />
          ) : (
            <Pressable accessibilityRole="button" onPress={onOpenProductPicker} style={styles.productSelectButton}>
              <Text style={row.productId ? styles.productInput : styles.productPlaceholder}>
                {row.productName || 'Select product'}
              </Text>
              <Text style={styles.meta}>
                {row.productId ? 'Inventory product selected' : 'Tap to search product catalogue'}
              </Text>
            </Pressable>
          )}
        </View>
        <View style={styles.rowWeightBlock}>
          <Text style={styles.rowWeight}>{weightLabel}</Text>
          <Text style={styles.meta}>{sourceLabel}</Text>
          <Text style={styles.rowCost}>{costLabel}</Text>
        </View>
      </View>
      {isManualIdentity ? (
        <View style={styles.manualIdentityCard}>
          <Text style={styles.label}>Manual ingredient fallback</Text>
          <Text style={styles.meta}>Use only when the ingredient is not in the inventory catalogue.</Text>
          <TextInput
            onChangeText={(brand) => onMetadataChange({ ...row, brand })}
            placeholder="Brand / supplier"
            placeholderTextColor={labTheme.colors.textMuted}
            style={styles.smallInput}
            value={row.brand ?? ''}
          />
          <TextInput
            keyboardType="decimal-pad"
            onChangeText={(value) => {
              const parsedCostPerGram = Number(value);

              onMetadataChange({
                ...row,
                costBasis: {
                  source:
                    value.trim().length > 0 && !Number.isNaN(parsedCostPerGram)
                      ? 'manual_cost'
                      : 'missing',
                  costPerGramCents:
                    value.trim().length > 0 && !Number.isNaN(parsedCostPerGram)
                      ? parsedCostPerGram
                      : undefined,
                  currencyCode: row.costBasis.currencyCode,
                },
              });
            }}
            placeholder="Manual cost / g in pence"
            placeholderTextColor={labTheme.colors.textMuted}
            style={styles.smallInput}
            value={row.costBasis.source === 'manual_cost' ? row.costBasis.costPerGramCents?.toString() ?? '' : ''}
          />
          <LabButton label="Select catalogue product instead" onPress={onOpenProductPicker} variant="secondary" />
        </View>
      ) : (
        <View style={styles.productSummaryCard}>
          <View>
            <Text style={styles.label}>Product data</Text>
            <Text style={styles.productSummaryTitle}>{row.displayName ?? (row.productName || 'No product selected')}</Text>
            <Text style={styles.meta}>{productMeta || 'Brand/category/SKU will autofill after selection.'}</Text>
            <Text style={row.costBasis.costPerGramCents == null ? styles.warningText : styles.meta}>
              {costBasisLabel}
            </Text>
          </View>
          <View style={styles.productActions}>
            <LabButton label={row.productId ? 'Change product' : 'Select product'} onPress={onOpenProductPicker} variant="secondary" />
            <Pressable accessibilityRole="button" onPress={onUseManualIdentity} style={styles.textAction}>
              <Text style={styles.textActionLabel}>Custom ingredient</Text>
            </Pressable>
          </View>
        </View>
      )}
      <View style={styles.metadataGrid}>
        <TextInput
          onChangeText={(developer) => onMetadataChange({ ...row, developer })}
          placeholder="Developer / application metadata"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.smallInput}
          value={row.developer ?? ''}
        />
        <TextInput
          keyboardType="decimal-pad"
          onChangeText={(value) => {
            const parsedWaste = Number(value);

            onMetadataChange({
              ...row,
              wasteGrams:
                value.trim().length > 0 && !Number.isNaN(parsedWaste)
                  ? parsedWaste
                  : undefined,
            });
          }}
          placeholder="Waste grams"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.smallInput}
          value={row.wasteGrams?.toString() ?? ''}
        />
      </View>
      <View style={styles.manualRow}>
        <TextInput
          keyboardType="decimal-pad"
          onChangeText={onManualChange}
          placeholder="Manual grams"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.manualInput}
          value={manualValue}
        />
        <LabButton
          label="Use manual"
          onPress={onManualSubmit}
          disabled={manualDisabled}
          variant="secondary"
        />
      </View>
      <TextInput
        onChangeText={(notes) => onMetadataChange({ ...row, notes })}
        placeholder="Notes"
        placeholderTextColor={labTheme.colors.textMuted}
        style={styles.notesInput}
        value={row.notes ?? ''}
      />
      {canRemove ? <LabButton label="Remove row" onPress={onRemove} variant="secondary" /> : null}
    </Pressable>
  );
}

interface ProductPickerModalProps {
  visible: boolean;
  products: InventoryProduct[];
  loading: boolean;
  error?: string;
  search: string;
  row?: FormulaIngredientRow;
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
  onSearchChange,
  onClose,
  onRetry,
  onSelect,
}: ProductPickerModalProps): React.JSX.Element {
  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.productPicker}>
          <View style={styles.clientHeader}>
            <View>
              <Text style={styles.label}>Select product</Text>
              <Text style={styles.sectionTitle}>{row?.productName || 'Inventory catalogue'}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.lastFormulaButton}>
              <Text style={styles.lastFormulaText}>Close</Text>
            </Pressable>
          </View>
          <TextInput
            autoCapitalize="none"
            onChangeText={onSearchChange}
            placeholder="Search brand, shade, SKU or category"
            placeholderTextColor={labTheme.colors.textMuted}
            style={styles.searchInput}
            value={search}
          />
          {loading ? <Text style={styles.meta}>Loading products...</Text> : null}
          {error ? (
            <View style={styles.errorCard}>
              <Text style={styles.warningText}>{error}</Text>
              <LabButton label="Retry" onPress={onRetry} variant="secondary" />
            </View>
          ) : null}
          {!loading && !error && products.length === 0 ? (
            <Text style={styles.meta}>No matching inventory products. Use custom ingredient only if this is not catalogued.</Text>
          ) : null}
          <ScrollView contentContainerStyle={styles.productList} keyboardShouldPersistTaps="handled">
            {products.map((product) => (
              <ProductResult key={product.id} product={product} onPress={() => onSelect(product)} />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ProductResult({
  product,
  onPress,
}: {
  product: InventoryProduct;
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

  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.productResult}>
      <Text style={styles.productSummaryTitle}>{formatProductDisplayName(product)}</Text>
      <Text style={styles.meta}>{meta || 'Inventory product'}</Text>
      <Text style={product.defaultCostPerGramCents == null ? styles.warningText : styles.rowCost}>
        {product.defaultCostPerGramCents == null ? 'Missing cost basis' : `${product.defaultCostPerGramCents}p/g`}
      </Text>
    </Pressable>
  );
}

interface PreviousFormulaCardProps {
  formula: SavedFormulaRecord;
  onDuplicate: () => void;
}

function PreviousFormulaCard({ formula, onDuplicate }: PreviousFormulaCardProps): React.JSX.Element {
  return (
    <View style={styles.previousCard}>
      <View style={styles.clientHeader}>
        <View>
          <Text style={styles.label}>Last formula</Text>
          <Text style={styles.sectionTitle}>{new Date(formula.savedAt).toLocaleDateString()}</Text>
        </View>
        <Text style={styles.rowWeight}>{formatMoney(formula.totalCostCents, formula.currencyCode)}</Text>
      </View>
      {formula.rows.slice(0, 3).map((row) => (
        <Text key={row.id} style={styles.meta}>
          {formatRowDisplayName(row)} · {row.capturedGrams?.toFixed(1) ?? '--'} g
        </Text>
      ))}
      <LabButton label="Duplicate into current mix" onPress={onDuplicate} variant="secondary" />
    </View>
  );
}

function formatPatchTest(status: string, performedAt?: string): string {
  if (!performedAt) return status;

  return `${status} on ${new Date(performedAt).toLocaleDateString()}`;
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

const styles = StyleSheet.create({
  clientBar: {
    gap: labTheme.spacing.xs,
    padding: labTheme.spacing.lg,
    borderRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.card,
  },
  clientHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: labTheme.spacing.md,
  },
  label: {
    color: labTheme.colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  clientName: {
    color: labTheme.colors.textPrimary,
    fontSize: 24,
    fontWeight: '900',
  },
  serviceText: {
    color: labTheme.colors.textSecondary,
    fontSize: 16,
    fontWeight: '700',
  },
  lastFormulaButton: {
    alignSelf: 'flex-start',
    paddingVertical: labTheme.spacing.sm,
    paddingHorizontal: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.full,
  },
  lastFormulaText: {
    color: labTheme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  captureCard: {
    gap: labTheme.spacing.xs,
    padding: labTheme.spacing.lg,
    borderWidth: 1,
    borderColor: labTheme.colors.primary,
    borderRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.card,
  },
  captureTitle: {
    color: labTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  weight: {
    color: labTheme.colors.textPrimary,
    fontSize: 48,
    fontWeight: '900',
  },
  meta: {
    color: labTheme.colors.textSecondary,
    fontSize: 14,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: labTheme.spacing.md,
  },
  sectionTitle: {
    color: labTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '900',
  },
  ingredientRow: {
    gap: labTheme.spacing.md,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  activeIngredientRow: {
    borderColor: labTheme.colors.primary,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: labTheme.spacing.md,
  },
  rowTitleBlock: {
    flex: 1,
    gap: labTheme.spacing.xs,
  },
  rowWeightBlock: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  activePill: {
    color: labTheme.colors.primary,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  productInput: {
    color: labTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  productPlaceholder: {
    color: labTheme.colors.textMuted,
    fontSize: 20,
    fontWeight: '900',
  },
  productSelectButton: {
    gap: labTheme.spacing.xs,
    paddingVertical: labTheme.spacing.xs,
  },
  rowWeight: {
    color: labTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  rowCost: {
    color: labTheme.colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  metadataGrid: {
    gap: labTheme.spacing.sm,
  },
  productSummaryCard: {
    gap: labTheme.spacing.md,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.inputBg,
  },
  productSummaryTitle: {
    color: labTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '900',
  },
  productActions: {
    gap: labTheme.spacing.sm,
  },
  manualIdentityCard: {
    gap: labTheme.spacing.sm,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.inputBg,
  },
  textAction: {
    alignSelf: 'flex-start',
    paddingVertical: labTheme.spacing.xs,
  },
  textActionLabel: {
    color: labTheme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '800',
  },
  warningText: {
    color: labTheme.colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  smallInput: {
    minHeight: 48,
    paddingHorizontal: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.inputLg,
    backgroundColor: labTheme.colors.inputBg,
    color: labTheme.colors.textPrimary,
    fontSize: 18,
  },
  manualRow: {
    gap: labTheme.spacing.sm,
  },
  manualInput: {
    minHeight: 48,
    paddingHorizontal: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.inputLg,
    backgroundColor: labTheme.colors.inputBg,
    color: labTheme.colors.textPrimary,
    fontSize: 18,
  },
  notesInput: {
    minHeight: 48,
    paddingHorizontal: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.inputLg,
    backgroundColor: labTheme.colors.inputBg,
    color: labTheme.colors.textPrimary,
    fontSize: 16,
  },
  chargeCard: {
    gap: labTheme.spacing.sm,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  chargeTotal: {
    color: labTheme.colors.textPrimary,
    fontSize: 34,
    fontWeight: '900',
  },
  previousCard: {
    gap: labTheme.spacing.sm,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.primary,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  productPicker: {
    maxHeight: '86%',
    gap: labTheme.spacing.md,
    padding: labTheme.spacing.lg,
    borderTopLeftRadius: labTheme.radius.cardLg,
    borderTopRightRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.background,
  },
  searchInput: {
    minHeight: 52,
    paddingHorizontal: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.primary,
    borderRadius: labTheme.radius.inputLg,
    backgroundColor: labTheme.colors.inputBg,
    color: labTheme.colors.textPrimary,
    fontSize: 18,
  },
  productList: {
    gap: labTheme.spacing.sm,
    paddingBottom: labTheme.spacing.lg,
  },
  productResult: {
    gap: labTheme.spacing.xs,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  errorCard: {
    gap: labTheme.spacing.sm,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.primary,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
});
