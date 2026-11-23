import { useEffect, useRef, useState } from 'react';
import type {
  MoneyAmount,
  MoneyDetailPage,
  MoneyDetailRow,
  MoneyFirstPageBody,
  MoneyReportBody,
  MoneyTotals,
  ResolvedReportLocation,
} from '@sheer/domain';
import { AppButton, AppCard, AppText } from '../../design';
import { formatReportDate } from '../reportScopeLine';
import {
  COMPOSITION_LABELS,
  DETAIL_KIND_LABELS,
  NOT_RECORDED_LABELS,
  RETAIL_METHOD_LABELS,
  SETTLEMENT_LABELS,
  formatMoneyAmount,
} from './moneyLabels';

/** A first page: the whole report (a continuation page carries only detail rows). */
export type MoneyFirstPage = MoneyFirstPageBody;

export function isMoneyFirstPage(body: MoneyReportBody): body is MoneyFirstPage {
  return body.continuation === false;
}

export interface MoneyReportProps {
  body: MoneyFirstPage;
  /** The resolved locations, for names. */
  locations: readonly ResolvedReportLocation[];
  /**
   * Fetch the next detail page for the current filter. `'reloading'`: the cursor
   * belongs to dates the filter no longer names, and a fresh first page is on its
   * way (it arrives as a new `body`).
   */
  loadMore(cursor: string): Promise<MoneyDetailPage | 'reloading' | null>;
}

/**
 * The R1 Money report body. It renders the API's figures as they are — it never
 * adds, subtracts or derives money — and a figure Service SaaS does not record reads
 * "Not recorded", never £0.00.
 */
