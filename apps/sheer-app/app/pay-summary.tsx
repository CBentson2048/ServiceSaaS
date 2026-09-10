import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { PayPeriodStatus, PaySummaryBreakdown, PaySummaryHours } from '@sheer/domain';
import { HOUR_CATEGORY_LABELS } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { ScreenHeader } from '../src/navigation/ScreenHeader';
import {
  PAY_STATUS_LABELS,
  formatHours,
  formatMoney,
  periodWindowLabel,
} from '../src/payroll/format';
import { BG, BORDER, BRAND_LIGHT, CARD, DANGER, SUCCESS } from '../src/design/colors';

/**
 * One pay statement, fully explained. The breakdown comes from
 * `GET /payroll/me/summaries/:summaryId` — the same explainability payload the
 * salon sees, so a stylist's question about a figure starts from identical
 * numbers. Period dates/status arrive as route params from the list screen
 * (the breakdown envelope itself carries only the period id).
 */
export default function PaySummaryScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { id, periodStart, periodEnd, status } = useLocalSearchParams<{
    id?: string;
    periodStart?: string;
    periodEnd?: string;
    status?: PayPeriodStatus;
  }>();

  const [breakdown, setBreakdown] = useState<PaySummaryBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !id) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.getMyPaySummary(accessToken, id);
      setBreakdown(response.breakdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this statement');
    } finally {
      setLoading(false);
    }
  }, [accessToken, id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <ScreenHeader title="Pay statement" />

        {loading ? (
          <View style={s.loadingCard}>
            <ActivityIndicator color={palette.brand[300]} size="small" />
            <Text style={s.loadingText}>Loading statement…</Text>
          </View>
        ) : error ? (
          <View style={s.errorCard}>
            <Text style={s.errorText}>{error}</Text>
            <Pressable
              onPress={() => void load()}
              style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}
            >
              <Text style={s.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : !breakdown ? null : (
          <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
            <StatementBody
              breakdown={breakdown}
              periodStart={periodStart}
              periodEnd={periodEnd}
              status={status}
            />
          </ScrollView>
        )}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Body ──────────────────────────────────────────────────────────────────────

function StatementBody({
  breakdown,
  periodStart,
  periodEnd,
  status,
}: {
  breakdown: PaySummaryBreakdown;
  periodStart?: string;
  periodEnd?: string;
  status?: PayPeriodStatus;
}) {
  const { summary } = breakdown;
  const currency = summary.currencyCode;
  const owesSalon = summary.grossPayableCents < 0;

  const earnings: [string, number][] = [
    ['Base pay', summary.basePayCents],
    ['Commission', summary.commissionCents],
    ['Revenue split', summary.revenueSplitCents],
    ['Bonus', summary.bonusCents],
    ['Tips owed to you', summary.tipsOwedCents],
    ['Adjustments', summary.adjustmentsCents],
  ];
  const deductions: [string, number][] = [
    ['Chair rent', summary.chairRentCents],
    ['Other deductions', summary.deductionsCents],
  ];
  const shownEarnings = earnings.filter(([, cents]) => cents !== 0);
  const shownDeductions = deductions.filter(([, cents]) => cents !== 0);
  const shownHours = breakdown.hours.filter((entry) => entry.hours !== 0);
  const target = breakdown.target;

  return (
    <>
      {/* ── Gross pay hero ── */}
      <View style={s.hero}>
        <View style={s.heroTopRow}>
          <Text style={s.heroPeriod}>
            {periodStart && periodEnd ? periodWindowLabel(periodStart, periodEnd) : 'Pay period'}
          </Text>
          {status ? (
            <View style={[s.statusPill, status === 'paid' ? s.statusPillPaid : s.statusPillConfirmed]}>
              <Text
                style={[
                  s.statusPillText,
                  status === 'paid' ? s.statusTextPaid : s.statusTextConfirmed,
                ]}
              >
                {PAY_STATUS_LABELS[status]}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={s.heroValueLabel}>{owesSalon ? 'OWED TO THE SALON' : 'GROSS PAY'}</Text>
        <Text style={[s.heroValue, owesSalon && s.heroValueOwed]}>
          {formatMoney(Math.abs(summary.grossPayableCents), currency)}
        </Text>
        {owesSalon ? (
          <Text style={s.heroNote}>
            Chair rent and deductions were more than your earnings this period — the balance is
            owed to the salon.
          </Text>
        ) : null}
        {summary.isStale ? (
          <Text style={s.staleNote}>
            Source data changed after this statement was generated — your salon is rechecking the
            figures.
          </Text>
        ) : null}
      </View>

      {/* ── Revenue you generated ── */}
      <Section label="REVENUE YOU GENERATED">
        <View style={s.card}>
          <DetailRow
            label="Service revenue"
            value={formatMoney(summary.serviceRevenueCents, currency)}
          />
          {summary.retailRevenueCents !== 0 ? (
            <DetailRow
              label="Retail revenue"
              value={formatMoney(summary.retailRevenueCents, currency)}
            />
          ) : null}
          {target.targetCents !== null ? (
            <DetailRow
              label="Service revenue target"
              value={formatMoney(target.targetCents, currency)}
              isLast
            />
          ) : null}
          {target.targetCents !== null ? (
            <Text style={s.derivation}>{target.derivation}</Text>
          ) : null}
        </View>
      </Section>

      {/* ── Earnings ── */}
      {shownEarnings.length > 0 ? (
        <Section label="YOUR EARNINGS">
          <View style={s.card}>
            {shownEarnings.map(([label, cents], index) => (
              <DetailRow
                key={label}
                label={label}
                value={formatMoney(cents, currency)}
                accent
                isLast={index === shownEarnings.length - 1}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {/* ── Deductions ── */}
      {shownDeductions.length > 0 ? (
        <Section label="DEDUCTIONS">
          <View style={s.card}>
            {shownDeductions.map(([label, cents], index) => (
              <DetailRow
                key={label}
                label={label}
                value={`−${formatMoney(Math.abs(cents), currency)}`}
                isLast={index === shownDeductions.length - 1}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {/* ── Greater-of outcome ── */}
      {breakdown.greaterOf?.applied ? (
        <View style={s.infoCard}>
          <Text style={s.infoTitle}>Whichever-is-higher applied</Text>
          <Text style={s.infoBody}>
            {greaterOfExplanation(breakdown.greaterOf.winner)} Base pay{' '}
            {formatMoney(breakdown.greaterOf.basePayCents, currency)} vs commission{' '}
            {formatMoney(breakdown.greaterOf.commissionCents, currency)}
            {breakdown.greaterOf.revenueSplitCents !== null
              ? ` vs revenue split ${formatMoney(breakdown.greaterOf.revenueSplitCents, currency)}`
              : ''}
            .
          </Text>
        </View>
      ) : null}

      {/* ── Commission workings ── */}
      {breakdown.bands.length > 0 ? (
        <Section label="COMMISSION WORKINGS">
          <View style={s.card}>
            {breakdown.bands.map((band, index) => (
              <View
                key={band.bandId}
                style={[s.bandRow, index === breakdown.bands.length - 1 && s.rowLast]}
              >
                <View style={s.bandBody}>
                  <Text style={s.bandFrom}>From {band.fromLabel}</Text>
                  <Text style={s.bandRate}>
                    {band.ratePercentApplied}%
                    {band.acceleratorRateApplied ? ' · accelerator rate' : ''}
                  </Text>
                </View>
                <Text style={s.bandAmount}>{formatMoney(band.amountCents, currency)}</Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {/* ── Accelerator outcome ── */}
      {breakdown.accelerator ? (
        <View style={s.infoCard}>
          <Text style={s.infoTitle}>
            {breakdown.accelerator.achieved === true
              ? 'Accelerator achieved'
              : breakdown.accelerator.achieved === false
                ? 'Accelerator not achieved'
                : 'Accelerator could not be evaluated'}
          </Text>
          {breakdown.accelerator.conditions.map((condition, index) => (
            <View key={index} style={s.conditionRow}>
              {condition.passed === true ? (
                <Ionicons name="checkmark-circle" size={14} color={SUCCESS} />
              ) : condition.passed === false ? (
                <Ionicons name="close-circle" size={14} color={DANGER} />
              ) : (
                <Text style={s.infoBody}>–</Text>
              )}
              <Text style={s.infoBody}>{conditionLabel(condition.metric)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* ── Hours ── */}
      {shownHours.length > 0 ? (
        <Section label="YOUR HOURS">
          <View style={s.card}>
            {shownHours.map((entry, index) => (
              <DetailRow
                key={entry.id}
                label={hourLabel(entry)}
                value={formatHours(entry.hours)}
                isLast={index === shownHours.length - 1}
              />
            ))}
          </View>
        </Section>
      ) : null}

      {/* ── Corrections carried into this period ── */}
      {breakdown.adjustments.length > 0 ? (
        <Section label="CORRECTIONS">
          <View style={s.card}>
            {breakdown.adjustments.map((adjustment, index) => (
              <DetailRow
                key={adjustment.id}
                label={adjustment.description}
                value={formatMoney(adjustment.amountCents, currency)}
                isLast={index === breakdown.adjustments.length - 1}
              />
            ))}
          </View>
        </Section>
      ) : null}

      <Text style={s.footNote}>
        Questions about a figure? Your salon sees this exact breakdown — speak to your manager.
      </Text>
    </>
  );
}

// ── Sections & rows ───────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

function DetailRow({
  label,
  value,
  accent = false,
  isLast = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  isLast?: boolean;
}) {
  return (
    <View style={[s.detailRow, isLast && s.rowLast]}>
      <Text style={s.detailLabel} numberOfLines={2}>
        {label}
      </Text>
      <Text style={[s.detailValue, accent && s.detailValueAccent]}>{value}</Text>
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hourLabel(entry: PaySummaryHours): string {
  return HOUR_CATEGORY_LABELS[entry.category] ?? entry.category;
}

function greaterOfExplanation(winner: string | null): string {
  switch (winner) {
    case 'base_pay':
      return 'You were paid your guaranteed base pay — it was higher.';
    case 'commission':
      return 'You were paid commission — it was higher than your guarantee.';
    case 'revenue_split':
      return 'You were paid the revenue split — it was the higher amount.';
    default:
      return 'The higher of the compared amounts was paid.';
  }
}

function conditionLabel(metric: string): string {
  switch (metric) {
    case 'rebooking_rate_percent':
      return 'Rebooking rate';
    case 'retail_revenue':
      return 'Retail target';
    case 'average_bill':
      return 'Average bill';
    default:
      return metric.replace(/_/g, ' ');
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────


const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header

  // ── Loading / error
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    margin: spacing.base,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  loadingText: { color: 'rgba(255,255,255,0.5)', fontSize: 14, fontWeight: '600' },
  errorCard: {
    gap: spacing.sm,
    margin: spacing.base,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.3)',
    backgroundColor: 'rgba(248,113,113,0.08)',
  },
  errorText: { color: palette.danger[300], fontSize: 13, fontWeight: '600' },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
  },
  retryText: { color: palette.danger[300], fontSize: 12, fontWeight: '700' },

  scroll: { padding: spacing.base, gap: spacing.lg, paddingBottom: spacing['4xl'] },

  // ── Hero
  hero: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.3)',
    backgroundColor: 'rgba(166,124,245,0.1)',
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  heroPeriod: { flex: 1, color: palette.white, fontSize: 15, fontWeight: '700' },
  heroValueLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginTop: spacing.xs,
  },
  heroValue: { color: BRAND_LIGHT, fontSize: 34, fontWeight: '800', letterSpacing: -0.7 },
  heroValueOwed: { color: palette.warning[300] },
  heroNote: { color: 'rgba(255,255,255,0.6)', fontSize: 12, lineHeight: 17 },
  staleNote: { color: palette.warning[300], fontSize: 12, lineHeight: 17, fontWeight: '600' },

  // ── Status pill
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  statusPillPaid: { backgroundColor: 'rgba(74,222,128,0.12)', borderColor: 'rgba(74,222,128,0.3)' },
  statusPillConfirmed: {
    backgroundColor: 'rgba(166,124,245,0.14)',
    borderColor: 'rgba(196,160,245,0.4)',
  },
  statusPillText: { fontSize: 10, fontWeight: '700' },
  statusTextPaid: { color: palette.success[300] },
  statusTextConfirmed: { color: BRAND_LIGHT },

  // ── Sections
  section: { gap: spacing.sm },
  sectionLabel: { color: 'rgba(255,255,255,0.32)', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  card: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
    padding: spacing.base,
    gap: spacing.sm,
  },
  rowLast: { borderBottomWidth: 0, paddingBottom: 0 },

  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  detailLabel: { flex: 1, color: 'rgba(255,255,255,0.48)', fontSize: 13 },
  detailValue: { color: 'rgba(255,255,255,0.82)', fontSize: 14, fontWeight: '700' },
  detailValueAccent: { color: BRAND_LIGHT, fontWeight: '800' },
  derivation: { color: 'rgba(255,255,255,0.38)', fontSize: 11, lineHeight: 15 },

  // ── Commission bands
  bandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  bandBody: { flex: 1, gap: 2 },
  bandFrom: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '700' },
  bandRate: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '600' },
  bandAmount: { color: palette.white, fontSize: 13, fontWeight: '800' },

  // ── Info cards
  infoCard: {
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.3)',
    backgroundColor: 'rgba(166,124,245,0.08)',
  },
  infoTitle: { color: palette.white, fontSize: 14, fontWeight: '800' },
  infoBody: { color: 'rgba(255,255,255,0.6)', fontSize: 12, lineHeight: 17 },
  conditionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  footNote: { color: 'rgba(255,255,255,0.32)', fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
