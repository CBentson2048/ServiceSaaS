import type React from 'react';
import { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { registerDeviceWithToken } from '../../features/sheer-lab/deviceSession';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';

export function DeviceRegistrationScreen(): React.JSX.Element {
  const { refreshDeviceSession } = useDeviceSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function handleRegister(): Promise<void> {
    const nextToken = token.trim();
    if (!nextToken || busy) return;

    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const context = await registerDeviceWithToken(nextToken);
      setToken('');
      setMessage(`Registered ${context.device.deviceName} at ${context.location.name}.`);
      await refreshDeviceSession();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Device token could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LabScreen title="Register this iPad" eyebrow="Sheer Lab device setup">
      <Text style={styles.copy}>
        Ask an owner or manager to register this iPad from the web app, then paste the one-time token here.
      </Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        multiline
        onChangeText={setToken}
        placeholder="Paste device registration token"
        placeholderTextColor={labTheme.colors.textMuted}
        secureTextEntry
        style={styles.input}
        value={token}
      />
      {message ? <Text style={styles.success}>{message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <LabButton label="Register device" onPress={() => void handleRegister()} disabled={busy || token.trim().length === 0} />
      <LabButton label="Check registration" onPress={() => void refreshDeviceSession()} variant="secondary" disabled={busy} />
      <Text style={styles.meta}>
        The token is stored only in Keychain or Keystore-backed storage. Stylist PINs are never stored on this iPad.
      </Text>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  copy: {
    color: labTheme.colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  input: {
    minHeight: 76,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    paddingHorizontal: labTheme.spacing.md,
    paddingVertical: labTheme.spacing.sm,
    backgroundColor: labTheme.colors.card,
    color: labTheme.colors.textPrimary,
    fontSize: 14,
  },
  success: {
    color: '#86efac',
    fontSize: 14,
    fontWeight: '700',
  },
  error: {
    color: '#fca5a5',
    fontSize: 14,
    fontWeight: '700',
  },
  meta: {
    color: labTheme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
});
