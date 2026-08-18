/**
 * ZAC presentation vocabulary shared by the full console page (/zac) and the
 * floating chat widget — one source for badges, evidence labels and error
 * copy so the two surfaces can never drift apart.
 */

import { useState } from 'react';
import type { SVGProps } from 'react';
import type { StatusTone } from '../../design';
import { ApiRequestError } from '../../auth/api';

export const ZAC_STARTER_QUESTIONS = [
  'What can you help me with?',
  'How is my business doing?',
  'Who is my top performer?',
  'Which stylists are below rebooking target?',
  "How's my rebooking rate?",
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
