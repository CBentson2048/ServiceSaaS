/**
 * The report filter codec — the one translation between a URL / API query and
 * a ReportFilter.
 *
 * Strict mode is the API's only validator. Lenient mode is the browser's: it
 * canonicalises what a report ignores and blocks only what the API would
 * refuse. The same encoder writes both, so a filter survives a URL round trip
 * and reaches the API unchanged.
 */
import {
  REPORT_MIN_DATE,
  decodeReportFilter,
  encodeReportFilter,
  getReportDefinition,
  reportCustomRangeIssues,
  type ReportDefinition,
  type ReportFilter,
} from '@sheer/domain';

const money = getReportDefinition('money') as ReportDefinition; // detail: true
const team = getReportDefinition('team') as ReportDefinition; // detail: false
const staffReport: ReportDefinition = { ...team, controls: { staff: true, detail: false } };

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

const strict = (params: Record<string, string>, def: ReportDefinition = money) =>
  decodeReportFilter(params, def, 'strict');
const lenient = (search: string, def: ReportDefinition = money) =>
  decodeReportFilter(new URLSearchParams(search), def, 'lenient');
const codes = (params: Record<string, string>, def: ReportDefinition = money) =>
  strict(params, def).issues.map((issue) => `${issue.param}:${issue.code}`);

