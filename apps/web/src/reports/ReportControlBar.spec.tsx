/**
 * The Universal Report Control Bar: shows only what a report supports, never
 * builds a date boundary, and commits each deliberate choice exactly once.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  getReportDefinition,
  type ReportDefinition,
  type ReportFilter,
  type ReportOptions,
} from '@sheer/domain';
import { ReportControlBar, type ReportControlBarProps } from './ReportControlBar';

const money = getReportDefinition('money') as ReportDefinition;
const team = getReportDefinition('team') as ReportDefinition;
const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const L3 = '33333333-3333-4333-8333-333333333333';

const base: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' };
const options: ReportOptions = {
  reportKey: 'money',
  weekStartDay: 2,
  locations: [
    { id: L1, name: 'London', timezone: 'Europe/London', isActive: true, timezoneValid: true },
    { id: L2, name: 'Tokyo', timezone: 'Asia/Tokyo', isActive: true, timezoneValid: true },
    { id: L3, name: 'Old Street', timezone: 'Europe/London', isActive: false, timezoneValid: true },
  ],
};

function renderBar(overrides: Partial<ReportControlBarProps> = {}) {
  const onChange = jest.fn();
  const props: ReportControlBarProps = {
    definition: money,
    filter: base,
    issues: [],
    options,
    onChange,
    ...overrides,
  };
  const view = render(<ReportControlBar {...props} />);
  return { onChange, ...view, rerenderWith: (next: Partial<ReportControlBarProps>) => view.rerender(<ReportControlBar {...props} {...next} />) };
}

describe('presets', () => {
  it('sends a preset as a preset: one change, pushed, with no dates attached', () => {
    const { onChange } = renderBar({ filter: { ...base, locationIds: [L1] } });
    fireEvent.click(screen.getByRole('tab', { name: 'Last week' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ preset: 'last_week', locationIds: [L1], staffProfileIds: [], view: 'summary' }, 'push');
  });

  it('marks the active preset', () => {
    renderBar({ filter: { ...base, preset: 'this_month' } });
    expect(screen.getByRole('tab', { name: 'This month' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Today' }).getAttribute('aria-selected')).toBe('false');
  });

  it('disables the week presets and says why when the business has no week start', () => {
    renderBar({ options: { ...options, weekStartDay: null } });
    expect((screen.getByRole('tab', { name: 'This week' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('tab', { name: 'Last week' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('tab', { name: 'This month' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/no week start configured/)).toBeTruthy();
  });

  it('disables every control while options load', () => {
    renderBar({ options: null, disabled: true });
    for (const tab of screen.getAllByRole('tab')) expect((tab as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Locations/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('custom range', () => {
  it('opening Custom and editing the dates writes nothing until Apply', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-22' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-29' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...base, preset: 'custom', from: '2026-09-22', to: '2026-09-29' }, 'push');
  });

  it.each([
    ['an incomplete range', '2026-09-22', '', /start and an end date/],
    ['an inverted range', '2026-09-29', '2026-09-22', /on or before the end date/],
    ['a range over 366 days', '2025-01-01', '2026-06-30', /366 days or fewer/],
    ['a range before 2000', '1999-12-31', '2000-01-02', /1 January 2000/],
  ])('disables Apply with a message for %s', (_label, from, to, message) => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(apply);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets no product upper bound: a range in 2100 applies like any other', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2100-12-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2101-01-31' } });
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(onChange).toHaveBeenCalledWith({ ...base, preset: 'custom', from: '2100-12-01', to: '2101-01-31' }, 'push');
  });

  it('allows a future range: the server decides per location what has started', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2030-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2030-01-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ ...base, preset: 'custom', from: '2030-01-01', to: '2030-01-31' }, 'push');
  });

  it('prefills the form only when every location shares one range', () => {
    const resolved = (from: string, to: string, name: string) => ({
      id: name, name, timezone: 'Europe/London', isActive: true, timezoneValid: true, localToday: to, from, to, status: 'in_progress' as const,
    });
    const shared = renderBar({ resolvedLocations: [resolved('2026-09-22', '2026-09-28', 'A'), resolved('2026-09-22', '2026-09-28', 'B')] });
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-09-22');
    shared.unmount();

    renderBar({ resolvedLocations: [resolved('2026-09-22', '2026-09-28', 'A'), resolved('2026-09-29', '2026-09-29', 'B')] });
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('');
  });

  it('shows the problem with a custom range that arrived in the URL', () => {
    renderBar({ filter: { ...base, preset: 'custom', from: '2026-09-29', to: '2026-09-22' }, issues: [{ code: 'range_inverted', param: 'to' }] });
    expect(screen.getByText(/on or before the end date/)).toBeTruthy();
  });
});

describe('locations', () => {
  it('"All locations" is the empty selection, committed once when the list closes', () => {
    const { onChange } = renderBar({ filter: { ...base, locationIds: [L1] } });
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    fireEvent.click(screen.getByRole('option', { name: /All locations/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...base, locationIds: [] }, 'push');
  });

  it('ticking every location one by one stays an explicit list', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    for (const name of ['London', 'Tokyo', 'Old Street']) fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].locationIds).toEqual([L1, L2, L3].sort());
  });

  it('closing without a change commits nothing', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses listbox semantics and groups closed locations separately', () => {
    renderBar({ filter: { ...base, locationIds: [L2] } });
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    const listbox = screen.getByRole('listbox');
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    expect(screen.getByRole('option', { name: /Tokyo/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: /London/ }).getAttribute('aria-selected')).toBe('false');
    const closed = within(listbox).getByRole('group', { name: 'Closed' });
    expect(within(closed).getByRole('option', { name: /Old Street/ })).toBeTruthy();
  });

  it('shows a single permitted location as a label, not a control', () => {
    renderBar({ options: { ...options, locations: [options.locations[0]] } });
    expect(screen.queryByRole('button', { name: /Locations/ })).toBeNull();
    expect(screen.getByText('London')).toBeTruthy();
  });

  it('marks a location with a broken timezone and does not let it be chosen', () => {
    const { onChange } = renderBar({
      options: { ...options, locations: [...options.locations, { id: 'broken', name: 'Broken', timezone: 'Europe/Londn', isActive: true, timezoneValid: false }] },
    });
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    const broken = screen.getByRole('option', { name: /Broken/ });
    expect(broken.getAttribute('aria-disabled')).toBe('true');
    expect(within(broken).getByText('Time zone needs fixing')).toBeTruthy();
    fireEvent.click(broken);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('optional controls and slots', () => {
  it('shows summary/detail only on reports with a detail view', () => {
    const { unmount } = renderBar({ definition: money });
    expect(screen.getByRole('tab', { name: 'Detail' })).toBeTruthy();
    unmount();
    renderBar({ definition: team });
    expect(screen.queryByRole('tab', { name: 'Detail' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Summary' })).toBeNull();
  });

  it('pushes a view change', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('tab', { name: 'Detail' }));
    expect(onChange).toHaveBeenCalledWith({ ...base, view: 'detail' }, 'push');
  });

  it('renders the staff slot only on a report that supports a staff control (none yet)', () => {
    const { unmount } = renderBar({ definition: team, staffControl: <span>Staff picker</span> });
    expect(screen.queryByText('Staff picker')).toBeNull();
    unmount();
    renderBar({ definition: { ...team, controls: { staff: true, detail: false } }, staffControl: <span>Staff picker</span> });
    expect(screen.getByText('Staff picker')).toBeTruthy();
  });

  it('renders the actions slot when given one, and nothing otherwise', () => {
    const { unmount } = renderBar();
    expect(screen.queryByRole('group', { name: 'Report actions' })).toBeNull();
    unmount();
    renderBar({ actions: <button type="button">Export</button> });
    const slot = screen.getByRole('group', { name: 'Report actions' });
    expect(within(slot).getByRole('button', { name: 'Export' })).toBeTruthy();
  });
});

describe('location list keeps the committed selection honest', () => {
  const FOREIGN = '99999999-9999-4999-8999-999999999999';

  it('keeps an id it has no option for: closing untouched commits nothing', () => {
    const { onChange } = renderBar({ filter: { ...base, locationIds: [FOREIGN] } });
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps an id it has no option for when another location is ticked', () => {
    const { onChange } = renderBar({ filter: { ...base, locationIds: [FOREIGN] } });
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    fireEvent.click(screen.getByRole('option', { name: /London/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledWith({ ...base, locationIds: [FOREIGN, L1].sort() }, 'push');
  });

  it('an untouched open list follows a URL change and does not commit the old selection', () => {
    const { onChange, rerenderWith } = renderBar({ filter: { ...base, locationIds: [L1] } });
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    rerenderWith({ filter: { ...base, locationIds: [L1, L2] } }); // e.g. browser Back
    fireEvent.mouseDown(document.body);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes and commits once when keyboard focus leaves the list', () => {
    const { onChange } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    const london = screen.getByRole('option', { name: /London/ });
    fireEvent.keyDown(london, { key: ' ' });
    fireEvent.blur(london, { relatedTarget: screen.getByRole('tab', { name: 'Detail' }) });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].locationIds).toEqual([L1]);
  });

  it('closes on Escape pressed anywhere, and Done returns focus to the toggle', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Locations/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Locations/ }));
  });

  it('marks a single permitted location that is closed', () => {
    renderBar({ options: { ...options, locations: [options.locations[2]] } });
    expect(screen.getByText(/Closed/)).toBeTruthy();
  });
});
