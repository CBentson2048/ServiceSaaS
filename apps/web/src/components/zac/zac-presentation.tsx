/**
 * ZAC presentation vocabulary shared by the full console page (/zac) and the
 * floating chat widget — one source for badges, evidence labels and error
 * copy so the two surfaces can never drift apart.
 */

import { useState } from 'react';
import type { ReactNode, SVGProps } from 'react';
import type { StatusTone } from '../../design';
import { ApiRequestError } from '../../auth/api';

export const ZAC_STARTER_QUESTIONS = [
  'What can you help me with?',
  'How is my business doing?',
  'Who is my top performer?',
  'Which stylists are below rebooking target?',
  "How's my rebooking rate?",
  // Workstream 1 — Expanded Intelligence. Starters are how these areas get
  // discovered: an owner has no reason to guess that ZAC can now answer them.
  // A starter for an area the actor cannot access is not a leak — the answer
  // is still permission-checked server-side, and hearing "that needs a
  // permission you do not have" is the honest outcome.
  'What are my top services?',
  'How is my retail doing?',
  'How many clients have lapsed?',
  'What is my cancellation rate?',
  'Which locations can you see?',
];

/** Friendly labels for evidence sources — users should never need to read code names. */
export const ZAC_EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  'report.dashboard': 'Dashboard KPIs',
  'kpi.engine': 'KPI engine',
  'kpi.personal': 'Your own KPI snapshot',
  'booking.schedule': 'Your own diary',
  'auth.context': 'Your signed-in access scope',
  'zac.registry': 'Connected capability check',
  'zac.intent': 'Question understanding',
  'zac.foundation': 'ZAC foundation',
  'zac.access_boundary': 'Your role’s access level',
  'crm.client_intelligence': 'Client retention analysis',
  'billing.retail_sales': 'Retail sales records',
  'zac.reasoning': 'ZAC reasoning (no salon data)',
  'zac.memory': 'What you asked ZAC to remember',
  'zac.permissions': 'Your effective permissions',
  'zac.analysis': 'Multi-source analysis',
};

export const ZAC_RESPONSE_TYPE_BADGES: Record<string, { label: string; tone: StatusTone }> = {
  Insight: { label: 'Insight', tone: 'success' },
  'Coaching Point': { label: 'Coaching point', tone: 'neutral' },
  Opportunity: { label: 'Opportunity', tone: 'success' },
  Risk: { label: 'Risk', tone: 'danger' },
  'Watch Point': { label: 'Watch point', tone: 'warning' },
  Explanation: { label: 'Explanation', tone: 'neutral' },
  'Refusal / Insufficient Data': { label: 'Data not connected yet', tone: 'warning' },
};

/** Modes that reason WITHOUT reading any QLOOQO business data. */
const ADVISORY_MODES = new Set(['general_advice', 'hypothetical', 'conversational']);

/**
 * The badge for one answer.
 *
 * `response_type` alone is not enough for refusals. The API has a single
 * `Refusal / Insufficient Data` type covering two very different situations,
 * and labelling both "Data not connected yet" is wrong — and specifically
 * wrong in the direction that failed client acceptance:
 *
 *   - a DATA question that found no connected source  → data really is missing
 *   - an ADVICE or HYPOTHETICAL question that ZAC could not reason about
 *     → nothing to do with their data; the user may even have asked ZAC to
 *       set their data aside, and is then told their data is the problem
 *
 * The request mode distinguishes them, so the badge uses it.
 */
export function zacResponseBadge(response: {
  response_type: string;
  technical_details?: { request_mode?: string };
}): { label: string; tone: StatusTone } | undefined {
  const mode = response.technical_details?.request_mode;
  if (response.response_type === 'Refusal / Insufficient Data' && mode && ADVISORY_MODES.has(mode)) {
    return { label: 'Answer unavailable', tone: 'warning' };
  }
  return ZAC_RESPONSE_TYPE_BADGES[response.response_type];
}

