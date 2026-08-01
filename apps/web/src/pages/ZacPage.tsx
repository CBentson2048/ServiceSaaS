import { useState } from 'react';
import type { FormEvent, KeyboardEvent, SVGProps } from 'react';
import { AppButton, AppCard, StatusBadge } from '../design';
import type { StatusTone } from '../design';
import { useAuth } from '../auth/AuthProvider';
import { ApiRequestError, askZac } from '../auth/api';
import type { ZacAskResponse } from '../auth/api';

const STARTER_QUESTIONS = [
  'What can you help me with?',
  'How is my business doing?',
  'Which locations can you see?',
  'What business context do you have?',
  'Members of my business?',
  'Which tools are connected?',
];

const FIELD =
  'w-full resize-y rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[14px] leading-6 text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-surface-alt';

/** Friendly labels for evidence sources — users should never need to read code names. */
const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  'report.dashboard': 'Dashboard KPIs',
  'auth.context': 'Your signed-in access scope',
  'zac.registry': 'Connected capability check',
  'zac.intent': 'Question understanding',
  'zac.foundation': 'ZAC foundation',
};

const RESPONSE_TYPE_BADGES: Record<string, { label: string; tone: StatusTone }> = {
  Insight: { label: 'Insight', tone: 'success' },
  'Coaching Point': { label: 'Coaching point', tone: 'neutral' },
  Opportunity: { label: 'Opportunity', tone: 'success' },
  Risk: { label: 'Risk', tone: 'danger' },
  'Watch Point': { label: 'Watch point', tone: 'warning' },
  Explanation: { label: 'Explanation', tone: 'neutral' },
  'Refusal / Insufficient Data': { label: 'Data not connected yet', tone: 'warning' },
};

interface AskError {
  kind: 'notice' | 'error';
  text: string;
}