describe('defaults and round trip', () => {
  it('an empty query is today, all locations, summary', () => {
    expect(strict({})).toEqual({
      filter: { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' },
      issues: [],
    });
  });

  it('omits defaults when encoding', () => {
    expect(encodeReportFilter({ preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' })).toEqual({});
  });

  it('encode(decode(x)) is stable and independent of parameter order and id order', () => {
    const a = lenient(`view=detail&locations=${L2},${L1}&preset=custom&to=2026-09-14&from=2026-09-01`);
    const b = lenient(`preset=custom&from=2026-09-01&to=2026-09-14&locations=${L1},${L2}&view=detail`);
    expect(a.issues).toEqual([]);
    expect(encodeReportFilter(a.filter)).toEqual(encodeReportFilter(b.filter));
    expect(Object.keys(encodeReportFilter(a.filter))).toEqual(['preset', 'from', 'to', 'locations', 'view']);
    const again = decodeReportFilter(encodeReportFilter(a.filter), money, 'strict');
    expect(again).toEqual({ filter: a.filter, issues: [] });
  });

  it('dedupes, lowercases and sorts ids', () => {
    const decoded = strict({ locations: `${L2.toUpperCase()},${L1}, ${L2}` });
    expect(decoded.filter.locationIds).toEqual([L1, L2]);
    expect(encodeReportFilter(decoded.filter).locations).toBe(`${L1},${L2}`);
  });

  it('keeps "every location" ([]) distinct from an explicit list of every location', () => {
    const all: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' };
    const explicit: ReportFilter = { ...all, locationIds: [L1, L2] };
    expect(encodeReportFilter(all)).not.toEqual(encodeReportFilter(explicit));
  });

  it('treats empty parameter values as absent', () => {
    expect(strict({ preset: '', locations: '', view: '' })).toEqual(strict({}));
  });
});

describe('strict mode (API)', () => {
  it('refuses unknown presets and views', () => {
    expect(codes({ preset: 'fortnight' })).toEqual(['preset:invalid_preset']);
    expect(codes({ view: 'chart' })).toEqual(['view:invalid_view']);
  });

  it('refuses dates on a non-custom preset', () => {
    expect(codes({ preset: 'today', from: '2026-09-01' })).toEqual(['from:dates_require_custom']);
    expect(codes({ from: '2026-09-01', to: '2026-09-02' })).toEqual(['from:dates_require_custom', 'to:dates_require_custom']);
  });

  it('refuses controls a report does not support: staff everywhere, detail on team', () => {
    expect(codes({ staff: L1 })).toEqual(['staff:control_not_supported']);
    expect(codes({ view: 'detail' }, team)).toEqual(['view:control_not_supported']);
    expect(codes({ view: 'summary' }, team)).toEqual([]);
  });

  it('refuses malformed custom ranges', () => {
    expect(codes({ preset: 'custom' })).toEqual(['from:custom_dates_required', 'to:custom_dates_required']);
    expect(codes({ preset: 'custom', from: '2026-09-01' })).toEqual(['to:custom_dates_required']);
    expect(codes({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' })).toEqual(['from:invalid_date']);
    expect(codes({ preset: 'custom', from: '2026-07-01T00:00:00Z', to: '2026-07-02' })).toEqual(['from:invalid_date']);
    expect(codes({ preset: 'custom', from: '2026-09-14', to: '2026-09-01' })).toEqual(['to:range_inverted']);
    expect(codes({ preset: 'custom', from: '1999-12-31', to: '2000-01-05' })).toEqual(['from:date_before_min']);
  });

  it('allows exactly 366 inclusive days and refuses 367', () => {
    expect(codes({ preset: 'custom', from: '2025-09-14', to: '2026-09-14' })).toEqual([]);
    expect(codes({ preset: 'custom', from: '2025-09-13', to: '2026-09-14' })).toEqual(['to:range_too_long']);
    expect(codes({ preset: 'custom', from: '2024-01-01', to: '2024-12-31' })).toEqual([]);
  });

  it('has no product upper bound: any real YYYY-MM-DD date is valid, up to the format’s own 9999-12-31', () => {
    expect(codes({ preset: 'custom', from: '2099-12-01', to: '2100-01-01' })).toEqual([]);
    expect(codes({ preset: 'custom', from: '9999-01-01', to: '9999-12-31' })).toEqual([]);
    expect(codes({ preset: 'custom', from: '9999-12-31', to: '10000-01-01' })).toEqual(['to:invalid_date']);
  });

  it('accepts a custom range that is entirely in the future — dates apply as given', () => {
    expect(strict({ preset: 'custom', from: '2030-01-01', to: '2030-01-31' })).toEqual({
      filter: { preset: 'custom', from: '2030-01-01', to: '2030-01-31', locationIds: [], staffProfileIds: [], view: 'summary' },
      issues: [],
    });
  });

  it('refuses non-uuid ids and more than 50 ids', () => {
    expect(codes({ locations: `${L1},not-a-uuid` })).toEqual(['locations:invalid_id']);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(codes({ locations: fiftyOne.join(',') })).toEqual(['locations:too_many_ids']);
    expect(codes({ locations: fiftyOne.slice(0, 50).join(',') })).toEqual([]);
  });

  it('decodes staff ids only when a report supports the control (future R2)', () => {
    expect(strict({ staff: L1 }, staffReport)).toEqual({
      filter: { preset: 'today', locationIds: [], staffProfileIds: [L1], view: 'summary' },
      issues: [],
    });
  });
});

describe('lenient mode (browser URL)', () => {
  it('falls back to defaults for junk presets and views, without blocking', () => {
    expect(lenient('preset=fortnight&view=chart')).toEqual({
      filter: { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' },
      issues: [],
    });
  });

  it('drops parameters the report ignores: dates on non-custom presets, staff, detail on team', () => {
    expect(lenient('preset=last_week&from=2026-09-01&to=2026-09-02').filter).toEqual({
      preset: 'last_week', locationIds: [], staffProfileIds: [], view: 'summary',
    });
    expect(lenient(`staff=${L1}`).filter.staffProfileIds).toEqual([]);
    expect(lenient('view=detail', team).filter.view).toBe('summary');
    expect(lenient('view=detail', money).filter.view).toBe('detail');
    expect(lenient(`staff=${L1}&view=detail`, team).issues).toEqual([]);
  });

  it('never drops ids, including ids the viewer may not see and non-uuid ids, and blocks on bad ids', () => {
    const decoded = lenient(`locations=${L1},bogus`);
    expect(decoded.filter.locationIds).toEqual([L1, 'bogus']);
    expect(decoded.issues).toEqual([{ code: 'invalid_id', param: 'locations' }]);
  });

  it('blocks on a repeated parameter instead of silently reading only the first value', () => {
    expect(lenient(`locations=${L1}&locations=${L2}`).issues).toEqual([{ code: 'repeated_param', param: 'locations' }]);
    expect(lenient(`locations=&locations=${L2}`).issues).toEqual([{ code: 'repeated_param', param: 'locations' }]);
    expect(lenient('preset=today&preset=last_week').issues).toEqual([{ code: 'repeated_param', param: 'preset' }]);
    expect(decodeReportFilter(new URLSearchParams(`locations=${L1}&locations=${L2}`), money, 'strict').issues).toEqual([
      { code: 'repeated_param', param: 'locations' },
    ]);
  });

  it('blocks on an incomplete, inverted or over-long custom range', () => {
    expect(lenient('preset=custom&from=2026-09-01').issues).toEqual([{ code: 'custom_dates_required', param: 'to' }]);
    expect(lenient('preset=custom&from=2026-09-14&to=2026-09-01')).toEqual({
      filter: { preset: 'custom', from: '2026-09-14', to: '2026-09-01', locationIds: [], staffProfileIds: [], view: 'summary' },
      issues: [{ code: 'range_inverted', param: 'to' }],
    });
    expect(lenient('preset=custom&from=2025-01-01&to=2026-12-31').issues).toEqual([{ code: 'range_too_long', param: 'to' }]);
  });
});

describe('reportCustomRangeIssues (shared with the control bar)', () => {
  it('is empty for a valid range and names every problem otherwise', () => {
    expect(reportCustomRangeIssues('2026-09-01', '2026-09-14')).toEqual([]);
    expect(reportCustomRangeIssues(undefined, undefined).map((i) => i.code)).toEqual([
      'custom_dates_required',
      'custom_dates_required',
    ]);
    expect(reportCustomRangeIssues(REPORT_MIN_DATE, REPORT_MIN_DATE)).toEqual([]);
  });
});
