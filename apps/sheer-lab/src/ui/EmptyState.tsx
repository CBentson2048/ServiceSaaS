import type React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../theme/theme';
import { Button } from './Button';
import { Icon, type IconName } from './icons';
import { Text } from './Text';

export interface EmptyStateProps {
  /** Illustrative icon. Pick one that names the missing thing, not a generic box. */
  icon?: IconName;
  title: string;
  /** One sentence explaining why it's empty and what would fill it. */
  body?: string;
  /** The action that resolves the emptiness, when there is one. */
  action?: { label: string; onPress: () => void; icon?: IconName };
  /** `error` swaps to the danger tone — for "couldn't load", not "nothing here". */
  variant?: 'empty' | 'error' | 'locked';
  /** Compact spacing, for an empty state inside a small panel. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Empty, error and permission-locked states.
 *
 * Today these are a bare muted `<Text>` line ("No stock movements yet.",
 * "Stock levels could not be loaded.") with no icon, no hierarchy and — for the
 * error cases — no way to retry. Distinguishing the three matters: "nothing
 * here yet" is a normal state, "we failed to load" is a fault the stylist can
 * retry, and "you don't have access" is neither.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  variant = 'empty',
  compact = false,
  style,
}: EmptyStateProps): React.JSX.Element {
  const resolvedIcon: IconName = icon ?? (variant === 'error' ? 'alert' : variant === 'locked' ? 'lock' : 'info');

  return (
    <View style={[styles.wrap, compact && styles.compact, style]}>
      <View style={[styles.iconWrap, variant === 'error' && styles.iconWrapError]}>
        <Icon name={resolvedIcon} size="md" tone={variant === 'error' ? 'danger' : 'muted'} />
      </View>

      <Text variant="sectionTitle" align="center">
        {title}
      </Text>

      {body ? (
        <Text variant="bodySm" tone="muted" align="center" style={styles.body}>
          {body}
        </Text>
      ) : null}

      {action ? (
        <Button
          label={action.label}
          icon={action.icon}
          onPress={action.onPress}
          variant={variant === 'error' ? 'secondary' : 'primary'}
          size="sm"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing['2xl'],
    paddingHorizontal: theme.spacing.lg,
  },
  compact: { paddingVertical: theme.spacing.lg },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceRaised,
    marginBottom: theme.spacing.xs,
  },
  iconWrapError: { backgroundColor: theme.colors.dangerBg },
  // Caps the measure so the sentence wraps to a readable width rather than
  // stretching the full span of a 12.9" iPad.
  body: { maxWidth: 380 },
});
