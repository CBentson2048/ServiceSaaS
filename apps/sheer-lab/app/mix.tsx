import { Redirect, router } from 'expo-router';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { ScaleStatusBar } from '../src/ble/ScaleStatusBar';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';
import { labColors, labTheme } from '../src/ui/labTheme';

const INGREDIENTS = [
  { name: 'Tint 7.13', target: '34g', captured: '32g' },
  { name: 'Gloss 9V', target: '12g', captured: '12g' },
  { name: 'Developer 20 vol', target: '70g', captured: 'Pending' },
];

export default function MixFormulaScreen() {
  const { boundSalon, stylistSession } = useSheerLabSession();

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  if (!stylistSession) {
    return <Redirect href="/pin" />;
  }

  return (
    <LabScreen>
      <ScaleStatusBar />

      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <LabText variant="heading" weight="bold">
            Formula capture
          </LabText>
          <LabText tone="secondary">
            Capture colour usage for {stylistSession.stylistName} at {boundSalon.name}.
          </LabText>
        </View>
        <LabButton label="Cancel" variant="secondary" onPress={() => router.back()} />
      </View>

      <LabCard tone="accent">
        <View style={styles.clientBar}>
          <View>
            <LabText variant="micro" tone="muted" weight="bold">
              Client
            </LabText>
            <LabText variant="title" weight="bold">
              Ava Morgan
            </LabText>
            <LabText tone="secondary">Balayage refresh | Appointment 10:30</LabText>
          </View>
          <StatusPill label="Billing linked" tone="success" />
        </View>
      </LabCard>

      <View style={styles.workspace}>
        <LabCard style={styles.ingredientsCard}>
          <LabText variant="title" weight="bold">
            Ingredients
          </LabText>
          {INGREDIENTS.map((ingredient, index) => (
            <View key={ingredient.name} style={styles.ingredientRow}>
              <View style={styles.ingredientIndex}>
                <LabText weight="bold" style={{ color: '#ffffff' }}>
                  {index + 1}
                </LabText>
              </View>
              <View style={styles.ingredientText}>
                <LabText weight="bold">{ingredient.name}</LabText>
                <LabText variant="caption" tone="muted">
                  Target {ingredient.target}
                </LabText>
              </View>
              <StatusPill
                label={ingredient.captured}
                tone={ingredient.captured === 'Pending' ? 'warning' : 'success'}
              />
            </View>
          ))}
        </LabCard>

        <View style={styles.captureColumn}>
          <LabCard tone="accent" style={styles.captureCard}>
            <LabText variant="micro" tone="muted" weight="bold">
              Active ingredient
            </LabText>
            <LabText variant="heading" weight="bold">
              Developer 20 vol
            </LabText>
            <View style={styles.weightCapture}>
              <LabText variant="display" weight="bold" style={styles.weightValue}>
                0.0g
              </LabText>
              <LabText tone="secondary">Waiting for BLE scale or manual entry</LabText>
            </View>
            <View style={styles.quickAmounts}>
              {['+5g', '+10g', '+25g'].map((amount) => (
                <Pressable key={amount} style={styles.quickAmount}>
                  <LabText weight="bold" tone="brand">
                    {amount}
                  </LabText>
                </Pressable>
              ))}
            </View>
          </LabCard>

          <LabCard>
            <LabText variant="title" weight="bold">
              Manual fallback
            </LabText>
            <LabText tone="secondary">
              Use when the scale is unavailable, then mark the reason for audit.
            </LabText>
            <TextInput
              keyboardType="decimal-pad"
              placeholder="Enter grams manually"
              placeholderTextColor={labTheme.colors.inputPlaceholder}
              style={styles.input}
            />
          </LabCard>
        </View>

        <View style={styles.summaryColumn}>
          <LabCard tone="success">
            <LabText variant="title" weight="bold">
              Colour charge preview
            </LabText>
            <LabText variant="display" weight="bold" tone="success">
              GBP 42.50
            </LabText>
            <LabText tone="secondary">
              Estimated from product cost, service rules, and manager-configured billing handoff.
            </LabText>
          </LabCard>

          <LabCard>
            <LabText variant="title" weight="bold">
              Save readiness
            </LabText>
            <StatusPill label="Inventory update pending" tone="warning" />
            <StatusPill label="Billing handoff prepared" tone="success" />
            <LabButton label="Save formula" fullWidth onPress={() => router.push('/review')} />
          </LabCard>
        </View>
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 18,
  },
  headerCopy: {
    flex: 1,
    gap: 4,
  },
  clientBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
  },
  workspace: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'stretch',
  },
  ingredientsCard: {
    width: 310,
  },
  ingredientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: labTheme.colors.border,
  },
  ingredientIndex: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: labColors.basin,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ingredientText: {
    flex: 1,
  },
  captureColumn: {
    flex: 1,
    gap: 16,
  },
  captureCard: {
    minHeight: 330,
  },
  weightCapture: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  weightValue: {
    color: labColors.basin,
  },
  quickAmounts: {
    flexDirection: 'row',
    gap: 12,
  },
  quickAmount: {
    minHeight: 54,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: labTheme.colors.borderStrong,
    backgroundColor: '#ffffff',
  },
  summaryColumn: {
    width: 310,
    gap: 16,
  },
  input: {
    minHeight: 58,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: labTheme.colors.inputBorder,
    backgroundColor: labTheme.colors.inputBg,
    paddingHorizontal: 16,
    fontSize: 18,
  },
});
