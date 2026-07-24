import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../app/navigation/routes';
import { appConfig } from '../../config/appConfig';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import type { BleConnectionStatus } from '../../features/ble/types';
import { getActiveLabSession, unlockLabSession } from '../../features/sheer-lab/labSession';
import { useDeviceSession } from '../../features/sheer-lab/DeviceSessionProvider';
import { useApiClient } from '../../lib/api/ApiProvider';
import { labTheme } from '../../theme/labTheme';
import { BrandMark } from '../shared/BrandMark';
import { BrandWordmark } from '../shared/BrandWordmark';

type AuthScreenProps = NativeStackScreenProps<RootStackParamList, 'Auth'>;

type KeypadKey = { kind: 'digit'; value: string } | { kind: 'clear' } | { kind: 'backspace' };

const KEYPAD: KeypadKey[] = [
  { kind: 'digit', value: '1' },
  { kind: 'digit', value: '2' },
  { kind: 'digit', value: '3' },
  { kind: 'digit', value: '4' },
  { kind: 'digit', value: '5' },
  { kind: 'digit', value: '6' },
  { kind: 'digit', value: '7' },
  { kind: 'digit', value: '8' },
  { kind: 'digit', value: '9' },
  { kind: 'clear' },
  { kind: 'digit', value: '0' },
  { kind: 'backspace' },
];