export interface ZacAskError {
  kind: 'notice' | 'error';
  text: string;
}

export function zacFriendlyError(err: unknown): ZacAskError {
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
export function extractQuotedQuestion(text: string): string | null {
  const match = text.match(/"([^"]{4,120}\?)"/);
  return match ? match[1] : null;
}

export function formatEvidenceDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ZacAvatar({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-deep text-text-on-primary shadow-card ${className ?? ''}`}
      aria-hidden
    >
      <SparkGlyph className="h-[45%] w-[45%]" />
    </span>
  );
}

export function SparkGlyph(props: SVGProps<SVGSVGElement>) {
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

export function SourceGlyph(props: SVGProps<SVGSVGElement>) {
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

/**
 * Useful / Not useful controls for one persisted ZAC output. Shared by the
 * console page and the chat widget so feedback behaviour never drifts.
 * Honest by design: success state appears only after the server confirmed the
 * write, the selection can be changed (the server updates the single active
 * vote in place), and failures show without losing the conversation.
 */
export function ZacFeedbackControls({
  outputId,
  submit,
}: {
  outputId: string;
  submit: (outputId: string, rating: 'useful' | 'not_useful') => Promise<void>;
}) {
  const [selected, setSelected] = useState<'useful' | 'not_useful' | null>(null);
  const [saving, setSaving] = useState<'useful' | 'not_useful' | null>(null);
  const [failed, setFailed] = useState<'retry' | 'unavailable' | false>(false);

  async function vote(rating: 'useful' | 'not_useful') {
    if (saving) return;
    setSaving(rating);
    setFailed(false);
    try {
      await submit(outputId, rating);
      setSelected(rating);
    } catch (err) {
      // "Try again" only when a retry can plausibly succeed — a 401/403/404
      // is a boundary, not a blip.
      setFailed(
        err instanceof ApiRequestError && [401, 403, 404].includes(err.status)
          ? 'unavailable'
          : 'retry',
      );
    } finally {
      setSaving(null);
    }
  }

  const buttonClass = (active: boolean) =>
    `rounded-pill border px-2.5 py-1 text-[11.5px] transition disabled:cursor-not-allowed disabled:opacity-60 ${
      active
        ? 'border-primary bg-primary-soft text-primary-deep'
        : 'border-border text-text-secondary hover:border-border-strong hover:text-text-primary'
    }`;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-output-id={outputId}>
      <span className="text-[11px] text-text-muted">Was this useful?</span>
      <button
        type="button"
        onClick={() => void vote('useful')}
        disabled={saving !== null}
        aria-pressed={selected === 'useful'}
        className={buttonClass(selected === 'useful')}
      >
        {saving === 'useful' ? 'Saving…' : 'Useful'}
      </button>
      <button
        type="button"
        onClick={() => void vote('not_useful')}
        disabled={saving !== null}
        aria-pressed={selected === 'not_useful'}
        className={buttonClass(selected === 'not_useful')}
      >
        {saving === 'not_useful' ? 'Saving…' : 'Not useful'}
      </button>
      {selected && !failed ? (
        <span className="text-[11px] text-text-muted">Thanks — noted.</span>
      ) : null}
      {failed ? (
        <span className="text-[11px] text-danger">
          {failed === 'unavailable'
            ? 'Feedback isn’t available for this answer.'
            : 'Couldn’t save — try again.'}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ANSWER RENDERING
//
// ZAC's answers arrive as Markdown. The deterministic tool copy contains none,
// but the synthesis model narrates in Markdown by default — so a live answer
// reads "**0% full this week**" and, rendered as plain text, the user sees the
// asterisks. Emphasis on the figures is genuinely useful here, so the fix is
// to render it rather than to strip it.
//
// Deliberately hand-rolled rather than pulling in a Markdown library:
//
//  * SAFETY. Every branch below builds React elements, so the answer text is
//    escaped by React itself and `dangerouslySetInnerHTML` never appears. Model
//    output cannot inject markup, which a full Markdown parser with HTML
//    passthrough would allow.
//  * LINKS ARE NOT CLICKABLE. A URL in an answer is model-generated, and a
//    clickable model-generated link is a phishing vector. Link text renders;
//    the anchor does not.
//  * NO `_underscore_` EMPHASIS. ZAC legitimately names things like
//    `report.client_retention`, and underscore emphasis would italicise the
//    middle of identifiers. Only `**bold**`, `*italic*` and `` `code` `` are
//    recognised, which is what the model actually emits.
// ---------------------------------------------------------------------------

/**
 * `**bold**`, `*italic*`, `` `code` `` — longest delimiter first so `**` wins.
 *
 * The italic arm requires its delimiters to HUG non-whitespace, which is the
 * CommonMark rule and not decoration here: a looser `\*([^*\n]+)\*` matched
 * from the asterisk in "5 * 3" all the way to the next one in the sentence,
 * swallowing both delimiters and italicising the text between. A renderer that
 * silently drops characters out of an answer is worse than one that leaves a
 * stray asterisk visible.
 */
const INLINE_PATTERN = /\*\*([^*]+)\*\*|\*(\S(?:[^*\n]*\S)?)\*|`([^`\n]+)`/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const key = `${keyPrefix}-${match.index}`;
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-text-primary">
          {match[1]}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(<em key={key}>{match[2]}</em>);
    } else {
      nodes.push(
        <code key={key} className="rounded bg-surface-alt px-1 py-px text-[0.92em]">
          {match[3]}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  // An unmatched delimiter is left exactly as written rather than swallowed —
  // dropping a stray asterisk would silently alter the answer's text.
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** Single newlines inside one block become line breaks. */
function renderLines(block: string, keyPrefix: string): ReactNode[] {
  return block.split('\n').flatMap((line, index) => {
    const rendered = renderInline(line, `${keyPrefix}-l${index}`);
    return index === 0 ? rendered : [<br key={`${keyPrefix}-br${index}`} />, ...rendered];
  });
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/**
 * Render one ZAC answer. Blocks are separated by a blank line; a block whose
 * every line is a list marker becomes a real list, so the bullets ZAC already
 * emits stop rendering as literal dashes mid-paragraph.
 */
export function ZacAnswer({ text, className = '' }: { text: string; className?: string }) {
  const blocks = text.trim().split(/\n{2,}/);

  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').filter((line) => line.trim().length > 0);
        const key = `b${blockIndex}`;
        const spacing = blockIndex === 0 ? '' : 'mt-2';

        if (lines.length > 0 && lines.every((line) => BULLET.test(line))) {
          return (
            <ul key={key} className={`${spacing} list-disc space-y-1 pl-4`}>
              {lines.map((line, i) => (
                <li key={`${key}-${i}`}>{renderInline(line.replace(BULLET, ''), `${key}-${i}`)}</li>
              ))}
            </ul>
          );
        }

        if (lines.length > 0 && lines.every((line) => NUMBERED.test(line))) {
          return (
            <ol key={key} className={`${spacing} list-decimal space-y-1 pl-4`}>
              {lines.map((line, i) => (
                <li key={`${key}-${i}`}>
                  {renderInline(line.replace(NUMBERED, ''), `${key}-${i}`)}
                </li>
              ))}
            </ol>
          );
        }

        if (HEADING.test(block)) {
          // ZAC has its own heading styles; a model-emitted "##" becomes
          // emphasis rather than a competing type scale.
          return (
            <p key={key} className={`${spacing} font-semibold text-text-primary`}>
              {renderLines(block.replace(HEADING, ''), key)}
            </p>
          );
        }

        return (
          <p key={key} className={spacing}>
            {renderLines(block, key)}
          </p>
        );
      })}
    </div>
  );
}
