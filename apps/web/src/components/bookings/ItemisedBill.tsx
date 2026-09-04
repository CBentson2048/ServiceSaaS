import type {
  AppointmentCompletionLineItem,
  AppointmentCompletionResponse,
  AppointmentPaymentRecord,
  SalonPaymentMethod,
} from '@sheer/domain';

// Itemised checkout bill — a clean, receipt-style summary of what the salon
// collects at the till. Each service and each colour charge is its own line; a
// deposit already taken shows as a credit with a running subtotal, then the
// balance to collect stands alone in the footer. Shared by the checkout panel
// on the appointment book and the retrievable bill page (/checkout/visits/:id).
//
// VAT is handled automatically server-side: the API still computes the tax
// rollup in billing.tax for records/reporting, but it is intentionally not shown
// here — staff and clients see clean, all-in prices, never a tax breakdown. The
// headline stays exactly billing.balanceDueCents, the only total the
// confirm-payment endpoint settles, so the bill and the charge can never diverge.
export function ItemisedBill({ billing }: { billing: AppointmentCompletionResponse['billing'] }) {
  const cc = billing.currencyCode;
  const hasDeposit = billing.depositPaidCents > 0;

  // Group the API line items into the bill's sections. Anything that isn't a
  // service or colour charge is bucketed into "Other" so no line silently drops.
  const serviceLines = billing.lineItems.filter((line) => line.lineType === 'service');
  const colourLines = billing.lineItems.filter((line) => line.lineType === 'product_usage');
  const otherLines = billing.lineItems.filter(
    (line) => line.lineType !== 'service' && line.lineType !== 'product_usage',
  );

  return (
    <div className="mt-4 overflow-hidden rounded-input-lg border border-border bg-surface-alt/40">
      <div className="flex flex-col gap-5 px-5 py-4">
        <BillGroup
          title="Services"
          lines={serviceLines}
          fallbackLabel="Services"
          fallbackCents={billing.serviceTotalCents}
          currencyCode={cc}
        />

        <BillGroup
          title="Colour charge"
          note="Includes the salon's colour pricing policy."
          lines={colourLines}
          fallbackLabel="Colour charges"
          fallbackCents={billing.productUsageTotalCents}
          currencyCode={cc}
          hideWhenEmpty
        />

        {otherLines.length > 0 ? (
          <BillGroup title="Other charges" lines={otherLines} currencyCode={cc} />
        ) : null}

        {/* With a deposit taken, show the running subtotal and the credit so the
            arithmetic down to the balance stays transparent. */}
        {hasDeposit ? (
          <dl className="flex flex-col gap-1.5 border-t border-border/60 pt-3 text-[13px]">
            <BillRow label="Subtotal" value={formatMoney(billing.totalCents, cc)} />
            <BillRow label="Deposit paid" value={`− ${formatMoney(billing.depositPaidCents, cc)}`} />
          </dl>
        ) : null}
      </div>

      {/* The single figure the salon charges — exactly what confirm-payment settles. */}
      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
        <span className="text-[13px] font-medium text-text-secondary">Total to collect</span>
        <span className="text-[22px] font-semibold text-text-primary tabular-nums">
          {formatMoney(billing.balanceDueCents, cc)}
        </span>
      </div>
    </div>
  );
}

// One labelled group of bill lines (Services / Colour charge / Other). Prefers the
// API's itemised lines; when a completion predates line items it falls back to the
// rolled-up category total so the figure is never lost. An optional group with no
// lines and a zero total is hidden rather than shown empty.
function BillGroup({
  title,
  note,
  lines,
  fallbackLabel,
  fallbackCents = 0,
  currencyCode,
  hideWhenEmpty = false,
}: {
  title: string;
  note?: string;
  lines: AppointmentCompletionLineItem[];
  fallbackLabel?: string;
  fallbackCents?: number;
  currencyCode: string;
  hideWhenEmpty?: boolean;
}) {
  const hasLines = lines.length > 0;
  if (!hasLines && (hideWhenEmpty || fallbackLabel === undefined) && fallbackCents <= 0) {
    return null;
  }
  return (
    <div>
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-secondary">{title}</span>
      {note ? <p className="mt-0.5 text-[11px] text-text-muted">{note}</p> : null}
      <dl className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
        {hasLines ? (
          lines.map((line, index) => (
            <BillRow
              key={`${line.lineType}-${index}`}
              label={line.description}
              value={formatMoney(line.amountCents, currencyCode)}
              // 0110: a service that joined the visit after check-in is marked, so
              // the till shows booked vs performed without a second screen.
              hint={
                line.origin === 'post_checkin_add' || line.origin === 'post_checkin_replace'
                  ? 'added during visit'
                  : undefined
              }
            />
          ))
        ) : (
          <BillRow label={fallbackLabel ?? title} value={formatMoney(fallbackCents, currencyCode)} />
        )}
      </dl>
    </div>
  );
}

export function BillRow({
  label,
  value,
  strong = false,
  muted = false,
  hint,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={muted ? 'text-text-muted' : strong ? 'font-semibold text-text-primary' : 'text-text-secondary'}>
        {label}
        {hint ? <span className="ml-1.5 text-[11px] text-text-muted">· {hint}</span> : null}
      </dt>
      <dd className={`tabular-nums ${muted ? 'text-text-muted' : strong ? 'font-semibold text-text-primary' : 'text-text-primary'}`}>
        {value}
      </dd>
    </div>
  );
}

// How the bill was settled — one row per tender (a split bill has a cash row
// and a card row), each with who-took-it context supplied by the caller.
export function BillPayments({ payments }: { payments: AppointmentPaymentRecord[] }) {
  if (payments.length === 0) return null;
  return (
    <div className="mt-4 rounded-input-lg border border-border bg-surface-alt/40 px-5 py-4">
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-secondary">Payments</span>
      <dl className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
        {payments.map((payment) => (
          <BillRow
            key={payment.id}
            label={formatPaymentMethod(payment.paymentMethod)}
            hint={formatPaidAt(payment.paidAt)}
            value={formatMoney(payment.amountCents, payment.currencyCode)}
          />
        ))}
      </dl>
    </div>
  );
}

function formatPaidAt(paidAt: string): string | undefined {
  const date = new Date(paidAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatPaymentMethod(method: SalonPaymentMethod): string {
  return method === 'card_reader' ? 'Card reader' : 'Cash';
}

export function formatMoney(amountCents: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amountCents / 100);
}
