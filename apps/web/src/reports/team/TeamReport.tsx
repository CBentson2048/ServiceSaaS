import type {
  ResolvedReportLocation,
  TeamCommissionPeriod,
  TeamMetrics,
  TeamReportBody,
  TeamStaffRow,
  TeamTotals,
} from '@sheer/domain';
import type { ReactNode } from 'react';
import { AppCard, AppText } from '../../design';
import { formatReportDate } from '../reportScopeLine';
import {
  COMMISSION_RESTRICTION_TEXT,
  GREATER_OF_TEXT,
  UNAVAILABLE_METRIC_LABELS,
  asAtWhen,
  billsText,
  bookedOfRostered,
  clientsParts,
  currentStatusText,
  formatTeamAmount,
  formatTeamCount,
  formatTeamRatio,
  formerStaffLabel,
  staffName,
  unavailableMetricText,
} from './teamLabels';

export interface TeamReportProps {
  body: TeamReportBody;
  /** The resolved locations, for names. */
  locations: readonly ResolvedReportLocation[];
}

/**
 * The R2 Team report body. It renders the API's figures as they are — it never
 * adds, divides, averages or derives a figure — and a figure that can't be stated
 * reads as words, never 0. Rebooking At Source and Future Booking are separate
 * measures and are always named in full.
 */
