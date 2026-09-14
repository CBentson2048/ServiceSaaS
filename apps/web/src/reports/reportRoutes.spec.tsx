/**
 * Report routes: declared only for available reports, and gated by the same
 * decision the API applies.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { REPORT_DEFINITIONS, type AuthUser, type ReportDefinition, type ReportSurface } from '@sheer/domain';
import { reportRoutes } from './reportRoutes';

let mockUser: Partial<AuthUser> | null = null;

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated', session: { accessToken: 'token' }, user: mockUser }),
}));

jest.mock('./ReportPage', () => ({
  ReportPage: ({ definition }: { definition: { key: string } }) => <p>Report page: {definition.key}</p>,
}));

const A = '11111111-1111-4111-8111-111111111111';

function Where() {
  return <p data-testid="path">{useLocation().pathname}</p>;
}

function renderAt(url: string, surface: ReportSurface, definitions?: readonly ReportDefinition[]) {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Where />
      <Routes>
        {reportRoutes(surface, definitions)}
        <Route path="/unauthorized" element={<p>Unauthorized page</p>} />
        <Route path="/" element={<p>Home page</p>} />
        <Route path="*" element={<p>Catch-all</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const managerLevel: Partial<AuthUser> = {
  roles: ['manager'],
  membershipGrants: [{ locationId: A, permissions: ['report.financials.view', 'report.performance.view', 'report.lab_analytics.view'] }],
};

describe('reportRoutes', () => {
  it('declares no route for unreleased reports while the shell is off — even an owner falls through', () => {
    mockUser = { roles: ['owner'] };
    renderAt('/reports/money', { foundationShell: false });
    expect(screen.getByText('Catch-all')).toBeTruthy();
    expect(screen.queryByText(/Report page/)).toBeNull();
  });

  it('with the shell on, an owner opens every report', () => {
    mockUser = { roles: ['owner'] };
    for (const definition of REPORT_DEFINITIONS) {
      const { unmount } = render(
        <MemoryRouter initialEntries={[`/reports/${definition.key}`]}>
          <Routes>{reportRoutes({ foundationShell: true })}</Routes>
        </MemoryRouter>,
      );
      expect(screen.getByText(`Report page: ${definition.key}`)).toBeTruthy();
      unmount();
    }
  });

  it('sends a NULL-level manager (whatever their merged permissions) to /unauthorized', () => {
    mockUser = { roles: ['manager'], permissions: ['report.financials.view', 'report.pnl.view'] };
    renderAt('/reports/money', { foundationShell: true });
    expect(screen.getByText('Unauthorized page')).toBeTruthy();
  });

  it('sends a receptionist-level membership to /unauthorized', () => {
    mockUser = { roles: ['manager'], membershipGrants: [{ locationId: A, permissions: ['bookings.manage', 'eod.manage'] }] };
    renderAt('/reports/cash-up', { foundationShell: true });
    expect(screen.getByText('Unauthorized page')).toBeTruthy();
  });

  it('lets a Manager-level membership open Money but not P&L', () => {
    mockUser = managerLevel;
    renderAt('/reports/money', { foundationShell: true });
    expect(screen.getByText('Report page: money')).toBeTruthy();
  });

  it('sends a Manager-level membership on /reports/pnl to /unauthorized', () => {
    mockUser = managerLevel;
    renderAt('/reports/pnl', { foundationShell: true });
    expect(screen.getByTestId('path').textContent).toBe('/unauthorized');
  });

  it('declares a released report with the shell off', () => {
    mockUser = managerLevel;
    const released = REPORT_DEFINITIONS.map((d) => (d.key === 'money' ? { ...d, release: 'released' as const } : d));
    renderAt('/reports/money', { foundationShell: false }, released);
    expect(screen.getByText('Report page: money')).toBeTruthy();
  });
});
