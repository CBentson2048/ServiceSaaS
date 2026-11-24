import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ClientVisitColourFormula, ClientVisitDetail, ClientVisitServiceLine } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';
import { ScreenHeader } from '../../src/navigation/ScreenHeader';
import { StatusBadge } from '../../src/design';
import { BG, BRAND_LIGHT, CARD } from '../../src/design/colors';

export default function VisitDetailScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [visit, setVisit] = useState<ClientVisitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !id) return;
    setLoading(true);
    setError(null);
    try {
      setVisit(await api.getMyVisitDetail(accessToken, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this visit');
    } finally {
      setLoading(false);
    }
  }, [accessToken, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const tone = visit ? visitTone(visit.status) : 'neutral';

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <ScreenHeader title="Visit details" />

        {loading ? (
          <View style={s.loadingCard}>
            <ActivityIndicator color={palette.brand[300]} size="small" />
            <Text style={s.loadingText}>Loading visit…</Text>
          </View>
        ) : error ? (
          <View style={s.errorCard}>
            <Text style={s.errorText}>{error}</Text>
            <Pressable onPress={() => void load()} style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}>
              <Text style={s.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : !visit ? null : (
          <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
            {/* ── Summary ── */}
            <View style={s.summaryCard}>
              <View style={s.summaryTitleRow}>
                <Text style={s.summaryTitle} numberOfLines={2}>
                  {visit.serviceSummary || visit.services.map((sv) => sv.name).join(', ') || 'Visit'}
                </Text>
                <StatusBadge label={formatStatus(visit.status)} tone={tone} />
              </View>
              <View style={s.summaryMeta}>
                <Ionicons name="calendar-outline" size={14} color={BRAND_LIGHT} />
                <Text style={s.summaryMetaText}>{formatDateTime(visit.occurredAt)}</Text>
              </View>
              {visit.stylistName ? (
                <View style={s.summaryMeta}>
                  <Ionicons name="cut-outline" size={14} color={BRAND_LIGHT} />
                  <Text style={s.summaryMetaText}>with {visit.stylistName}</Text>
                </View>
              ) : null}
            </View>

            {/* ── Services ── */}
            <Section label="SERVICES">
              {visit.services.length === 0 ? (
                <View style={s.card}>
                  <Text style={s.mutedSm}>{visit.serviceSummary ?? 'No itemised services recorded.'}</Text>
                </View>
              ) : (
                <View style={s.card}>
                  {visit.services.map((service, idx) => (
                    <ServiceRow
                      key={`${service.name}-${idx}`}
                      service={service}
                      currency={visit.currencyCode ?? 'GBP'}
                      isLast={idx === visit.services.length - 1}
                    />
                  ))}
                </View>
              )}
            </Section>

            {/* ── Colours used ── */}
            <Section
              label="COLOURS USED"
              accessory={
                visit.colourCount > 0 ? (
                  <View style={s.countPill}>
                    <Text style={s.countPillText}>
                      {visit.colourCount} colour{visit.colourCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                ) : null
              }
            >
              {visit.colourFormulas.length === 0 ? (
                <View style={s.card}>
                  <Text style={s.mutedSm}>No colour formula was recorded for this visit.</Text>
                </View>
              ) : (
                visit.colourFormulas.map((formula) => (
                  <ColourFormulaCard key={formula.id} formula={formula} currency={visit.currencyCode ?? 'GBP'} />
                ))
              )}
            </Section>

            {/* ── Payment ── */}
            <Section label="PAYMENT">
              <View style={s.card}>
                {visit.depositAmount != null ? (
                  <>
                    <DetailRow
                      label="Total"
                      value={formatMoney(visit.totalAmount ?? 0, visit.currencyCode ?? 'GBP')}
                    />
                    <DetailRow
                      label="Deposit (at booking)"
                      value={formatMoney(visit.depositAmount, visit.currencyCode ?? 'GBP')}
                    />
                    <DetailRow
                      label="Paid at checkout"
                      value={visit.amountPaid != null ? formatMoney(visit.amountPaid, visit.currencyCode ?? 'GBP') : 'Not recorded'}
                      accent
                    />
                  </>
                ) : (
                  <DetailRow
                    label="Amount paid"
                    value={
                      visit.amountPaid != null
                        ? formatMoney(visit.amountPaid, visit.currencyCode ?? 'GBP')
                        : visit.totalAmount != null
                          ? formatMoney(visit.totalAmount, visit.currencyCode ?? 'GBP')
                          : 'Not recorded'
                    }
                    accent
                  />
                )}
                {visit.paymentMethod ? (
                  <DetailRow label="Method" value={formatPaymentMethod(visit.paymentMethod)} />
                ) : null}
                {visit.paidAt ? <DetailRow label="Paid on" value={formatDateTime(visit.paidAt)} isLast /> : null}
              </View>
            </Section>

            {visit.taxLabel ? (
              <Text style={s.taxNote}>All service and colour prices include {visit.taxLabel}.</Text>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Sections & rows ─────────────────────────────────────────────────────────

function Section({
  label,
  accessory,
  children,
}: {
  label: string;
  accessory?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={s.section}>
      <View style={s.sectionHeaderRow}>
        <Text style={s.sectionLabel}>{label}</Text>
        {accessory}
      </View>
      {children}
    </View>
  );
}

function ServiceRow({
  service,
  currency,
  isLast,
}: {
  service: ClientVisitServiceLine;
  currency: string;
  isLast: boolean;
}) {
  return (
    <View style={[s.serviceRow, isLast && s.rowLast]}>
      <View style={s.serviceBody}>
        <Text style={s.serviceName} numberOfLines={2}>
          {service.name}
        </Text>
        {service.durationMinutes ? (
          <Text style={s.serviceMeta}>{formatDuration(service.durationMinutes)}</Text>
        ) : null}
      </View>
      {service.priceAmount != null ? (
        <Text style={s.servicePrice}>{formatMoney(service.priceAmount, currency)}</Text>
      ) : null}
    </View>
  );
}

function ColourFormulaCard({ formula, currency }: { formula: ClientVisitColourFormula; currency: string }) {
  return (
    <View style={s.card}>
      {formula.savedAt ? <Text style={s.formulaDate}>{formatDate(formula.savedAt)}</Text> : null}
      {formula.items.length === 0 ? (
        <Text style={s.mutedSm}>No product details recorded.</Text>
      ) : (
        formula.items.map((item, idx) => (
          <View key={`${formula.id}-${idx}`} style={[s.colourRow, idx === formula.items.length - 1 && s.rowLast]}>
            <View style={s.colourBody}>
              <Text style={s.colourName} numberOfLines={1}>
                {[item.brand, item.shade].filter(Boolean).join(' ') || item.productName}
              </Text>
              <Text style={s.colourDetail} numberOfLines={1}>
                {[
                  item.developer,
                  item.ratio,
                  item.processingTimeMinutes != null ? `${item.processingTimeMinutes} min` : null,
                  item.grams != null ? `${formatGrams(item.grams)} used` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || item.productName}
              </Text>
            </View>
            {item.priceAmount != null ? (
              <Text style={s.colourPrice}>{formatMoney(item.priceAmount, currency)}</Text>
            ) : null}
          </View>
        ))
      )}
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
      <Text style={s.detailLabel}>{label}</Text>
      <Text style={[s.detailValue, accent && s.detailValueAccent]}>{value}</Text>
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function visitTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'completed' || status === 'paid') return 'success';
  if (status === 'cancelled' || status === 'no_show') return 'warning';
  return 'neutral';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

function formatStatus(value: string): string {
  return value.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function formatGrams(grams: number): string {
  return `${Number.isInteger(grams) ? grams : grams.toFixed(1)} g`;
}

function formatPaymentMethod(method: string): string {
  if (method === 'card_reader') return 'Card';
  if (method === 'cash') return 'Cash';
  return formatStatus(method);
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BORDER_MED = 'rgba(255,255,255,0.11)';

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
    borderColor: BORDER_MED,
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

  // ── Scroll
  scroll: { padding: spacing.base, gap: spacing.lg, paddingBottom: spacing['4xl'] },

  // ── Summary
  summaryCard: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_MED,
    padding: spacing.base,
    gap: spacing.sm,
  },
  summaryTitleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  summaryTitle: { flex: 1, color: palette.white, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  summaryMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  summaryMetaText: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600' },

  // ── Section
  section: { gap: spacing.sm },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 22 },
  sectionLabel: { color: 'rgba(255,255,255,0.32)', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  countPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(166,124,245,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(230,160,141,0.4)',
  },
  countPillText: { color: BRAND_LIGHT, fontSize: 11, fontWeight: '800' },

  // ── Cards / rows
  card: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_MED,
    padding: spacing.base,
    gap: spacing.sm,
  },
  rowLast: { borderBottomWidth: 0, paddingBottom: 0 },

  serviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
  },
  serviceBody: { flex: 1, gap: 2 },
  serviceName: { color: palette.white, fontSize: 14, fontWeight: '700' },
  serviceMeta: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  servicePrice: { color: BRAND_LIGHT, fontSize: 14, fontWeight: '800' },

  formulaDate: { color: 'rgba(255,255,255,0.45)', fontSize: 12, fontWeight: '600' },
  colourRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
  },
  colourBody: { flex: 1, gap: 2 },
  colourName: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '700' },
  colourDetail: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '600' },
  colourPrice: { color: palette.white, fontSize: 13, fontWeight: '800' },

  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
  },
  detailLabel: { color: 'rgba(255,255,255,0.48)', fontSize: 13 },
  detailValue: { color: 'rgba(255,255,255,0.82)', fontSize: 14, fontWeight: '700' },
  detailValueAccent: { color: BRAND_LIGHT, fontWeight: '800' },

  mutedSm: { color: 'rgba(255,255,255,0.38)', fontSize: 13 },
  taxNote: { color: 'rgba(255,255,255,0.32)', fontSize: 11, textAlign: 'center' },
});
