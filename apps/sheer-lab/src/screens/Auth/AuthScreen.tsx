import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { getActiveLabSession, unlockLabSession } from '../../features/sheer-lab/labSession';
import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { useApiClient } from '../../lib/api/ApiProvider';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';

type AuthScreenProps = NativeStackScreenProps<RootStackParamList, 'Auth'>;

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export function AuthScreen({ navigation }: AuthScreenProps): React.JSX.Element {
  const api = useApiClient();
  const { deviceContext, resolution, refreshDeviceSession } = useDeviceSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getActiveLabSession().then((session) => {
      if (session) navigation.replace('Home');
    });
  }, [navigation]);

  async function submitPin(nextPin = pin): Promise<void> {
    if (nextPin.length !== 4 || busy || !deviceContext) return;
    setBusy(true);
    setError(undefined);
    try {
      await unlockLabSession(nextPin, {
        sharedDeviceId: deviceContext.device.id,
        locationId: deviceContext.location.id,
      });
      setPin('');
      navigation.replace('Home');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'PIN could not be verified');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  function appendDigit(digit: string): void {
    if (busy) return;
    const next = `${pin}${digit}`.slice(0, 4);
    setPin(next);
    if (next.length === 4) void submitPin(next);
  }

  return (
    <LabScreen title="Enter stylist PIN" eyebrow="Shared Sheer Lab device">
      {resolution.status !== 'ready' ? (
        <>
          <Text style={styles.copy}>This iPad must resolve its shared-device registration before stylist PIN entry.</Text>
          <LabButton label="Check device registration" onPress={() => void refreshDeviceSession()} />
        </>
      ) : null}
      <Text style={styles.copy}>
        Unlock {deviceContext?.device.deviceName ?? 'this Lab station'} at{' '}
        {deviceContext?.location.name ?? 'the assigned location'} to see your scheduled clients for today.
      </Text>
      <View style={styles.pinDots}>
        {[0, 1, 2, 3].map((index) => (
          <View key={index} style={[styles.dot, pin.length > index && styles.dotFilled]} />
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.keypad}>
        {DIGITS.map((digit) => (
          <Pressable
            accessibilityRole="button"
            disabled={busy || !deviceContext}
            key={digit}
            onPress={() => appendDigit(digit)}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed, busy && styles.disabled]}
          >
            <Text style={styles.keyText}>{digit}</Text>
          </Pressable>
        ))}
      </View>
      <LabButton label="Clear" onPress={() => setPin('')} variant="secondary" disabled={busy || pin.length === 0} />
      <Text style={styles.meta}>
        {deviceContext
          ? `Device ${shortId(deviceContext.device.id)} · Location ${shortId(deviceContext.location.id)} · ${api.baseUrl}`
          : api.baseUrl}
      </Text>
    </LabScreen>
  );
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

const styles = StyleSheet.create({
  copy: {
    color: labTheme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  pinDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: labTheme.spacing.md,
    paddingVertical: labTheme.spacing.md,
  },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    backgroundColor: labTheme.colors.card,
  },
  dotFilled: {
    backgroundColor: labTheme.colors.primary,
    borderColor: labTheme.colors.primary,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: labTheme.spacing.sm,
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '30%',
    minHeight: 68,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  keyPressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.45,
  },
  keyText: {
    color: labTheme.colors.textPrimary,
    fontSize: 28,
    fontWeight: '800',
  },
  error: {
    color: '#fca5a5',
    fontSize: 14,
    fontWeight: '700',
  },
  meta: {
    color: labTheme.colors.textMuted,
    fontSize: 12,
  },
});
