import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type {
  CommissionResult,
  CommissionTier,
  KpiDataNote,
  KpiPeriod,
  StylistKpiResult,
} from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { BG, BORDER, BORDER_SUBTLE, BRAND, BRAND_LIGHT, CARD } from '../src/design/colors';

const PERIODS: { id: KpiPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
];

/**
 * Stylist Home — a motivational, commission-first view of the period.
 *
 * Every figure is read from the backend KPI + commission engine (`GET /kpi/me`).
 * The hero plots the real service-revenue multiple against the real 3x / 3.5x
 * tier thresholds; the next-tier callout, targets, money and unlock progress
 * are all derived from `StylistKpiResult` — nothing is computed or faked here.
 */
export default function PerformanceScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const displayName = auth.user?.profile.fullName ?? '';

  const [period, setPeriod] = useState<KpiPeriod>('week');
  const [stylist, setStylist] = useState<StylistKpiResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
        {/* ── App / greeting bar ── */}
        <View style={s.topBar}>
          <View style={s.topBarInfo}>
            <Text style={s.greeting}>{greeting()}</Text>
            <Text style={s.name}>{firstName(displayName)}</Text>
          </View>
          <Pressable
            onPress={() => router.push('/profile')}
            onLongPress={() => setMenuOpen(true)}
            style={({ pressed }) => [s.avatar, pressed && s.avatarPressed]}
            accessibilityRole="button"
            accessibilityLabel="Profile"
            accessibilityHint="Tap to open your profile, long press for more options"
          >
            <View style={s.avatarDot} />
            <Text style={s.avatarText}>{initials(displayName)}</Text>
          </Pressable>
        </View>

        {/* ── Avatar dropdown menu (long press) ── */}
        <Modal
          visible={menuOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setMenuOpen(false)}
        >
          <Pressable style={s.menuBackdrop} onPress={() => setMenuOpen(false)}>
            <View style={s.menuCard}>
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  router.push('/profile');
                }}
                style={({ pressed }) => [s.menuItem, pressed && s.menuItemPressed]}
              >
                <Text style={s.menuItemText}>Profile</Text>
              </Pressable>
              <View style={s.menuDivider} />
              <Pressable
                onPress={() => {
                  setMenuOpen(false);
                  void auth.signOut();
                }}
                style={({ pressed }) => [s.menuItem, pressed && s.menuItemPressed]}
              >
                <Text style={[s.menuItemText, s.menuItemDanger]}>Sign out</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>

        {/* ── Period selector ── */}
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

        <ScrollView style={s.scrollView} contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
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
              <Text style={s.loadingText}>Loading your performance…</Text>
            </View>
          ) : stylist ? (
            <KpiContent stylist={stylist} />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Content ─────────────────────────────────────────────────────────────────

function KpiContent({ stylist }: { stylist: StylistKpiResult }) {
  return (
    <>
      <HeroCard stylist={stylist} />
      <NextTierCallout stylist={stylist} />
      <TargetsSection stylist={stylist} />
      <MoneySection stylist={stylist} />
      <UnlockProgress stylist={stylist} />
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

// ── Hero: tier headline + multiple-vs-threshold meter ─────────────────────────

function HeroCard({ stylist }: { stylist: StylistKpiResult }) {
  const { commission, currencyCode } = stylist;
  const tone = TIER_TONE[commission.tier];
  const accent = TONE_COLOR[tone];
  const activeStep = TIER_STEP[commission.tier];

  // Real meter: the service-revenue multiple of labour cost, plotted on a 0–4×
  // scale with the live 3× and 3.5× commission thresholds marked.
  const fillPercent = clampPercent((commission.serviceMultiple / METER_MAX) * 100);

  return (
    <View style={[s.hero, { borderColor: withAlpha(accent, 0.32) }]}>
      <View style={s.heroHeader}>
        <View style={s.heroHeadline}>
          <Text style={s.heroTitle}>{tierHeadline(commission.tier)}</Text>
          <Text style={s.heroSubtitle}>{tierSubtitle(commission)}</Text>
        </View>

        {/* Tier ladder — current standing highlighted */}
        <View style={s.ladder}>
          {LADDER.map((step, index) => {
            const isActive = index === activeStep;
            const color = TONE_COLOR[step.tone];
            return (
              <View key={step.label} style={s.ladderRow}>
                <View
                  style={[
                    s.ladderDot,
                    { borderColor: withAlpha(color, 0.5) },
                    isActive && { backgroundColor: color, borderColor: color },
                  ]}
                />
                <Text style={[s.ladderLabel, isActive && { color }]}>{step.label}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* Generated value */}
      <View style={s.heroValueRow}>
        <Text style={s.heroValueLabel}>Generated</Text>
        <Text style={[s.heroMultiple, { color: accent }]}>{formatMultiple(commission.serviceMultiple)}</Text>
      </View>
      <Text style={s.heroValue}>{formatMoney(commission.commissionBaseCents, currencyCode)}</Text>

      {/* Meter */}
      <View style={s.meterTrack}>
        <View style={[s.meterFill, { width: `${fillPercent}%`, backgroundColor: accent }]} />
        <View style={[s.meterTick, { left: `${(3 / METER_MAX) * 100}%` }]} />
        <View style={[s.meterTick, { left: `${(3.5 / METER_MAX) * 100}%` }]} />
      </View>
      <View style={s.meterScale}>
        <Text style={s.meterScaleText}>0</Text>
        <MeterMark label="3×" met={commission.serviceMultiple >= 3} position={(3 / METER_MAX) * 100} />
        <MeterMark label="3.5×" met={commission.serviceMultiple >= 3.5} position={(3.5 / METER_MAX) * 100} />
        <Text style={[s.meterScaleText, s.meterScaleEnd]}>4×</Text>
      </View>

      <Text style={s.heroMeta}>
        {formatHours(stylist.hoursWorked)} worked · labour {formatMoney(commission.laborCostCents, currencyCode)} · {stylist.locationName}
      </Text>
    </View>
  );
}

function MeterMark({ label, met, position }: { label: string; met: boolean; position: number }) {
  return (
    <View style={[s.meterMark, { left: `${position}%` }]}>
      {met ? <Ionicons name="checkmark" size={9} color={palette.success[300]} /> : null}
      <Text style={[s.meterScaleText, met && s.meterScaleMet]}>{label}</Text>
    </View>
  );
}

// ── Next-tier callout (the headline opportunity) ──────────────────────────────

function NextTierCallout({ stylist }: { stylist: StylistKpiResult }) {
  const { commission, currencyCode, averageBill } = stylist;
  const next = commission.nextTier;

  // Top tier already reached.
  if (!next) {
    return (
      <View style={[s.callout, s.calloutSuccess]}>
        <Text style={s.calloutEyebrowSuccess}>TOP TIER REACHED</Text>
        <Text style={s.calloutHeadline}>Earning the full {commission.ratePercent}% commission.</Text>
      </View>
    );
  }

  const additional = next.additionalServiceRevenueCents ?? 0;
  const nextMultipleLabel = TIER_MULTIPLE_LABEL[next.tier];
  const verb = commission.ratePercent > 0 ? 'JUMPS TO' : 'STARTS AT';

  // Revenue-driven step (reach a higher multiple).
  if (additional > 0) {
    const appts =
      averageBill.actualAverageBillCents > 0
        ? Math.ceil(additional / averageBill.actualAverageBillCents)
        : null;
    return (
      <View style={[s.callout, s.calloutWarning]}>
        <Text style={s.calloutEyebrow}>
          TO HIT {nextMultipleLabel} — COMMISSION {verb} {next.ratePercent}%
        </Text>
        <View style={s.calloutBody}>
          <View style={s.calloutTextCol}>
            <Text style={s.calloutHeadline}>
              Generate another{' '}
              <Text style={s.calloutHighlight}>{formatMoney(additional, currencyCode)}</Text> in services
            </Text>
            <Text style={s.calloutSub}>
              {commission.ratePercent > 0
                ? `Moves you from ${commission.ratePercent}% to ${next.ratePercent}% commission`
                : `Unlocks ${next.ratePercent}% commission on your service revenue`}
            </Text>
            {appts ? <Text style={s.calloutSub}>≈ {appts} appointment{appts === 1 ? '' : 's'} away</Text> : null}
            {next.requiresAllKpis ? (
              <Text style={s.calloutSub}>Also requires all 3 KPIs met</Text>
            ) : null}
          </View>
          <Text style={s.calloutAmount}>{formatMoney(additional, currencyCode)}</Text>
        </View>
      </View>
    );
  }

  // KPI-gated step (already at 3.5×; meeting all KPIs promotes 15% → 30%).
  return (
    <View style={[s.callout, s.calloutWarning]}>
      <Text style={s.calloutEyebrow}>UNLOCK {next.ratePercent}% COMMISSION</Text>
      <Text style={s.calloutHeadline}>
        Now at {nextMultipleLabel} — meet all 3 KPIs to lift commission to{' '}
        <Text style={s.calloutHighlight}>{next.ratePercent}%</Text>.
      </Text>
    </View>
  );
}

// ── Your 3 targets ────────────────────────────────────────────────────────────

function TargetsSection({ stylist }: { stylist: StylistKpiResult }) {
  const { rebooking, retail, averageBill, currencyCode } = stylist;

  const retailShortfallCents = Math.max(0, -retail.varianceCents);
  const rebookGapPercent = Math.max(0, rebooking.thresholdPercent - rebooking.rebookingRatePercent);
  const avgBillShortfallCents = Math.max(0, -averageBill.varianceCents);

  return (
    <>
      <Text style={s.sectionLabel}>YOUR 3 TARGETS</Text>
      <View style={s.targetRow}>
        <TargetCard
          value={`${rebooking.rebookingRatePercent}%`}
          label="Rebook"
          met={stylist.rebookingKpiMet}
          status={stylist.rebookingKpiMet ? 'Done' : `${rebookGapPercent}% to go`}
        />
        <TargetCard
          value={formatMoney(retail.actualRetailSalesCents, currencyCode)}
          label="Retail"
          met={stylist.retailKpiMet}
          status={stylist.retailKpiMet ? 'Done' : `${formatMoney(retailShortfallCents, currencyCode)} left`}
        />
        <TargetCard
          value={averageBill.hasBenchmark ? formatMoney(averageBill.actualAverageBillCents, currencyCode) : '—'}
          label="Avg bill"
          met={stylist.averageBillKpiMet}
          neutral={!averageBill.hasBenchmark}
          status={
            !averageBill.hasBenchmark
              ? 'No benchmark'
              : stylist.averageBillKpiMet
                ? 'Done'
                : `${formatMoney(avgBillShortfallCents, currencyCode)} left`
          }
        />
      </View>
    </>
  );
}

function TargetCard({
  value,
  label,
  status,
  met,
  neutral = false,
}: {
  value: string;
  label: string;
  status: string;
  met: boolean;
  neutral?: boolean;
}) {
  const tone: Tone = neutral ? 'neutral' : met ? 'success' : 'danger';
  const color = tone === 'neutral' ? palette.brand[300] : TONE_COLOR[tone];
  return (
    <View style={[s.targetCard, { borderColor: withAlpha(color, 0.3) }]}>
      <Text style={[s.targetValue, { color }]}>{value}</Text>
      <Text style={s.targetLabel}>{label}</Text>
      <View style={[s.targetStatus, { backgroundColor: withAlpha(color, 0.14) }]}>
        {!neutral ? (
          <Ionicons name={met ? 'checkmark-circle' : 'close-circle'} size={11} color={color} />
        ) : null}
        <Text style={[s.targetStatusText, { color }]} numberOfLines={1} adjustsFontSizeToFit>
          {status}
        </Text>
      </View>
    </View>
  );
}

// ── Your money ────────────────────────────────────────────────────────────────

function MoneySection({ stylist }: { stylist: StylistKpiResult }) {
  const { commission, currencyCode } = stylist;
  return (
    <>
      <Text style={s.sectionLabel}>YOUR MONEY</Text>
      <View style={s.moneyRow}>
        <View style={s.moneyCard}>
          <Text style={s.moneyValue}>{formatMoney(commission.commissionBaseCents, currencyCode)}</Text>
          <Text style={s.moneyLabel}>Generated so far</Text>
          <Text style={s.moneySub}>Service revenue this period</Text>
        </View>
        <View style={[s.moneyCard, s.moneyCardAccent]}>
          <Text style={[s.moneyValue, s.moneyValueAccent]}>
            {formatMoney(commission.commissionAmountCents, currencyCode)}
          </Text>
          <Text style={s.moneyLabel}>Commission earned</Text>
          <Text style={s.moneySub}>
            {commission.ratePercent > 0 ? `${commission.ratePercent}% tier rate` : 'Reach 3× to start earning'}
          </Text>
        </View>
      </View>
    </>
  );
}

// ── Commission unlock progress (real all-KPIs gate) ───────────────────────────

function UnlockProgress({ stylist }: { stylist: StylistKpiResult }) {
  const met = [stylist.rebookingKpiMet, stylist.retailKpiMet, stylist.averageBillKpiMet];
  const metCount = met.filter(Boolean).length;
  const unlocked = stylist.allKpisMet;
  const color = unlocked ? palette.success[300] : palette.brand[300];

  return (
    <View style={s.unlockCard}>
      <View style={s.unlockHeader}>
        <View style={s.flex}>
          <Text style={s.unlockTitle}>Commission unlock</Text>
          <Text style={s.unlockSub}>
            {unlocked
              ? 'Unlocked — 30% available once you hold 3.5×'
              : 'Meet all 3 KPIs to lift the 3.5× tier to 30%'}
          </Text>
        </View>
        <Text style={[s.unlockCount, { color }]}>{metCount}/3</Text>
      </View>
      <View style={s.unlockSegments}>
        {met.map((isMet, index) => (
          <View
            key={index}
            style={[s.unlockSegment, { backgroundColor: isMet ? color : 'rgba(255,255,255,0.1)' }]}
          />
        ))}
      </View>
    </View>
  );
}

// ── Tier presentation maps ────────────────────────────────────────────────────

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<Tone, string> = {
  success: palette.success[300],
  warning: palette.warning[300],
  danger: palette.danger[300],
  neutral: palette.brand[300],
};

const TIER_TONE: Record<CommissionTier, Tone> = {
  below_3x: 'danger',
  tier_3x: 'warning',
  tier_3_5x: 'success',
  tier_3_5x_unlocked: 'success',
};

const TIER_STEP: Record<CommissionTier, number> = {
  below_3x: 0,
  tier_3x: 1,
  tier_3_5x: 2,
  tier_3_5x_unlocked: 2,
};

const TIER_MULTIPLE_LABEL: Record<CommissionTier, string> = {
  below_3x: 'below 3×',
  tier_3x: '3×',
  tier_3_5x: '3.5×',
  tier_3_5x_unlocked: '3.5×',
};

const LADDER: { label: string; tone: Tone }[] = [
  { label: 'Behind', tone: 'danger' },
  { label: 'On track', tone: 'warning' },
  { label: 'Smashing it', tone: 'success' },
];

const METER_MAX = 4;

function tierHeadline(tier: CommissionTier): string {
  switch (tier) {
    case 'below_3x':
      return "Let's build momentum";
    case 'tier_3x':
      return "You're on a roll";
    case 'tier_3_5x':
      return 'Smashing it';
    case 'tier_3_5x_unlocked':
      return 'Top tier unlocked';
  }
}

function tierSubtitle(commission: CommissionResult): string {
  const multiple = formatMultiple(commission.serviceMultiple);
  if (commission.ratePercent > 0) {
    return `${multiple} reached · ${commission.ratePercent}% commission active`;
  }
  return `${multiple} · reach 3× to start earning commission`;
}

// ── Formatting (presentation only; values come from the API) ──────────────────

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

function formatMultiple(multiple: number): string {
  if (!Number.isFinite(multiple) || multiple <= 0) return '0×';
  return `${multiple.toFixed(1)}×`;
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

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstName(value: string): string {
  return value.split(' ')[0] || 'there';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Apply an alpha channel to a #RRGGBB token colour. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const CARD_ELEVATED = '#271F38';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.74 },
  flex: { flex: 1 },

  // ── Greeting bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.base,
    paddingBottom: spacing.sm,
  },
  topBarInfo: { flex: 1 },
  greeting: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500' },
  name: { color: palette.white, fontSize: 28, fontWeight: '800', letterSpacing: -0.6, marginTop: 1 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: withAlpha(BRAND_LIGHT, 0.4),
  },
  avatarPressed: { opacity: 0.7 },
  avatarText: { color: palette.white, fontSize: 14, fontWeight: '800' },
  avatarDot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 11,
    height: 11,
    borderRadius: radius.full,
    backgroundColor: palette.success[300],
    borderWidth: 2,
    borderColor: BG,
  },

  // ── Avatar dropdown menu
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'flex-end',
    paddingTop: 72,
    paddingHorizontal: spacing.lg,
  },
  menuCard: {
    minWidth: 180,
    backgroundColor: CARD_ELEVATED,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: BORDER,
    paddingVertical: spacing.xs,
    overflow: 'hidden',
  },
  menuItem: { paddingVertical: spacing.sm, paddingHorizontal: spacing.base },
  menuItemPressed: { backgroundColor: BORDER_SUBTLE },
  menuItemText: { color: palette.white, fontSize: 15, fontWeight: '600' },
  menuItemDanger: { color: palette.danger[300] },
  menuDivider: { height: 1, backgroundColor: BORDER_SUBTLE, marginHorizontal: spacing.base },

  // ── Period selector
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

  scrollView: { flex: 1 },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing['4xl'], gap: spacing.base },

  // ── Loading / error
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
    borderColor: withAlpha(palette.danger[300], 0.3),
    backgroundColor: withAlpha(palette.danger[300], 0.08),
  },
  errorTitle: { color: palette.white, fontSize: 15, fontWeight: '800' },
  errorBody: { color: palette.danger[300], fontSize: 13 },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: withAlpha(palette.danger[300], 0.4),
  },
  retryBtnText: { color: palette.danger[300], fontSize: 12, fontWeight: '700' },

  // ── Hero
  hero: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    backgroundColor: CARD,
  },
  heroHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  heroHeadline: { flex: 1, gap: 4 },
  heroTitle: { color: palette.white, fontSize: 24, fontWeight: '800', letterSpacing: -0.5, lineHeight: 28 },
  heroSubtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 18 },
  ladder: { gap: 6, alignItems: 'flex-end' },
  ladderRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ladderDot: { width: 9, height: 9, borderRadius: radius.full, borderWidth: 1.5 },
  ladderLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '700' },

  heroValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  heroValueLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  heroMultiple: { fontSize: 18, fontWeight: '800' },
  heroValue: { color: palette.white, fontSize: 30, fontWeight: '800', letterSpacing: -0.6 },

  meterTrack: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
    marginTop: spacing.xs,
    position: 'relative',
  },
  meterFill: { height: '100%', borderRadius: radius.pill },
  meterTick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  meterScale: { height: 16, position: 'relative', marginTop: 2 },
  meterMark: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    transform: [{ translateX: -14 }],
  },
  meterScaleText: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '700' },
  meterScaleEnd: { position: 'absolute', right: 0, top: 0 },
  meterScaleMet: { color: palette.success[300] },
  heroMeta: { color: BRAND_LIGHT, fontSize: 11, fontWeight: '600', marginTop: spacing.xs },

  // ── Callout
  callout: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
  },
  calloutWarning: {
    borderColor: withAlpha(palette.warning[300], 0.4),
    backgroundColor: withAlpha(palette.warning[300], 0.09),
  },
  calloutSuccess: {
    borderColor: withAlpha(palette.success[300], 0.4),
    backgroundColor: withAlpha(palette.success[300], 0.09),
  },
  calloutEyebrow: { color: palette.warning[300], fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  calloutEyebrowSuccess: { color: palette.success[300], fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  calloutBody: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  calloutTextCol: { flex: 1, gap: 4 },
  calloutHeadline: { color: palette.white, fontSize: 15, fontWeight: '700', lineHeight: 21 },
  calloutHighlight: { color: palette.warning[300], fontWeight: '800' },
  calloutSub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, lineHeight: 16 },
  calloutAmount: { color: palette.warning[300], fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },

  // ── Section label
  sectionLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: spacing.sm,
  },

  // ── Targets
  targetRow: { flexDirection: 'row', gap: spacing.sm },
  targetCard: {
    flex: 1,
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    backgroundColor: CARD,
    alignItems: 'flex-start',
  },
  targetValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  targetLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  targetStatus: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginTop: spacing.xs,
  },
  targetStatusText: { fontSize: 11, fontWeight: '800' },

  // ── Money
  moneyRow: { flexDirection: 'row', gap: spacing.sm },
  moneyCard: {
    flex: 1,
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    backgroundColor: CARD,
  },
  moneyCardAccent: {
    borderColor: withAlpha(BRAND_LIGHT, 0.3),
    backgroundColor: withAlpha(BRAND, 0.1),
  },
  moneyValue: { color: palette.white, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  moneyValueAccent: { color: BRAND_LIGHT },
  moneyLabel: { color: 'rgba(255,255,255,0.78)', fontSize: 13, fontWeight: '700' },
  moneySub: { color: 'rgba(255,255,255,0.45)', fontSize: 11 },

  // ── Unlock progress
  unlockCard: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    backgroundColor: CARD_ELEVATED,
  },
  unlockHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  unlockTitle: { color: palette.white, fontSize: 15, fontWeight: '800' },
  unlockSub: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  unlockCount: { fontSize: 20, fontWeight: '800' },
  unlockSegments: { flexDirection: 'row', gap: spacing.xs },
  unlockSegment: { flex: 1, height: 8, borderRadius: radius.pill },

  // ── Notes
  notesCard: {
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  noteText: { color: 'rgba(255,255,255,0.5)', fontSize: 12 },
});
