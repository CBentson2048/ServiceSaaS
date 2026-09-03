import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { userHasPermission } from '@sheer/domain';
import { StatusBadge } from '../../design';
import { useAuth } from '../../auth/AuthProvider';
import { ApiRequestError, askZac, submitZacFeedback } from '../../auth/api';
import type { ZacAskResponse } from '../../auth/api';
import {
  ZAC_EVIDENCE_SOURCE_LABELS,
  zacResponseBadge,
  ZAC_STARTER_QUESTIONS,
  ZacAvatar,
  SparkGlyph,
  SourceGlyph,
  extractQuotedQuestion,
  formatEvidenceDate,
  zacFriendlyError,
  ZacFeedbackControls,
} from './zac-presentation';
import type { ZacAskError } from './zac-presentation';
import { ZacRoutingInspector } from './ZacRoutingInspector';
import { zacRoutingDebugEnabled } from '../../config/zacRoutingDebug';

type ZacTurn =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'zac'; response: ZacAskResponse };

let turnSeq = 1;

/**
 * Floating ZAC assistant: a launcher bubble in the bottom-right of every
 * dashboard page that opens a chat panel (support-widget pattern). The
 * transcript is client-side presentation only — each ask is the same
 * stateless POST /zac/ask the console page uses; nothing here adds
 * intelligence, permissions or persistence.
 *
 * Self-gating: renders nothing without `zac.access`, and stays out of the way
 * on /zac itself, where the full console lives.
 */
export function ZacChatWidget() {
  const auth = useAuth();
  const location = useLocation();
  const accessToken = auth.session?.accessToken;

  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<ZacTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ZacAskError | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Backend conversation for this widget session. A ref (not state): the ask
  // callback reads it without re-creating, and it lives only in memory for the
  // signed-in user — never persisted client-side, so it cannot leak across
  // accounts on a shared machine.
  const conversationRef = useRef<string | null>(null);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, loading, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // A different signed-in user must never continue the previous user's thread.
  const userId = auth.user?.id ?? null;
  useEffect(() => {
    conversationRef.current = null;
    setTurns([]);
    setError(null);
  }, [userId]);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !accessToken || loading) return;

      setTurns((current) => [...current, { id: turnSeq++, role: 'user', text: trimmed }]);
      setQuestion('');
      setLoading(true);
      setError(null);
      const sentConversationId = conversationRef.current;
      try {
        const response = await askZac(accessToken, {
          question: trimmed,
          conversationId: sentConversationId ?? undefined,
        });
        conversationRef.current = response.conversation_id ?? conversationRef.current;
        setTurns((current) => [...current, { id: turnSeq++, role: 'zac', response }]);
      } catch (err) {
        // A 404 while continuing a thread means THIS conversation is gone or
        // not continuable — drop it so the next ask starts fresh, instead of
        // showing the rollout copy and retrying a dead id forever.
        if (sentConversationId && err instanceof ApiRequestError && err.status === 404) {
          conversationRef.current = null;
          setError({
            kind: 'notice',
            text: "That conversation is no longer available, so I've started a fresh one — please ask again.",
          });
        } else {
          setError(zacFriendlyError(err));
        }
      } finally {
        setLoading(false);
        inputRef.current?.focus();
      }
    },
    [accessToken, loading],
  );

  if (!userHasPermission(auth.user, 'zac.access')) return null;
  if (location.pathname === '/zac') return null;
  // UAT / developer visibility of each answer's routing decision (presentation only).
  const routingDebug = zacRoutingDebugEnabled();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void ask(question);
  }

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask ZAC, your AI business assistant"
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-deep text-text-on-primary shadow-modal transition hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <SparkGlyph className="h-6 w-6" />
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="ZAC assistant"
      onKeyDown={onPanelKeyDown}
      className="fixed bottom-6 right-6 z-50 flex h-[min(640px,calc(100vh-3rem))] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-card-lg border border-border bg-surface shadow-modal"
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b border-border-divider bg-surface px-4 py-3">
        <ZacAvatar className="h-9 w-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-5 text-text-primary">ZAC</div>
          <div className="truncate text-[11px] text-text-muted">
            Answers from your salon’s verified data
          </div>
        </div>
        {turns.length > 0 ? (
          <button
            type="button"
            // Disabled while a reply is in flight: clearing mid-request would
            // let the resolving ask silently resurrect the abandoned thread.
            disabled={loading}
            onClick={() => {
              setTurns([]);
              setError(null);
              // A cleared chat is a NEW conversation — continuity ends here.
              conversationRef.current = null;
            }}
            className="rounded-pill border border-border px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-border-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Clear
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close ZAC"
          className="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition hover:bg-surface-alt hover:text-text-primary"
        >
          <CloseGlyph className="h-4 w-4" />
        </button>
      </div>

      {/* ── Transcript ── */}
      <div
        ref={scrollRef}
        aria-live="polite"
        aria-busy={loading}
        className="flex-1 space-y-3 overflow-y-auto bg-surface-alt px-4 py-4"
      >
        <div className="flex items-start gap-2.5">
          <ZacAvatar className="h-7 w-7 shrink-0" />
          <div className="max-w-[85%] rounded-card border border-border bg-surface px-3.5 py-2.5">
            <p className="text-[13px] leading-5 text-text-primary">
              Hi 👋 I’m ZAC. Ask me about your business — I answer only from your salon’s own
              verified data, and I say plainly when something isn’t connected yet.
            </p>
            {turns.length === 0 ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {ZAC_STARTER_QUESTIONS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => void ask(starter)}
                    disabled={loading}
                    className="rounded-pill border border-border-strong bg-surface px-2.5 py-1 text-[11.5px] text-text-secondary transition hover:border-primary hover:bg-primary-soft hover:text-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-card bg-primary px-3.5 py-2.5 text-[13px] leading-5 text-text-on-primary">
                {turn.text}
              </div>
            </div>
          ) : (
            <ZacAnswerBubble
              key={turn.id}
              routingDebug={routingDebug}
              response={turn.response}
              onAsk={(q) => void ask(q)}
              onFeedback={
                accessToken
                  ? async (outputId, rating) => {
                      await submitZacFeedback(accessToken, outputId, rating);
                    }
                  : undefined
              }
            />
          ),
        )}

        {loading ? <TypingIndicator /> : null}

        {error ? (
          <div
            role="status"
            className={
              error.kind === 'error'
                ? 'rounded-card border border-danger-border bg-danger-soft px-3.5 py-2.5 text-[12.5px] text-danger'
                : 'rounded-card border border-border bg-surface px-3.5 py-2.5 text-[12.5px] text-text-secondary'
            }
          >
            {error.text}
          </div>
        ) : null}
      </div>

      {/* ── Composer ── */}
      <form onSubmit={onSubmit} className="border-t border-border-divider bg-surface px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about your business…"
            maxLength={2000}
            disabled={loading}
            className="min-w-0 flex-1 rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-surface-alt"
          />
          <button
            type="submit"
            disabled={!question.trim() || loading || !accessToken}
            aria-label="Send question"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-text-on-primary transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SendGlyph className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 px-1 text-[10.5px] leading-4 text-text-subtle">
          Every figure comes from QLOOQO’s own reports. ZAC can still word things imperfectly —
          the full console is <span className="font-medium">ZAC</span> in the sidebar.
        </p>
      </form>
    </div>
  );
}

