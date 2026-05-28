import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { CrmVisitSummary } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../../src/auth/ProtectedScreen';
import { useAuth } from '../../src/auth/AuthProvider';
import * as api from '../../src/auth/api';

const PAGE_SIZE = 10;

export default function VisitHistoryScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';

  const [allVisits, setAllVisits] = useState<CrmVisitSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      // Re-use dashboard endpoint: visitHistory is the full list for client role
      const result = await api.getMobileDashboard(accessToken, 'client');
      if (result.role === 'client') {
        setAllVisits(result.visitHistory);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load visit history');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { void load(); }, [load]);

  // Reset to page 1 whenever search changes
  useEffect(() => { setPage(1); }, [search]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return allVisits;
    return allVisits.filter((v) => {
      const hay = [
        v.serviceSummary ?? '',
        v.clientVisibleSummary ?? '',
        v.stylistName ?? '',
        v.status,
        formatDate(v.occurredAt),
      ].join(' ').toLowerCase();
      return hay.includes(term);
    });
  }, [allVisits, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>

        {/* ── Header ── */}
        <View style={s.header}>
          <Pressable
            style={({ pressed }) => [s.backBtn, pressed && s.pressed]}
            onPress={() => router.back()}
          >
            <Text style={s.backArrow}>‹</Text>
            <Text style={s.backLabel}>Dashboard</Text>
          </Pressable>
          <Text style={s.headerTitle}>Visit History</Text>
          <View style={s.headerSpacer} />
        </View>

        {/* ── Search bar ── */}
        <View style={s.searchWrap}>
          <Text style={s.searchIcon}>⌕</Text>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by service, stylist, date…"
            placeholderTextColor="rgba(255,255,255,0.28)"
            style={[s.searchInput, searchFocused && s.searchInputFocused]}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch('')} style={s.clearBtn}>
              <Text style={s.clearBtnText}>✕</Text>
            </Pressable>
          ) : null}
        </View>

        {/* ── Stats bar ── */}
        {!loading && !error ? (
          <View style={s.statsBar}>
            <Text style={s.statsText}>
              {filtered.length === allVisits.length
                ? `${allVisits.length} visit${allVisits.length === 1 ? '' : 's'} total`
                : `${filtered.length} of ${allVisits.length} visits`}
            </Text>
            {totalPages > 1 ? (
              <Text style={s.statsText}>
                Page {page} of {totalPages}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* ── List ── */}
        {loading ? (
          <View style={s.loadingCard}>
            <ActivityIndicator color={palette.brand[300]} size="small" />
            <Text style={s.loadingText}>Loading visit history…</Text>
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
        ) : (
          <ScrollView
            contentContainerStyle={s.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {paginated.length === 0 ? (
              <View style={s.emptyCard}>
                <Text style={s.emptyTitle}>
                  {search ? 'No visits match your search' : 'No visit history yet'}
                </Text>
                <Text style={s.emptyBody}>
                  {search
                    ? 'Try a different keyword or clear the search.'
                    : 'Completed visits will appear here after your appointments.'}
                </Text>
                {search ? (
                  <Pressable
                    onPress={() => setSearch('')}
                    style={({ pressed }) => [s.clearSearchBtn, pressed && s.pressed]}
                  >
                    <Text style={s.clearSearchBtnText}>Clear search</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <View style={s.list}>
                {paginated.map((visit, idx) => (
                  <VisitCard
                    key={visit.id}
                    visit={visit}
                    index={(page - 1) * PAGE_SIZE + idx + 1}
                    isLast={idx === paginated.length - 1}
                  />
                ))}
              </View>
            )}

            {/* ── Pagination ── */}
            {totalPages > 1 ? (
              <View style={s.pagination}>
                <Pressable
                  onPress={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  style={({ pressed }) => [s.pageBtn, page === 1 && s.pageBtnDisabled, pressed && s.pressed]}
                >
                  <Text style={[s.pageBtnText, page === 1 && s.pageBtnTextDisabled]}>‹ Prev</Text>
                </Pressable>

                <View style={s.pageNumbers}>
                  {buildPageNumbers(page, totalPages).map((item, i) =>
                    item === '…' ? (
                      <Text key={`ellipsis-${i}`} style={s.pageDots}>…</Text>
                    ) : (
                      <Pressable
                        key={item}
                        onPress={() => setPage(item as number)}
                        style={[s.pageNum, page === item && s.pageNumActive]}
                      >
                        <Text style={[s.pageNumText, page === item && s.pageNumTextActive]}>
                          {item}
                        </Text>
                      </Pressable>
                    ),
                  )}
                </View>

                <Pressable
                  onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  style={({ pressed }) => [s.pageBtn, page === totalPages && s.pageBtnDisabled, pressed && s.pressed]}
                >
                  <Text style={[s.pageBtnText, page === totalPages && s.pageBtnTextDisabled]}>Next ›</Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        )}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Visit card ────────────────────────────────────────────────────────────────

function VisitCard({
  visit,
  index,
  isLast,
}: {
  visit: CrmVisitSummary;
  index: number;
  isLast: boolean;
}) {
  const tone = visitTone(visit.status);
  return (
    <View style={[s.visitCard, isLast && s.visitCardLast]}>
      {/* Left accent bar */}
      <View style={[s.visitAccent, tone === 'success' ? s.accentGreen : tone === 'warning' ? s.accentAmber : s.accentGray]} />

      <View style={s.visitBody}>
        {/* Title row */}
        <View style={s.visitTitleRow}>
          <Text style={s.visitTitle} numberOfLines={1}>
            {visit.serviceSummary ?? visit.clientVisibleSummary ?? 'Visit'}
          </Text>
          <View style={[s.visitStatusPill, tone === 'success' ? s.statusGreen : tone === 'warning' ? s.statusAmber : s.statusGray]}>
            <Text style={[s.visitStatusText, tone === 'success' ? s.statusTextGreen : tone === 'warning' ? s.statusTextAmber : s.statusTextGray]}>
              {formatStatus(visit.status)}
            </Text>
          </View>
        </View>

        {/* Meta row */}
        <View style={s.visitMeta}>
          <Text style={s.visitMetaText}>{formatDate(visit.occurredAt)}</Text>
          {visit.stylistName ? (
            <>
              <View style={s.visitMetaDot} />
              <Text style={s.visitMetaText}>with {visit.stylistName}</Text>
            </>
          ) : null}
          {visit.priceAmount != null ? (
            <>
              <View style={s.visitMetaDot} />
              <Text style={s.visitMetaPrice}>
                {formatMoney(visit.priceAmount, visit.currencyCode ?? 'GBP')}
              </Text>
            </>
          ) : null}
        </View>

        {/* Rebooking badge */}
        {visit.rebooked ? (
          <View style={s.rebookedBadge}>
            <Text style={s.rebookedText}>✓ Rebooked</Text>
          </View>
        ) : null}
      </View>

      <Text style={s.visitChevron}>›</Text>
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
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatStatus(value: string): string {
  return value.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function buildPageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  if (current > 3) pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) {
    pages.push(p);
  }
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BG = '#18141F';
const CARD = '#211A2E';
const BORDER = 'rgba(255,255,255,0.08)';
const BORDER2 = 'rgba(255,255,255,0.13)';
const BRAND = palette.brand[500];
const BRAND_LIGHT = palette.brand[300];

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER2,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 90 },
  backArrow: { color: BRAND_LIGHT, fontSize: 28, lineHeight: 30, fontWeight: '300', marginTop: -2 },
  backLabel: { color: BRAND_LIGHT, fontSize: 15, fontWeight: '600' },
  headerTitle: { color: palette.white, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  headerSpacer: { minWidth: 90 },

  // ── Search
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.base,
    marginTop: spacing.base,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER2,
    backgroundColor: CARD,
    gap: spacing.sm,
  },
  searchIcon: { color: 'rgba(255,255,255,0.35)', fontSize: 18 },
  searchInput: {
    flex: 1,
    color: palette.white,
    fontSize: 14,
    fontWeight: '500',
    paddingVertical: spacing.md,
  },
  searchInputFocused: { color: palette.white },
  clearBtn: { padding: spacing.xs },
  clearBtnText: { color: 'rgba(255,255,255,0.35)', fontSize: 14 },

  // ── Stats bar
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  statsText: { color: 'rgba(255,255,255,0.35)', fontSize: 11, fontWeight: '600' },

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
    borderColor: BORDER2,
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

  // ── Scroll / list
  scroll: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing['4xl'],
    gap: spacing.base,
  },
  list: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER2,
    overflow: 'hidden',
  },

  // ── Empty
  emptyCard: {
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
    alignItems: 'center',
  },
  emptyTitle: { color: palette.white, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  emptyBody: { color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  clearSearchBtn: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.3)',
    backgroundColor: 'rgba(166,124,245,0.1)',
  },
  clearSearchBtnText: { color: BRAND_LIGHT, fontSize: 13, fontWeight: '700' },

  // ── Visit card
  visitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER2,
  },
  visitCardLast: { borderBottomWidth: 0 },
  visitAccent: { width: 3, alignSelf: 'stretch' },
  accentGreen: { backgroundColor: palette.success[300] },
  accentAmber: { backgroundColor: palette.warning[300] },
  accentGray: { backgroundColor: 'rgba(255,255,255,0.18)' },
  visitBody: { flex: 1, paddingHorizontal: spacing.base, paddingVertical: spacing.md, gap: 5 },
  visitTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  visitTitle: { flex: 1, color: palette.white, fontSize: 14, fontWeight: '700' },
  visitStatusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  statusGreen: {
    backgroundColor: 'rgba(74,222,128,0.12)',
    borderColor: 'rgba(74,222,128,0.3)',
  },
  statusAmber: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.3)',
  },
  statusGray: {
    backgroundColor: 'rgba(148,163,184,0.12)',
    borderColor: 'rgba(148,163,184,0.25)',
  },
  visitStatusText: { fontSize: 10, fontWeight: '700' },
  statusTextGreen: { color: palette.success[300] },
  statusTextAmber: { color: palette.warning[300] },
  statusTextGray: { color: 'rgba(255,255,255,0.45)' },
  visitMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  visitMetaText: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  visitMetaDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.2)' },
  visitMetaPrice: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700' },
  rebookedBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(74,222,128,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.25)',
    marginTop: 2,
  },
  rebookedText: { color: palette.success[300], fontSize: 10, fontWeight: '700' },
  visitChevron: {
    color: 'rgba(255,255,255,0.22)',
    fontSize: 20,
    paddingRight: spacing.md,
  },

  // ── Pagination
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.sm,
  },
  pageBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: BORDER2,
    backgroundColor: CARD,
  },
  pageBtnDisabled: { opacity: 0.3 },
  pageBtnText: { color: BRAND_LIGHT, fontSize: 13, fontWeight: '700' },
  pageBtnTextDisabled: { color: 'rgba(255,255,255,0.3)' },
  pageNumbers: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  pageNum: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pageNumActive: {
    backgroundColor: BRAND,
    borderColor: BRAND,
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.45,
    shadowRadius: 6,
    elevation: 3,
  },
  pageNumText: { color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: '700' },
  pageNumTextActive: { color: palette.white },
  pageDots: { color: 'rgba(255,255,255,0.3)', fontSize: 14, paddingHorizontal: 2 },
});
