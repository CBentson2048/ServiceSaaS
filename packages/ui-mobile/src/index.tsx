import { Pressable, ScrollView, StyleSheet, Text, View, type PressableProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { palette, radius, spacing } from '@sheer/design-tokens';

type ConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
    </SafeAreaView>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.subtitle}>{label}</Text>
    </Card>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{body}</Text>
    </View>
  );
}

export function AppButton({
  label,
  variant = 'primary',
  ...props
}: PressableProps & { label: string; variant?: 'primary' | 'secondary' }) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, variant === 'secondary' && styles.buttonSecondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PinPad({ onDigit, onClear }: { onDigit: (digit: string) => void; onClear: () => void }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];

  return (
    <View style={styles.pinPad}>
      {keys.map((key) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          onPress={() => (key === 'clear' || key === 'del' ? onClear() : onDigit(key))}
          style={({ pressed }) => [styles.pinKey, pressed && styles.pressed]}
        >
          <Text style={styles.pinKeyText}>{key.toUpperCase()}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ConnectionBadge({
  label,
  state,
}: {
  label: string;
  state: ConnectionState;
}) {
  return (
    <View style={[styles.connectionBadge, CONNECTION_STYLES[state]]}>
      <Text style={styles.connectionText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: palette.ink[950],
  },
  content: {
    flexGrow: 1,
    gap: spacing.base,
    padding: spacing.lg,
  },
  card: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.card,
    backgroundColor: palette.ink[700],
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  sectionHeader: {
    gap: spacing.xs,
  },
  title: {
    color: palette.white,
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
  },
  statValue: {
    color: palette.brand[300],
    fontSize: 28,
    fontWeight: '700',
  },
  emptyState: {
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  button: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    backgroundColor: palette.brand[500],
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  buttonText: {
    color: palette.white,
    fontWeight: '700',
  },
  buttonSecondaryText: {
    color: palette.brand[300],
  },
  pressed: {
    opacity: 0.78,
  },
  pinPad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  pinKey: {
    width: 96,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
    backgroundColor: palette.white,
  },
  pinKeyText: {
    color: palette.ink[900],
    fontSize: 20,
    fontWeight: '700',
  },
  connectionBadge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
  },
  connection_connected: {
    backgroundColor: 'rgba(74,222,128,0.16)',
    borderColor: 'rgba(74,222,128,0.4)',
  },
  connection_disconnected: {
    backgroundColor: 'rgba(148,163,184,0.16)',
    borderColor: 'rgba(148,163,184,0.4)',
  },
  connection_reconnecting: {
    backgroundColor: 'rgba(245,158,11,0.16)',
    borderColor: 'rgba(245,158,11,0.4)',
  },
  connectionText: {
    color: palette.white,
    fontWeight: '700',
  },
});

const CONNECTION_STYLES: Record<ConnectionState, object> = {
  connected: styles.connection_connected,
  disconnected: styles.connection_disconnected,
  reconnecting: styles.connection_reconnecting,
};
