import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSheerLabSession } from '../src/session/SheerLabSessionProvider';
import { LabButton } from '../src/ui/LabButton';
import { LabCard } from '../src/ui/LabCard';
import { LabScreen } from '../src/ui/LabScreen';
import { LabText } from '../src/ui/LabText';
import { StatusPill } from '../src/ui/StatusPill';
import { labTheme } from '../src/ui/labTheme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];

export default function StylistPinScreen() {
  const { boundSalon, signInWithPin, unbindSalon } = useSheerLabSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!boundSalon) {
    return <Redirect href="/bind" />;
  }

  async function submitPin(nextPin: string) {
    setIsSubmitting(true);
    const result = await signInWithPin(nextPin);
    setIsSubmitting(false);

    if (result.ok) {
      setError(null);
      router.replace('/home');
      return;
    }

    setError(result.message ?? 'PIN not recognised for this salon.');
    setPin('');
  }

  function handleKey(key: string) {
    setError(null);

    if (key === 'clear') {
      setPin('');
      return;
    }

    if (key === 'back') {
      setPin((current) => current.slice(0, -1));
      return;
    }

    const nextPin = `${pin}${key}`.slice(0, 4);
    setPin(nextPin);

    if (nextPin.length === 4) {
      void submitPin(nextPin);
    }
  }

  async function handleUnbindRequest() {
    await unbindSalon();
    router.replace('/bind');
  }

  return (
    <LabScreen scroll={false} contentStyle={styles.content}>
      <View style={styles.contextPanel}>
        <StatusPill label="Shared salon tablet" />
        <LabText variant="display" weight="bold">
          Stylist PIN
        </LabText>
        <LabText variant="body" tone="secondary">
          Enter your 4-digit salon PIN. PIN validation is scoped to this salon and must never run
          globally by PIN alone.
        </LabText>

        <LabCard tone="accent" style={styles.salonCard}>
          <LabText variant="micro" tone="muted" weight="bold">
            Active salon
          </LabText>
          <LabText variant="heading" weight="bold">
            {boundSalon.name}
          </LabText>
          <LabText tone="secondary">
            {boundSalon.locationName} | {boundSalon.deviceLabel}
          </LabText>
        </LabCard>

        <View style={styles.helpActions}>
          <LabButton label="Need help?" variant="secondary" />
          <LabButton label="Manager reset PIN" variant="ghost" />
          <LabButton
            label="Unbind tablet"
            variant="danger"
            onPress={() => void handleUnbindRequest()}
          />
        </View>
      </View>

      <View style={styles.pinPanel}>
        <View style={styles.pinDots} accessibilityLabel={`${pin.length} of 4 PIN digits entered`}>
          {[0, 1, 2, 3].map((index) => (
            <View key={index} style={[styles.dot, index < pin.length && styles.dotFilled]} />
          ))}
        </View>

        {error ? (
          <LabText variant="body" tone="danger" align="center">
            {error}
          </LabText>
        ) : (
          <LabText variant="body" tone="muted" align="center">
            {isSubmitting ? 'Checking PIN...' : 'Use the large keypad for fast basin login'}
          </LabText>
        )}

        <View style={styles.keypad}>
          {KEYS.map((key) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              disabled={isSubmitting}
              onPress={() => handleKey(key)}
              style={({ pressed }) => [
                styles.key,
                key === 'clear' || key === 'back' ? styles.keyUtility : null,
                pressed && styles.keyPressed,
              ]}
            >
              <LabText variant={key.length === 1 ? 'heading' : 'title'} weight="bold">
                {key === 'back' ? 'DEL' : key.toUpperCase()}
              </LabText>
            </Pressable>
          ))}
        </View>
      </View>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 24,
  },
  contextPanel: {
    flex: 1,
    justifyContent: 'center',
    gap: 18,
  },
  salonCard: {
    maxWidth: 560,
  },
  helpActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  pinPanel: {
    width: 420,
    justifyContent: 'center',
    gap: 18,
  },
  pinDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
  },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: labTheme.colors.borderStrong,
    backgroundColor: '#ffffff',
  },
  dotFilled: {
    backgroundColor: labTheme.colors.primary,
    borderColor: labTheme.colors.primary,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  key: {
    width: 132,
    height: 88,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: labTheme.colors.surface,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
  },
  keyUtility: {
    backgroundColor: labTheme.colors.surfaceAlt,
  },
  keyPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.75,
  },
});
