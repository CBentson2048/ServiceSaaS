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
  contactGroup: {
    gap: spacing.sm,
  },
  contactLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  contactGlyph: {
    width: 22,
    alignItems: 'center',
    marginTop: 2,
  },
  contactText: {
    flex: 1,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  contactLink: {
    flex: 1,
    color: palette.brand[300],
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '700',
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

  // ── Merged service + stylist page ────────────────────────────────────────────
  // Lead-in for a section (e.g. "What would you like?")
  blockHeading: {
    color: palette.white,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  blockSub: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  // Small uppercase divider label (e.g. "CHOOSE YOUR STYLIST")
  groupLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  // Two-column service grid
  serviceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  serviceCard: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 132,
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  serviceCardSelected: {
    borderColor: palette.brand[300],
    backgroundColor: 'rgba(166,124,245,0.14)',
  },
  serviceCardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  serviceIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.input,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(166,124,245,0.16)',
  },
  serviceCheck: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.brand[500],
  },
  serviceCheckMark: {
    color: palette.white,
    fontSize: 13,
    fontWeight: '900',
    lineHeight: 16,
  },
  serviceName: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  serviceMeta: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
  },
  servicePrice: {
    color: palette.brand[300],
    fontSize: 14,
    fontWeight: '800',
    marginTop: 2,
  },

  // Stylist rows
  stylistCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  stylistCardSelected: {
    borderColor: palette.brand[300],
    backgroundColor: 'rgba(166,124,245,0.14)',
  },
  stylistAvatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stylistAvatarText: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '800',
  },
  stylistName: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
  },
  stylistMeta: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  stylistBadge: {
    color: palette.warning[300],
    fontSize: 12,
    fontWeight: '800',
    marginTop: 3,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterSelected: {
    borderColor: palette.brand[300],
  },
  radioInner: {
    width: 11,
    height: 11,
    borderRadius: radius.full,
    backgroundColor: palette.brand[300],
  },

  // ── Date & time selection page ───────────────────────────────────────────────
  // Section lead-in (month label + nav, "Available slots")
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  monthLabel: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  zoneLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: spacing.xs,
  },

  // Month nav row: ‹  Month Year ▾  ›
  calNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  calNavBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  calNavBtnDisabled: {
    opacity: 0.3,
  },
  calMonthBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },

  // Mon–Sun week strip
  weekStrip: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  weekCell: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dateCellSelected: {
    borderColor: palette.brand[300],
    backgroundColor: palette.brand[500],
  },
  dateCellDisabled: {
    opacity: 0.32,
  },

  // Full-calendar modal
  calBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  calSheet: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.cardLg,
    borderTopRightRadius: radius.cardLg,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: palette.ink[900],
  },
  calSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  calSheetTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  calWeekHead: {
    flexDirection: 'row',
  },
  calWeekHeadCell: {
    flex: 1,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  calGrid: {
    gap: spacing.xs,
  },
  calRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  calCell: {
    flex: 1,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  calCellSelected: {
    borderColor: palette.brand[300],
    backgroundColor: palette.brand[500],
  },
  calCellText: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
  },
  calCellMuted: {
    color: 'rgba(255,255,255,0.28)',
  },
  calCellSelectedText: {
    color: palette.white,
  },
  calDot: {
    width: 5,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: palette.success[300],
  },
  calEmptyNote: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  updatingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  updatingText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '600',
  },
  dateDow: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  dateDowSelected: {
    color: 'rgba(255,255,255,0.85)',
  },
  dateDay: {
    color: palette.white,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  dateDot: {
    width: 5,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: palette.success[300],
  },
  dateDotSelected: {
    backgroundColor: palette.white,
  },
  dateDotEmpty: {
    backgroundColor: 'transparent',
  },

  // Time slot row
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    paddingVertical: spacing.base,
    paddingHorizontal: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  slotRowSelected: {
    borderColor: palette.brand[300],
    backgroundColor: 'rgba(166,124,245,0.14)',
  },
  slotTimes: {
    width: 130,
    gap: spacing.xs,
  },
  slotTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  slotTimeLabel: {
    width: 38,
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  slotStart: {
    color: palette.white,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  slotEnd: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontWeight: '600',
  },
  slotMid: {
    flex: 1,
    gap: spacing.xs,
  },
  durationChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  durationChipText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 12,
    fontWeight: '700',
  },
  slotStylist: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
  },

  // Footer selected-slot summary
  footerSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  footerSummaryLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  footerSummaryValue: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 2,
  },
  footerPriceValue: {
    color: palette.brand[300],
    fontSize: 18,
    fontWeight: '800',
    marginTop: 2,
  },

  // ── Review & confirm page ────────────────────────────────────────────────────
  // Soft info/notice banner (e.g. deposit info, "action needed")
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.32)',
    backgroundColor: 'rgba(245,158,11,0.1)',
  },
  noticeBannerDanger: {
    borderColor: 'rgba(248,113,113,0.34)',
    backgroundColor: 'rgba(248,113,113,0.1)',
  },
  noticeGlyph: {
    marginTop: 1,
  },
  noticeTextWrap: {
    flex: 1,
    gap: 2,
  },
  noticeTitle: {
    color: palette.white,
    fontSize: 14,
    fontWeight: '800',
  },
  noticeBody: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    lineHeight: 19,
  },

  // Selected-service row inside the "Your selection" card
  selectionCard: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  selectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  selectionIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.inputLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.3)',
    backgroundColor: 'rgba(196,160,245,0.16)',
  },
  selectionName: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  selectionMeta: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  selectionPrice: {
    color: palette.brand[300],
    fontSize: 14,
    fontWeight: '800',
  },

  // Appointment detail rows (location / stylist / when)
  reviewDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  reviewDetailGlyph: {
    width: 22,
    alignItems: 'center',
  },
  reviewDetailLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  reviewDetailValue: {
    color: palette.white,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 2,
  },

  // Total-estimate bar in the pinned footer
  totalBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  totalBarLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  totalBarValue: {
    color: palette.white,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
    marginTop: 2,
  },
  totalBarDuration: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 2,
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
