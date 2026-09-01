import type {
  BackToBackColourSignal,
  NoShowRiskSignal,
  SlotGapSignal,
  SpendTrendSignal,
} from '@sheer/domain';

/**
 * Presenters for the four operational intelligence signals (Wrike 4507283793).
 *
 * ONE place for the wording, shared by the client profile and the diary, so a
 * stylist reads the same sentence wherever a signal appears.
 *
 * Deliberately calm and factual. These are operational context, not verdicts
 * about a person: the spend card says "recent spend trend is lower", never
 * "declining client value", and the attendance card says "previous
 * missed-appointment pattern" with the actual counts, never "unreliable" and
 * never a percentage likelihood. There is no model behind any of this and the UI
 * must not imply one.
 */

// ---------------------------------------------------------------------------
// Client profile
// ---------------------------------------------------------------------------

/**
 * Spend trend.
 *
 * Shows average value PER VISIT alongside the visit counts, because those are
 * different facts: a client who comes half as often at the same ticket price has
 * not reduced their spend per visit, and the card must let a stylist see which
 * of the two actually moved.
 */
export function SpendTrendCard({ signal }: { signal: SpendTrendSignal }) {
  const tone =
    signal.status === 'falling' ? 'warning' : signal.status === 'rising' ? 'success' : 'neutral';
  const label =
    signal.status === 'rising'
      ? 'Higher'
      : signal.status === 'falling'
        ? 'Lower'
        : signal.status === 'stable'
          ? 'Steady'
          : 'Not enough history';

  return (
    <SignalCard title="Spend trend" label={label} tone={tone}>
      <p className="text-[13px] text-text-secondary">{signal.summary}</p>
      {signal.evidence ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
          <Fact
            label="Recent average"
            value={`${formatPence(signal.evidence.recentAverageCents)} over ${signal.evidence.recentVisitCount} visits`}
          />
          <Fact
            label="Previous average"
            value={`${formatPence(signal.evidence.previousAverageCents)} over ${signal.evidence.previousVisitCount} visits`}
          />
          <Fact
            label="Change"
            value={`${signal.evidence.changePercent > 0 ? '+' : ''}${signal.evidence.changePercent}%`}
          />
          <Fact
            label="Compared"
            value={`${signal.evidence.previousFromDate} → ${signal.evidence.recentToDate}`}
          />
        </dl>
      ) : null}
    </SignalCard>
  );
}

/**
 * Attendance pattern.
 *
 * Every number shown is a COUNT the salon can verify, never a probability. The
 * card is suppressed entirely at `low` / `insufficient_data` on the diary, but
 * the profile shows it always so "we looked and there is no pattern" is
 * distinguishable from "we did not look".
 */
export function NoShowRiskCard({ signal }: { signal: NoShowRiskSignal }) {
  const tone =
    signal.level === 'high' ? 'danger' : signal.level === 'medium' ? 'warning' : 'neutral';
  const label =
    signal.level === 'high'
      ? 'Repeat pattern'
      : signal.level === 'medium'
        ? 'Some history'
        : signal.level === 'low'
          ? 'No pattern'
          : 'Not enough history';

  return (
    <SignalCard title="Attendance" label={label} tone={tone}>
      <p className="text-[13px] text-text-secondary">{signal.summary}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
        <Fact label="Appointments" value={String(signal.evidence.relevantAppointments)} />
        <Fact label="Attended" value={String(signal.evidence.attendedCount)} />
        <Fact label="No-shows" value={String(signal.evidence.noShowCount)} />
        <Fact label="No-show rate" value={`${signal.evidence.noShowRatePercent}%`} />
        {signal.evidence.lateCancellationCount > 0 ? (
          <Fact
            label="Cancelled inside notice"
            value={String(signal.evidence.lateCancellationCount)}
          />
        ) : null}
        {signal.evidence.mostRecentNoShowDate ? (
          <Fact
            label="Most recent no-show"
            value={`${signal.evidence.mostRecentNoShowDate} (${signal.evidence.daysSinceMostRecentNoShow} days ago)`}
          />
        ) : null}
      </dl>
      <p className="mt-2 text-[11px] text-text-muted">
        Based on the last {signal.evidence.lookbackDays} days of appointments. Cancellations made
        inside the notice period are counted separately from no-shows and are never treated as the
        same thing.
      </p>
    </SignalCard>
  );
}

