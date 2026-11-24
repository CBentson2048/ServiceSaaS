import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type {
  ClientLabFormulaSummary,
  CrmVisitSummary,
  CustomerSalonDetailResponse,
} from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { ScreenHeader } from '../src/navigation/ScreenHeader';
import { BG, BORDER_SUBTLE, BRAND_LIGHT, CARD } from '../src/design/colors';

export default function SalonDetailScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { clientProfileId } = useLocalSearchParams<{ clientProfileId?: string }>();

  const [detail, setDetail] = useState<CustomerSalonDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !clientProfileId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMySalonDetail(accessToken, clientProfileId);
      setDetail(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load salon');
    } finally {
      setLoading(false);
    }
  }, [accessToken, clientProfileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const salon = detail?.salon;
  const locationLine = salon
    ? [salon.locationName, salon.city].filter(Boolean).join(' · ')
    : '';

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist', 'client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <ScreenHeader title="Salon" backLabel="Profile" />

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {loading ? (
            <View style={s.stateCard}>
              <ActivityIndicator color={palette.brand[300]} size="small" />
              <Text style={s.mutedSm}>Loading salon…</Text>
            </View>
          ) : error ? (
            <View style={s.errorCard}>
              <Text style={s.errorTitle}>Salon unavailable</Text>
              <Text style={s.errorBody}>{error}</Text>
              <Pressable onPress={() => void load()} style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}>
                <Text style={s.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : salon && detail ? (
            <>
              {/* ── Salon hero ── */}
              <View style={s.heroCard}>
                <Text style={s.salonName}>{salon.businessName}</Text>
                {locationLine ? <Text style={s.salonLocation}>{locationLine}</Text> : null}

                <View style={s.codeChip}>
                  <Text style={s.codeChipLabel}>YOUR CLIENT CODE</Text>
                  <Text style={s.codeChipValue}>{salon.clientCode}</Text>
                </View>

                <View style={s.statRow}>
                  <Stat label="Visits" value={String(salon.visitCount)} />
                  <Stat label="Last visit" value={salon.lastVisitAt ? formatDate(salon.lastVisitAt) : '—'} />
                  <Stat label="Contact" value={prefLabel(salon.communicationPreference)} />
                </View>
              </View>

              {/* ── Visits ── */}
              <Text style={s.sectionLabel}>VISITS</Text>
              {detail.visits.length === 0 ? (
                <Empty text="No visits recorded at this salon yet." />
              ) : (
                <View style={s.list}>
                  {detail.visits.map((visit, idx) => (
                    <VisitRow key={visit.id} visit={visit} isLast={idx === detail.visits.length - 1} />
                  ))}
                </View>
              )}

              {/* ── Colour formulas ── */}
              <Text style={s.sectionLabel}>COLOUR FORMULAS</Text>
              {detail.formulas.length === 0 ? (
                <Empty text="No colour records at this salon yet." />
              ) : (
                <View style={s.labList}>
                  {detail.formulas.map((formula) => (
                    <FormulaCard key={formula.id} formula={formula} />
                  ))}
                </View>
              )}
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <View style={s.emptyCard}>
      <Text style={s.mutedSm}>{text}</Text>
    </View>
  );
}

function VisitRow({ visit, isLast }: { visit: CrmVisitSummary; isLast: boolean }) {
  const tone = visitTone(visit.status);
  return (
    <Pressable
      onPress={() => router.push(`/client/visit-detail?id=${encodeURIComponent(visit.id)}`)}
      style={({ pressed }) => [s.recordRow, isLast && s.recordRowLast, pressed && s.pressed]}
    >
      <View
        style={[
          s.recordAccent,
          tone === 'success' ? s.accentGreen : tone === 'warning' ? s.accentAmber : s.accentGray,
        ]}
      />
      <View style={s.recordBody}>
        <Text style={s.recordTitle} numberOfLines={1}>
          {visit.serviceSummary ?? visit.clientVisibleSummary ?? 'Visit'}
        </Text>
        <View style={s.recordMeta}>
          <Text style={s.recordMetaText}>{formatDateTime(visit.occurredAt)}</Text>
          {visit.stylistName ? (
            <>
              <View style={s.recordMetaDot} />
              <Text style={s.recordMetaText}>with {visit.stylistName}</Text>
            </>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.28)" />
    </Pressable>
  );
}

function FormulaCard({ formula }: { formula: ClientLabFormulaSummary }) {
  return (
    <View style={s.labCard}>
      <View style={s.labCardHeader}>
        <Text style={s.labCardTitle}>{formula.serviceType ?? 'Colour formula'}</Text>
        <Text style={s.labCardDate}>{formatDate(formula.savedAt)}</Text>
      </View>
      {formula.items.length === 0 ? (
        <Text style={s.mutedSm}>No product details recorded.</Text>
      ) : (
        formula.items.map((item, idx) => (
          <View
            key={`${formula.id}-${idx}`}
            style={[s.labItemRow, idx === formula.items.length - 1 && s.labItemRowLast]}
          >
            <Text style={s.labItemName} numberOfLines={1}>
              {[item.brand, item.shade].filter(Boolean).join(' ') || item.productName}
            </Text>
            <Text style={s.labItemDetail} numberOfLines={1}>
              {[
                item.developer,
                item.ratio,
                item.processingTimeMinutes != null ? `${item.processingTimeMinutes} min` : null,
              ]
                .filter(Boolean)
                .join(' · ') || item.productName}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prefLabel(pref?: string): string {
  if (pref === 'whatsapp') return 'WhatsApp';
  if (pref === 'sms') return 'SMS';
  if (pref === 'email') return 'Email';
  return '—';
}

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

// ── Styles ────────────────────────────────────────────────────────────────────

const BORDER_MED = 'rgba(255,255,255,0.11)';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.74 },
  mutedSm: { color: 'rgba(255,255,255,0.5)', fontSize: 13 },


  scroll: { paddingHorizontal: spacing.base, paddingBottom: spacing['4xl'], gap: spacing.base },

  stateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_MED,
  },
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
  retryText: { color: palette.danger[300], fontSize: 12, fontWeight: '700' },

  // Salon hero
  heroCard: {
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: 'rgba(230,160,141,0.28)',
    gap: spacing.sm,
  },
  salonName: { color: palette.white, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  salonLocation: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  codeChip: {
    marginTop: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: BORDER_MED,
  },
  codeChipLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  codeChipValue: { color: BRAND_LIGHT, fontSize: 18, fontWeight: '800', letterSpacing: 0.5, marginTop: 2 },
  statRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  stat: {
    flex: 1,
    gap: 3,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: 'rgba(24,20,31,0.5)',
  },
  statValue: { color: palette.white, fontSize: 15, fontWeight: '800' },
  statLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: '700' },

  sectionLabel: {
    color: 'rgba(255,255,255,0.32)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginTop: spacing.xs,
  },
  emptyCard: {
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    alignItems: 'center',
  },

  // Visit rows
  list: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_MED,
    overflow: 'hidden',
  },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingRight: spacing.base,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_MED,
  },
  recordRowLast: { borderBottomWidth: 0 },
  recordAccent: { width: 3, alignSelf: 'stretch', marginRight: spacing.md, borderRadius: 2 },
  accentGreen: { backgroundColor: palette.success[300] },
  accentAmber: { backgroundColor: palette.warning[300] },
  accentGray: { backgroundColor: 'rgba(148,163,184,0.6)' },
  recordBody: { flex: 1, gap: 3 },
  recordTitle: { color: palette.white, fontSize: 14, fontWeight: '700' },
  recordMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recordMetaText: { color: 'rgba(255,255,255,0.48)', fontSize: 12 },
  recordMetaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' },

  // Formula cards
  labList: { gap: spacing.sm },
  labCard: {
    padding: spacing.base,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER_MED,
    gap: spacing.xs,
  },
  labCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  labCardTitle: { color: palette.white, fontSize: 14, fontWeight: '800' },
  labCardDate: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  labItemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
  },
  labItemRowLast: {},
  labItemName: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  labItemDetail: { color: 'rgba(255,255,255,0.5)', fontSize: 12, flexShrink: 1, textAlign: 'right' },
});
