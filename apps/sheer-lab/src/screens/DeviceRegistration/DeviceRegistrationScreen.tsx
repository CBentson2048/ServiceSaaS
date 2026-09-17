import type React from 'react';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { REVIEW_MODE_ENABLED } from '../../config/reviewMode'; // REVIEW MODE — delete with the feature
import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { registerDeviceWithToken } from '../../features/sheer-lab/deviceSession';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';

/** Keeps the setup card readable and centered on every iPad, portrait or landscape. */
const CONTENT_WIDTH = 540;

const MONOSPACE = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function DeviceRegistrationScreen(): React.JSX.Element {
  const { refreshDeviceSession, enterReviewMode } = useDeviceSession();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const trimmed = token.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  function handleChangeToken(next: string): void {
    setToken(next);
    if (message) setMessage(undefined);
    if (error) setError(undefined);
  }

  async function handleRegister(): Promise<void> {
    if (!canSubmit) return;

    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const context = await registerDeviceWithToken(trimmed);
      setToken('');
      setMessage(`Registered ${context.device.deviceName} at ${context.location.name}.`);
      await refreshDeviceSession();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Device token could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck(): Promise<void> {
    if (busy || checking) return;
    setChecking(true);
    try {
      await refreshDeviceSession();
    } finally {
      setChecking(false);
    }
  }

  return (
    <LabScreen
      eyebrow="Qlooqo Lab device setup"
      title="Register this iPad"
      subtitle="Ask an owner or manager to register this iPad from the web app, then paste the one-time token below."
      maxContentWidth={CONTENT_WIDTH}
      align="center"
    >
      {/* REVIEW MODE — delete with the feature (see src/config/reviewMode.ts). */}
      {REVIEW_MODE_ENABLED ? (
        <View style={styles.reviewMode}>
          <Text style={styles.reviewModeLabel}>App Store review — start here</Text>
          <Text style={styles.reviewModeCopy}>
            No device token is needed to review the app. Tap the button below to open the Kensington demo, then enter
            the PIN supplied with this build on the next screen.
          </Text>
          <LabButton label="Enter demo (Kensington)" onPress={enterReviewMode} disabled={busy} />
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={styles.label}>Device registration token</Text>
        <View style={[styles.inputRow, focused && styles.inputRowFocused]}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            onBlur={() => setFocused(false)}
            onChangeText={handleChangeToken}
            onFocus={() => setFocused(true)}
            placeholder="Paste device registration token"
            placeholderTextColor={labTheme.colors.textMuted}
            secureTextEntry={!revealed}
            spellCheck={false}
            style={styles.input}
            value={token}
          />
          {trimmed.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={revealed ? 'Hide token' : 'Show token'}
              hitSlop={8}
              onPress={() => setRevealed((prev) => !prev)}
              style={styles.reveal}
            >
              <Text style={styles.revealLabel}>{revealed ? 'Hide' : 'Show'}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {message ? (
        <View style={[styles.alert, styles.alertSuccess]}>
          <View style={[styles.alertDot, styles.alertDotSuccess]} />
          <Text style={[styles.alertText, styles.alertTextSuccess]}>{message}</Text>
        </View>
      ) : null}

      {error ? (
        <View style={[styles.alert, styles.alertError]}>
          <View style={[styles.alertDot, styles.alertDotError]} />
          <Text style={[styles.alertText, styles.alertTextError]}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <LabButton label="Register device" onPress={() => void handleRegister()} disabled={!canSubmit} loading={busy} />
        <LabButton
          label="Check registration"
          onPress={() => void handleCheck()}
          variant="secondary"
          disabled={busy}
          loading={checking}
        />
      </View>

      <Text style={styles.meta}>
        The token is stored only in Keychain or Keystore-backed storage. Stylist PINs are never stored on this iPad.
      </Text>
    </LabScreen>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: labTheme.spacing.sm,
  },
  label: {
    color: labTheme.colors.textSecondary,
    fontSize: labTheme.typography.fontSize.small,
    fontWeight: '700',
    letterSpacing: labTheme.typography.letterSpacing.wide,
    textTransform: 'uppercase',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: labTheme.spacing.sm,
    minHeight: 56,
    paddingHorizontal: labTheme.spacing.base,
    borderWidth: 1,
    borderColor: labTheme.colors.inputBorder,
    borderRadius: labTheme.radius.inputLg,
    backgroundColor: labTheme.colors.card,
  },
  inputRowFocused: {
    borderColor: labTheme.colors.primary,
  },
  input: {
    flex: 1,
    paddingVertical: labTheme.spacing.md,
    color: labTheme.colors.textPrimary,
    fontFamily: MONOSPACE,
    fontSize: labTheme.typography.fontSize.bodyLg,
  },
  reveal: {
    paddingVertical: labTheme.spacing.xs,
    paddingHorizontal: labTheme.spacing.sm,
    borderRadius: labTheme.radius.input,
  },
  revealLabel: {
    color: labTheme.colors.primary,
    fontSize: labTheme.typography.fontSize.small,
    fontWeight: '700',
  },
  alert: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: labTheme.spacing.sm,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderRadius: labTheme.radius.card,
  },
  alertDot: {
    width: 8,
    height: 8,
    marginTop: 6,
    borderRadius: labTheme.radius.full,
  },
  alertText: {
    flex: 1,
    fontSize: labTheme.typography.fontSize.body,
    lineHeight: labTheme.typography.lineHeight.body,
    fontWeight: '500',
  },
  alertSuccess: {
    backgroundColor: labTheme.colors.success.bg,
    borderColor: labTheme.colors.success.border,
  },
  alertDotSuccess: {
    backgroundColor: labTheme.colors.success.text,
  },
  alertTextSuccess: {
    color: labTheme.colors.success.text,
  },
  alertError: {
    backgroundColor: labTheme.colors.danger.bg,
    borderColor: labTheme.colors.danger.border,
  },
  alertDotError: {
    backgroundColor: labTheme.colors.danger.text,
  },
  alertTextError: {
    color: labTheme.colors.danger.text,
  },
  actions: {
    gap: labTheme.spacing.sm,
    marginTop: labTheme.spacing.xs,
  },
  meta: {
    color: labTheme.colors.textMuted,
    fontSize: labTheme.typography.fontSize.caption,
    lineHeight: labTheme.typography.lineHeight.caption,
  },
  // REVIEW MODE — delete with the feature. Prominent top callout so an App Store
  // reviewer can't miss the way in (they have no device-registration token).
  reviewMode: {
    gap: labTheme.spacing.sm,
    marginBottom: labTheme.spacing.lg,
    padding: labTheme.spacing.base,
    borderWidth: 1,
    borderColor: labTheme.colors.primary,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.primarySoft,
  },
  reviewModeLabel: {
    color: labTheme.colors.textSecondary,
    fontSize: labTheme.typography.fontSize.small,
    fontWeight: '700',
    letterSpacing: labTheme.typography.letterSpacing.wide,
    textTransform: 'uppercase',
  },
  reviewModeCopy: {
    color: labTheme.colors.textSecondary,
    fontSize: labTheme.typography.fontSize.body,
    lineHeight: labTheme.typography.lineHeight.body,
  },
});
