import type React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { labTheme } from '../../theme/labTheme';

interface LabScreenProps {
  title: string;
  eyebrow?: string;
  children?: React.ReactNode;
}

export function LabScreen({ title, eyebrow, children }: LabScreenProps): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title}>{title}</Text>
        <View style={styles.card}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: labTheme.colors.background,
  },
  content: {
    gap: labTheme.spacing.lg,
    padding: labTheme.spacing.xl,
  },
  eyebrow: {
    color: labTheme.colors.primary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: {
    color: labTheme.colors.textPrimary,
    fontSize: 30,
    fontWeight: '800',
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
