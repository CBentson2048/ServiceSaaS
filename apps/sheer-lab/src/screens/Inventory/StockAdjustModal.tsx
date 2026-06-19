import type React from 'react';
import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { t, c } from '../shared/LabShell';
import { formatGrams } from '../Home/dashboardHelpers';

export interface StockAdjustTarget {
  productId: string;
  productName: string;
  brand?: string;
  currentQuantityGrams: number;
  /** false when the product has no stock record at this station yet. */
  isStocked: boolean;
}

export interface StockAdjustValues {
  direction: 'inbound' | 'loss';
  quantityGrams: number;
  reason: string | null;
}

interface StockAdjustModalProps {
  visible: boolean;
  item?: StockAdjustTarget;
  saving: boolean;
  onClose: () => void;
  onSubmit: (values: StockAdjustValues) => void;
}

// Records an auditable stock movement against one product at the station's
// location — inbound restock (+) or loss/correction (−). Every adjustment is
// written to the movement log by the API.
export function StockAdjustModal({ visible, item, saving, onClose, onSubmit }: StockAdjustModalProps): React.JSX.Element {
  const [direction, setDirection] = useState<'inbound' | 'loss'>('inbound');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();

  const canReduce = item?.isStocked ?? false;

  useEffect(() => {
    if (!visible) return;
    setDirection('inbound');
    setQuantity('');
    setReason('');
    setError(undefined);
  }, [visible, item]);

  const handleSubmit = () => {
    const magnitude = Number(quantity.trim());
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      setError('Enter a quantity greater than zero.');
      return;
    }
    onSubmit({ direction, quantityGrams: magnitude, reason: reason.trim() || null });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{canReduce ? 'Adjust stock' : 'Initialize stock'}</Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {item ? `${item.brand ? `${item.brand} · ` : ''}${item.productName}` : ''}
              </Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10} style={styles.close}>
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.body}>
            {item ? (
              <Text style={styles.onHand}>
                On hand now: <Text style={styles.onHandValue}>{formatGrams(item.currentQuantityGrams)}</Text>
              </Text>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            {canReduce ? (
              <View style={styles.toggleRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDirection('inbound')}
                  style={[styles.toggle, direction === 'inbound' && styles.toggleInbound]}
                >
                  <Text style={[styles.toggleLabel, direction === 'inbound' && styles.toggleLabelInbound]}>Inbound (+)</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDirection('loss')}
                  style={[styles.toggle, direction === 'loss' && styles.toggleLoss]}
                >
                  <Text style={[styles.toggleLabel, direction === 'loss' && styles.toggleLabelLoss]}>Loss (−)</Text>
                </Pressable>
              </View>
            ) : null}

            <Text style={styles.label}>Quantity (g)</Text>
            <TextInput
              value={quantity}
              onChangeText={(value) => setQuantity(value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              placeholderTextColor={c.textMuted}
              keyboardType="decimal-pad"
              style={styles.input}
            />

            <Text style={styles.label}>Reason (optional)</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Restock delivery, damage, cycle count…"
              placeholderTextColor={c.textMuted}
              style={styles.input}
            />
          </View>

          <View style={styles.footer}>
            <Pressable accessibilityRole="button" onPress={onClose} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleSubmit}
              disabled={saving}
              style={[styles.btn, styles.btnPrimary, saving && styles.btnDisabled]}
            >
              <Text style={styles.btnPrimaryLabel}>{saving ? 'Saving…' : 'Record adjustment'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(24,20,31,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: t.spacing.base,
  },
  card: {
    width: '100%',
    maxWidth: 440,
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
  close: { width: 30, height: 30, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceAlt },
  closeGlyph: { color: c.textSecondary, fontSize: 14, fontWeight: '700' },
  body: { padding: t.spacing.lg, gap: t.spacing.sm },
  onHand: { color: c.textSecondary, fontSize: t.typography.fontSize.small },
  onHandValue: { color: c.textPrimary, fontWeight: '700' },
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
  toggleRow: { flexDirection: 'row', gap: t.spacing.sm, marginTop: 4 },
  toggle: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.input, borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surface },
  toggleInbound: { backgroundColor: c.successBg, borderColor: c.successBorder },
  toggleLoss: { backgroundColor: c.dangerBg, borderColor: c.dangerBorder },
  toggleLabel: { color: c.textSecondary, fontWeight: '700', fontSize: t.typography.fontSize.small },
  toggleLabelInbound: { color: c.successText },
  toggleLabelLoss: { color: c.dangerText },
  label: { color: c.textSecondary, fontSize: t.typography.fontSize.micro, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 6 },
  input: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.body,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: t.radius.input,
    paddingHorizontal: t.spacing.md,
    paddingVertical: 10,
    backgroundColor: c.surface,
  },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: t.spacing.sm, padding: t.spacing.lg, borderTopWidth: 1, borderTopColor: c.border },
  btn: { minHeight: 44, paddingHorizontal: t.spacing.lg, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surface },
  btnGhostLabel: { color: c.textSecondary, fontWeight: '700', fontSize: t.typography.fontSize.body },
  btnPrimary: { backgroundColor: c.primary },
  btnPrimaryLabel: { color: c.textOnPrimary, fontWeight: '800', fontSize: t.typography.fontSize.body },
  btnDisabled: { opacity: 0.5 },
});