export function AuthScreen({ navigation }: AuthScreenProps): React.JSX.Element {
  const api = useApiClient();
  const { deviceContext, resolution, refreshDeviceSession } = useDeviceSession();
  const scale = useBleScale();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const { width } = useWindowDimensions();
  const layout = useMemo(() => computeLayout(width), [width]);

  useEffect(() => {
    getActiveLabSession().then((session) => {
      if (session) navigation.replace('Home');
    });
  }, [navigation]);

  // Lightweight live clock for the status bar — minute resolution is enough.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const ready = resolution.status === 'ready';

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
    if (busy || !deviceContext) return;
    setError(undefined);
    const next = `${pin}${digit}`.slice(0, 4);
    setPin(next);
    if (next.length === 4) void submitPin(next);
  }

  function removeDigit(): void {
    if (busy) return;
    setError(undefined);
    setPin((current) => current.slice(0, -1));
  }

  const locationLabel = (deviceContext?.location.name ?? 'Assigned location').toUpperCase();
  const deviceLabel = deviceContext?.device.deviceName ?? 'this Lab station';
  const apiHost = useMemo(() => formatHost(api.baseUrl), [api.baseUrl]);
  const clock = formatClock(now);
  const scaleStatus = describeScale(scale.status, scale.connectedDevice?.name, scale.bluetoothPoweredOn, scale.error);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingHorizontal: layout.hPadding }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Brand header */}
        <View style={styles.header}>
          <BrandMark size={64} radius={32} />
          <BrandWordmark height={30} style={styles.wordmark} />
          <Text style={styles.welcome}>Welcome back</Text>
          <View style={styles.locationChip}>
            <LockGlyph />
            <Text style={styles.locationText} numberOfLines={1}>
              {locationLabel}
            </Text>
          </View>
        </View>

        {/* PIN card */}
        <View style={[styles.card, { width: layout.cardWidth }]}>
          {ready ? (
            <Text style={styles.hint}>Enter your stylist PIN to see {deviceLabel}&rsquo;s clients for today</Text>
          ) : (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Device not ready</Text>
              <Text style={styles.noticeBody}>This iPad must resolve its shared-device registration before PIN entry.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void refreshDeviceSession()}
                style={({ pressed }) => [styles.noticeAction, pressed && styles.pressed]}
              >
                <Text style={styles.noticeActionText}>Check device registration</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.pinDots}>
            {[0, 1, 2, 3].map((index) => (
              <View key={index} style={[styles.dot, pin.length > index && styles.dotFilled]} />
            ))}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.keypad}>
            {KEYPAD.map((key, index) => (
              <KeypadButton
                key={key.kind === 'digit' ? key.value : `${key.kind}-${index}`}
                keyDef={key}
                size={layout.keySize}
                digitFontSize={layout.digitFont}
                disabled={busy || !deviceContext}
                pinEmpty={pin.length === 0}
                onDigit={appendDigit}
                onClear={() => setPin('')}
                onBackspace={removeDigit}
              />
            ))}
          </View>

          <View style={styles.divider} />

          <View style={[styles.scalePill, { backgroundColor: scaleStatus.bg, borderColor: scaleStatus.border }]}>
            <StatusDot color={scaleStatus.dot} />
            <Text style={[styles.scaleLabel, { color: scaleStatus.text }]}>{scaleStatus.label}</Text>
            <Text style={styles.scaleDetail} numberOfLines={1}>
              {scaleStatus.detail}
            </Text>
          </View>
        </View>

        {/* Status bar */}
        <View style={styles.footer}>
          <Text style={styles.restricted}>Secure lab access restricted to authorised stylists</Text>
          <View style={styles.footerRow}>
            <View style={styles.footerGroup}>
              <Text style={styles.footerText}>{clock}</Text>
              <Text style={styles.footerDivider}>·</Text>
              <Text style={styles.footerText} numberOfLines={1}>
                {apiHost}
              </Text>
            </View>
            <View style={styles.footerGroup}>
              <Text style={styles.footerText}>{appConfig.environment.toUpperCase()}</Text>
              <StatusDot color={ready ? labTheme.colors.success.text : labTheme.colors.warning.text} />
              <Text style={[styles.footerText, { color: ready ? labTheme.colors.success.text : labTheme.colors.warning.text }]}>
                {ready ? 'SYSTEM LIVE' : 'CONNECTING'}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function KeypadButton({
  keyDef,
  size,
  digitFontSize,
  disabled,
  pinEmpty,
  onDigit,
  onClear,
  onBackspace,
}: {
  keyDef: KeypadKey;
  size: number;
  digitFontSize: number;
  disabled: boolean;
  pinEmpty: boolean;
  onDigit: (digit: string) => void;
  onClear: () => void;
  onBackspace: () => void;
}): React.JSX.Element {
  const cell = { width: size, height: size };

  if (keyDef.kind === 'clear') {
    const inactive = disabled || pinEmpty;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Clear PIN"
        disabled={inactive}
        onPress={onClear}
        style={({ pressed }) => [styles.actionKey, cell, pressed && styles.pressed, inactive && styles.disabled]}
      >
        <Text style={styles.actionText}>Clear</Text>
      </Pressable>
    );
  }

  if (keyDef.kind === 'backspace') {
    const inactive = disabled || pinEmpty;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delete last digit"
        disabled={inactive}
        onPress={onBackspace}
        style={({ pressed }) => [styles.actionKey, cell, pressed && styles.pressed, inactive && styles.disabled]}
      >
        <Text style={styles.backspaceText}>⌫</Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Digit ${keyDef.value}`}
      disabled={disabled}
      onPress={() => onDigit(keyDef.value)}
      style={({ pressed }) => [styles.digitKey, cell, pressed && styles.digitKeyPressed, disabled && styles.disabled]}
    >
      <Text style={[styles.digitText, { fontSize: digitFontSize }]}>{keyDef.value}</Text>
    </Pressable>
  );
}

/** Derive sizing from the viewport width so the card and keypad fit any device. */
function computeLayout(width: number): {
  hPadding: number;
  cardWidth: number;
  keySize: number;
  digitFont: number;
} {
  const isTablet = width >= 700;
  const hPadding = isTablet ? labTheme.spacing['2xl'] : labTheme.spacing.xl;
  const cardWidth = Math.min(440, width - hPadding * 2);
  // cardWidth − card padding (xl×2) − keypad gaps (md×2), split across 3 columns.
  const raw = Math.floor((cardWidth - labTheme.spacing.xl * 2 - labTheme.spacing.md * 2) / 3);
  const keySize = Math.max(54, Math.min(80, raw));
  const digitFont = Math.round(keySize * 0.36);
  return { hPadding, cardWidth, keySize, digitFont };
}

/** Small padlock glyph drawn with Views for the secured-location chip. */
function LockGlyph(): React.JSX.Element {
  return (
    <View style={styles.lock}>
      <View style={styles.lockShackle} />
      <View style={styles.lockBody} />
    </View>
  );
}

function StatusDot({ color }: { color: string }): React.JSX.Element {
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

interface ScaleDescriptor {
  label: string;
  detail: string;
  text: string;
  bg: string;
  border: string;
  dot: string;
}

function describeScale(
  status: BleConnectionStatus,
  deviceName: string | undefined,
  bluetoothPoweredOn: boolean,
  error: string | undefined,
): ScaleDescriptor {
  const success = { text: labTheme.colors.success.text, bg: labTheme.colors.success.bg, border: labTheme.colors.success.border, dot: labTheme.colors.success.text };
  const warning = { text: labTheme.colors.warning.text, bg: labTheme.colors.warning.bg, border: labTheme.colors.warning.border, dot: labTheme.colors.warning.text };
  const danger = { text: labTheme.colors.danger.text, bg: labTheme.colors.danger.bg, border: labTheme.colors.danger.border, dot: labTheme.colors.danger.text };
  const neutral = { text: labTheme.colors.neutral.text, bg: labTheme.colors.neutral.bg, border: labTheme.colors.neutral.border, dot: labTheme.colors.textMuted };

  if (!bluetoothPoweredOn) {
    return { ...neutral, label: 'BLUETOOTH OFF', detail: 'Enable Bluetooth to pair a scale' };
  }

  switch (status) {
    case 'connected':
      return { ...success, label: 'SCALE CONNECTED', detail: deviceName ?? 'Acaia Pearl' };
    case 'scanning':
      return { ...warning, label: 'SEARCHING', detail: 'Scanning for nearby scales' };
    case 'connecting':
    case 'discovering':
    case 'reconnecting':
      return { ...warning, label: 'CONNECTING SCALE', detail: deviceName ?? 'Pairing in progress' };
    case 'error':
      return { ...danger, label: 'SCALE ERROR', detail: error ?? 'Connection failed' };
    default:
      return { ...neutral, label: 'SCALE OFFLINE', detail: 'No scale paired' };
  }
}

function formatHost(url: string): string {
  return url.replace(/^https?:\/\//, '').split('/')[0] ?? url;
}

function formatClock(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${meridiem}`;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: labTheme.colors.background,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: labTheme.spacing.xl,
    paddingVertical: labTheme.spacing.lg,
  },

  // Brand header
  header: {
    alignItems: 'center',
    gap: labTheme.spacing.sm,
    paddingTop: labTheme.spacing.lg,
  },
  wordmark: {
    marginTop: labTheme.spacing.xs,
  },
  welcome: {
    color: labTheme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  locationChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: labTheme.spacing.xs,
    paddingVertical: labTheme.spacing.xs,
    paddingHorizontal: labTheme.spacing.md,
    borderRadius: labTheme.radius.pill,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    backgroundColor: labTheme.colors.surface,
    marginTop: labTheme.spacing.xs,
    maxWidth: 320,
  },
  locationText: {
    color: labTheme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },

  // PIN card
  card: {
    gap: labTheme.spacing.base,
    padding: labTheme.spacing.xl,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.surface,
  },
  hint: {
    color: labTheme.colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  notice: {
    gap: labTheme.spacing.xs,
    padding: labTheme.spacing.md,
    borderRadius: labTheme.radius.card,
    borderWidth: 1,
    borderColor: labTheme.colors.warning.border,
    backgroundColor: labTheme.colors.warning.bg,
  },
  noticeTitle: {
    color: labTheme.colors.warning.text,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  noticeBody: {
    color: labTheme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  noticeAction: {
    alignSelf: 'flex-start',
    marginTop: labTheme.spacing.xs,
    paddingVertical: labTheme.spacing.xs,
  },
  noticeActionText: {
    color: labTheme.colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  pinDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: labTheme.spacing.base,
    paddingVertical: labTheme.spacing.sm,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: labTheme.radius.full,
    borderWidth: 1.5,
    borderColor: labTheme.colors.borderStrong,
    backgroundColor: 'transparent',
  },
  dotFilled: {
    backgroundColor: labTheme.colors.primary,
    borderColor: labTheme.colors.primary,
  },
  error: {
    color: labTheme.colors.danger.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },

  // Keypad
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: labTheme.spacing.md,
  },
  digitKey: {
    borderRadius: labTheme.radius.full,
    borderWidth: 1,
    borderColor: labTheme.colors.borderStrong,
    backgroundColor: labTheme.colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digitKeyPressed: {
    backgroundColor: labTheme.colors.primarySoft,
    borderColor: labTheme.colors.primary,
  },
  digitText: {
    color: labTheme.colors.textPrimary,
    fontWeight: '700',
  },
  actionKey: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    color: labTheme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
  },
  backspaceText: {
    color: labTheme.colors.textSecondary,
    fontSize: 24,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.35,
  },

  divider: {
    height: 1,
    backgroundColor: labTheme.colors.border,
    marginVertical: labTheme.spacing.xs,
  },

  // Scale status pill
  scalePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: labTheme.spacing.sm,
    paddingVertical: labTheme.spacing.sm,
    paddingHorizontal: labTheme.spacing.base,
    borderRadius: labTheme.radius.pill,
    borderWidth: 1,
  },
  scaleLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  scaleDetail: {
    color: labTheme.colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },

  // Status bar
  footer: {
    width: '100%',
    maxWidth: 560,
    alignItems: 'center',
    gap: labTheme.spacing.sm,
    paddingTop: labTheme.spacing.md,
  },
  restricted: {
    color: labTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: labTheme.spacing.sm,
    width: '100%',
  },
  footerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: labTheme.spacing.xs,
    flexShrink: 1,
  },
  footerText: {
    color: labTheme.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  footerDivider: {
    color: labTheme.colors.textMuted,
    fontSize: 11,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: labTheme.radius.full,
  },

  // Lock glyph
  lock: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  lockShackle: {
    width: 8,
    height: 6,
    borderWidth: 1.5,
    borderBottomWidth: 0,
    borderColor: labTheme.colors.primary,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    marginBottom: -1,
  },
  lockBody: {
    width: 11,
    height: 8,
    borderRadius: 2,
    backgroundColor: labTheme.colors.primary,
  },
});
