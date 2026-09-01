import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  ColourPrepAppointment,
  ColourPrepPlan,
  ColourPrepProductRequirement,
  ColourPrepRange,
  ColourPrepStockState,
  StockUnit,
} from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';
import { getColourPrep } from '../auth/api';
import { FormulaChangeFlag } from '../components/FormulaChangeFlag';
import { useLocationScope } from '../components/LocationScopeContext';

/**
 * Colour Prep — what the salon needs to mix for the colour work coming up, and
 * whether it is on the shelf. The screen is built so the answer is readable at
 * a glance: shortfalls sort to the top and carry the exact deficit, so nobody
 * has to subtract two numbers to find out whether they can start an
 * appointment. It doubles as the morning prep sheet, hence the print action.
 */

const RANGES: { value: ColourPrepRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'custom', label: 'Custom' },
];

const STATE_LABEL: Record<ColourPrepStockState, string> = {
  sufficient: 'In stock',
  low_stock: 'Low stock',
  shortfall: 'Short',
  not_stocked: 'Not stocked here',
  unmapped_product: 'Not linked',
};

const STATE_TONE: Record<ColourPrepStockState, 'success' | 'warning' | 'danger'> = {
  sufficient: 'success',
  low_stock: 'warning',
  shortfall: 'danger',
  not_stocked: 'danger',
  unmapped_product: 'warning',
};

/** Explains what the user should actually do about each state. */
const STATE_HINT: Record<ColourPrepStockState, string> = {
  sufficient: 'Enough on the shelf for the appointments in this range.',
  low_stock: 'Enough for now, but this drops to or below the reorder threshold.',
  shortfall: 'Not enough to complete these appointments.',
  not_stocked: 'This product has never been stocked at this location.',
  unmapped_product:
    'This formula line was never linked to a catalogue product, so stock cannot be checked.',
};

/** Shortfalls first — the order a prep bench triages in. */
const STATE_SEVERITY: Record<ColourPrepStockState, number> = {
  shortfall: 0,
  not_stocked: 1,
  unmapped_product: 2,
  low_stock: 3,
  sufficient: 4,
};

function formatQuantity(value: number, unit: StockUnit): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  if (unit === 'unit') return `${text} ${rounded === 1 ? 'item' : 'items'}`;
  return `${text}${unit === 'millilitre' ? 'ml' : 'g'}`;
}

