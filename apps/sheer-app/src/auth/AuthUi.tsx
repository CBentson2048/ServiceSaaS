/**
 * Shared building blocks for the QLOOQO auth screens (login + sign-up).
 *
 * These live app-side rather than in `@sheer/ui-mobile` because they are auth
 * specific — a branded, immersive, header-less canvas with soft brand glow, and
 * form controls richer than the generic primitives. Keeping login and sign-up on
 * the same components is what makes the two screens read as one product.
 *
 * Respects the design system: palette + radius + spacing tokens, and the
 * typography constraint of font weights 400/500 only (hierarchy comes from size,
 * colour and letter-spacing, never heavier weight).
 */
import { forwardRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, spacing } from '@sheer/design-tokens';

// React Native loads bundled image assets via require(); there is no static
// module type for *.png in this project, so the lint rule is disabled here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const appIcon = require('../../assets/icon.png');

// ── Canvas ────────────────────────────────────────────────────────────────────

/**
 * Full-bleed, dark, keyboard-aware auth canvas. Two out-of-focus brand orbs sit
 * behind the content to give depth without needing a gradient dependency.
 * `onBack` renders a floating chevron (used by sign-up); `footer` pins content
 * (the sign-in ⇄ sign-up switch) to the bottom of the scroll area.
 */
export function AuthLayout({
  children,
  footer,
  onBack,
}: {
  children: ReactNode;
  footer?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <View style={styles.canvas}>
      <View pointerEvents="none" style={styles.glowLayer}>
        <View style={[styles.glow, styles.glowPrimary]} />
        <View style={[styles.glow, styles.glowSecondary]} />
      </View>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={12}
            onPress={onBack}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressedDim]}
          >
            <Ionicons name="chevron-back" size={22} color={palette.white} />
          </Pressable>
        ) : null}
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.flex}>{children}</View>
            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

// ── Brand lockup ──────────────────────────────────────────────────────────────

export function BrandMark({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.brand}>
      <View style={styles.logoTile}>
        <Image source={appIcon} style={styles.logo} resizeMode="contain" />
      </View>
      <Text style={styles.wordmark}>QLOOQO</Text>
      <Text style={styles.headline}>{title}</Text>
      {subtitle ? <Text style={styles.headlineSub}>{subtitle}</Text> : null}
    </View>
  );
}

// ── Text field ────────────────────────────────────────────────────────────────

interface AuthFieldProps extends TextInputProps {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  hint?: string;
  /** Renders a show/hide toggle and manages `secureTextEntry` internally. */
  isPassword?: boolean;
}

export const AuthField = forwardRef<TextInput, AuthFieldProps>(function AuthField(
  { label, icon, hint, isPassword, style, onFocus, onBlur, ...props },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [reveal, setReveal] = useState(false);

  return (
    <View style={styles.fieldBlock}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldRow, focused && styles.fieldRowFocused]}>
        <Ionicons
          name={icon}
          size={18}
          color={focused ? palette.brand[300] : palette.alpha.whiteMuted}
          style={styles.fieldIcon}
        />
        <TextInput
          ref={ref}
          placeholderTextColor={palette.alpha.whiteMuted}
          style={[styles.fieldInput, style]}
          secureTextEntry={isPassword && !reveal}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...props}
        />
        {isPassword ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
            hitSlop={10}
            onPress={() => setReveal((v) => !v)}
            style={({ pressed }) => pressed && styles.pressedDim}
          >
            <Ionicons
              name={reveal ? 'eye-off-outline' : 'eye-outline'}
              size={18}
              color={palette.alpha.whiteMuted}
            />
          </Pressable>
        ) : null}
      </View>
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
});

// ── Buttons + inline messages ───────────────────────────────────────────────

export function PrimaryButton({
  label,
  loading,
  disabled,
  ...props
}: PressableProps & { label: string; loading?: boolean }) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(isDisabled), busy: Boolean(loading) }}
      disabled={isDisabled}
      {...props}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && styles.pressedDim,
        isDisabled && styles.primaryButtonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.white} />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function FormMessage({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  const isError = tone === 'error';
  return (
    <View style={[styles.message, isError ? styles.messageError : styles.messageSuccess]}>
      <Ionicons
        name={isError ? 'alert-circle' : 'checkmark-circle'}
        size={16}
        color={isError ? palette.danger[300] : palette.success[300]}
      />
      <Text style={[styles.messageText, isError ? styles.messageTextError : styles.messageTextSuccess]}>
        {children}
      </Text>
    </View>
  );
}

/** "New to QLOOQO? Create an account" style switch used in the layout footer. */
export function AuthSwitch({
  prompt,
  actionLabel,
  onPress,
}: {
  prompt: string;
  actionLabel: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchPrompt}>{prompt}</Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => pressed && styles.pressedDim}
      >
        <Text style={styles.switchAction}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  canvas: {
    flex: 1,
    backgroundColor: palette.ink[950],
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    borderRadius: radius.full,
  },
  glowPrimary: {
    width: 460,
    height: 460,
    top: -220,
    right: -140,
    backgroundColor: palette.brand[700],
    opacity: 0.32,
  },
  glowSecondary: {
    width: 320,
    height: 320,
    bottom: -180,
    left: -120,
    backgroundColor: palette.brand[500],
    opacity: 0.14,
  },
  safe: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  backButton: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.alpha.whiteSoft,
    borderWidth: 1,
    borderColor: palette.alpha.whiteLine,
  },
  footer: {
    paddingTop: spacing.lg,
  },
  // Brand lockup
  brand: {
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xl,
  },
  logoTile: {
    width: 76,
    height: 76,
    borderRadius: radius.cardLg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.alpha.whiteSoft,
    borderWidth: 1,
    borderColor: palette.alpha.whiteLine,
    marginBottom: spacing.sm,
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: radius.card,
  },
  wordmark: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '500',
    letterSpacing: 5,
  },
  headline: {
    color: palette.white,
    fontSize: 28,
    fontWeight: '500',
    letterSpacing: -0.2,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  headlineSub: {
    color: palette.alpha.whiteSubtle,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 300,
  },
  // Fields
  fieldBlock: {
    gap: spacing.xs,
  },
  fieldLabel: {
    color: palette.alpha.whiteHi,
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 54,
    borderRadius: radius.inputLg,
    borderWidth: 1,
    borderColor: palette.alpha.whiteLine,
    backgroundColor: palette.alpha.whiteSoft,
    paddingHorizontal: spacing.base,
  },
  fieldRowFocused: {
    borderColor: palette.brand[500],
    backgroundColor: 'rgba(166,124,245,0.10)',
  },
  fieldIcon: {
    width: 20,
    textAlign: 'center',
  },
  fieldInput: {
    flex: 1,
    color: palette.white,
    fontSize: 15,
    paddingVertical: spacing.sm,
  },
  fieldHint: {
    color: palette.alpha.whiteMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  // Primary button
  primaryButton: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    backgroundColor: palette.brand[500],
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  pressedDim: {
    opacity: 0.7,
  },
  // Messages
  message: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.input,
    borderWidth: 1,
  },
  messageError: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderColor: 'rgba(248,113,113,0.4)',
  },
  messageSuccess: {
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderColor: 'rgba(74,222,128,0.4)',
  },
  messageText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  messageTextError: {
    color: palette.danger[300],
  },
  messageTextSuccess: {
    color: palette.success[300],
  },
  // Switch
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs,
  },
  switchPrompt: {
    color: palette.alpha.whiteSubtle,
    fontSize: 14,
  },
  switchAction: {
    color: palette.brand[300],
    fontSize: 14,
    fontWeight: '500',
  },
});
