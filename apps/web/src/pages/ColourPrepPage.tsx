import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { useLocationScope } from '../components/LocationScopeContext';
import { AppCard, AppText, StatusBadge } from '../design/components';
import type { StatusTone } from '../design/components/StatusBadge';

/**
 * Colour Prep — what the salon needs to mix for the colour work coming up, and
 * whether it is on the shelf. The screen is built so the answer is readable at a
 * glance: shortfalls sort to the top and carry the exact deficit, so nobody has
 * to subtract two numbers to find out whether they can start an appointment.
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
  unmapped_product: 'Not linked to a product',
};

const STATE_TONE: Record<ColourPrepStockState, StatusTone> = {
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
  unmapped_product: 'This formula line was never linked to a catalogue product, so stock cannot be checked.',
};

function formatQuantity(value: number, unit: StockUnit): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  if (unit === 'unit') return `${text} ${rounded === 1 ? 'item' : 'items'}`;
  return `${text}${unit === 'millilitre' ? 'ml' : 'g'}`;
}

function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
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

  useEffect(() => {
    if (!accessToken || !resolvedLocationId) return;
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

  const needsAttention = useMemo(
    () => (plan?.products ?? []).filter((product) => product.state !== 'sufficient'),
    [plan],
  );

  if (!resolvedLocationId) {
    return (
      <AppCard className="p-6">
        <AppText variant="body">
          {locations.length === 0
            ? 'No locations are available for your account yet.'
            : 'Choose a location to see what needs preparing.'}
        </AppText>
      </AppCard>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <div>
          <AppText variant="heading">Colour prep</AppText>
          <AppText variant="caption" className="text-text-secondary">
            What the upcoming colour appointments need, and whether it is on the shelf.
          </AppText>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {RANGES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRange(option.value)}
              aria-pressed={range === option.value}
              className={`rounded-pill px-3 py-1.5 text-sm transition ${
                range === option.value
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-alt text-text-secondary hover:text-text-primary'
              }`}
            >
              {option.label}
            </button>
          ))}

          {range === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-sm text-text-secondary">
                <span className="sr-only">From</span>
                <input
                  type="date"
                  value={from}
                  max={to}
                  onChange={(event) => setCustomDate('from', event.target.value)}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
                />
              </label>
              <span className="text-text-secondary">to</span>
              <label className="flex items-center gap-1 text-sm text-text-secondary">
                <span className="sr-only">To</span>
                <input
                  type="date"
                  value={to}
                  min={from}
                  onChange={(event) => setCustomDate('to', event.target.value)}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
                />
              </label>
            </div>
          ) : null}
        </div>

        {plan ? (
          <AppText variant="caption" className="text-text-secondary">
            {plan.locationName} · {plan.fromDate}
            {plan.fromDate === plan.toDate ? '' : ` to ${plan.toDate}`} · required quantities include a{' '}
            {plan.wasteAllowancePercent}% waste allowance
          </AppText>
        ) : null}
      </header>

      {error ? (
        <AppCard className="border-danger p-4">
          <AppText variant="body" className="text-danger">
            {error}
          </AppText>
        </AppCard>
      ) : null}

      {loading ? (
        <AppCard className="p-6">
          <AppText variant="body">Loading colour prep…</AppText>
        </AppCard>
      ) : null}

      {!loading && plan ? (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryTile label="Colour appointments" value={plan.summary.appointmentCount} />
            <SummaryTile
              label="Need consultation"
              value={plan.summary.appointmentsWithoutFormula}
              tone={plan.summary.appointmentsWithoutFormula > 0 ? 'warning' : undefined}
            />
            <SummaryTile
              label="Products short"
              value={plan.summary.shortfallProductCount}
              tone={plan.summary.shortfallProductCount > 0 ? 'danger' : undefined}
            />
            <SummaryTile
              label="Running low"
              value={plan.summary.lowStockProductCount}
              tone={plan.summary.lowStockProductCount > 0 ? 'warning' : undefined}
            />
          </section>

          {plan.appointments.length === 0 ? (
            <AppCard className="p-6">
              <AppText variant="body">
                No colour appointments in this range.
              </AppText>
              <AppText variant="caption" className="mt-1 text-text-secondary">
                Colour Prep only lists appointments whose service category is tagged as colour work.
                If something is missing, check the category on the service.
              </AppText>
            </AppCard>
          ) : (
            <>
              <ProductTable
                title={needsAttention.length > 0 ? 'Needs attention' : 'Products required'}
                products={needsAttention.length > 0 ? needsAttention : plan.products}
              />
              {needsAttention.length > 0 ? (
                <ProductTable title="Everything else" products={plan.products.filter((p) => p.state === 'sufficient')} />
              ) : null}
              <AppointmentList appointments={plan.appointments} timeZone={plan.timezone} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warning' | 'danger';
}) {
  const colour = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-text-primary';
  return (
    <AppCard className="p-4">
      <AppText variant="caption" className="text-text-secondary">
        {label}
      </AppText>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${colour}`}>{value}</p>
    </AppCard>
  );
}

function ProductTable({
  title,
  products,
}: {
  title: string;
  products: ColourPrepProductRequirement[];
}) {
  if (products.length === 0) return null;
  return (
    <AppCard className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <AppText variant="title">{title}</AppText>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="bg-surface-alt text-left text-xs uppercase tracking-wide text-text-secondary">
              <th className="px-4 py-2 font-medium">Product</th>
              <th className="px-4 py-2 text-right font-medium">Required</th>
              <th className="px-4 py-2 text-right font-medium">Available</th>
              <th className="px-4 py-2 text-right font-medium">Shortfall</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.productId ?? `unmapped-${product.productName}`} className="border-t border-border">
                <td className="px-4 py-3">
                  <div className="font-medium text-text-primary">{product.productName}</div>
                  <div className="text-xs text-text-secondary">
                    {product.brand ? `${product.brand} · ` : ''}
                    {product.appointmentCount} appointment{product.appointmentCount === 1 ? '' : 's'}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatQuantity(product.requiredGrams, product.stockUnit)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {product.state === 'unmapped_product'
                    ? '—'
                    : formatQuantity(product.onHandGrams, product.stockUnit)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {product.shortfallGrams > 0 ? (
                    <span className="font-semibold text-danger">
                      {formatQuantity(product.shortfallGrams, product.stockUnit)}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge label={STATE_LABEL[product.state]} tone={STATE_TONE[product.state]} />
                  <div className="mt-1 text-xs text-text-secondary">{STATE_HINT[product.state]}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppCard>
  );
}

function AppointmentList({
  appointments,
  timeZone,
}: {
  appointments: ColourPrepAppointment[];
  timeZone: string;
}) {
  return (
    <AppCard className="overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <AppText variant="title">Appointments</AppText>
      </div>
      <ul className="divide-y divide-border">
        {appointments.map((appointment) => (
          <li key={appointment.appointmentId} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className="font-medium text-text-primary">{appointment.clientName}</span>
                <span className="ml-2 text-sm text-text-secondary">
                  {formatTime(appointment.scheduledStartAt, timeZone)}
                </span>
              </div>
              {appointment.state === 'no_formula_on_file' ? (
                <StatusBadge label="No formula on file" tone="warning" />
              ) : null}
            </div>

            <div className="text-sm text-text-secondary">
              {appointment.serviceNames.join(', ')}
              {appointment.stylistName ? ` · ${appointment.stylistName}` : ''}
            </div>

            {appointment.state === 'no_formula_on_file' ? (
              <AppText variant="caption" className="text-text-secondary">
                This client has no saved formula, so nothing can be pre-weighed. Book consultation time.
              </AppText>
            ) : (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-secondary">
                {appointment.items.map((item, index) => (
                  <li key={`${appointment.appointmentId}-${item.productId ?? item.productName}-${index}`}>
                    {item.productName}{' '}
                    <span className="tabular-nums text-text-primary">
                      {Math.round(item.requiredGrams * 10) / 10}g
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </AppCard>
  );
}
