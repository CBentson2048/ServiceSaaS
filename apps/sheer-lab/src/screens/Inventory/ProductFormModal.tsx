import type { InventoryCategory, InventoryProduct } from '@sheer/domain';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../../ui/icons/Icon';
import { t, c } from '../shared/LabShell';
import { formatMoney } from '../Home/dashboardHelpers';

// The edit modal mirrors the product mockup: Brand, Category, Product range
// (name), Shade/batch (sku), Cost/g, Markup %, the derived Billing price/g,
// opening stock and reorder alert level. Cost and billing are entered in
// currency units for the operator and converted to integer cents for the API.

export interface ProductFormValues {
  brand: string;
  categoryId: string;
  name: string;
  sku: string;
  costPerGram: string;
  markupPct: string;
  initialStock: string;
  reorderLevel: string;
}

export interface ProductSavePayload {
  brand: string | null;
  name: string;
  categoryId: string | null;
  sku: string | null;
  defaultCostPerGramCents: number | null;
  retailPriceCents: number | null;
  lowStockThresholdGrams: number;
  initialStockGrams: number | null;
}

const EMPTY: ProductFormValues = {
  brand: '',
  categoryId: '',
  name: '',
  sku: '',
  costPerGram: '',
  markupPct: '',
  initialStock: '',
  reorderLevel: '',
};

interface ProductFormModalProps {
  visible: boolean;
  product?: InventoryProduct;
  categories: InventoryCategory[];
  currentOnHandGrams?: number;
  saving: boolean;
  /** Owner-only archive action; omitted for managers and when creating. */
  onArchive?: () => void;
  onClose: () => void;
  onSave: (payload: ProductSavePayload) => void;
}

