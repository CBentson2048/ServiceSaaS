import type {
  CashUpAmount,
  CashUpDayRow,
  CashUpDetailPage,
  CashUpFirstPageBody,
  CashUpReportBody,
  CashUpTenderFigures,
  ResolvedReportLocation,
} from '@sheer/domain';
import { AppButton, AppCard, AppText } from '../../design';
import { formatReportDate } from '../reportScopeLine';
import { usePagedDetail, type LoadMoreResult } from '../usePagedDetail';
import { dayStatusLabel, formatCashUpAmount, formatCount, formatEntered, thresholdLabel } from './cashUpLabels';

export type CashUpFirstPage = CashUpFirstPageBody;

export function isCashUpFirstPage(body: CashUpReportBody): body is CashUpFirstPage {
  return body.continuation === false;
}

export interface CashUpReportProps {
  body: CashUpFirstPage;
  /** The resolved locations, for names. */
  locations: readonly ResolvedReportLocation[];
  loadMore(cursor: string): Promise<LoadMoreResult<CashUpDayRow>>;
}

/**
 * The R7 Cash Up report body. It renders the API's figures as they are — it never
 * adds, subtracts or derives money — and a day without a cash-up, or a figure that
 * can't be compared, reads as words, never £0.00.
 */
export function CashUpReport({ body, locations, loadMore }: CashUpReportProps) {
  const currency = body.currencyCode;
  const money = (amount: CashUpAmount) => formatCashUpAmount(amount, currency);
  const nameOf = (id: string) => locations.find((location) => location.id === id)?.name ?? 'Unknown location';
  const { summary } = body;
  const { recorded } = summary;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Days">
          <Figures
            rows={[
              ['Signed off', String(summary.days.signedOff)],
              ['Not signed off', String(summary.days.open)],
              ['No cash-up recorded', String(summary.days.none)],
              ['Not started', String(summary.days.notStarted)],
            ]}
          />
          <Note>Each location counts its own local days. Today counts as started.</Note>
        </Section>

        <Section title="Signed-off days, as recorded">
          <TenderTable caption="Signed-off tills by tender" cash={recorded.cash} card={recorded.card} format={money} />
          <Figures
            rows={[
              ['Variance, both tenders', money(recorded.variance)],
              ['Petty cash out', money(recorded.pettyCashOut)],
              ['Refunds entered at cash-up', formatEntered(recorded.refundsEntered, currency)],
              ['Voids entered at cash-up', formatEntered(recorded.voidsEntered, currency)],
              ['Days outside threshold', formatCount(recorded.daysOutsideThreshold)],
            ]}
          />
          <Note>
            Variance is counted minus expected, as recorded at sign-off. The opening float and petty cash are not part of it.
            Days outside threshold use each location’s threshold today.
          </Note>
          {recorded.daysUnavailable > 0 ? (
            <Note>
              {recorded.daysUnavailable === 1
                ? '1 signed-off day is not included: its End of Day figures can’t be compared with the location’s own day.'
                : `${recorded.daysUnavailable} signed-off days are not included: their End of Day figures can’t be compared with the location’s own day.`}
            </Note>
          ) : null}
        </Section>

        <Section title="Changed since sign-off">
          <Figures
            rows={[
              ['Days changed', formatCount(summary.sourceCheck.daysChanged)],
              ['Cash', money(summary.sourceCheck.cashChange)],
              ['Card', money(summary.sourceCheck.cardChange)],
            ]}
          />
          <Note>Takings recorded for a signed-off day now, minus what was expected at sign-off — for example a payment taken after sign-off.</Note>
        </Section>

        <Section title="Takings without a signed-off cash-up">
          <Figures
            rows={[
              ['Expected cash', money(summary.withoutSignOff.expectedCash)],
              ['Expected card', money(summary.withoutSignOff.expectedCard)],
            ]}
          />
          <Note>Till payments and retail sales on days that were not signed off, today included.</Note>
        </Section>

        <Section title="Retail outside the till">
          <Figures
            rows={[
              ['Paid by other method', money(summary.retailOutsideTill.other)],
              ['Payment method not recorded', money(summary.retailOutsideTill.notRecorded)],
            ]}
          />
          <Note>These sales are not in expected cash or card, and are never guessed into either.</Note>
        </Section>
      </div>

      {body.locations.length > 1 ? <LocationTable body={body} nameOf={nameOf} /> : null}

      {body.detail ? <CashUpDetail initial={body.detail} nameOf={nameOf} loadMore={loadMore} /> : null}
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

function TenderTable({
  caption,
  cash,
  card,
  format,
}: {
  caption: string;
  cash: CashUpTenderFigures;
  card: CashUpTenderFigures;
  format: (amount: CashUpAmount) => string;
}) {
  return (
    <table className="w-full text-[14px]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-text-secondary">
          <th scope="col" className="py-1 pr-3 font-medium">
            Tender
          </th>
          {['Expected', 'Counted', 'Variance'].map((label) => (
            <th key={label} scope="col" className="py-1 pl-3 text-right font-medium">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(
          [
            ['Cash', cash],
            ['Card', card],
          ] as const
        ).map(([label, figures]) => (
          <tr key={label} className="border-t border-border">
            <th scope="row" className="py-1 pr-3 text-left font-medium">
              {label}
            </th>
            <td className="py-1 pl-3 text-right tabular-nums">{format(figures.expected)}</td>
            <td className="py-1 pl-3 text-right tabular-nums">{format(figures.counted)}</td>
            <td className="py-1 pl-3 text-right tabular-nums">{format(figures.variance)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LocationTable({ body, nameOf }: { body: CashUpFirstPage; nameOf: (id: string) => string }) {
  return (
    <AppCard padding="md">
      <section aria-label="By location" className="flex flex-col gap-2">
        <AppText as="h2" variant="subtitle" weight="medium">
          By location
        </AppText>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <caption className="sr-only">Cash up by location</caption>
            <thead>
              <tr className="text-left text-text-secondary">
                {['Location', 'Signed off', 'Not signed off', 'No cash-up', 'Variance', 'Outside threshold', 'Threshold today'].map((label, index) => (
                  <th key={label} scope="col" className={`py-1 pr-4 font-medium ${index > 0 ? 'text-right' : ''}`}>
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
                  <td className="py-1 pr-4 text-right tabular-nums">{row.totals.days.signedOff}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{row.totals.days.open}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{row.totals.days.none}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{formatCashUpAmount(row.totals.recorded.variance, row.currencyCode)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{formatCount(row.totals.recorded.daysOutsideThreshold)}</td>
                  <td className="py-1 pr-4 text-right tabular-nums">{formatCashUpAmount(row.threshold, row.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppCard>
  );
}

const DETAIL_COLUMNS = [
  'Date',
  'Location',
  'Status',
  'Takings cash',
  'Takings card',
  'Expected cash',
  'Counted cash',
  'Cash variance',
  'Expected card',
  'Counted card',
  'Card variance',
  'Variance',
  'Threshold',
  'Petty cash out',
  'Signed off',
  'Changed since sign-off',
  'Notes',
];

function CashUpDetail({
  initial,
  nameOf,
  loadMore,
}: {
  initial: CashUpDetailPage;
  nameOf: (id: string) => string;
  loadMore(cursor: string): Promise<LoadMoreResult<CashUpDayRow>>;
}) {
  const { rows, cursor, state, more, actionRef, sectionRef } = usePagedDetail(initial, loadMore);

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
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Cash up by location and day</caption>
              <thead>
                <tr className="text-left text-text-secondary">
                  {DETAIL_COLUMNS.map((label) => (
                    <th key={label} scope="col" className="py-1 pr-4 font-medium whitespace-nowrap">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DayRow key={row.rowKey} row={row} locationName={nameOf(row.locationId)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p aria-live="polite" className="sr-only">
          {initial.notStarted ? '' : `Showing ${rows.length} ${rows.length === 1 ? 'day' : 'days'}`}
        </p>
        {state === 'error' ? (
          <div role="alert">
            <AppText as="p" variant="caption" tone="danger">
              We couldn’t load more days.
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

function DayRow({ row, locationName }: { row: CashUpDayRow; locationName: string }) {
  const f = (amount: CashUpAmount) => formatCashUpAmount(amount, row.currencyCode);
  const record = row.record;
  const blank = '—';
  const cell = (value: string, right = true) => <td className={`py-1 pr-4 whitespace-nowrap ${right ? 'text-right tabular-nums' : ''}`}>{value}</td>;
  return (
    <tr className="border-t border-border align-top">
      {cell(formatReportDate(row.localDate), false)}
      {cell(locationName, false)}
      {cell(dayStatusLabel(row), false)}
      {cell(f(row.sources.expectedCash))}
      {cell(f(row.sources.expectedCard))}
      {cell(record ? f(record.cash.expected) : blank)}
      {cell(record ? f(record.cash.counted) : blank)}
      {cell(record ? f(record.cash.variance) : blank)}
      {cell(record ? f(record.card.expected) : blank)}
      {cell(record ? f(record.card.counted) : blank)}
      {cell(record ? f(record.card.variance) : blank)}
      {cell(record ? f(record.variance) : blank)}
      {cell(record ? thresholdLabel(record.outsideThreshold) : blank, false)}
      {cell(record ? f(record.pettyCashOut) : blank)}
      {cell(
        record?.signedOff
          ? `${formatReportDate(record.signedOff.localDate)} ${record.signedOff.localTime}${record.signedOffBy ? ` · ${record.signedOffBy}` : ''}`
          : blank,
        false,
      )}
      {cell(row.changeSinceSignOff ? `Cash ${f(row.changeSinceSignOff.cash)} · Card ${f(row.changeSinceSignOff.card)}` : blank, false)}
      <td className="py-1 pr-4 text-text-secondary">{record?.notes ?? ''}</td>
    </tr>
  );
}