export function ZacPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;

  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AskError | null>(null);
  const [response, setResponse] = useState<ZacAskResponse | null>(null);
  const [askedQuestion, setAskedQuestion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !accessToken || loading) return;

    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const result = await askZac(accessToken, { question: trimmed });
      setResponse(result);
      setAskedQuestion(trimmed);
      setQuestion('');
    } catch (err) {
      setResponse(null);
      setAskedQuestion(null);
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void ask(question);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask(question);
    }
  }

  async function copyAnswer() {
    if (!response) return;
    try {
      await navigator.clipboard.writeText(response.answer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/HTTP) — quietly ignore.
    }
  }

  const badge = response ? RESPONSE_TYPE_BADGES[response.response_type] : undefined;
  const followUp = response?.suggested_next_step
    ? extractQuotedQuestion(response.suggested_next_step)
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex items-start gap-4">
        <ZacAvatar className="h-12 w-12" />
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] font-semibold leading-7 text-text-primary">ZAC</h1>
            <StatusBadge label="Foundation mode" tone="neutral" />
          </div>
          <p className="mt-0.5 text-[13px] text-text-secondary">
            AI business assistant for QLOOQO
          </p>
          <p className="mt-1 max-w-2xl text-[12px] leading-5 text-text-muted">
            Ask anything about your business. ZAC answers only from connected read-only data
            sources — and says plainly when something is not connected yet.
          </p>
        </div>
      </header>

      <AppCard padding="lg" className="mb-6" elevation="card">
        <form onSubmit={onSubmit}>
          <label
            htmlFor="zac-question"
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted"
          >
            Ask a question
          </label>
          <textarea
            id="zac-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="e.g. How is my business doing?"
            rows={3}
            maxLength={2000}
            disabled={loading}
            className={FIELD}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-text-subtle">
              Enter to ask · Shift+Enter for a new line
            </span>
            <AppButton
              type="submit"
              variant="primary"
              loading={loading}
              disabled={!question.trim() || !accessToken}
              leadingIcon={<SparkGlyph className="h-3.5 w-3.5" />}
            >
              Ask ZAC
            </AppButton>
          </div>

          <div className="mt-4 border-t border-border-divider pt-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted">
              Try asking
            </div>
            <div className="flex flex-wrap gap-2">
              {STARTER_QUESTIONS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => void ask(starter)}
                  disabled={loading}
                  className="rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12px] text-text-secondary transition hover:border-primary hover:bg-primary-soft hover:text-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        </form>
      </AppCard>

      {error ? (
        <div
          role="status"
          className={
            error.kind === 'error'
              ? 'mb-6 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger'
              : 'mb-6 rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-[13px] text-text-secondary'
          }
        >
          {error.text}
        </div>
      ) : null}

      <div aria-live="polite" aria-busy={loading}>
        {loading ? <AnswerSkeleton /> : null}

        {!loading && !response && !error ? (
          <AppCard padding="lg" className="text-center">
            <ZacAvatar className="mx-auto h-14 w-14" />
            <p className="mt-4 text-[15px] font-medium text-text-primary">
              Ready when you are
            </p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-text-secondary">
              Ask a question above, or pick one of the suggestions to see what ZAC can already
              tell you about your business.
            </p>
          </AppCard>
        ) : null}

        {response && !loading ? (
          <AppCard padding="lg">
            {askedQuestion ? (
              <div className="mb-4 rounded-input-lg bg-surface-alt px-4 py-2.5">
                <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted">
                  You asked
                </span>
                <p className="mt-0.5 text-[13px] text-text-primary">{askedQuestion}</p>
              </div>
            ) : null}

            <div className="flex items-start gap-3">
              <ZacAvatar className="h-9 w-9 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-text-primary">ZAC</span>
                  {badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null}
                  <StatusBadge label={`Confidence: ${response.confidence}`} tone="neutral" />
                  <button
                    type="button"
                    onClick={() => void copyAnswer()}
                    className="ml-auto rounded-pill border border-border px-2.5 py-1 text-[11px] text-text-secondary transition hover:border-border-strong hover:text-text-primary"
                  >
                    {copied ? 'Copied' : 'Copy answer'}
                  </button>
                </div>
                <p className="whitespace-pre-line text-[14px] leading-6 text-text-primary">
                  {response.answer}
                </p>
              </div>
            </div>

            {response.suggested_next_step ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-input-lg border border-primary/30 bg-primary-soft px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-primary-deep">
                    Next useful step
                  </div>
                  <p className="mt-1 text-[13px] leading-5 text-text-primary">
                    {response.suggested_next_step}
                  </p>
                </div>
                {followUp ? (
                  <button
                    type="button"
                    onClick={() => void ask(followUp)}
                    disabled={loading}
                    className="shrink-0 rounded-pill border-[1.5px] border-primary-deep bg-surface px-4 py-1.5 text-[12px] font-medium text-primary-deep transition hover:bg-primary-soft"
                  >
                    Ask this
                  </button>
                ) : null}
              </div>
            ) : null}

            {response.evidence.length > 0 || response.limitations.length > 0 ? (
              <div className="mt-6 grid gap-5 border-t border-border-divider pt-5 sm:grid-cols-2">
                {response.evidence.length > 0 ? (
                  <section>
                    <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted">
                      Where this comes from
                    </h2>
                    <ul className="space-y-1.5">
                      {response.evidence.map((item, index) => (
                        <li key={index} className="flex items-start gap-2 text-[13px] leading-5 text-text-secondary">
                          <SourceGlyph className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary-deep" />
                          <span>
                            {EVIDENCE_SOURCE_LABELS[item.source_type] ?? item.source_type}
                            {item.as_of ? ` · data up to ${formatDate(item.as_of)}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {response.limitations.length > 0 ? (
                  <section>
                    <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-muted">
                      Good to know
                    </h2>
                    <ul className="space-y-1.5">
                      {response.limitations.map((limitation, index) => (
                        <li key={index} className="flex items-start gap-2 text-[13px] leading-5 text-text-secondary">
                          <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-border-strong" />
                          <span>{limitation}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : null}

            <details className="mt-6 rounded-input-lg border border-border bg-surface-alt px-4 py-3">
              <summary className="cursor-pointer select-none text-[12px] font-medium text-text-secondary">
                Developer details
              </summary>
              <div className="mt-3 space-y-2 text-[12px] text-text-secondary">
                <div>
                  Connected sources:{' '}
                  {response.technical_details.connected_tools.length > 0
                    ? response.technical_details.connected_tools.join(', ')
                    : 'none'}
                </div>
                <div>
                  Planned (not connected):{' '}
                  {response.technical_details.disabled_tools.length > 0
                    ? response.technical_details.disabled_tools.join(', ')
                    : 'none'}
                </div>
                <div>
                  Provider: {response.technical_details.provider} · Model:{' '}
                  {response.technical_details.model} · Trace: {response.trace_id}
                </div>
                <pre className="scroll-area max-h-72 overflow-auto rounded-input border border-border bg-surface p-3 text-[11px] leading-4 text-text-secondary">
                  {JSON.stringify(response, null, 2)}
                </pre>
              </div>
            </details>
          </AppCard>
        ) : null}
      </div>
    </div>
  );
}

function ZacAvatar({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-deep text-text-on-primary shadow-card ${className ?? ''}`}
      aria-hidden
    >
      <SparkGlyph className="h-[45%] w-[45%]" />
    </span>
  );
}

function SparkGlyph(props: SVGProps<SVGSVGElement>) {
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
      <path d="M10 3.5 11.6 8l4.4 1.6-4.4 1.6L10 15.6 8.4 11.2 4 9.6 8.4 8 10 3.5Z" />
      <path d="M15.5 3v3M14 4.5h3" />
    </svg>
  );
}

function SourceGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <circle cx="10" cy="10" r="6.5" />
      <path d="m7.5 10 1.8 1.8 3.2-3.6" />
    </svg>
  );
}

function AnswerSkeleton() {
  return (
    <AppCard padding="lg" aria-hidden>
      <div className="animate-pulse">
        <div className="mb-4 h-9 rounded-input-lg bg-surface-alt" />
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-full bg-surface-alt" />
          <div className="flex-1 space-y-2.5 pt-1">
            <div className="h-3.5 w-1/4 rounded bg-surface-alt" />
            <div className="h-3.5 w-full rounded bg-surface-alt" />
            <div className="h-3.5 w-11/12 rounded bg-surface-alt" />
            <div className="h-3.5 w-3/4 rounded bg-surface-alt" />
          </div>
        </div>
        <div className="mt-6 h-16 rounded-input-lg bg-surface-alt" />
      </div>
    </AppCard>
  );
}

function friendlyError(err: unknown): AskError {
  if (err instanceof ApiRequestError) {
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
    if (err.status === 401) {
      return { kind: 'error', text: 'Your session has expired — please sign in again.' };
    }
    return { kind: 'error', text: err.message };
  }
  return { kind: 'error', text: 'Something went wrong talking to ZAC. Please try again.' };
}

/** First double-quoted question inside the next-step copy, offered as a one-click follow-up. */
function extractQuotedQuestion(text: string): string | null {
  const match = text.match(/"([^"]{4,120}\?)"/);
  return match ? match[1] : null;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
