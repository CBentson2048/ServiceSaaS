import { createFormulaDraft } from '@sheer/lab-core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ConnectionStatusBar } from '../../features/ble/components/ConnectionStatusBar';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';
import { PlaceholderText } from '../shared/PlaceholderText';

const draft = createFormulaDraft({
  id: 'local-placeholder',
  labSessionId: 'pending-session',
});

export function FormulaScreen(): React.JSX.Element {
  const ble = useBleScale();
  const [manualValue, setManualValue] = useState('');
  const activeWeight = ble.liveWeight;
  const manualDisabled = manualValue.trim().length === 0 || Number.isNaN(Number(manualValue));
  const modeLabel = activeWeight?.source === 'ble' ? 'Live BLE scale' : activeWeight ? 'Manual entry' : 'No weight';
  const displayWeight = useMemo(() => {
    if (!activeWeight) return '--.-';
    return activeWeight.grams.toFixed(1);
  }, [activeWeight]);

  function submitManualWeight(): void {
    const grams = Number(manualValue);
    if (Number.isNaN(grams)) return;

    ble.setManualWeight(grams);
    setManualValue('');
  }

  return (
    <LabScreen title="Capture formula" eyebrow="Manual fallback ready">
      <ConnectionStatusBar
        status={ble.status}
        deviceName={ble.connectedDevice?.name}
        weight={ble.liveWeight}
        error={ble.error}
      />
      <PlaceholderText>
        The formula workflow will combine BLE weight capture with manual entry fallback. This screen
        proves the live weight foundation without adding ingredient rows or save flow yet.
      </PlaceholderText>
      <View style={styles.weightCard}>
        <Text style={styles.mode}>{modeLabel}</Text>
        <Text style={styles.weight}>{displayWeight} g</Text>
        <Text style={styles.meta}>
          Draft status: {draft.status} · Items: {draft.items.length}
        </Text>
      </View>
      <View style={styles.manualCard}>
        <Text style={styles.manualTitle}>Manual fallback</Text>
        <PlaceholderText>
          Use this if the scale is unavailable, Bluetooth is denied, or the connection drops mid-mix.
        </PlaceholderText>
        <TextInput
          keyboardType="decimal-pad"
          onChangeText={setManualValue}
          placeholder="Enter grams"
          placeholderTextColor={labTheme.colors.textMuted}
          style={styles.input}
          value={manualValue}
        />
        <LabButton
          label="Use manual weight"
          onPress={submitManualWeight}
          disabled={manualDisabled}
        />
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  weightCard: {
    gap: labTheme.spacing.xs,
    padding: labTheme.spacing.lg,
    borderRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.card,
  },
  mode: {
    color: labTheme.colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
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
  manualCard: {
    gap: labTheme.spacing.md,
  },
  manualTitle: {
    color: labTheme.colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  input: {
    minHeight: 48,
    paddingHorizontal: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.inputLg,
    backgroundColor: labTheme.colors.inputBg,
    color: labTheme.colors.textPrimary,
    fontSize: 18,
  },
});