// ---------------------------------------------------------------------------
// Diary
// ---------------------------------------------------------------------------

/**
 * The day's operational signals, in one compact panel above the calendar.
 *
 * A panel rather than badges threaded through every calendar tile: the three
 * diary signals are about the SHAPE of the day (two colours stacked on Sam, half
 * an hour dead at 11:20), and a stylist reads that faster as a short list than
 * as scattered dots. It also keeps the calendar's rendering untouched, so a
 * signal failure cannot break the diary itself.
 */
export function DiaryIntelligencePanel({
  backToBackColour,
  slotGaps,
  noShowClients,
  timeZone,
}: {
  backToBackColour: BackToBackColourSignal[];
  slotGaps: SlotGapSignal[];
  noShowClients: Array<{ clientName: string; startsAt: string; signal: NoShowRiskSignal }>;
  timeZone: string;
}) {
  const total = backToBackColour.length + slotGaps.length + noShowClients.length;
  if (total === 0) return null;

  return (
    <section className="rounded-input-lg border border-border bg-surface px-4 py-3">
      <h2 className="text-[13px] font-semibold text-text-primary">Today at a glance</h2>

      {noShowClients.length > 0 ? (
        <Group title="Attendance">
          {noShowClients.map((entry) => (
            <li key={`${entry.clientName}-${entry.startsAt}`} className="text-[12px] text-text-secondary">
              <span className="font-medium text-text-primary">
                {formatClock(entry.startsAt, timeZone)} {entry.clientName}
              </span>{' '}
              — {entry.signal.evidence.noShowCount} no-show
              {entry.signal.evidence.noShowCount === 1 ? '' : 's'} from{' '}
              {entry.signal.evidence.relevantAppointments} appointments
            </li>
          ))}
        </Group>
      ) : null}

      {backToBackColour.length > 0 ? (
        <Group title="Colour sequencing">
          {backToBackColour.map((warning) => (
            <li
              key={`${warning.firstAppointmentId}-${warning.secondAppointmentId}`}
              className="text-[12px] text-text-secondary"
            >
              <span className="font-medium text-text-primary">
                {formatClock(warning.first.startsAt, timeZone)} {warning.first.clientDisplayName}
              </span>{' '}
              →{' '}
              <span className="font-medium text-text-primary">
                {formatClock(warning.second.startsAt, timeZone)} {warning.second.clientDisplayName}
              </span>{' '}
              — {warning.kind === 'overlap' ? 'overlapping' : `${warning.bufferMinutes} min buffer`} (
              {warning.minimumBufferMinutes} min recommended)
            </li>
          ))}
        </Group>
      ) : null}

      {slotGaps.length > 0 ? (
        <Group title="Unbooked time">
          {slotGaps.map((gap) => (
            <li key={`${gap.staffProfileId}-${gap.startsAt}`} className="text-[12px] text-text-secondary">
              <span className="font-medium text-text-primary">
                {formatClock(gap.startsAt, timeZone)}–{formatClock(gap.endsAt, timeZone)}
              </span>{' '}
              — {gap.gapMinutes} min between appointments
            </li>
          ))}
        </Group>
      ) : null}
    </section>
  );
}

/** A compact per-appointment attendance badge, for a calendar tile. */
export function NoShowBadge({ signal }: { signal: NoShowRiskSignal }) {
  if (signal.level !== 'medium' && signal.level !== 'high') return null;
  return (
    <span
      className="inline-flex items-center rounded-pill bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning"
      title={signal.summary}
    >
      ⚑ Previous no-show pattern
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function SignalCard({
  title,
  label,
  tone,
  children,
}: {
  title: string;
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  children: React.ReactNode;
}) {
  const toneClass = {
    neutral: 'bg-surface-alt text-text-secondary',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  }[tone];

  return (
    <div className="rounded-input-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
        <span className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-[11px] font-medium ${toneClass}`}>
          {label}
        </span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{title}</p>
      <ul className="mt-0.5 space-y-0.5">{children}</ul>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-secondary">{label}</dt>
      <dd className="font-medium tabular-nums text-text-primary">{value}</dd>
    </div>
  );
}

function formatPence(cents: number): string {
  return `£${(Math.round(cents) / 100).toFixed(2)}`;
}

function formatClock(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleTimeString(undefined, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