/**
 * One assistant turn. Exported for tests: every bubble renders the routing
 * metadata of ITS OWN response, so a transcript with different routes per
 * turn shows each one correctly.
 */
export function ZacAnswerBubble({
  response,
  onAsk,
  onFeedback,
  routingDebug = false,
}: {
  response: ZacAskResponse;
  onAsk: (question: string) => void;
  onFeedback?: (outputId: string, rating: 'useful' | 'not_useful') => Promise<void>;
  /** Show the routing inspector for this answer (presentation flag). */
  routingDebug?: boolean;
}) {
  const badge = zacResponseBadge(response);
  const followUp = response.suggested_next_step
    ? extractQuotedQuestion(response.suggested_next_step)
    : null;

  return (
    <div className="flex items-start gap-2.5">
      <ZacAvatar className="h-7 w-7 shrink-0" />
      <div className="max-w-[85%] rounded-card border border-border bg-surface px-3.5 py-2.5">
        {badge ? (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge label={badge.label} tone={badge.tone} />
            <span className="text-[10.5px] text-text-muted">
              Confidence: {response.confidence}
            </span>
          </div>
        ) : null}
        <p className="whitespace-pre-line text-[13px] leading-5 text-text-primary">
          {response.answer}
        </p>
        <ZacRoutingInspector details={response.technical_details} enabled={routingDebug} />

        {response.output_id && onFeedback ? (
          <ZacFeedbackControls
            key={response.output_id}
            outputId={response.output_id}
            submit={onFeedback}
          />
        ) : null}

        {followUp ? (
          <button
            type="button"
            onClick={() => onAsk(followUp)}
            className="mt-2.5 rounded-pill border-[1.5px] border-primary-deep bg-surface px-3 py-1 text-[11.5px] font-medium text-primary-deep transition hover:bg-primary-soft"
          >
            {followUp}
          </button>
        ) : null}

        {response.evidence.length > 0 || response.limitations.length > 0 ? (
          <details className="mt-2.5 border-t border-border-divider pt-2">
            <summary className="cursor-pointer select-none text-[11px] font-medium text-text-secondary">
              Where this comes from
            </summary>
            <div className="mt-2 space-y-2">
              {response.evidence.length > 0 ? (
                <ul className="space-y-1">
                  {response.evidence.map((item, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-1.5 text-[11.5px] leading-4 text-text-secondary"
                    >
                      <SourceGlyph className="mt-px h-3 w-3 shrink-0 text-primary-deep" />
                      <span>
                        {ZAC_EVIDENCE_SOURCE_LABELS[item.source_type] ?? item.source_type}
                        {item.as_of ? ` · data up to ${formatEvidenceDate(item.as_of)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {response.limitations.length > 0 ? (
                <ul className="space-y-1">
                  {response.limitations.map((limitation, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-1.5 text-[11.5px] leading-4 text-text-muted"
                    >
                      <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-border-strong" />
                      <span>{limitation}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-2.5" aria-label="ZAC is thinking">
      <ZacAvatar className="h-7 w-7 shrink-0" />
      <div className="flex items-center gap-1 rounded-card border border-border bg-surface px-3.5 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:300ms]" />
      </div>
    </div>
  );
}

function CloseGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
      {...props}
    >
      <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
    </svg>
  );
}

function SendGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M3.5 10h13M11 4.5 16.5 10 11 15.5" />
    </svg>
  );
}
