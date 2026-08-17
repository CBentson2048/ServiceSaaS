import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { userHasPermission, userHasRole } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { StylistTabBar } from '../src/navigation/StylistTabBar';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { ApiError, SessionExpiredError } from '../src/auth/api';
import type { ZacAskResponse } from '../src/auth/api';

const BUSINESS_STARTERS = [
  'What can you help me with?',
  'How is my business doing?',
  'Which locations can you see?',
  'What business context do you have?',
  'Members of my business?',
  'Which tools are connected?',
];

// The last two deliberately exercise the unavailable-safe and restricted paths,
// so a stylist sees ZAC being honest about its boundaries.
const STYLIST_STARTERS = [
  'What can you help me with?',
  'What should I focus on today?',
  'How can I improve this week?',
  'What information can you access for my role?',
  'Can you show my appointments today?',
  'Can you show business revenue?',
];

/** Friendly labels for evidence sources — users should never read code names. */
const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  'report.dashboard': 'Dashboard KPIs',
  'kpi.engine': 'KPI engine',
  'kpi.personal': 'Your own KPI snapshot',
  'booking.schedule': 'Your own diary',
  'auth.context': 'Your signed-in access scope',
  'zac.registry': 'Connected capability check',
  'zac.intent': 'Question understanding',
  'zac.foundation': 'ZAC foundation',
  'zac.access_boundary': 'Your role’s access level',
};

const RESPONSE_TYPE_BADGES: Record<string, { label: string; color: string }> = {
  Insight: { label: 'Insight', color: palette.success[300] },
  'Coaching Point': { label: 'Coaching point', color: palette.brand[300] },
  Opportunity: { label: 'Opportunity', color: palette.success[300] },
  Risk: { label: 'Risk', color: palette.danger[300] },
  'Watch Point': { label: 'Watch point', color: palette.warning[300] },
  Explanation: { label: 'Explanation', color: palette.brand[300] },
  'Refusal / Insufficient Data': { label: 'Data not connected yet', color: palette.warning[300] },
};

interface AskError {
  kind: 'notice' | 'error';
  text: string;
}

