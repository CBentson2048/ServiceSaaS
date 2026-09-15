/** Build a Ticket A ReportScope for Money tests from real per-location windows. */
import { getReportDefinition, type MoneyCoverage, type MoneyReportBody, type MoneyTotals, type ReportFilter, type WeekStartDay } from '@sheer/domain';
import type { ReportScope } from '../../report-scope.service';
import { resolveReportWindows } from '../../report-window';

export interface ScopeLocation {
  id: string;
  name: string;
  timezone: string;
}

export function moneyScope(
  businessId: string,
  locations: readonly ScopeLocation[],
  filter: ReportFilter,
  asOf: Date,
  weekStartDay: WeekStartDay = 2,
): ReportScope {
  const windows = resolveReportWindows(locations.map((l) => ({ id: l.id, timezone: l.timezone })), filter, asOf, weekStartDay);
  return {
    actor: { id: 'user-1', businessId, roles: ['owner'] },
    definition: getReportDefinition('money')!,
    asOf,
    resolved: {
      reportKey: 'money',
      filter,
      weekStartDay: null,
      locations: windows.map((w, i) => ({
        id: w.locationId,
        name: locations[i].name,
        timezone: w.timezone,
        isActive: true,
        timezoneValid: true,
        localToday: w.localToday,
        from: w.from,
        to: w.to,
        status: w.status,
      })),
    },
    windows,
  };
}

/** A test instant key: `YYYY-MM-DDTHH:MM:SS[.f]Z` → fixed six-digit fraction. */
export function instant(iso: string): string {
  const [date, rest] = iso.split('T');
  const [time, frac = ''] = rest.replace('Z', '').split('.');
  return `${date}T${time}.${frac.padEnd(6, '0')}Z`;
}

export type FirstPageBody = MoneyReportBody & { continuation: false; summary: MoneyTotals; coverage: MoneyCoverage };

/** Narrow a body to a first page (summary and coverage present), failing loudly otherwise. */
export function firstPage(body: MoneyReportBody): FirstPageBody {
  if (body.continuation || body.summary === null || body.coverage === null) throw new Error('expected a first page');
  return body as FirstPageBody;
}
