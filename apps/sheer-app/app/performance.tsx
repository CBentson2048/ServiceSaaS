import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { KpiDataNote, KpiPeriod, StylistKpiResult } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

const PERIODS: { id: KpiPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
];

/**
 * Stylist-facing KPI screen. Every value is read from the backend KPI engine
 * (`GET /kpi/me`) — targets, rebooking, retail, average bill, and the overall
 * commission unlock state. Nothing is computed or faked on the client.
 */
export default function PerformanceScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';

  const [period, setPeriod] = useState<KpiPeriod>('week');
  const [stylist, setStylist] = useState<StylistKpiResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMyKpi(accessToken, period);
      setStylist(result.stylist);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your KPIs');
    } finally {
      setLoading(false);
    }
  }, [accessToken, period]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProtectedScreen allowedRoles={['stylist']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <View style={s.topBar}>
          <Pressable onPress={() => router.back()} style={({ pressed }) => [s.backBtn, pressed && s.pressed]}>
            <Text style={s.backBtnText}>‹</Text>
          </Pressable>
          <View style={s.topBarTitleBlock}>
            <Text style={s.topBarTitle}>Performance</Text>
            <Text style={s.topBarSub}>Targets &amp; KPI · the inputs that unlock commission</Text>
          </View>
        </View>

        <View style={s.periodRow}>
          {PERIODS.map((tab) => {
            const active = tab.id === period;
            return (
              <Pressable
                key={tab.id}
                onPress={() => setPeriod(tab.id)}
                style={[s.periodTab, active && s.periodTabActive]}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Text style={[s.periodTabText, active && s.periodTabTextActive]}>{tab.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {error ? (
            <View style={s.errorCard}>
              <Text style={s.errorTitle}>Performance unavailable</Text>
              <Text style={s.errorBody}>{error}</Text>
              <Pressable onPress={() => void load()} style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}>
                <Text style={s.retryBtnText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}

          {loading && !stylist ? (
            <View style={s.loadingCard}>
              <ActivityIndicator color={palette.brand[300]} size="small" />
              <Text style={s.loadingText}>Loading your KPIs…</Text>
            </View>
          ) : stylist ? (
            <KpiContent stylist={stylist} />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

function KpiContent({ stylist }: { stylist: StylistKpiResult }) {
  const { currencyCode, rebooking, retail, averageBill } = stylist;
  const unlocked = stylist.allKpisMet;

  return (
    <>
      {/* Commission unlock hero */}
      <View style={[s.hero, unlocked ? s.heroUnlocked : s.heroLocked]}>
        <Text style={[s.heroEyebrow, unlocked ? s.heroEyebrowUnlocked : s.heroEyebrowLocked]}>
          COMMISSION STATUS
        </Text>
        <Text style={s.heroTitle}>{unlocked ? 'Commission ready' : 'Locked'}</Text>
        <Text style={s.heroBody}>
          {unlocked
            ? 'Every KPI is met for this period.'
            : 'Meet all three KPIs to unlock commission for this period.'}
        </Text>
        <Text style={s.heroMeta}>{formatHours(stylist.hoursWorked)} worked · {stylist.locationName}</Text>
      </View>

      {/* Target progress */}
      <Text style={s.sectionTitle}>Targets</Text>
      <View style={s.card}>
        <ProgressRow
          label="Service target"
          actualCents={stylist.actualServiceRevenueCents}
          targetCents={stylist.serviceTargetCents}
          percent={stylist.serviceTargetProgressPercent}
          currencyCode={currencyCode}
          met={stylist.actualServiceRevenueCents >= stylist.serviceTargetCents && stylist.serviceTargetCents > 0}
        />
        <View style={s.divider} />
        <ProgressRow
          label="Retail target"
          actualCents={stylist.actualRetailRevenueCents}
          targetCents={stylist.retailTargetCents}
          percent={stylist.retailTargetProgressPercent}
          currencyCode={currencyCode}
          met={stylist.retailKpiMet}
        />
      </View>

      {/* KPI verdicts */}
      <Text style={s.sectionTitle}>KPIs</Text>
      <View style={s.card}>
        <KpiRow
          label="Rebooking"
          detail={`${rebooking.rebookedVisits}/${rebooking.completedVisits} visits · ${rebooking.rebookingRatePercent}% (target ${rebooking.thresholdPercent}%)`}
          met={stylist.rebookingKpiMet}
        />
        <View style={s.divider} />
        <KpiRow
          label="Retail"
          detail={`${formatMoney(retail.actualRetailSalesCents, currencyCode)} of ${formatMoney(
            retail.retailTargetCents,
            currencyCode,
          )} (${signedMoney(retail.varianceCents, currencyCode)})`}
          met={stylist.retailKpiMet}
        />
        <View style={s.divider} />
        <KpiRow
          label="Average bill"
          detail={
            averageBill.hasBenchmark
              ? `${formatMoney(averageBill.actualAverageBillCents, currencyCode)} vs ${formatMoney(
                  averageBill.benchmarkCents,
                  currencyCode,
                )} benchmark`
              : 'No benchmark set'
          }
          met={stylist.averageBillKpiMet}
        />
      </View>

      {stylist.notes.length > 0 ? (
        <View style={s.notesCard}>
          {stylist.notes.map((note) => (
            <Text key={note} style={s.noteText}>
              • {noteLabel(note)}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

function ProgressRow({
  label,
  actualCents,
  targetCents,
  percent,
  currencyCode,
  met,
}: {
  label: string;
  actualCents: number;
  targetCents: number;
  percent: number;
  currencyCode: string;
  met: boolean;
}) {
  const fillColor = met ? palette.success[300] : percent >= 60 ? palette.warning[300] : palette.brand[300];
  return (
    <View style={s.progressRow}>
      <View style={s.progressHeader}>
        <Text style={s.progressLabel}>{label}</Text>
        <Text style={s.progressValue}>
          {formatMoney(actualCents, currencyCode)}
          <Text style={s.progressTarget}> / {formatMoney(targetCents, currencyCode)} ({percent}%)</Text>
        </Text>
      </View>
      <View style={s.track}>
        <View style={[s.fill, { width: `${clampPercent(percent)}%`, backgroundColor: fillColor }]} />
      </View>
    </View>
  );
}

function KpiRow({ label, detail, met }: { label: string; detail: string; met: boolean }) {
  return (
    <View style={s.kpiRow}>
      <View style={s.kpiRowMain}>
        <Text style={s.kpiRowLabel}>{label}</Text>
        <Text style={s.kpiRowDetail}>{detail}</Text>
      </View>
      <View style={[s.verdictPill, met ? s.verdictMet : s.verdictNotMet]}>
        <Text style={[s.verdictText, met ? s.verdictTextMet : s.verdictTextNotMet]}>
          {met ? 'Met' : 'Not met'}
        </Text>
      </View>
    </View>
  );
}

// --- Formatting (presentation only; values come from the API) ---------------

function formatMoney(cents: number, currencyCode: string): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const hasFraction = safe % 100 !== 0;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'GBP',
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(safe / 100);
}

function signedMoney(cents: number, currencyCode: string): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${formatMoney(Math.abs(cents), currencyCode)}`;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

function noteLabel(note: KpiDataNote): string {
  switch (note) {
    case 'no_hours_worked':
      return 'No rostered hours this period';
    case 'no_completed_visits':
      return 'No completed visits yet';
    case 'missing_benchmark':
      return 'No average-bill benchmark set';
    case 'retail_attribution_approximate':
      return 'Retail figures are approximate';
    default:
      return note;
  }
}

const BG = '#18141F';
const CARD = '#211A2E';
const BORDER = 'rgba(255,255,255,0.13)';
const BRAND = palette.brand[500];
const BRAND_LIGHT = palette.brand[300];

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.74 },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: BORDER,
  },
  backBtnText: { color: palette.white, fontSize: 22, fontWeight: '700', marginTop: -2 },
  topBarTitleBlock: { flex: 1 },
  topBarTitle: { color: palette.white, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  topBarSub: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },

  periodRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  periodTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: BORDER,
  },
  periodTabActive: { backgroundColor: BRAND, borderColor: BRAND },
  periodTabText: { color: 'rgba(255,255,255,0.65)', fontSize: 13, fontWeight: '700' },
  periodTabTextActive: { color: palette.white },

  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing['4xl'], gap: spacing.base },

  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  loadingText: { color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '600' },
  errorCard: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.3)',
    backgroundColor: 'rgba(248,113,113,0.08)',
  },
  errorTitle: { color: palette.white, fontSize: 15, fontWeight: '800' },
  errorBody: { color: palette.danger[300], fontSize: 13 },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.4)',
  },
  retryBtnText: { color: palette.danger[300], fontSize: 12, fontWeight: '700' },

  hero: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
  },
  heroUnlocked: { borderColor: 'rgba(74,222,128,0.32)', backgroundColor: 'rgba(74,222,128,0.10)' },
  heroLocked: { borderColor: BORDER, backgroundColor: CARD },
  heroEyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  heroEyebrowUnlocked: { color: palette.success[300] },
  heroEyebrowLocked: { color: 'rgba(255,255,255,0.45)' },
  heroTitle: { color: palette.white, fontSize: 22, fontWeight: '800' },
  heroBody: { color: 'rgba(255,255,255,0.65)', fontSize: 13, lineHeight: 18 },
  heroMeta: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700', marginTop: spacing.xs },

  sectionTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
    marginTop: spacing.sm,
  },
  card: {
    padding: spacing.base,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: spacing.md },

  progressRow: { gap: spacing.sm },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  progressLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600' },
  progressValue: { color: palette.white, fontSize: 13, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
  progressTarget: { color: 'rgba(255,255,255,0.5)', fontWeight: '600' },
  track: { height: 6, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },

  kpiRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  kpiRowMain: { flex: 1, gap: 2 },
  kpiRowLabel: { color: palette.white, fontSize: 14, fontWeight: '700' },
  kpiRowDetail: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
  verdictPill: { borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 4, borderWidth: 1 },
  verdictMet: { backgroundColor: 'rgba(74,222,128,0.16)', borderColor: 'rgba(74,222,128,0.4)' },
  verdictNotMet: { backgroundColor: 'rgba(245,158,11,0.14)', borderColor: 'rgba(245,158,11,0.4)' },
  verdictText: { fontSize: 11, fontWeight: '800' },
  verdictTextMet: { color: palette.success[300] },
  verdictTextNotMet: { color: palette.warning[300] },

  notesCard: {
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  noteText: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
});
