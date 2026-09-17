/**
 * The Reports group in the real Sidebar: shown from the report registry and
 * the fail-closed decision, links carrying the report filter, the separate
 * location picker hidden on report pages, and every non-report entry unchanged.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthUser, Permission } from '@sheer/domain';
import { Sidebar } from '../components/Sidebar';

let mockUser: Partial<AuthUser> | null = null;
let mockShell = true;

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated', session: { accessToken: 'token' }, user: mockUser }),
}));

jest.mock('../config/reportsFoundationShell', () => ({
  reportsSurface: () => ({ foundationShell: mockShell }),
}));

jest.mock('../components/LocationScopeContext', () => ({
  ALL_LOCATIONS: 'all',
  useLocationScope: () => ({
    locations: [
      { id: 'l1', name: 'London' },
      { id: 'l2', name: 'Tokyo' },
    ],
    selectedLocationId: 'all',
    setSelectedLocationId: () => undefined,
    isAllLocations: true,
    firstLocationId: 'l1',
    resolvedLocationId: 'l1',
  }),
}));

const A = '11111111-1111-4111-8111-111111111111';
const MANAGER_LEVEL: Permission[] = ['report.dashboard.view', 'report.performance.view', 'report.commission.view', 'report.financials.view', 'report.lab_analytics.view'];

function renderSidebar(url: string) {
  // Expanded, so group children and the picker render.
  window.localStorage.setItem('sheer.web.sidebarCollapsed', '0');
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

function reportLinks(): Array<{ label: string; href: string | null }> {
  const heading = screen.queryByRole('button', { name: /^Reports/ });
  if (!heading) return [];
  // Groups start collapsed away from their own pages.
  if (heading.getAttribute('aria-expanded') !== 'true') fireEvent.click(heading);
  const group = heading.closest('li') as HTMLElement;
  return within(group)
    .queryAllByRole('link')
    .map((link) => ({ label: link.textContent ?? '', href: link.getAttribute('href') }));
}

function allHrefs(): string[] {
  return screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
}

describe('Sidebar Reports group', () => {
  it('shows every report to an owner on a report page, with links carrying the filter', () => {
    mockShell = true;
    mockUser = { roles: ['owner'], primaryRole: 'owner', permissions: MANAGER_LEVEL };
    renderSidebar(`/reports/money?preset=last_week&locations=${A}&view=detail`);
    expect(reportLinks()).toEqual([
      { label: 'Money', href: `/reports/money?preset=last_week&locations=${A}&view=detail` },
      { label: 'Cash up', href: `/reports/cash-up?preset=last_week&locations=${A}&view=detail` },
      { label: 'Team report', href: `/reports/team?preset=last_week&locations=${A}` },
      { label: 'Colour lab', href: `/reports/colour-lab?preset=last_week&locations=${A}` },
      { label: 'P&L', href: `/reports/pnl?preset=last_week&locations=${A}` },
    ]);
    expect(screen.getByRole('button', { name: /^Reports \(preview\)/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('hides P&L from a Manager-level membership', () => {
    mockShell = true;
    mockUser = { roles: ['manager'], primaryRole: 'manager', permissions: MANAGER_LEVEL, membershipGrants: [{ locationId: A, permissions: MANAGER_LEVEL }] };
    renderSidebar('/dashboard');
    expect(reportLinks().map((l) => l.label)).toEqual(['Money', 'Cash up', 'Team report', 'Colour lab']);
  });

  it('shows no Reports group to a NULL-level manager, even though their merged permissions hold every report key', () => {
    mockShell = true;
    mockUser = { roles: ['manager'], primaryRole: 'manager', permissions: [...MANAGER_LEVEL, 'report.pnl.view'] };
    renderSidebar('/dashboard');
    expect(screen.queryByRole('button', { name: /^Reports/ })).toBeNull();
    // The rest of their navigation is untouched.
    expect(allHrefs()).toContain('/dashboard');
  });

  it('shows no Reports group to anyone while the shell is off', () => {
    mockShell = false;
    mockUser = { roles: ['owner'], primaryRole: 'owner', permissions: MANAGER_LEVEL };
    renderSidebar('/dashboard');
    expect(screen.queryByRole('button', { name: /^Reports/ })).toBeNull();
  });

  it('leaves every non-report entry exactly as it was', () => {
    mockUser = { roles: ['owner'], primaryRole: 'owner', permissions: MANAGER_LEVEL };
    mockShell = false;
    const { unmount } = renderSidebar('/dashboard');
    const without = allHrefs();
    unmount();
    mockShell = true;
    renderSidebar('/dashboard');
    expect(allHrefs().filter((href) => !href.startsWith('/reports/'))).toEqual(without);
  });

  it('hides the sidebar location picker on report pages and keeps it elsewhere', () => {
    mockShell = true;
    mockUser = { roles: ['owner'], primaryRole: 'owner', permissions: MANAGER_LEVEL };
    const { unmount } = renderSidebar('/reports/money');
    expect(screen.queryByLabelText('Location')).toBeNull();
    unmount();
    renderSidebar('/dashboard');
    expect(screen.getByLabelText('Location')).toBeTruthy();
  });
});
