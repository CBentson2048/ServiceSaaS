import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { MyPaySummaryListItem, PayPeriodStatus } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import {
  PAY_STATUS_LABELS,
  formatHours,
  formatMoney,
  periodWindowLabel,
} from '../src/payroll/format';

/**
 * My pay — the stylist's own statements, newest first.
 *
 * Every figure comes from `GET /payroll/me/summaries`, which the API scopes to
 * the verified actor's staff profile and to approved/locked/paid periods.
 * Nothing is computed here; a statement that is not in the response does not
 * exist as far as this screen is concerned.
 */
export default function MyPayScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const hasSelfView = userHasPermission(auth.user, 'payroll.self.view');

  const [summaries, setSummaries] = useState<MyPaySummaryListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !hasSelfView) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.getMyPaySummaries(accessToken);
      setSummaries(response.summaries);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your pay statements');
    } finally {
      setLoading(false);
    }
  }, [accessToken, hasSelfView]);

  useEffect(() => {
    void load();
  }, [load]);

  const latest = summaries?.[0] ?? null;
  const rest = summaries && summaries.length > 1 ? summaries.slice(1) : [];

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header ── */}
        <View style={s.header}>
          <Pressable
            style={({ pressed }) => [s.backBtn, pressed && s.pressed]}
            onPress={() => router.back()}
          >
            <Text style={s.backArrow}>‹</Text>
            <Text style={s.backLabel}>Back</Text>
          </Pressable>
          <Text style={s.headerTitle}>My pay</Text>
          <View style={s.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {!hasSelfView ? (
            <View style={s.noticeCard}>
              <Text style={s.noticeTitle}>Pay statements are not enabled for your role yet</Text>
              <Text style={s.noticeBody}>
                Ask the business owner to grant “View own pay” on your security level.
              </Text>
            </View>
          ) : error ? (
            <View style={s.errorCard}>
              <Text style={s.errorTitle}>Pay statements unavailable</Text>
              <Text style={s.errorBody}>{error}</Text>
              <Pressable
                onPress={() => void load()}
                style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}
              >
                <Text style={s.retryBtnText}>Try again</Text>
              </Pressable>
            </View>
          ) : loading && !summaries ? (
            <View style={s.loadingCard}>
              <ActivityIndicator color={palette.brand[300]} size="small" />
              <Text style={s.loadingText}>Loading your pay…</Text>
            </View>
          ) : !summaries || summaries.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No pay statements yet</Text>
              <Text style={s.emptyBody}>
                Statements appear here once your salon approves a pay period that includes you.
              </Text>
            </View>
          ) : (
            <>
              {latest ? (
                <>
                  <Text style={s.sectionLabel}>LATEST STATEMENT</Text>
                  <HeroStatement item={latest} />
                </>
              ) : null}
              {rest.length > 0 ? (
                <>
                  <Text style={s.sectionLabel}>EARLIER STATEMENTS</Text>
                  {rest.map((item) => (
                    <StatementCard key={item.summaryId} item={item} />
                  ))}
                </>
              ) : null}
              <Text style={s.footNote}>
                Statements are published once your salon approves the pay period. Questions about
                a figure? Every statement has a full breakdown — tap it, or speak to your manager.
              </Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function openStatement(item: MyPaySummaryListItem) {
  router.push(
    `/pay-summary?id=${encodeURIComponent(item.summaryId)}` +
      `&periodStart=${encodeURIComponent(item.period.periodStart)}` +
      `&periodEnd=${encodeURIComponent(item.period.periodEnd)}` +
      `&status=${encodeURIComponent(item.period.status)}` +
      (item.period.label ? `&label=${encodeURIComponent(item.period.label)}` : ''),
  );
}

/** The most recent statement — the number the stylist opened the screen for. */
function HeroStatement({ item }: { item: MyPaySummaryListItem }) {
  const owesSalon = item.netPayableCents < 0;
  return (
    <Pressable
      onPress={() => openStatement(item)}
      style={({ pressed }) => [s.hero, pressed && s.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Pay statement for ${periodWindowLabel(item.period.periodStart, item.period.periodEnd)}`}
    >
      <View style={s.heroTopRow}>
        <Text style={s.heroPeriod}>
          {periodWindowLabel(item.period.periodStart, item.period.periodEnd)}
        </Text>
        <StatusPill status={item.period.status} />
      </View>
      <Text style={s.heroValueLabel}>{owesSalon ? 'OWED TO THE SALON' : 'NET PAY'}</Text>
      <Text style={[s.heroValue, owesSalon && s.heroValueOwed]}>
        {formatMoney(Math.abs(item.netPayableCents), item.currencyCode)}
      </Text>
      <Text style={s.heroMeta}>
        {[
          item.structureName,
          item.payableHours > 0 ? `${formatHours(item.payableHours)} payable` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Tap for the full breakdown'}
      </Text>
      {item.isStale ? (
        <Text style={s.staleNote}>Figures are being rechecked by your salon.</Text>
      ) : null}
      <Text style={s.heroCta}>View breakdown ›</Text>
    </Pressable>
  );
}

function StatementCard({ item }: { item: MyPaySummaryListItem }) {
  const owesSalon = item.netPayableCents < 0;
  return (
    <Pressable
      onPress={() => openStatement(item)}
      style={({ pressed }) => [s.rowCard, pressed && s.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Pay statement for ${periodWindowLabel(item.period.periodStart, item.period.periodEnd)}`}
    >
      <View style={s.rowBody}>
        <Text style={s.rowPeriod}>
          {periodWindowLabel(item.period.periodStart, item.period.periodEnd)}
        </Text>
        <View style={s.rowMetaRow}>
          <StatusPill status={item.period.status} />
          {item.isStale ? <Text style={s.rowStale}>Being rechecked</Text> : null}
        </View>
      </View>
      <View style={s.rowRight}>
        <Text style={[s.rowAmount, owesSalon && s.rowAmountOwed]}>
          {formatMoney(item.netPayableCents, item.currencyCode)}
        </Text>
        <Text style={s.rowChevron}>›</Text>
      </View>
    </Pressable>
  );
}

function StatusPill({ status }: { status: PayPeriodStatus }) {
  const paid = status === 'paid';
  return (
    <View style={[s.statusPill, paid ? s.statusPillPaid : s.statusPillConfirmed]}>
      <Text style={[s.statusPillText, paid ? s.statusTextPaid : s.statusTextConfirmed]}>
        {PAY_STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BG = palette.ink[950];
const CARD = palette.ink[700];
const BORDER = 'rgba(255,255,255,0.13)';
const BORDER_SOFT = 'rgba(255,255,255,0.08)';
const BRAND_LIGHT = palette.brand[300];

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.74 },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 90 },
  backArrow: { color: BRAND_LIGHT, fontSize: 28, lineHeight: 30, fontWeight: '300', marginTop: -2 },
  backLabel: { color: BRAND_LIGHT, fontSize: 15, fontWeight: '600' },
  headerTitle: { color: palette.white, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  headerSpacer: { minWidth: 90 },

  scroll: { padding: spacing.base, gap: spacing.sm, paddingBottom: spacing['4xl'] },

  sectionLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: spacing.sm,
  },

  // ── Notice / loading / error / empty
  noticeCard: {
    gap: spacing.xs,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  noticeTitle: { color: palette.white, fontSize: 15, fontWeight: '800' },
  noticeBody: { color: 'rgba(255,255,255,0.55)', fontSize: 13, lineHeight: 18 },
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
  emptyCard: {
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing['2xl'],
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  emptyTitle: { color: palette.white, fontSize: 15, fontWeight: '800' },
  emptyBody: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },

  // ── Hero (latest statement)
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
  heroMeta: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '600' },
  staleNote: { color: palette.warning[300], fontSize: 12, fontWeight: '600' },
  heroCta: { color: BRAND_LIGHT, fontSize: 13, fontWeight: '700', marginTop: spacing.xs },

  // ── Earlier statements
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_SOFT,
  },
  rowBody: { flex: 1, gap: 5 },
  rowPeriod: { color: palette.white, fontSize: 14, fontWeight: '700' },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowStale: { color: palette.warning[300], fontSize: 11, fontWeight: '600' },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowAmount: { color: 'rgba(255,255,255,0.88)', fontSize: 16, fontWeight: '800' },
  rowAmountOwed: { color: palette.warning[300] },
  rowChevron: { color: BRAND_LIGHT, fontSize: 22, fontWeight: '300' },

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

  footNote: {
    color: 'rgba(255,255,255,0.32)',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});