export function ProductFormModal({
  visible,
  product,
  categories,
  currentOnHandGrams,
  saving,
  onArchive,
  onClose,
  onSave,
}: ProductFormModalProps): React.JSX.Element {
  const isEdit = Boolean(product);
  const [form, setForm] = useState<ProductFormValues>(EMPTY);
  const [error, setError] = useState<string | undefined>();

  // Re-seed whenever the target product (or visibility) changes so the modal
  // always reflects the row that was tapped.
  useEffect(() => {
    if (!visible) return;
    setError(undefined);
    setForm(product ? fromProduct(product) : EMPTY);
  }, [visible, product]);

  const cost = parseDecimal(form.costPerGram);
  const markup = parseDecimal(form.markupPct);
  const billingPerGramCents = useMemo(() => {
    if (cost === undefined) return undefined;
    const factor = 1 + (markup ?? 0) / 100;
    return Math.round(cost * 100 * factor);
  }, [cost, markup]);

  const set = (key: keyof ProductFormValues) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    if (!form.name.trim()) {
      setError('Product range / name is required.');
      return;
    }
    onSave({
      brand: nullable(form.brand),
      name: form.name.trim(),
      categoryId: form.categoryId || null,
      sku: nullable(form.sku),
      defaultCostPerGramCents: cost === undefined ? null : Math.round(cost * 100),
      retailPriceCents: billingPerGramCents ?? null,
      lowStockThresholdGrams: parseDecimal(form.reorderLevel) ?? 0,
      initialStockGrams: isEdit ? null : parseDecimal(form.initialStock) ?? null,
    });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{isEdit ? 'Edit product details' : 'Add product'}</Text>
              <Text style={styles.subtitle}>Configure product specifications, financial rules, and stock thresholds.</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={10}
              style={styles.close}
            >
              <Icon name="close" size="xs" tone="secondary" />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.grid}>
              <FieldInput label="Brand name" value={form.brand} onChangeText={set('brand')} placeholder="L'Oréal Professionnel" />
              <View style={styles.field}>
                <Text style={styles.label}>Category</Text>
                <CategoryPicker
                  categories={categories}
                  value={form.categoryId}
                  onChange={(id) => setForm((prev) => ({ ...prev, categoryId: id }))}
                />
              </View>
            </View>

            <View style={styles.grid}>
              <FieldInput label="Product range" value={form.name} onChangeText={set('name')} placeholder="Majirel" />
              <FieldInput label="Shade / batch code" value={form.sku} onChangeText={set('sku')} placeholder="7.1" autoCapitalize="characters" />
            </View>

            <View style={styles.grid3}>
              <FieldInput
                label="Cost per gram"
                value={form.costPerGram}
                onChangeText={set('costPerGram')}
                placeholder="0.12"
                keyboardType="decimal-pad"
                prefix="£"
              />
              <FieldInput
                label="Markup %"
                value={form.markupPct}
                onChangeText={set('markupPct')}
                placeholder="40"
                keyboardType="decimal-pad"
              />
              <View style={styles.field}>
                <Text style={styles.label}>Billing price / g</Text>
                <View style={styles.derived}>
                  <Text style={styles.derivedValue}>
                    {billingPerGramCents === undefined ? '—' : formatMoney(billingPerGramCents)}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.grid}>
              {isEdit ? (
                <View style={styles.field}>
                  <Text style={styles.label}>On hand (this location)</Text>
                  <View style={styles.derived}>
                    <Text style={styles.derivedMuted}>
                      {currentOnHandGrams === undefined ? 'Not stocked here' : `${Math.round(currentOnHandGrams)} g`}
                    </Text>
                  </View>
                  <Text style={styles.helper}>Use “Adjust stock” to change on-hand quantity.</Text>
                </View>
              ) : (
                <FieldInput
                  label="Initial stock (grams)"
                  value={form.initialStock}
                  onChangeText={set('initialStock')}
                  placeholder="450"
                  keyboardType="decimal-pad"
                />
              )}
              <FieldInput
                label="Reorder alert level"
                value={form.reorderLevel}
                onChangeText={set('reorderLevel')}
                placeholder="500"
                keyboardType="decimal-pad"
              />
            </View>
          </ScrollView>

          <View style={styles.footer}>
            {isEdit && onArchive ? (
              <Pressable accessibilityRole="button" onPress={onArchive} disabled={saving} style={[styles.btn, styles.btnArchive]}>
                <Text style={styles.btnArchiveLabel}>Archive</Text>
              </Pressable>
            ) : null}
            <View style={styles.footerSpacer} />
            <Pressable accessibilityRole="button" onPress={onClose} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleSave}
              disabled={saving}
              style={[styles.btn, styles.btnPrimary, saving && styles.btnDisabled]}
            >
              <Text style={styles.btnPrimaryLabel}>{saving ? 'Saving…' : isEdit ? 'Update inventory' : 'Add product'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: InventoryCategory[];
  value: string;
  onChange: (id: string) => void;
}): React.JSX.Element {
  if (categories.length === 0) {
    return (
      <View style={styles.derived}>
        <Text style={styles.derivedMuted}>No categories yet</Text>
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      <Chip label="None" active={value === ''} onPress={() => onChange('')} />
      {categories.map((category) => (
        <Chip key={category.id} label={category.name} active={value === category.id} onPress={() => onChange(category.id)} />
      ))}
    </ScrollView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function FieldInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  prefix,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'decimal-pad';
  autoCapitalize?: 'none' | 'characters';
  prefix?: string;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputWrap}>
        {prefix ? <Text style={styles.prefix}>{prefix}</Text> : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={c.textMuted}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize={autoCapitalize ?? 'sentences'}
          style={[styles.input, prefix ? styles.inputWithPrefix : null]}
        />
      </View>
    </View>
  );
}

function fromProduct(product: InventoryProduct): ProductFormValues {
  const cost = product.defaultCostPerGramCents;
  const retail = product.retailPriceCents;
  const markup = cost && cost > 0 && retail !== undefined ? Math.round(((retail - cost) / cost) * 1000) / 10 : undefined;
  return {
    brand: product.brand ?? '',
    categoryId: product.categoryId ?? '',
    name: product.name,
    sku: product.sku ?? '',
    costPerGram: cost === undefined ? '' : String(cost / 100),
    markupPct: markup === undefined ? '' : String(markup),
    initialStock: '',
    reorderLevel: product.lowStockThresholdGrams ? String(product.lowStockThresholdGrams) : '',
  };
}

function parseDecimal(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nullable(value: string): string | null {
  const next = value.trim();
  return next ? next : null;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(25,19,31,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: t.spacing.base,
  },
  card: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '90%',
    backgroundColor: c.surface,
    borderRadius: t.radius.cardLg,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: t.spacing.md,
    padding: t.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  title: { color: c.textPrimary, fontSize: t.typography.fontSize.subtitle, fontWeight: '700' },
  subtitle: { color: c.textSecondary, fontSize: t.typography.fontSize.small, marginTop: 2 },
  close: {
    width: 30,
    height: 30,
    borderRadius: t.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceAlt,
  },
  body: { maxHeight: 460 },
  bodyContent: { padding: t.spacing.lg, gap: t.spacing.base },
  error: {
    color: c.dangerText,
    backgroundColor: c.dangerBg,
    borderColor: c.dangerBorder,
    borderWidth: 1,
    borderRadius: t.radius.input,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    fontSize: t.typography.fontSize.small,
  },
  grid: { flexDirection: 'row', gap: t.spacing.base, flexWrap: 'wrap' },
  grid3: { flexDirection: 'row', gap: t.spacing.base, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 150, gap: 6 },
  label: { color: c.textSecondary, fontSize: t.typography.fontSize.micro, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  inputWrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: c.borderStrong, borderRadius: t.radius.input, backgroundColor: c.surface },
  prefix: { color: c.textMuted, fontSize: t.typography.fontSize.body, paddingLeft: t.spacing.md },
  input: {
    flex: 1,
    color: c.textPrimary,
    fontSize: t.typography.fontSize.body,
    paddingHorizontal: t.spacing.md,
    paddingVertical: 10,
  },
  inputWithPrefix: { paddingLeft: 4 },
  derived: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: t.radius.input,
    backgroundColor: c.primarySoft,
    paddingHorizontal: t.spacing.md,
    paddingVertical: 11,
  },
  derivedValue: { color: c.primary, fontSize: t.typography.fontSize.body, fontWeight: '800' },
  derivedMuted: { color: c.textSecondary, fontSize: t.typography.fontSize.body },
  helper: { color: c.textMuted, fontSize: t.typography.fontSize.micro },
  chips: { gap: t.spacing.sm, paddingVertical: 2 },
  chip: {
    paddingHorizontal: t.spacing.md,
    paddingVertical: 8,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: c.borderStrong,
    backgroundColor: c.surface,
  },
  chipActive: { backgroundColor: c.primarySoft, borderColor: c.primary },
  chipLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.small, fontWeight: '600' },
  chipLabelActive: { color: c.primary },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    padding: t.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  footerSpacer: { flex: 1 },
  btnArchive: { borderWidth: 1, borderColor: c.dangerBorder, backgroundColor: c.dangerBg },
  btnArchiveLabel: { color: c.dangerText, fontWeight: '700', fontSize: t.typography.fontSize.body },
  btn: { minHeight: 44, paddingHorizontal: t.spacing.lg, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surface },
  btnGhostLabel: { color: c.textSecondary, fontWeight: '700', fontSize: t.typography.fontSize.body },
  btnPrimary: { backgroundColor: c.primary },
  btnPrimaryLabel: { color: c.textOnPrimary, fontWeight: '800', fontSize: t.typography.fontSize.body },
  btnDisabled: { opacity: 0.5 },
});
