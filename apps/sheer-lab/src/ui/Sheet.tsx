import type React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { theme } from '../theme/theme';
import { IconButton } from './Button';
import { Text } from './Text';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Supporting line under the title. */
  subtitle?: string;
  /** Pinned action row at the bottom — Cancel / Save, etc. */
  footer?: React.ReactNode;
  /**
   * Maximum width on a tablet. Defaults to 560pt, which keeps a form at a
   * readable measure instead of stretching across a 12.9" iPad.
   */
  maxWidth?: number;
  /** Disables the tap-outside-to-close affordance, for a form with unsaved edits. */
  dismissOnBackdropPress?: boolean;
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * The standard modal container.
 *
 * QLAB hand-rolls four modals — `ProductFormModal`, `StockAdjustModal`,
 * `ProductPickerModal` and the history `CalendarModal` — each with its own
 * scrim colour, card radius, header layout and close affordance, and only one
 * of which handles the keyboard. This is one shell they can all sit inside.
 *
 * The header always carries a labelled close button: several of the current
 * modals can only be dismissed by an unlabelled `✕` or by the Android back
 * gesture.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  footer,
  maxWidth = 560,
  dismissOnBackdropPress = true,
  children,
  contentStyle,
}: SheetProps): React.JSX.Element {
  const { height } = useWindowDimensions();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Full-bleed dismiss target behind the card. Marked as a button so
            VoiceOver users get an explicit way out rather than a silent region. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${title}`}
          style={StyleSheet.absoluteFill}
          onPress={dismissOnBackdropPress ? onClose : undefined}
          disabled={!dismissOnBackdropPress}
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.centerer}
          pointerEvents="box-none"
        >
          <View style={[styles.card, { maxWidth, maxHeight: height * 0.88 }, contentStyle]}>
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text variant="title" numberOfLines={1}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text variant="bodySm" tone="muted">
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <IconButton icon="close" label={`Close ${title}`} onPress={onClose} variant="ghost" size="sm" />
            </View>

            <ScrollView
              contentContainerStyle={styles.body}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>

            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.overlay },
  centerer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.spacing.lg },
  card: {
    width: '100%',
    borderRadius: theme.radius.cardLg,
    borderWidth: theme.hairline,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceOverlay,
    overflow: 'hidden',
    ...theme.elevation.overlay,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
    borderBottomWidth: theme.hairline,
    borderBottomColor: theme.colors.divider,
  },
  headerText: { flex: 1, gap: 2 },
  body: { padding: theme.spacing.lg, gap: theme.spacing.base },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderTopWidth: theme.hairline,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.surface,
  },
});