export function TeamReport({ body, locations }: TeamReportProps) {
  const nameOf = (id: string) => locations.find((location) => location.id === id)?.name ?? 'Unknown location';
  const asAt = asAtText(body, nameOf);
  const asAtByLocation = new Map(body.locations.map((location) => [location.locationId, asAtWhen(location.futureBookingAsAt)]));
  // One time for the whole report when every location shares it; otherwise each location states its own.
  const overviewAsAt = new Set(asAtByLocation.values()).size === 1 ? `As at ${[...asAtByLocation.values()][0]}` : 'As at each location’s time below';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Team overview">
          <MetricsFigures metrics={body.summary} currencyCode={body.currencyCode} totals={body.summary} asAt={overviewAsAt} />
          <Note>Every location in this report, whatever the staff filter. Team figures are worked out from all the facts, never averaged from staff.</Note>
        </Section>
        {body.selectedStaff ? (
          <Section title="Selected staff">
            <MetricsFigures metrics={body.selectedStaff} currencyCode={body.currencyCode} asAt={overviewAsAt} />
            <Note>The staff chosen in the filter, across every location in this report. A client or bill they share counts once.</Note>
          </Section>
        ) : null}
      </div>

      {body.locations.length > 1 ? <LocationTable body={body} nameOf={nameOf} asAtByLocation={asAtByLocation} /> : null}

      <StaffTable body={body} nameOf={nameOf} asAtByLocation={asAtByLocation} />

      <Section title="Future Booking">
        <AppText as="p" variant="body">
          {asAt}
        </AppText>
        <Note>
          Future Booking is the share of clients seen in this period who now hold another appointment — pending or accepted, at any location, with anyone.
          It is worked out when the report is made, not as at the end of the period. It is not Rebooking At Source.
        </Note>
      </Section>

      <CommissionSection body={body} nameOf={nameOf} />

      {body.unavailableMetrics.length > 0 ? (
        <Section title="Not available yet">
          <dl className="flex flex-col gap-2 text-[14px]">
            {body.unavailableMetrics.map((metric) => (
              <div key={metric.metric}>
                <dt className="font-medium text-text-primary">{UNAVAILABLE_METRIC_LABELS[metric.metric]}</dt>
                <dd className="text-text-secondary">{unavailableMetricText(metric)}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      <DataQuality body={body} />
    </div>
  );
}

function asAtText(body: TeamReportBody, nameOf: (id: string) => string): string {
  const labels = [...new Set(body.locations.map((location) => asAtWhen(location.futureBookingAsAt)))];
  if (labels.length === 1) return `As at ${labels[0]}`;
  return `As at ${body.locations.map((location) => `${asAtWhen(location.futureBookingAsAt)} (${nameOf(location.locationId)})`).join('; ')}`;
}

function MetricsFigures({ metrics, currencyCode, totals, asAt }: { metrics: TeamMetrics; currencyCode: string | null; totals?: TeamTotals; asAt: string }) {
  const money = (amount: TeamMetrics['retailRevenue']) => formatTeamAmount(amount, currencyCode);
  const utilisation = metrics.utilisation;
  const future = metrics.futureBooking;
  const rows: Array<[string, string, string | null]> = [
    ['Service revenue (incl. VAT)', money(metrics.serviceRevenue.gross), null],
    ['Service revenue, net of VAT', money(metrics.serviceRevenue.netOfVat), null],
    ['Colour', money(metrics.colour.gross), null],
    ['Average bill', money(metrics.averageBill.average), metrics.averageBill.average.availability === 'available' ? billsText(metrics.averageBill.bills) : null],
    ['Utilisation', formatTeamRatio(utilisation.utilisation), utilisation.utilisation.availability === 'available' ? bookedOfRostered(utilisation.bookedMinutes, utilisation.availableMinutes) : null],
    ['Future Booking', formatTeamRatio(future.withFutureBooking), [clientsParts(future.withFutureBooking), future.withFutureBooking.availability === 'not_started' ? null : asAt].filter(Boolean).join(' · ') || null],
    ['Future Booking, confirmed only', formatTeamRatio(future.withConfirmedFutureBooking), null],
    ['Retail revenue', money(metrics.retailRevenue), null],
  ];
  if (totals) rows.push(['Retail as a share of service revenue', formatTeamRatio(totals.retailShareOfServiceRevenue), null]);
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[14px]">
      {rows.map(([label, value, detail]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="text-right font-medium tabular-nums text-text-primary">
            {value}
            {detail ? <span className="block text-[12px] font-normal text-text-muted">{detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STAFF_COLUMNS = [
  'Staff',
  'Service revenue (incl. VAT)',
  'Net of VAT',
  'Colour',
  'Average bill',
  'Bills',
  'Utilisation',
  'Booked / rostered',
  'Future Booking',
  'Clients seen',
  'Retail revenue',
];

function StaffTable({ body, nameOf, asAtByLocation }: { body: TeamReportBody; nameOf: (id: string) => string; asAtByLocation: ReadonlyMap<string, string> }) {
  const filtered = body.selectedStaff !== null;
  return (
    <AppCard padding="md">
      <section aria-label="Staff performance" className="flex flex-col gap-2">
        <AppText as="h2" variant="subtitle" weight="medium">
          Staff performance
        </AppText>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <caption className="sr-only">Staff performance by location</caption>
            <thead>
              <tr className="text-left text-text-secondary">
                {STAFF_COLUMNS.map((label, index) => (
                  <th key={label} scope="col" className={`py-1 pr-4 font-medium whitespace-nowrap ${index > 0 ? 'text-right' : ''}`}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            {body.locations.map((location) => {
              const rows = body.staffRows.filter((row) => row.locationId === location.locationId);
              return (
                <tbody key={location.locationId}>
                  <tr className="border-t border-border-strong">
                    <th scope="rowgroup" colSpan={STAFF_COLUMNS.length} className="pt-3 pb-1 text-left text-[13px] font-semibold text-text-primary">
                      {nameOf(location.locationId)}
                      <span className="ml-2 text-[11px] font-normal text-text-muted">Future Booking as at {asAtByLocation.get(location.locationId)}</span>
                    </th>
                  </tr>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={STAFF_COLUMNS.length} className="py-1 text-text-secondary">
                        {filtered ? 'None of the selected staff have a row at this location.' : 'No staff at this location.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => <StaffRow key={row.rowKey} row={row} />)
                  )}
                  {location.selectedStaff ? (
                    <MetricsRow label="Selected staff" metrics={location.selectedStaff} currencyCode={location.currencyCode} emphasis />
                  ) : null}
                  <MetricsRow label="Location total" metrics={location.totals} currencyCode={location.currencyCode} emphasis />
                </tbody>
              );
            })}
          </table>
        </div>
        <Note>
          Each fact counts at the location where it happened. The status shown under a name is today’s, not where someone worked in the period.
          Unattributed holds bill lines, visits and retail sales with no staff member recorded.
        </Note>
      </section>
    </AppCard>
  );
}

function StaffRow({ row }: { row: TeamStaffRow }) {
  const status = currentStatusText(row.staff);
  return (
    <MetricsRow
      label={staffName(row.staff)}
      note={status}
      metrics={row.metrics}
      currencyCode={row.currencyCode}
    />
  );
}

function MetricsRow({
  label,
  note,
  metrics,
  currencyCode,
  emphasis = false,
}: {
  label: string;
  note?: string | null;
  metrics: TeamMetrics;
  currencyCode: string | null;
  emphasis?: boolean;
}) {
  const money = (amount: TeamMetrics['retailRevenue']) => formatTeamAmount(amount, currencyCode);
  const cell = (value: string) => <td className="py-1 pr-4 text-right tabular-nums whitespace-nowrap">{value}</td>;
  return (
    <tr className={`border-t border-border align-top ${emphasis ? 'font-medium bg-surface-alt/40' : ''}`}>
      <th scope="row" className="py-1 pr-4 text-left font-medium">
        {label}
        {note ? <span className="block text-[11px] font-normal text-text-muted">{note}</span> : null}
      </th>
      {cell(money(metrics.serviceRevenue.gross))}
      {cell(money(metrics.serviceRevenue.netOfVat))}
      {cell(money(metrics.colour.gross))}
      {cell(money(metrics.averageBill.average))}
      {cell(formatTeamCount(metrics.averageBill.bills))}
      {cell(formatTeamRatio(metrics.utilisation.utilisation))}
      {cell(bookedOfRostered(metrics.utilisation.bookedMinutes, metrics.utilisation.availableMinutes))}
      {cell(formatTeamRatio(metrics.futureBooking.withFutureBooking))}
      {cell(formatTeamCount(metrics.futureBooking.clientsSeen))}
      {cell(money(metrics.retailRevenue))}
    </tr>
  );
}

function LocationTable({ body, nameOf, asAtByLocation }: { body: TeamReportBody; nameOf: (id: string) => string; asAtByLocation: ReadonlyMap<string, string> }) {
  const columns = ['Location', 'Service revenue (incl. VAT)', 'Average bill', 'Utilisation', 'Future Booking', 'Retail revenue', 'Retail share', 'Not itemised'];
  return (
    <AppCard padding="md">
      <section aria-label="By location" className="flex flex-col gap-2">
        <AppText as="h2" variant="subtitle" weight="medium">
          By location
        </AppText>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <caption className="sr-only">Team totals by location</caption>
            <thead>
              <tr className="text-left text-text-secondary">
                {columns.map((label, index) => (
                  <th key={label} scope="col" className={`py-1 pr-4 font-medium whitespace-nowrap ${index > 0 ? 'text-right' : ''}`}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.locations.map((location) => {
                const t = location.totals;
                const money = (amount: TeamTotals['retailRevenue']) => formatTeamAmount(amount, location.currencyCode);
                return (
                  <tr key={location.locationId} className="border-t border-border">
                    <th scope="row" className="py-1 pr-4 text-left font-medium">
                      {nameOf(location.locationId)}
                    </th>
                    {[
                      money(t.serviceRevenue.gross),
                      money(t.averageBill.average),
                      formatTeamRatio(t.utilisation.utilisation),
                      formatTeamRatio(t.futureBooking.withFutureBooking),
                      money(t.retailRevenue),
                      formatTeamRatio(t.retailShareOfServiceRevenue),
                      money(t.notItemised),
                    ].map((value, index) => (
                      <td key={index} className="py-1 pr-4 text-right tabular-nums whitespace-nowrap">
                        {value}
                        {index === 3 ? <span className="block text-[11px] text-text-muted">as at {asAtByLocation.get(location.locationId)}</span> : null}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </AppCard>
  );
}

function CommissionSection({ body, nameOf }: { body: TeamReportBody; nameOf: (id: string) => string }) {
  const { periods, restrictions } = body.finalisedCommission;
  return (
    <Section title="Finalised commission">
      <Note>From locked and paid pay runs only, as they were locked — never recalculated. Each pay period is shown on its own.</Note>
      {periods.length === 0 ? (
        <AppText as="p" variant="body" tone="secondary">
          No locked or paid pay periods overlap these dates.
        </AppText>
      ) : (
        periods.map((period) => <CommissionPeriod key={period.payPeriodId} period={period} nameOf={nameOf} filtered={body.selectedStaff !== null} />)
      )}
      {restrictions.map((restriction) => (
        <Note key={restriction}>{COMMISSION_RESTRICTION_TEXT[restriction]}</Note>
      ))}
    </Section>
  );
}

function CommissionPeriod({ period, nameOf, filtered }: { period: TeamCommissionPeriod; nameOf: (id: string) => string; filtered: boolean }) {
  const title = `${period.label ?? 'Pay period'} · ${formatReportDate(period.periodStart)} – ${formatReportDate(period.periodEnd)} · ${
    period.scope.kind === 'business' ? 'Whole business' : nameOf(period.scope.locationId)
  } · ${period.status === 'paid' ? 'Paid' : 'Locked'}`;
  return (
    <div className="flex flex-col gap-1">
      <AppText as="h3" variant="body" weight="medium">
        {title}
      </AppText>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-left text-text-secondary">
              {['Staff', 'Commission', 'Adjustments', 'Base pay or commission'].map((label, index) => (
                <th key={label} scope="col" className={`py-1 pr-4 font-medium ${index > 0 ? 'text-right' : ''}`}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {period.lines.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-1 text-text-secondary">
                  {period.statements === 0
                    ? 'No pay statements in this pay period.'
                    : filtered
                      ? 'None of the selected staff are on this pay period.'
                      : 'No pay statements to show.'}
                </td>
              </tr>
            ) : null}
            {period.lines.map((line) => (
              <tr key={line.staff.staffProfileId} className="border-t border-border">
                <th scope="row" className="py-1 pr-4 text-left font-medium">
                  {line.staff.kind === 'staff' ? line.staff.name : formerStaffLabel(line.staff.staffProfileId)}
                </th>
                <td className="py-1 pr-4 text-right tabular-nums">{formatTeamAmount(line.commission, line.currencyCode)}</td>
                <td className="py-1 pr-4 text-right tabular-nums">{formatTeamAmount(line.adjustments, line.currencyCode)}</td>
                <td className="py-1 pr-4 text-right">{GREATER_OF_TEXT[line.greaterOf]}</td>
              </tr>
            ))}
            {period.statements > 0 ? (
              <tr className="border-t border-border font-medium">
                <th scope="row" className="py-1 pr-4 text-left">
                  Pay period commission (all staff)
                </th>
                <td className="py-1 pr-4 text-right tabular-nums">{formatTeamAmount(period.total, period.currencyCode)}</td>
                <td colSpan={2} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataQuality({ body }: { body: TeamReportBody }) {
  const { dataQuality } = body;
  const notes: string[] = [];
  const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  if (dataQuality.rolledUpServiceLines > 0) {
    notes.push(`${count(dataQuality.rolledUpServiceLines, 'service line was', 'service lines were')} not itemised per service, so credited to the appointment’s stylist.`);
  }
  if (dataQuality.bookedWithoutRota > 0) {
    notes.push(`${count(dataQuality.bookedWithoutRota, 'booked appointment day has', 'booked appointment days have')} no rota shift for that stylist, so left out of utilisation.`);
  }
  if (dataQuality.bookedAtAnotherLocation > 0) {
    notes.push(`${count(dataQuality.bookedAtAnotherLocation, 'booked appointment day is', 'booked appointment days are')} at a different location from the stylist’s shift that day, so left out of utilisation.`);
  }
  if (dataQuality.leaveAtAnotherLocation > 0) {
    notes.push(`${count(dataQuality.leaveAtAnotherLocation, 'rostered day is', 'rostered days are')} covered by leave recorded at another location, so utilisation for them is not stated.`);
  }
  if (notes.length === 0) return null;
  return (
    <Section title="Data quality">
      <ul className="list-disc pl-5 text-[13px] text-text-secondary">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
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

function Note({ children }: { children: ReactNode }) {
  return (
    <AppText as="p" variant="caption" tone="muted">
      {children}
    </AppText>
  );
}
