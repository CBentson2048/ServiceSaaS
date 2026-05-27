import { StyleSheet } from 'react-native';
import { palette, radius, spacing } from '@sheer/design-tokens';

export const bookingStyles = StyleSheet.create({
  list: { gap: spacing.base },
  pressable: { borderRadius: radius.card },
  pressed: { opacity: 0.78 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  flex: { flex: 1, gap: spacing.xs },
  title: { color: palette.white, fontSize: 17, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.68)', fontSize: 13 },
  error: { color: palette.danger[300], fontWeight: '700' },
  warning: { color: palette.warning[300], fontWeight: '700' },
  success: { color: palette.success[300], fontWeight: '700' },
  selected: { color: palette.brand[300], fontWeight: '700' },
  unselected: { color: 'rgba(255,255,255,0.54)', fontWeight: '700' },
  hero: {
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.28)',
    backgroundColor: palette.ink[700],
  },
  eyebrow: {
    color: palette.brand[300],
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: palette.white,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  heroBody: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 14,
    lineHeight: 21,
  },
  panel: {
    gap: spacing.base,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  panelSelected: {
    borderColor: palette.brand[300],
    backgroundColor: 'rgba(166,124,245,0.16)',
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconBadge: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.32)',
    backgroundColor: 'rgba(196,160,245,0.18)',
  },
  iconText: {
    color: palette.white,
    fontSize: 18,
    fontWeight: '800',
  },
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pillSelected: {
    backgroundColor: palette.brand[300],
  },
  pillText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '800',
  },
  pillTextSelected: {
    color: palette.ink[950],
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  detailGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  detail: {
    flex: 1,
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.inputLg,
    backgroundColor: 'rgba(24,20,31,0.58)',
  },
  detailLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  detailValue: {
    color: palette.white,
    fontSize: 12,
    fontWeight: '700',
  },
  totalCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.28)',
    backgroundColor: 'rgba(166,124,245,0.12)',
  },
  totalValue: {
    color: palette.white,
    fontSize: 20,
    fontWeight: '800',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
  },
  summaryRow: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  summaryLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  summaryValue: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
  },
  successMark: {
    alignSelf: 'flex-start',
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: 'rgba(74,222,128,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.42)',
  },
  successMarkText: {
    color: palette.success[300],
    fontSize: 28,
    fontWeight: '800',
  },
  input: {
    minHeight: 88,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    padding: spacing.base,
    color: palette.white,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
});

export function formatMoney(amount: number, currencyCode = 'GBP'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amount);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatDateTime(iso: string): string {
  return `${new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })} at ${new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
