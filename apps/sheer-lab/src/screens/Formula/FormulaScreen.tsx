import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { formatMoney } from '../../features/formulas/formulaCosting';
import type { FormulaIngredientRow, SavedFormulaRecord } from '../../features/formulas/formulaDraftTypes';
import { toLabCoreFormulaDraft } from '../../features/formulas/formulaDraftTypes';
import { useFormulaDraft } from '../../features/formulas/useFormulaDraft';
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
    loadDraft,
    getLatestFormulaForClient,
    duplicateFormula,
    startFromAppointmentContext,
  } = useFormulaDraft();
  const [manualInputs, setManualInputs] = useState<ManualInputState>({});
  const [draftMessage, setDraftMessage] = useState('Local draft not saved yet');
  const [previousFormula, setPreviousFormula] = useState<SavedFormulaRecord | undefined>();
  const lastAppliedBleReading = useRef<string | undefined>(undefined);

  const activeRow = draft.rows.find((row) => row.id === draft.activeIngredientId);
  const activeWeightLabel = activeRow?.capturedGrams != null ? activeRow.capturedGrams.toFixed(1) : '--.-';
  const labCoreDraft = useMemo(() => toLabCoreFormulaDraft(draft), [draft]);
  const entryContext = route.params?.entryContext;

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

  function handleSaveDraft(): void {
    const saved = saveDraft();
    setDraftMessage(
      `Formula saved ${formatTime(saved.savedAt)} · ${saved.rows.length} rows · ${formatMoney(
        saved.billableChargeCents,
        saved.currencyCode,
      )} added to ${saved.client.clientName}'s bill`,
    );
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
        <Text style={styles.captureTitle}>{activeRow?.productName || 'Select an ingredient row'}</Text>
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
          onManualChange={(value) => updateManualInput(row.id, value)}
          onManualSubmit={() => submitManualWeight(row.id)}
        />
      ))}
      <View style={styles.chargeCard}>
        <Text style={styles.sectionTitle}>Colour charge</Text>
        <Text style={styles.chargeTotal}>{formatMoney(draft.billableChargeCents, draft.currencyCode)}</Text>
        <Text style={styles.meta}>
          Actual cost {formatMoney(draft.totalCostCents, draft.currencyCode)} · Waste{' '}
          {formatMoney(draft.totalWasteCostCents, draft.currencyCode)}
        </Text>
        <Text style={styles.meta}>
          {draft.hasMissingCost
            ? 'Some weighted rows are missing cost per gram.'
            : `Added to ${draft.client.clientName}'s bill on save. Inventory and waste are reconciled on save.`}
        </Text>
      </View>
      <LabButton label="Save draft" onPress={handleSaveDraft} />
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
  onMetadataChange: (metadata: {
    productName: string;
    brand?: string;
    shade?: string;
    developer?: string;
    ratio?: string;
    processingTimeMinutes?: number;
    costBasis: FormulaIngredientRow['costBasis'];
    wasteGrams?: number;
    notes?: string;
  }) => void;
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

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={[styles.ingredientRow, active && styles.activeIngredientRow]}
    >
      <View style={styles.rowHeader}>
        <View style={styles.rowTitleBlock}>
          <Text style={styles.activePill}>{active ? 'Active capture' : 'Tap to capture'}</Text>
          <TextInput
            onChangeText={(productName) => onMetadataChange({ ...row, productName })}
            placeholder="Product name"
            placeholderTextColor={labTheme.colors.textMuted}
            style={styles.productInput}
            value={row.productName}
          />
        </View>
        <View style={styles.rowWeightBlock}>
          <Text style={styles.rowWeight}>{weightLabel}</Text>
          <Text style={styles.meta}>{sourceLabel}</Text>
          <Text style={styles.rowCost}>{costLabel}</Text>
        </View>
      </View>
      <View style={styles.metadataGrid}>
        <TextInput
          onChangeText={(brand) => onMetadataChange({ ...row, brand })}
          placeholder="Brand"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.smallInput}
          value={row.brand ?? ''}
        />
        <TextInput
          onChangeText={(shade) => onMetadataChange({ ...row, shade })}
          placeholder="Shade"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.smallInput}
          value={row.shade ?? ''}
        />
        <TextInput
          onChangeText={(developer) => onMetadataChange({ ...row, developer })}
          placeholder="Developer"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.smallInput}
          value={row.developer ?? ''}
        />
        <TextInput
          keyboardType="decimal-pad"
          onChangeText={(value) => {
            const parsedCostPerGram = Number(value);

            onMetadataChange({
              ...row,
              costBasis: {
                ...row.costBasis,
                source:
                  value.trim().length > 0 && !Number.isNaN(parsedCostPerGram)
                    ? 'manual_cost'
                    : 'missing',
                costPerGramCents:
                  value.trim().length > 0 && !Number.isNaN(parsedCostPerGram)
                    ? parsedCostPerGram
                    : undefined,
              },
            });
          }}
          placeholder="Cost / g in pence"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.smallInput}
          value={row.costBasis.costPerGramCents?.toString() ?? ''}
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
          {row.productName || 'Untitled ingredient'} · {row.capturedGrams?.toFixed(1) ?? '--'} g
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
});