export default function ZacScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const hasZacAccess = userHasPermission(auth.user, 'zac.access');
  const isStylist = userHasRole(auth.user, 'stylist');
  const starters = isStylist ? STYLIST_STARTERS : BUSINESS_STARTERS;

  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AskError | null>(null);
  const [response, setResponse] = useState<ZacAskResponse | null>(null);
  const [askedQuestion, setAskedQuestion] = useState<string | null>(null);
  const [devOpen, setDevOpen] = useState(false);
  // Backend conversation for this screen session (matches the web contract).
  // A ref, read inside the ask callback without re-creating it; in-memory only,
  // so it can never leak to another signed-in account.
  const conversationRef = useRef<string | null>(null);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !accessToken || loading) return;

      setLoading(true);
      setError(null);
      setDevOpen(false);
      const sentConversationId = conversationRef.current;
      try {
        const result = await api.askZac(accessToken, {
          question: trimmed,
          conversationId: sentConversationId ?? undefined,
        });
        conversationRef.current = result.conversation_id ?? conversationRef.current;
        setResponse(result);
        setAskedQuestion(trimmed);
        setQuestion('');
      } catch (err) {
        setResponse(null);
        setAskedQuestion(null);
        // A 404 while continuing a thread means THIS conversation is gone —
        // drop the id so the next ask starts fresh instead of dead-ending on
        // the rollout copy forever.
        if (sentConversationId && err instanceof ApiError && err.status === 404) {
          conversationRef.current = null;
          setError({
            kind: 'notice',
            text: "That conversation is no longer available, so I've started a fresh one — please ask again.",
          });
        } else {
          setError(friendlyError(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [accessToken, loading],
  );

  const startNewConversation = useCallback(() => {
    conversationRef.current = null;
    setResponse(null);
    setAskedQuestion(null);
    setError(null);
    setDevOpen(false);
  }, []);

  const badge = response ? RESPONSE_TYPE_BADGES[response.response_type] : undefined;
  const followUp = response?.suggested_next_step
    ? extractQuotedQuestion(response.suggested_next_step)
    : null;

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        {/* ── Header ── */}
        <View style={s.topBar}>
          {/* Stylists arrive via the tab bar (flat stack, no history); owners
              and managers push in from the dashboard and get a back button. */}
          {!isStylist ? (
            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [s.backBtn, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Ionicons name="chevron-back" size={22} color={palette.white} />
            </Pressable>
          ) : null}
          <View style={s.avatar}>
            <Ionicons name="sparkles" size={20} color={palette.white} />
          </View>
          <View style={s.topBarInfo}>
            <View style={s.titleRow}>
              <Text style={s.title}>ZAC</Text>
            </View>
            <Text style={s.subtitle}>
              {isStylist ? 'AI assistant for QLOOQO' : 'AI business assistant for QLOOQO'}
            </Text>
          </View>
          {response || error ? (
            <Pressable
              onPress={startNewConversation}
              disabled={loading}
              style={({ pressed }) => [s.newChatBtn, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Start a new conversation"
            >
              <Text style={s.newChatLabel}>New chat</Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          style={s.scrollView}
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {!hasZacAccess ? (
            <View style={s.noticeCard}>
              <Text style={s.noticeTitle}>ZAC is not enabled for your role yet</Text>
              <Text style={s.noticeBody}>
                Ask the business owner to grant ZAC access on your security level.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.intro}>
                {isStylist
                  ? 'Ask about your own workday, coaching and improvement. ZAC answers only from read-only data allowed for your role — and says plainly when something is not connected or outside your access level.'
                  : 'Ask anything about your business. ZAC answers only from connected read-only data sources — and says plainly when something is not connected yet.'}
              </Text>

              {/* ── Composer ── */}
              <View style={s.card}>
                <Text style={s.fieldLabel}>ASK A QUESTION</Text>
                <TextInput
                  value={question}
                  onChangeText={setQuestion}
                  placeholder="e.g. How is my business doing?"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  multiline
                  maxLength={2000}
                  editable={!loading}
                  style={s.input}
                  accessibilityLabel="Your question for ZAC"
                />
                <Pressable
                  onPress={() => void ask(question)}
                  disabled={!question.trim() || loading}
                  style={({ pressed }) => [
                    s.askBtn,
                    (!question.trim() || loading) && s.askBtnDisabled,
                    pressed && s.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Ask ZAC"
                >
                  {loading ? (
                    <ActivityIndicator color={palette.white} size="small" />
                  ) : (
                    <Ionicons name="sparkles" size={15} color={palette.white} />
                  )}
                  <Text style={s.askBtnText}>{loading ? 'Asking…' : 'Ask ZAC'}</Text>
                </Pressable>

                <View style={s.divider} />
                <Text style={s.fieldLabel}>TRY ASKING</Text>
                <View style={s.chipWrap}>
                  {starters.map((starter) => (
                    <Pressable
                      key={starter}
                      onPress={() => void ask(starter)}
                      disabled={loading}
                      style={({ pressed }) => [s.chip, pressed && s.chipPressed]}
                      accessibilityRole="button"
                    >
                      <Text style={s.chipText}>{starter}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* ── States ── */}
              {error ? (
                <View style={error.kind === 'error' ? s.errorCard : s.noticeCard}>
                  <Text style={error.kind === 'error' ? s.errorText : s.noticeBody}>
                    {error.text}
                  </Text>
                </View>
              ) : null}

              {loading ? (
                <View style={s.loadingCard}>
                  <ActivityIndicator color={palette.brand[300]} size="small" />
                  <Text style={s.loadingText}>ZAC is thinking…</Text>
                </View>
              ) : null}

              {!loading && !response && !error ? (
                <View style={[s.card, s.emptyCard]}>
                  <View style={s.emptyAvatar}>
                    <Ionicons name="sparkles" size={26} color={palette.white} />
                  </View>
                  <Text style={s.emptyTitle}>Ready when you are</Text>
                  <Text style={s.emptyBody}>
                    Ask a question above, or tap a suggestion to see what ZAC can already tell you
                    about your business.
                  </Text>
                </View>
              ) : null}

              {/* ── Answer ── */}
              {response && !loading ? (
                <View style={s.card}>
                  {askedQuestion ? (
                    <View style={s.askedBlock}>
                      <Text style={s.askedLabel}>YOU ASKED</Text>
                      <Text style={s.askedText}>{askedQuestion}</Text>
                    </View>
                  ) : null}

                  <View style={s.answerHeader}>
                    <View style={s.miniAvatar}>
                      <Ionicons name="sparkles" size={13} color={palette.white} />
                    </View>
                    <Text style={s.answerAuthor}>ZAC</Text>
                    {badge ? <Badge label={badge.label} color={badge.color} /> : null}
                    <Badge label={`Confidence: ${response.confidence}`} color="rgba(255,255,255,0.55)" />
                  </View>

                  <Text style={s.answerText}>{response.answer}</Text>

                  {response.suggested_next_step ? (
                    <View style={s.nextStep}>
                      <Text style={s.nextStepLabel}>NEXT USEFUL STEP</Text>
                      <Text style={s.nextStepText}>{response.suggested_next_step}</Text>
                      {followUp ? (
                        <Pressable
                          onPress={() => void ask(followUp)}
                          disabled={loading}
                          style={({ pressed }) => [s.followUpBtn, pressed && s.pressed]}
                          accessibilityRole="button"
                        >
                          <Text style={s.followUpBtnText}>Ask this</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}

                  {response.evidence.length > 0 ? (
                    <View style={s.section}>
                      <Text style={s.sectionLabel}>WHERE THIS COMES FROM</Text>
                      {response.evidence.map((item, index) => (
                        <View key={index} style={s.evidenceRow}>
                          <Ionicons
                            name="checkmark-circle-outline"
                            size={15}
                            color={palette.brand[300]}
                            style={s.evidenceIcon}
                          />
                          <Text style={s.secondaryText}>
                            {EVIDENCE_SOURCE_LABELS[item.source_type] ?? item.source_type}
                            {item.as_of ? ` · data up to ${formatDate(item.as_of)}` : ''}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  {response.limitations.length > 0 ? (
                    <View style={s.section}>
                      <Text style={s.sectionLabel}>GOOD TO KNOW</Text>
                      {response.limitations.map((limitation, index) => (
                        <View key={index} style={s.evidenceRow}>
                          <View style={s.bulletDot} />
                          <Text style={s.secondaryText}>{limitation}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}

                  {/* ── Developer details (collapsed) ── */}
                  <Pressable
                    onPress={() => setDevOpen((open) => !open)}
                    style={({ pressed }) => [s.devToggle, pressed && s.pressed]}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: devOpen }}
                  >
                    <Text style={s.devToggleText}>Developer details</Text>
                    <Ionicons
                      name={devOpen ? 'chevron-up' : 'chevron-down'}
                      size={14}
                      color="rgba(255,255,255,0.55)"
                    />
                  </Pressable>
                  {devOpen ? (
                    <View style={s.devBody}>
                      <Text style={s.devLine}>
                        Connected: {response.technical_details.connected_tools.join(', ') || 'none'}
                      </Text>
                      <Text style={s.devLine}>
                        Planned: {response.technical_details.disabled_tools.join(', ') || 'none'}
                      </Text>
                      <Text style={s.devLine}>
                        Provider: {response.technical_details.provider} · Model:{' '}
                        {response.technical_details.model}
                      </Text>
                      <Text style={s.devLine}>Trace: {response.trace_id}</Text>
                      <Text style={s.devJson} numberOfLines={40}>
                        {JSON.stringify(response, null, 2)}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </ScrollView>

        {isStylist ? <StylistTabBar /> : null}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[s.badge, { borderColor: withAlpha(color, 0.4), backgroundColor: withAlpha(color, 0.12) }]}>
      <Text style={[s.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function friendlyError(err: unknown): AskError {
  if (err instanceof SessionExpiredError) {
    // The global handler is already redirecting to /login.
    return { kind: 'notice', text: err.message };
  }
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return {
        kind: 'notice',
        text: 'ZAC is not switched on for this business yet. It is being rolled out gradually — check back soon.',
      };
    }
    if (err.status === 403) {
      return {
        kind: 'notice',
        text: 'ZAC is not enabled for your role yet. Ask the business owner to grant ZAC access on your security level.',
      };
    }
    return { kind: 'error', text: err.message };
  }
  return { kind: 'error', text: 'Something went wrong talking to ZAC. Please try again.' };
}

/** First double-quoted question inside the next-step copy, offered as a one-tap follow-up. */
function extractQuotedQuestion(text: string): string | null {
  const match = text.match(/"([^"]{4,120}\?)"/);
  return match ? match[1] : null;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const BG = palette.ink[950];
const CARD = palette.ink[700];
const BORDER = 'rgba(255,255,255,0.13)';
const BORDER_SOFT = 'rgba(255,255,255,0.08)';
const BRAND = palette.brand[500];
const MONO = Platform.select({ ios: 'Courier', default: 'monospace' });

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.74 },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.base,
    paddingBottom: spacing.sm,
  },
  backBtn: { padding: spacing.xs, marginLeft: -spacing.xs },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topBarInfo: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { color: palette.white, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  foundationBadge: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  foundationBadgeText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  subtitle: { color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: '500', marginTop: 1 },
  newChatBtn: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  newChatLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' },

  scrollView: { flex: 1 },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing['4xl'], gap: spacing.base },
  intro: { color: 'rgba(255,255,255,0.55)', fontSize: 13, lineHeight: 18 },

  card: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  fieldLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  input: {
    minHeight: 88,
    borderRadius: radius.inputLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: palette.ink[900],
    color: palette.white,
    fontSize: 14,
    lineHeight: 20,
    padding: spacing.md,
    textAlignVertical: 'top',
  },
  askBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderRadius: radius.pill,
    backgroundColor: BRAND,
  },
  askBtnDisabled: { opacity: 0.5 },
  askBtnText: { color: palette.white, fontSize: 15, fontWeight: '700' },
  divider: { height: 1, backgroundColor: BORDER_SOFT },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: BORDER,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  chipPressed: { borderColor: BRAND, backgroundColor: withAlpha(BRAND, 0.14) },
  chipText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '500' },

  noticeCard: {
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
  },
  noticeTitle: { color: palette.white, fontSize: 14, fontWeight: '700' },
  noticeBody: { color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 18 },
  errorCard: {
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: withAlpha(palette.danger[300], 0.3),
    backgroundColor: withAlpha(palette.danger[300], 0.08),
  },
  errorText: { color: palette.danger[300], fontSize: 13, lineHeight: 18 },
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

  emptyCard: { alignItems: 'center', paddingVertical: spacing['2xl'] },
  emptyAvatar: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { color: palette.white, fontSize: 15, fontWeight: '700' },
  emptyBody: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    maxWidth: 280,
  },

  askedBlock: {
    borderRadius: radius.inputLg,
    backgroundColor: palette.ink[900],
    padding: spacing.md,
    gap: 2,
  },
  askedLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  askedText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 18 },
  answerHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  miniAvatar: {
    width: 26,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  answerAuthor: { color: palette.white, fontSize: 13, fontWeight: '700' },
  badge: {
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 10, fontWeight: '600' },
  answerText: { color: 'rgba(255,255,255,0.92)', fontSize: 14, lineHeight: 21 },

  nextStep: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.inputLg,
    borderWidth: 1,
    borderColor: withAlpha(BRAND, 0.35),
    backgroundColor: withAlpha(BRAND, 0.1),
  },
  nextStepLabel: { color: palette.brand[300], fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  nextStepText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 18 },
  followUpBtn: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: palette.brand[300],
    paddingHorizontal: spacing.base,
    paddingVertical: 6,
  },
  followUpBtnText: { color: palette.brand[300], fontSize: 12, fontWeight: '700' },

  section: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: BORDER_SOFT, paddingTop: spacing.md },
  sectionLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  evidenceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  evidenceIcon: { marginTop: 2 },
  bulletDot: {
    width: 4,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.35)',
    marginTop: 7,
  },
  secondaryText: { flex: 1, color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 18 },

  devToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: BORDER_SOFT,
    paddingTop: spacing.md,
  },
  devToggleText: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '600' },
  devBody: { gap: spacing.xs },
  devLine: { color: 'rgba(255,255,255,0.5)', fontSize: 12, lineHeight: 17 },
  devJson: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    lineHeight: 14,
    fontFamily: MONO,
    backgroundColor: palette.ink[900],
    borderRadius: radius.input,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
});
