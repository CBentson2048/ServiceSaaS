/**
 * The two report guards, in isolation. Guard ORDER and real HTTP status codes
 * are proven in reports.http.spec.ts.
 */
import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { AuthUser, ReportSurface } from '@sheer/domain';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReportAccessGuard } from './report-access.guard';
import type { ReportRequest } from './report-actor';
import { ReportAvailabilityGuard } from './report-availability.guard';
import { reportSurfaceFromEnv } from './report-surface';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const ON: ReportSurface = { foundationShell: true };
const OFF: ReportSurface = { foundationShell: false };

function contextFor(request: Partial<ReportRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function thrown(run: () => unknown): { status: number; body: unknown } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
}

const user = (overrides: Partial<AuthUser>): AuthUser =>
  ({
    id: 'user-1',
    businessId: 'biz-1',
    roles: ['manager'],
    primaryRole: 'manager',
    permissions: [],
    allowedLocationIds: [],
    locations: [],
    locationScope: { kind: 'locations', locationIds: [] },
    profile: { id: 'user-1', email: 'x@example.com', fullName: 'X' },
    ...overrides,
  }) as AuthUser;

const owner = user({ roles: ['owner'], primaryRole: 'owner' });
const managerLevel = user({
  membershipGrants: [{ locationId: A, permissions: ['report.financials.view', 'report.performance.view', 'report.lab_analytics.view'] }],
});
const nullLevelManager = user({ permissions: ['report.financials.view', 'report.pnl.view'] });
const stylistWithManagerLevel = user({ roles: ['stylist'], primaryRole: 'stylist', permissions: ['report.financials.view'] });
const managerAPlusStylistB = user({
  roles: ['manager', 'stylist'],
  allowedLocationIds: [A, B],
  membershipGrants: [{ locationId: A, permissions: ['report.financials.view'] }],
});

describe('reportSurfaceFromEnv', () => {
  it('is on only for the exact string "true"', () => {
    expect(reportSurfaceFromEnv('true')).toEqual({ foundationShell: true });
    for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', 'on', ' true']) {
      expect([value, reportSurfaceFromEnv(value).foundationShell]).toEqual([value, false]);
    }
  });
});

describe('ReportAvailabilityGuard (before authentication)', () => {
  it('404s an unknown key and prototype keys with the same body', () => {
    const guard = new ReportAvailabilityGuard(ON);
    const bodies = ['bogus', 'constructor', '__proto__', 'hasOwnProperty', ''].map((key) =>
      thrown(() => guard.canActivate(contextFor({ params: { reportKey: key } }))),
    );
    for (const body of bodies) expect(body).toEqual({ status: 404, body: bodies[0]?.body });
    expect(bodies[0]?.body).toMatchObject({ code: 'report_not_found' });
  });

  it('404s a foundation report while the shell is off, identically to an unknown key', () => {
    const guard = new ReportAvailabilityGuard(OFF);
    const foundation = thrown(() => guard.canActivate(contextFor({ params: { reportKey: 'money' } })));
    const unknown = thrown(() => guard.canActivate(contextFor({ params: { reportKey: 'bogus' } })));
    expect(foundation).toEqual(unknown);
  });

  it('passes a foundation report with the shell on, without looking at the user', () => {
    const guard = new ReportAvailabilityGuard(ON);
    expect(guard.canActivate(contextFor({ params: { reportKey: 'money' } }))).toBe(true);
  });

  it('imports no permission or role helper', () => {
    const source = readFileSync(join(__dirname, 'report-availability.guard.ts'), 'utf8');
    for (const banned of ['canOpenReport', 'reportAccessDecision', 'reportLocationIds', 'userHasPermission', 'userHasAnyRole', '.permissions', '.roles', 'membershipGrants', '.auth']) {
      expect([banned, source.includes(banned)]).toEqual([banned, false]);
    }
  });
});

describe('ReportAccessGuard (after authentication)', () => {
  const guard = new ReportAccessGuard(ON);
  const check = (auth: AuthUser | undefined, reportKey: string) => {
    const request: Partial<ReportRequest> = { params: { reportKey }, auth };
    const outcome = thrown(() => guard.canActivate(contextFor(request)));
    return { outcome, request };
  };

  it('lets an owner open all five reports and attaches the definition', () => {
    for (const key of ['money', 'cash-up', 'team', 'colour-lab', 'pnl']) {
      const { outcome, request } = check(owner, key);
      expect(outcome).toBeNull();
      expect(request.reportDefinition?.key).toBe(key);
    }
  });

  it('lets a Manager-level membership open four reports and refuses P&L', () => {
    for (const key of ['money', 'cash-up', 'team', 'colour-lab']) expect(check(managerLevel, key).outcome).toBeNull();
    expect(check(managerLevel, 'pnl').outcome).toMatchObject({ status: 403, body: { code: 'report_forbidden' } });
  });

  it('refuses every report to a NULL-level manager and a stylist, whatever their merged permissions say', () => {
    for (const actor of [nullLevelManager, stylistWithManagerLevel]) {
      for (const key of ['money', 'cash-up', 'team', 'colour-lab', 'pnl']) {
        const { outcome, request } = check(actor, key);
        expect(outcome).toMatchObject({ status: 403, body: { code: 'report_forbidden' } });
        expect(request.reportDefinition).toBeUndefined();
      }
    }
  });

  it('lets manager@A + stylist@B open Money (location scope is enforced later)', () => {
    expect(check(managerAPlusStylistB, 'money').outcome).toBeNull();
  });

  it('refuses a request with no authenticated user', () => {
    expect(check(undefined, 'money').outcome).toMatchObject({ status: 403, body: { code: 'report_forbidden' } });
  });

  it('404s an unknown key, and an unavailable report if reached with the shell off', () => {
    expect(check(owner, 'bogus').outcome).toMatchObject({ status: 404 });
    const offGuard = new ReportAccessGuard(OFF);
    const outcome = thrown(() => offGuard.canActivate(contextFor({ params: { reportKey: 'money' }, auth: owner })));
    expect(outcome).toMatchObject({ status: 404, body: { code: 'report_not_found' } });
  });
});