function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ColourPrepPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const { resolvedLocationId, locations } = useLocationScope();

  // URL-synced so a prep view can be pasted into a message and open the same
  // range for the same salon — the shareable-link pattern from Week 5.
  const [searchParams, setSearchParams] = useSearchParams();
  const range = (searchParams.get('range') as ColourPrepRange | null) ?? 'today';
  const from = searchParams.get('from') ?? todayIso();
  const to = searchParams.get('to') ?? todayIso();

  const [plan, setPlan] = useState<ColourPrepPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setRange = useCallback(
    (next: ColourPrepRange) => {
      const params = new URLSearchParams(searchParams);
      params.set('range', next);
      if (next === 'custom') {
        params.set('from', from);
        params.set('to', to);
      } else {
        params.delete('from');
        params.delete('to');
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams, from, to],
  );

  const setCustomDate = useCallback(
    (key: 'from' | 'to', value: string) => {
      const params = new URLSearchParams(searchParams);
      params.set('range', 'custom');
      params.set(key, value);
      if (!params.get('from')) params.set('from', value);
      if (!params.get('to')) params.set('to', value);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const reload = useCallback(() => {
    if (!accessToken || !resolvedLocationId) return () => undefined;
    let cancelled = false;

    setLoading(true);
    setError(null);
    getColourPrep(accessToken, {
      locationId: resolvedLocationId,
      range,
      ...(range === 'custom' ? { from, to } : {}),
    })
      .then((response) => {
        if (!cancelled) setPlan(response.plan);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPlan(null);
        setError(cause instanceof Error ? cause.message : 'Unable to load colour preparation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, resolvedLocationId, range, from, to]);

  useEffect(() => reload(), [reload]);

  const sortedProducts = useMemo(
    () =>
      [...(plan?.products ?? [])].sort(
        (a, b) =>
          STATE_SEVERITY[a.state] - STATE_SEVERITY[b.state] ||
          b.requiredGrams - a.requiredGrams,
      ),
    [plan],
  );
  const attentionCount = useMemo(
    () => sortedProducts.filter((product) => product.state !== 'sufficient').length,
    [sortedProducts],
  );

  const appointmentsByDay = useMemo(() => {
    if (!plan) return [] as { day: string; entries: ColourPrepAppointment[] }[];
    const groups = new Map<string, ColourPrepAppointment[]>();
    for (const appointment of plan.appointments) {
      const day = formatDay(appointment.scheduledStartAt, plan.timezone);
      const entries = groups.get(day) ?? [];
      entries.push(appointment);
      groups.set(day, entries);
    }
    return Array.from(groups.entries()).map(([day, entries]) => ({ day, entries }));
  }, [plan]);

  if (!resolvedLocationId) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
        <EmptyCard
          title={locations.length === 0 ? 'No locations yet' : 'Choose a location'}
          body={
            locations.length === 0
              ? 'No locations are available for your account yet.'
              : 'Pick a location in the sidebar to see what needs preparing.'
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      {/* Header */}
      <header className="mb-6 flex flex-col gap-4 print:mb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Colour prep</h1>
          <p className="mt-1 max-w-lg text-[13px] text-text-secondary">
            What the upcoming colour appointments need mixed, and whether it is on the shelf.
          </p>
          {plan ? (
            <p className="mt-1.5 text-[12px] text-text-muted">
              {plan.locationName} · {plan.fromDate}
              {plan.fromDate === plan.toDate ? '' : ` → ${plan.toDate}`} · quantities include a{' '}
              {plan.wasteAllowancePercent}% waste allowance
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 print:hidden sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setRange(option.value)}
                aria-pressed={range === option.value}
                className={`h-9 rounded-pill border px-4 text-[13px] font-medium transition ${
                  range === option.value
                    ? 'border-primary bg-primary-soft text-primary-deep'
                    : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt hover:text-text-primary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-9 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-semibold text-text-primary transition hover:bg-surface-alt"
          >
            <PrintIcon className="h-4 w-4" />
            Print prep sheet
          </button>
        </div>
      </header>

      {range === 'custom' ? (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-card-lg border border-border bg-surface px-4 py-3 print:hidden">
          <span className="text-[13px] font-medium text-text-secondary">Custom range</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => setCustomDate('from', event.target.value)}
            aria-label="From date"
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
          />
          <span className="text-[13px] text-text-secondary">to</span>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(event) => setCustomDate('to', event.target.value)}
            aria-label="To date"
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
          />
          <span className="text-[12px] text-text-muted">Inclusive salon days.</span>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading && !plan ? <EmptyCard title="Loading colour prep…" body="Resolving appointments, formulas and stock." /> : null}

      {plan ? (
        <>
          {/* KPI strip */}
          <section className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Colour appointments"
              value={String(plan.summary.appointmentCount)}
              icon={<CalendarIcon className="h-4 w-4 text-primary" />}
              hint="in the selected range"
            />
            <KpiCard
              label="Need consultation"
              value={String(plan.summary.appointmentsWithoutFormula)}
              icon={<PersonIcon className="h-4 w-4 text-warning" />}
              badge={
                plan.summary.appointmentsWithoutFormula > 0
                  ? { label: 'No formula', tone: 'warning' }
                  : undefined
              }
              hint="first-time colour clients"
            />
            <KpiCard
              label="Products short"
              value={String(plan.summary.shortfallProductCount)}
              icon={<AlertIcon className="h-4 w-4 text-danger" />}
              badge={plan.summary.shortfallProductCount > 0 ? { label: 'Order now', tone: 'danger' } : undefined}
              hint="cannot cover the range"
            />
            <KpiCard
              label="Running low"
              value={String(plan.summary.lowStockProductCount)}
              icon={<TrendDownIcon className="h-4 w-4 text-warning" />}
              badge={plan.summary.lowStockProductCount > 0 ? { label: 'Watch', tone: 'warning' } : undefined}
              hint="drops to the threshold"
            />
          </section>

          {plan.appointments.length === 0 ? (
            <div className="rounded-card-lg border border-border bg-surface px-6 py-12 text-center shadow-card">
              <div className="text-[15px] font-semibold text-text-primary">
                No colour appointments in this range
              </div>
              <p className="mx-auto mt-1.5 max-w-md text-[13px] text-text-secondary">
                Colour Prep only lists appointments whose service category is tagged as colour
                work. If an appointment you expected is missing, set the &ldquo;Colour billing
                category&rdquo; on its category under{' '}
                <Link to="/services/categories" className="font-medium text-primary-deep hover:underline">
                  Service management → Categories
                </Link>
                .
              </p>
            </div>
          ) : (
            <>
              {/* Mixing list */}
              <section className="mb-8 rounded-card-lg border border-border bg-surface shadow-card">
                <div className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-[15px] font-semibold text-text-primary">Mixing list</div>
                    <div className="mt-0.5 text-[13px] text-text-secondary">
                      {attentionCount > 0
                        ? `${attentionCount} of ${sortedProducts.length} products need attention before this range starts.`
                        : `All ${sortedProducts.length} products are covered by shelf stock.`}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-[12px] text-text-secondary print:hidden">
                    <LegendDot className="bg-success-fill" label="In stock" />
                    <LegendDot className="bg-warning-fill" label="Low / unlinked" />
                    <LegendDot className="bg-danger-fill" label="Short" />
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-[13px]">
                    <thead className="border-b border-border bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                      <tr>
                        <th className="px-5 py-3 font-medium">Product</th>
                        <th className="px-5 py-3 text-right font-medium">Required</th>
                        <th className="px-5 py-3 text-right font-medium">On shelf</th>
                        <th className="px-5 py-3 text-right font-medium">Shortfall</th>
                        <th className="px-5 py-3 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sortedProducts.map((product) => (
                        <ProductRow
                          key={product.productId ?? `unmapped-${product.productName}`}
                          product={product}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Schedule */}
              <section className="rounded-card-lg border border-border bg-surface shadow-card">
                <div className="border-b border-border px-5 py-4">
                  <div className="text-[15px] font-semibold text-text-primary">Appointment schedule</div>
                  <div className="mt-0.5 text-[13px] text-text-secondary">
                    Per-client formulas resolved from their latest saved QLAB formula.
                  </div>
                </div>
                {appointmentsByDay.map((group) => (
                  <div key={group.day}>
                    <div className="border-b border-border bg-surface-alt px-5 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                      {group.day}
                    </div>
                    <ul className="divide-y divide-border">
                      {group.entries.map((appointment) => (
                        <AppointmentRow
                          key={appointment.appointmentId}
                          appointment={appointment}
                          timeZone={plan.timezone}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ProductRow({ product }: { product: ColourPrepProductRequirement }) {
  const tone = STATE_TONE[product.state];
  const dot =
    tone === 'success' ? 'bg-success-fill' : tone === 'warning' ? 'bg-warning-fill' : 'bg-danger-fill';
  return (
    <tr className="transition hover:bg-surface-alt">
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <div>
            <div className="font-medium text-text-primary">{product.productName}</div>
            <div className="text-[12px] text-text-muted">
              {[product.brand, `${product.appointmentCount} appointment${product.appointmentCount === 1 ? '' : 's'}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
      </td>
      <td className="px-5 py-3.5 text-right font-semibold tabular-nums text-text-primary">
        {formatQuantity(product.requiredGrams, product.stockUnit)}
      </td>
      <td className="px-5 py-3.5 text-right tabular-nums text-text-secondary">
        {product.state === 'unmapped_product' ? '—' : formatQuantity(product.onHandGrams, product.stockUnit)}
      </td>
      <td className="px-5 py-3.5 text-right tabular-nums">
        {product.shortfallGrams > 0 ? (
          <span className="font-semibold text-danger">
            {formatQuantity(product.shortfallGrams, product.stockUnit)}
          </span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </td>
      <td className="px-5 py-3.5">
        <span title={STATE_HINT[product.state]}>
          <StatusPill label={STATE_LABEL[product.state]} tone={tone} />
        </span>
      </td>
    </tr>
  );
}

function AppointmentRow({
  appointment,
  timeZone,
}: {
  appointment: ColourPrepAppointment;
  timeZone: string;
}) {
  const needsConsultation = appointment.state === 'no_formula_on_file';
  return (
    <li className="flex gap-4 px-5 py-4">
      <div className="w-14 shrink-0 pt-0.5 text-[13px] font-semibold tabular-nums text-text-primary">
        {formatClock(appointment.scheduledStartAt, timeZone)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text-primary">{appointment.clientName}</span>
          {needsConsultation ? <StatusPill label="No formula on file" tone="warning" /> : null}
        </div>
        <div className="mt-0.5 text-[13px] text-text-secondary">
          {appointment.serviceNames.join(', ')}
          {appointment.stylistName ? ` · with ${appointment.stylistName}` : ''}
        </div>
        {appointment.formulaChange ? (
          <FormulaChangeFlag assessment={appointment.formulaChange} variant="inline" />
        ) : null}
        {needsConsultation ? (
          <p className="mt-1.5 text-[12px] text-text-muted">
            No saved formula, so nothing can be pre-weighed — allow consultation time.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {appointment.items.map((item, index) => (
              <span
                key={`${appointment.appointmentId}-${item.productId ?? item.productName}-${index}`}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-alt px-2.5 py-1 text-[12px] text-text-secondary"
              >
                {item.productName}
                <span className="font-semibold tabular-nums text-text-primary">
                  {Math.round(item.requiredGrams * 10) / 10}g
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function KpiCard({
  label,
  value,
  icon,
  hint,
  badge,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  hint?: string;
  badge?: { label: string; tone: 'warning' | 'danger' };
}) {
  return (
    <div className="rounded-card-lg border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-input bg-surface-alt">{icon}</span>
      </div>
      <div className="mt-2 text-[28px] font-semibold leading-none tabular-nums text-text-primary">{value}</div>
      <div className="mt-2 flex items-center gap-2">
        {badge ? <StatusPill label={badge.label} tone={badge.tone} /> : null}
        {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'success' | 'warning' | 'danger' }) {
  const cls =
    tone === 'success'
      ? 'border-success-border bg-success-soft text-success'
      : tone === 'warning'
        ? 'border-warning-border bg-warning-soft text-warning'
        : 'border-danger-border bg-danger-soft text-danger';
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}

function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-card-lg border border-border bg-surface px-6 py-12 text-center shadow-card">
      <div className="text-[15px] font-semibold text-text-primary">{title}</div>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-text-secondary">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline icons (no icon dependency in the web app)
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function CalendarIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function PersonIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function AlertIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function TrendDownIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 7 6 6 4-4 8 8" />
      <path d="M17 17h4v-4" />
    </svg>
  );
}

function PrintIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}
