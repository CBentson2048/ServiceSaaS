/**
 * ZAC semantic-routing inspector (UAT / developer visibility).
 *
 * Renders the routing decision the backend returned for ONE answer — the
 * request mode, the analysis intent, and whether the OpenAI semantic router
 * or the deterministic fallback decided it. It reads `technical_details` from
 * the response that produced the answer and never classifies anything itself:
 * no route is shown while a question is in flight, none is invented on an
 * error, and every assistant turn carries its own metadata.
 *
 * Presentation only. The metadata is already in the response the browser
 * holds; the backend remains authoritative for routing, permissions and
 * privacy. Whether the inspector is shown at all is the caller's decision
 * (see config/zacRoutingDebug.ts).
 */
import { describeZacRouting } from '@sheer/domain';
import type { ZacRoutingDescription, ZacRoutingDetails, ZacRoutingSourceTone } from '@sheer/domain';

const SOURCE_TONE: Record<ZacRoutingSourceTone, string> = {
  semantic: 'text-success',
  neutral: 'text-text-secondary',
  fallback: 'text-warning',
  unknown: 'text-text-muted',
};

/**
 * Compact indicator: "Routing: Service SaaS Data · Business Priorities" plus a
 * separate "Source: OpenAI semantic router" / "Source: Fallback (…)" element,
 * so the spec's compact format stays exact while semantic-vs-fallback is
 * visible without expanding anything. Secondary to the answer by design.
 * Renders nothing when the API reported no request mode.
 */
export function ZacRoutingBadge({
  details,
  className,
}: {
  details: ZacRoutingDetails | null | undefined;
  className?: string;
}) {
  const routing = describeZacRouting(details);
  if (!routing) return null;
  return (
    <p
      className={`flex flex-wrap items-baseline gap-x-2 text-[11px] leading-4 text-text-muted ${className ?? ''}`}
      data-testid="zac-routing-badge"
      data-request-mode={routing.requestMode.value}
      data-source-kind={routing.source.kind}
    >
      <span data-testid="zac-routing-summary">
        Routing: <span className="font-medium text-text-secondary">{routing.summary}</span>
        {routing.intentNote ? <span className="text-text-muted"> ({routing.intentNote})</span> : null}
      </span>
      {routing.source.kind !== 'unknown' ? (
        <span data-testid="zac-routing-badge-source">
          Source:{' '}
          <span className={`font-medium ${SOURCE_TONE[routing.source.tone]}`}>
            {routing.source.displayLabel}
          </span>
        </span>
      ) : null}
    </p>
  );
}

/**
 * The expandable field list. `collapsible` wraps it in a native
 * <details>/<summary> (keyboard-operable by default); pass false when the
 * caller already provides its own disclosure, as the console's Developer
 * details panel does. Absent fields are not rendered.
 */
export function ZacRoutingTechnicalDetails({
  details,
  collapsible = true,
  className,
}: {
  details: ZacRoutingDetails | null | undefined;
  collapsible?: boolean;
  className?: string;
}) {
  const routing = describeZacRouting(details);
  if (!routing) return null;

  const body = (
    <div className="space-y-2 text-[11.5px] leading-4 text-text-secondary">
      <p data-testid="zac-routing-source">
        <span className="text-text-muted">Source: </span>
        <span className={`font-medium ${SOURCE_TONE[routing.source.tone]}`}>
          {routing.source.displayLabel}
        </span>
      </p>
      <dl className={ROW_GRID}>
        {routing.rows.map((row) => (
          <div key={row.key} className="contents" data-testid={`zac-routing-row-${row.key}`}>
            <dt className="text-text-muted">{row.label}</dt>
            <dd className="min-w-0 break-words">
              {row.value}
              {row.raw ? <span className="text-text-muted"> ({row.raw})</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {routing.shadow ? <ZacShadowComparison shadow={routing.shadow} /> : null}
    </div>
  );

  if (!collapsible) return <div className={className}>{body}</div>;
  return (
    <details className={`border-t border-border-divider pt-2 ${className ?? ''}`}>
      <summary className="cursor-pointer select-none text-[11px] font-medium text-text-secondary">
        Technical details
      </summary>
      <div className="mt-2">{body}</div>
    </details>
  );
}

/** Label over value on phone widths; two columns once there is room. */
const ROW_GRID = 'grid grid-cols-1 gap-y-1 sm:grid-cols-[max-content_1fr] sm:gap-x-3';

function ZacShadowComparison({ shadow }: { shadow: ZacRoutingDescription['shadow'] }) {
  if (!shadow) return null;
  const agreement =
    shadow.agreement === null ? 'Not available' : shadow.agreement ? 'Yes' : 'No';
  return (
    <div
      className="rounded-input border border-border bg-surface-alt px-2.5 py-2"
      data-testid="zac-routing-shadow"
    >
      <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-text-muted">
        Shadow comparison · {shadow.providerLabel} {shadow.model}
      </p>
      <dl className={ROW_GRID}>
        <dt className="text-text-muted">Production route</dt>
        <dd className="min-w-0 break-words">{shadow.production}</dd>
        <dt className="text-text-muted">Shadow semantic route</dt>
        <dd className="min-w-0 break-words">
          {shadow.shadow ?? `Failed${shadow.failureLabel ? ` (${shadow.failureLabel})` : ''}`}
        </dd>
        <dt className="text-text-muted">Agreement</dt>
        <dd className={shadow.agreement === false ? 'font-medium text-warning' : undefined}>
          {agreement}
        </dd>
      </dl>
    </div>
  );
}

/** Badge + collapsible technical details, for surfaces that show both inline (the chat widget). */
export function ZacRoutingInspector({
  details,
  enabled,
}: {
  details: ZacRoutingDetails | null | undefined;
  /** The presentation flag. False renders nothing at all. */
  enabled: boolean;
}) {
  if (!enabled) return null;
  const routing = describeZacRouting(details);
  if (!routing) return null;
  return (
    <div className="mt-2 space-y-1.5" data-testid="zac-routing-inspector">
      <ZacRoutingBadge details={details} />
      <ZacRoutingTechnicalDetails details={details} />
    </div>
  );
}
