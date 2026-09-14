/**
 * URL-backed report filter. Every location change is recorded with its
 * navigation type, so "one PUSH", "a REPLACE" and "nothing" are asserted
 * exactly rather than inferred from renders.
 */
import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { getReportDefinition, type ReportDefinition, type ReportFilter } from '@sheer/domain';
import { useReportFilter } from './useReportFilter';

const money = getReportDefinition('money') as ReportDefinition;
const team = getReportDefinition('team') as ReportDefinition;
const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

let latest: ReturnType<typeof useReportFilter> | null = null;
let navigate: ReturnType<typeof useNavigate> | null = null;
let actions: string[] = [];
let currentSearch = '';

function HistoryProbe() {
  const location = useLocation();
  const type = useNavigationType();
  navigate = useNavigate();
  currentSearch = location.search;
  useEffect(() => {
    actions.push(type);
  }, [location.key, type]);
  return null;
}

function Probe({ definition }: { definition: ReportDefinition }) {
  latest = useReportFilter(definition);
  return (
    <div>
      <output data-testid="filter">{JSON.stringify(latest.filter)}</output>
      <output data-testid="issues">{latest.issues.map((i) => i.code).join(',')}</output>
    </div>
  );
}

function setup(initialUrl: string, definition: ReportDefinition = money) {
  latest = null;
  actions = [];
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <HistoryProbe />
      <Routes>
        <Route path="/reports/:key" element={<Probe definition={definition} />} />
      </Routes>
    </MemoryRouter>,
  );
  // The first entry is the initial POP of mounting, not a write.
  actions.shift();
  const write = (next: ReportFilter, mode: 'push' | 'replace') =>
    act(() => {
      latest?.setFilter(next, mode);
    });
  return { write, search: () => currentSearch };
}

const base: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' };

describe('useReportFilter', () => {
  it('hydrates the filter from the URL', () => {
    setup(`/reports/money?preset=custom&from=2026-09-01&to=2026-09-14&locations=${L2},${L1}&view=detail`);
    expect(JSON.parse(screen.getByTestId('filter').textContent ?? '')).toEqual({
      preset: 'custom',
      from: '2026-09-01',
      to: '2026-09-14',
      locationIds: [L1, L2],
      staffProfileIds: [],
      view: 'detail',
    });
  });

  it('writes nothing for a URL that is already canonical', () => {
    const { search } = setup('/reports/money?preset=last_week');
    expect(actions).toEqual([]);
    expect(search()).toBe('?preset=last_week');
  });

  it('omits defaults: choosing today removes every report parameter', () => {
    const { search, write } = setup('/reports/money?preset=last_week');
    write(base, 'push');
    expect(search()).toBe('');
  });

  it('a preset choice pushes exactly one entry; Back restores it and Forward re-applies it', () => {
    const { search, write } = setup('/reports/money');
    write({ ...base, preset: 'last_month' }, 'push');
    expect(actions).toEqual(['PUSH']);
    expect(search()).toBe('?preset=last_month');
    act(() => navigate?.(-1));
    expect(search()).toBe('');
    act(() => navigate?.(1));
    expect(search()).toBe('?preset=last_month');
    expect(actions).toEqual(['PUSH', 'POP', 'POP']);
  });

  it('writing an equal filter adds no history entry', () => {
    const { write } = setup('/reports/money?preset=yesterday');
    write({ ...base, preset: 'yesterday' }, 'push');
    write({ ...base, preset: 'yesterday' }, 'push');
    expect(actions).toEqual([]);
  });

  it('replace mode changes the URL without adding history', () => {
    const { search, write } = setup('/reports/money');
    write({ ...base, view: 'detail' }, 'replace');
    expect(actions).toEqual(['REPLACE']);
    expect(search()).toBe('?view=detail');
  });

  it('strips a staff parameter no report supports, with replace, keeping unrelated parameters', () => {
    const { search } = setup(`/reports/money?utm=mail&staff=${L1}&preset=yesterday`);
    expect(actions).toEqual(['REPLACE']);
    expect(search()).toBe('?utm=mail&preset=yesterday');
  });

  it('strips detail on a report without detail', () => {
    const { search } = setup('/reports/team?view=detail&preset=this_week', team);
    expect(actions).toEqual(['REPLACE']);
    expect(search()).toBe('?preset=this_week');
  });

  it('strips dates on a non-custom preset', () => {
    const { search } = setup('/reports/money?preset=last_week&from=2026-09-01&to=2026-09-07');
    expect(search()).toBe('?preset=last_week');
  });

  it('canonicalises a junk preset to the default with replace', () => {
    const { search } = setup('/reports/money?preset=fortnight');
    expect(actions).toEqual(['REPLACE']);
    expect(search()).toBe('');
  });

  it('keeps a location id the viewer may not see: the server refuses it, the URL never widens', () => {
    const { search } = setup(`/reports/money?locations=${L2}`);
    expect(actions).toEqual([]);
    expect(search()).toBe(`?locations=${L2}`);
  });

  it('leaves a URL with a blocking problem as typed and reports the problem', () => {
    const { search } = setup('/reports/money?locations=bogus&preset=custom&from=2026-09-01');
    expect(actions).toEqual([]);
    expect(search()).toBe('?locations=bogus&preset=custom&from=2026-09-01');
    expect(screen.getByTestId('issues').textContent).toBe('custom_dates_required,invalid_id');
  });

  it('leaves a repeated parameter as typed: which copy was meant is unknowable', () => {
    const { search } = setup(`/reports/money?locations=${L1}&locations=${L2}`);
    expect(actions).toEqual([]);
    expect(search()).toBe(`?locations=${L1}&locations=${L2}`);
    expect(screen.getByTestId('issues').textContent).toBe('repeated_param');
  });

  it('gives equal filters equal keys, independent of parameter and id order', () => {
    setup(`/reports/money?locations=${L2},${L1}&preset=yesterday`);
    const first = latest?.filterKey;
    setup(`/reports/money?preset=yesterday&locations=${L1},${L2}`);
    expect(latest?.filterKey).toBe(first);
  });

  it('does not loop: canonicalising writes once and then nothing further', () => {
    setup(`/reports/money?view=summary&staff=${L1}`);
    expect(actions).toEqual(['REPLACE']);
  });
});