export function MoneyReport({ body, locations, loadMore }: MoneyReportProps) {
  const currency = body.currencyCode;
  const money = (amount: MoneyAmount) => formatMoneyAmount(amount, currency);
  const nameOf = (id: string) => locations.find((location) => location.id === id)?.name ?? 'Unknown location';
  const { summary } = body;
  const coverage = body.coverage.tillPaymentsWithoutBill;
  const coverageMoney = formatMoneyAmount(coverage.amount, coverage.currencyCode);

  return (
    <div className="flex flex-col gap-4">
      {coverage.count > 0 ? (
        <AppCard padding="md" variant="warning" elevation="none" role="status">
          <AppText as="p" variant="body">
            {coverage.count === 1
              ? `1 till payment (${coverageMoney}) has no paid bill yet, so it is not in paid bill revenue below.`
              : `${coverage.count} till payments (${coverageMoney}) have no paid bill yet, so they are not in paid bill revenue below.`}
          </AppText>
        </AppCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Paid bill revenue">
          <Figures
            rows={[
              ['Gross (VAT included)', money(summary.paidBills.gross)],
              ['Net of VAT', money(summary.paidBills.netOfVat)],
              ['VAT', money(summary.paidBills.vat)],
            ]}
          />
          <Note>Net of VAT is the bills’ recorded ex-VAT total. It is not profit.</Note>
        </Section>

        <Section title="What paid bills were made of">
          <Figures rows={summary.composition.map((item) => [COMPOSITION_LABELS[item.key], money(item.gross)])} />
          <Note>Colour is part of paid bill revenue, not added to it.</Note>
        </Section>

        <Section title="How paid bills were settled">
          <Figures rows={summary.settlement.map((item) => [SETTLEMENT_LABELS[item.key], money(item.amount)])} />
        </Section>

        <Section title="Retail">
          <Figures
            rows={[
              ['Retail sales recorded', money(summary.retail.recorded)],
              ['VAT on retail', money(summary.retail.vat)],
              ...summary.retail.byMethod.map((item): [string, string] => [RETAIL_METHOD_LABELS[item.key], money(item.amount)]),
            ]}
          />
          <Note>Retail is recorded separately from paid bills and is not included in paid bill revenue.</Note>
        </Section>

        <Section title="Deposits">
          <Figures
            rows={[
              ['Collected', money(summary.deposits.collected)],
              ['Redeemed on paid bills', money(summary.deposits.redeemed)],
              ['Refunded in Service SaaS', money(summary.deposits.refunded)],
            ]}
          />
          <Note>Deposits are separate events and are not added to revenue. Redeemed deposits are already inside paid bill revenue.</Note>
        </Section>

        <Section title="Not recorded by Service SaaS">
          <Figures
            rows={[
              ['Net position', money(summary.netPosition)],
              ...body.notRecorded.map((category): [string, string] => [NOT_RECORDED_LABELS[category], 'Not recorded']),
            ]}
          />
        </Section>
      </div>

      {body.locations.length > 1 ? <LocationTable body={body} nameOf={nameOf} /> : null}

      {body.detail ? <MoneyDetail initial={body.detail} nameOf={nameOf} loadMore={loadMore} /> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AppCard padding="md">
      <section aria-label={title} className="flex flex-col gap-2">
        <AppText as="h2" variant="subtitle" weight="medium">
          {title}
        </AppText>
        {children}
      </section>
    </AppCard>
  );
}

function Figures({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[14px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="text-right font-medium tabular-nums text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <AppText as="p" variant="caption" tone="muted">
      {children}
    </AppText>
  );
}

const LOCATION_COLUMNS: Array<[string, (t: MoneyTotals) => MoneyAmount]> = [
  ['Gross', (t) => t.paidBills.gross],
  ['Net of VAT', (t) => t.paidBills.netOfVat],
  ['VAT', (t) => t.paidBills.vat],
  ['Retail', (t) => t.retail.recorded],
  ['Deposits collected', (t) => t.deposits.collected],
  ['Deposits redeemed', (t) => t.deposits.redeemed],
];

function LocationTable({ body, nameOf }: { body: MoneyFirstPage; nameOf: (id: string) => string }) {
  return (
    <AppCard padding="md">
      <section aria-label="By location" className="flex flex-col gap-2">
        <AppText as="h2" variant="subtitle" weight="medium">
          By location
        </AppText>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <caption className="sr-only">Money by location</caption>
            <thead>
              <tr className="text-left text-text-secondary">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Location
                </th>
                {LOCATION_COLUMNS.map(([label]) => (
                  <th key={label} scope="col" className="py-1 pr-4 text-right font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.locations.map((row) => (
                <tr key={row.locationId} className="border-t border-border">
                  <th scope="row" className="py-1 pr-4 text-left font-medium">
                    {nameOf(row.locationId)}
                  </th>
                  {LOCATION_COLUMNS.map(([label, pick]) => (
                    <td key={label} className="py-1 pr-4 text-right tabular-nums">
                      {formatMoneyAmount(pick(row.totals), row.currencyCode)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppCard>
  );
}

function MoneyDetail({
  initial,
  nameOf,
  loadMore,
}: {
  initial: MoneyDetailPage;
  nameOf: (id: string) => string;
  loadMore(cursor: string): Promise<MoneyDetailPage | 'reloading' | null>;
}) {
  const [rows, setRows] = useState<MoneyDetailRow[]>(initial.rows);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  /** Bumped on every reset: a Load more that began before it must not append. */
  const generation = useRef(0);
  /** One action button (Load more, Loading…, Retry) keeps keyboard focus across states. */
  const actionRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /**
   * The action had focus when it went away (the last page arrived, or a reload
   * replaced the list): move focus to the list on the next rows render, not to
   * the page body.
   */
  const focusList = useRef(false);
  /** A stale Load more asked the page to reload while the action had focus. */
  const focusAfterReload = useRef(false);

  // A new first page (a new filter or a refresh) starts the list again.
  useEffect(() => {
    generation.current += 1;
    focusList.current = focusAfterReload.current;
    focusAfterReload.current = false;
    setRows(initial.rows);
    setCursor(initial.nextCursor);
    setState('idle');
  }, [initial]);

  useEffect(() => {
    if (focusList.current) {
      focusList.current = false;
      sectionRef.current?.focus({ preventScroll: true });
    }
  }, [rows]);

  const more = () => {
    if (cursor === null || state === 'loading') return;
    const started = generation.current;
    setState('loading');
    loadMore(cursor).then(
      (page) => {
        if (generation.current !== started) return;
        if (page === 'reloading') {
          // Keep showing Loading…: the report reloads for its current dates and replaces this list.
          focusAfterReload.current = document.activeElement === actionRef.current;
          return;
        }
        if (!page) {
          setState('error');
          return;
        }
        if (page.nextCursor === null && document.activeElement === actionRef.current) focusList.current = true;
        setRows((current) => [...current, ...page.rows]);
        setCursor(page.nextCursor);
        setState('idle');
      },
      () => {
        if (generation.current === started) setState('error');
      },
    );
  };

  return (
    <AppCard padding="md">
      <section ref={sectionRef} tabIndex={-1} aria-label="Detail" className="flex flex-col gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <AppText as="h2" variant="subtitle" weight="medium">
          Detail
        </AppText>
        {initial.notStarted ? (
          <AppText as="p" variant="body" tone="secondary">
            These dates have not started yet.
          </AppText>
        ) : rows.length === 0 ? (
          <AppText as="p" variant="body" tone="secondary">
            Nothing was recorded for these dates.
          </AppText>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Money detail rows</caption>
              <thead>
                <tr className="text-left text-text-secondary">
                  {['Date', 'Time', 'Location', 'Type', 'Reference', 'Amount', 'Breakdown'].map((label) => (
                    <th key={label} scope="col" className="py-1 pr-4 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.rowKey} className="border-t border-border align-top">
                    <td className="py-1 pr-4 whitespace-nowrap">{formatReportDate(row.localDate)}</td>
                    <td className="py-1 pr-4 tabular-nums">{row.localTime}</td>
                    <td className="py-1 pr-4">{nameOf(row.locationId)}</td>
                    <td className="py-1 pr-4">{DETAIL_KIND_LABELS[row.kind]}</td>
                    <td className="py-1 pr-4">{row.kind === 'paid_bill' ? `Bill ${row.billNumber}` : ''}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">{formatMoneyAmount(row.amount, row.currencyCode)}</td>
                    <td className="py-1 pr-4 text-text-secondary">{breakdown(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p aria-live="polite" className="sr-only">
          {initial.notStarted ? '' : `Showing ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
        </p>
        {state === 'error' ? (
          <div role="alert">
            <AppText as="p" variant="caption" tone="danger">
              We couldn’t load more rows.
            </AppText>
          </div>
        ) : null}
        {cursor !== null ? (
          <div>
            {/* aria-disabled, not disabled: a disabled button would drop keyboard focus while loading. */}
            <AppButton ref={actionRef} size="sm" variant="secondary" onClick={more} aria-disabled={state === 'loading' || undefined}>
              {state === 'error' ? 'Retry' : state === 'loading' ? 'Loading…' : 'Load more'}
            </AppButton>
          </div>
        ) : null}
      </section>
    </AppCard>
  );
}

function breakdown(row: MoneyDetailRow): string {
  const f = (amount: MoneyAmount) => formatMoneyAmount(amount, row.currencyCode);
  switch (row.kind) {
    case 'paid_bill':
      return [
        `Net ${f(row.netOfVat)}`,
        `VAT ${f(row.vat)}`,
        `Colour ${f(row.colour)}`,
        `Cash ${f(row.cash)}`,
        `Card reader ${f(row.cardReader)}`,
        `Deposit applied ${f(row.depositApplied)}`,
      ].join(' · ');
    case 'retail_sale':
      return `Qty ${row.quantity} · ${RETAIL_METHOD_LABELS[row.method]}`;
    default:
      return '';
  }
}
