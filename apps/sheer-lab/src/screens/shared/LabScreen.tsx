import type React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import { BrandMark } from './BrandMark';
import { BrandWordmark } from './BrandWordmark';

/** Width (pt) at/above which we treat the iPad as a large surface (Pro / landscape). */
const LARGE_SCREEN_WIDTH = 1024;

interface LabScreenProps {
  title: string;
  eyebrow?: string;
  /** Optional supporting line rendered beneath the title, outside the card. */
  subtitle?: string;
  /**
   * Constrain the content column to this width (pt) and center it horizontally.
   * Recommended for focused forms so they don't stretch edge-to-edge on large iPads.
   */
  maxContentWidth?: number;
  /** Vertical placement of the content. Defaults to 'top'. */
  align?: 'top' | 'center';
  children?: React.ReactNode;
}

export function LabScreen({
  title,
  eyebrow,
  subtitle,
  maxContentWidth,
  align = 'top',
  children,
}: LabScreenProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const isLarge = width >= LARGE_SCREEN_WIDTH;
  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Slim branded bar — keeps these utility/config screens visually in step
          with the main app's header, with a back affordance when pushed. */}
      <View style={styles.topBar}>
        {canGoBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go back"
            onPress={() => navigation.goBack()}
            hitSlop={10}
            style={styles.backButton}
          >
            {/* Was a Unicode '‹' at 30pt — no shared stroke weight or optical
                size with anything else, and it could not take a tint. */}
            <Icon name="chevronLeft" size="md" tone="brand" />
          </Pressable>
        ) : null}
        <BrandMark size={26} />
        <BrandWordmark height={18} />
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { padding: isLarge ? labTheme.spacing['3xl'] : labTheme.spacing.xl },
            align === 'center' && styles.contentCentered,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.column, maxContentWidth != null ? { maxWidth: maxContentWidth } : null]}>
            {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
            <Text style={[styles.title, isLarge && styles.titleLarge]}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            <View style={styles.card}>{children}</View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: labTheme.colors.background,
  },
  flex: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: labTheme.spacing.sm,
    paddingHorizontal: labTheme.spacing.lg,
    paddingVertical: labTheme.spacing.md,
    backgroundColor: labTheme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: labTheme.colors.border,
  },
  backButton: { paddingRight: labTheme.spacing.xs },
  content: {
    flexGrow: 1,
    alignItems: 'center',
  },
  contentCentered: {
    justifyContent: 'center',
  },
  column: {
    width: '100%',
    gap: labTheme.spacing.lg,
  },
  eyebrow: {
    color: labTheme.colors.primary,
    fontSize: labTheme.typography.fontSize.small,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: {
    color: labTheme.colors.textPrimary,
    fontSize: labTheme.typography.fontSize.display,
    lineHeight: labTheme.typography.lineHeight.display,
    fontWeight: '800',
  },
  titleLarge: {
    fontSize: 34,
    lineHeight: 40,
  },
  subtitle: {
    color: labTheme.colors.textSecondary,
    fontSize: labTheme.typography.fontSize.bodyLg,
    lineHeight: labTheme.typography.lineHeight.bodyLg,
  },
  card: {
    gap: labTheme.spacing.md,
    padding: labTheme.spacing.lg,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.surface,
  },
});
