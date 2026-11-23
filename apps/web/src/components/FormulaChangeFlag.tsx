import type { FormulaChangeAssessment } from '@sheer/domain';

/**
 * The stylist-facing formula-change flag (Wrike 4507283774).
 *
 * ONE presenter, used by both the client profile and Colour Prep, so a stylist
 * reads the same words in both places and the two surfaces cannot drift apart.
 *
 * Deliberately calm. This is attention, not a clinical alert: the wording is
 * "changed significantly", never "dangerous" or "warning", because no safety
 * logic sits behind it and a stylist who is alarmed by a routine reformulation
 * learns to dismiss the flag. Raw internal fields — identities, basis points,
 * dimension enums — never reach the screen.
 */
export function FormulaChangeFlag({
  assessment,
  variant = 'card',
}: {
  assessment: FormulaChangeAssessment;
  variant?: 'card' | 'inline';
}) {
  if (!assessment.available || !assessment.significant) return null;

  const reasons = assessment.reasons.filter((reason) => reason.significant);

  if (variant === 'inline') {
    // Colour Prep: one compact block beside an appointment, so the stylist sees
    // it without opening another screen.
    return (
      <div className="mt-2 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2">
        <p className="text-[12px] font-semibold text-warning">⚑ Formula changed since previous visit</p>
        <ul className="mt-1 space-y-0.5">
          {reasons.map((reason, index) => (
            <li key={`${reason.type}-${index}`} className="text-[12px] text-text-secondary">
              {reason.summary}
            </li>
          ))}
        </ul>
        {assessment.previous ? (
          <p className="mt-1 text-[11px] text-text-muted">
            Compared with {formatDate(assessment.previous.savedAt)}
            {assessment.previous.serviceName ? ` · ${assessment.previous.serviceName}` : ''}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3">
      <p className="text-[13px] font-semibold text-warning">Colour formula changed significantly</p>
      <p className="mt-0.5 text-[12px] text-text-secondary">
        Compared with the previous comparable colour visit
        {assessment.previous ? ` on ${formatDate(assessment.previous.savedAt)}` : ''}.
      </p>
      <ul className="mt-2 space-y-1">
        {reasons.map((reason, index) => (
          <li key={`${reason.type}-${index}`} className="text-[13px] text-text-primary">
            • {reason.summary}
          </li>
        ))}
      </ul>
      <FormulaComparison assessment={assessment} />
      <UnavailableNote assessment={assessment} />
    </div>
  );
}

/**
 * The two formulas side by side as SHARES, not raw grams.
 *
 * Shares are what the comparison actually judged, so showing them is what makes
 * the verdict legible: "50% / 50%" against "20% / 80%" explains the flag in a
 * way two columns of gram figures never would.
 */
function FormulaComparison({ assessment }: { assessment: FormulaChangeAssessment }) {
  if (!assessment.previous || !assessment.current) return null;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <FormulaColumn title="Previous" snapshot={assessment.previous} />
      <FormulaColumn title="Latest" snapshot={assessment.current} />
    </div>
  );
}

function FormulaColumn({
  title,
  snapshot,
}: {
  title: string;
  snapshot: NonNullable<FormulaChangeAssessment['previous']>;
}) {
  return (
    <div className="rounded-input-lg bg-surface px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {title} · {formatDate(snapshot.savedAt)}
      </p>
      {snapshot.stylistName ? (
        <p className="text-[11px] text-text-muted">with {snapshot.stylistName}</p>
      ) : null}
      <ul className="mt-1 space-y-0.5">
        {snapshot.components.map((component) => (
          <li key={component.displayName} className="flex justify-between gap-3 text-[12px]">
            <span className="min-w-0 truncate text-text-secondary">{component.displayName}</span>
            <span className="shrink-0 font-semibold tabular-nums text-text-primary">
              {component.sharePercent}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What was NOT checked.
 *
 * Stated plainly rather than omitted: a stylist who assumes the system watched
 * the colour level would be misled by silence. Service SaaS records no structured
 * level or tone, so this line is the honest half of the flag.
 */
function UnavailableNote({ assessment }: { assessment: FormulaChangeAssessment }) {
  const missing = assessment.dimensions
    .filter((dimension) => !dimension.evaluated)
    .map((dimension) => dimension.dimension)
    .filter((dimension) => dimension === 'level' || dimension === 'tone');
  if (missing.length === 0) return null;

  return (
    <p className="mt-2 text-[11px] text-text-muted">
      Based on the products and quantities in the mix. {missing.join(' and ')} are not recorded as
      structured data, so they are not compared.
    </p>
  );
}

function formatDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? '—'
    : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
