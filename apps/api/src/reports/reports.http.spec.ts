/**
 * The report routes over real HTTP: Nest's router, the global validation pipe
 * configured as in main.ts, the real availability and access guards, and the
 * real SupabaseAuthGuard in front of a stub token verifier.
 *
 * This is the only place guard ORDER is observable: an unavailable report must
 * 404 before authentication, so an anonymous caller cannot tell a hidden report
 * from a missing one.
 */
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEFAULT_ROLE_PERMISSIONS, type AuthUser, type ReportSurface } from '@sheer/domain';
import request from 'supertest';
import { AuthService } from '../auth/auth.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { reportHttpError } from './report-errors';
import { ReportAccessGuard } from './report-access.guard';
import { ReportAvailabilityGuard } from './report-availability.guard';
import { ReportScopeService } from './report-scope.service';
import { REPORT_SURFACE } from './report-surface';
import { ReportsController } from './reports.controller';
import { MoneyReportService } from './money/money-report.service';

const A = '00000000-0000-4000-8000-00000000000a';

const users: Record<string, Partial<AuthUser>> = {
  owner: { id: 'owner', businessId: 'biz', roles: ['owner'], permissions: [] },
  manager: {
    id: 'manager',
    businessId: 'biz',
    roles: ['manager'],
    permissions: [],
    membershipGrants: [{ locationId: A, permissions: ['report.financials.view'] }],
  },
  // Shaped as resolveAuthUser builds them: no grants, role-default merged
  // permissions and real locations.
  'null-level-manager': {
    id: 'nl',
    businessId: 'biz',
    roles: ['manager'],
    membershipGrants: [],
    permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'report.pnl.view'],
    allowedLocationIds: [A],
    locations: [{ id: A, name: 'London' }],
    locationScope: { kind: 'locations', locationIds: [A] },
  },
  // Receptionist level: front-desk permissions, no financials.
  receptionist: {
    id: 'receptionist',
    businessId: 'biz',
    roles: ['manager'],
    permissions: [],
    membershipGrants: [{ locationId: A, permissions: ['bookings.manage', 'eod.manage'] }],
  },
  // A custom manager level without report.financials.view.
  'no-financials': {
    id: 'no-financials',
    businessId: 'biz',
    roles: ['manager'],
    permissions: [],
    membershipGrants: [{ locationId: A, permissions: ['report.performance.view', 'report.lab_analytics.view'] }],
  },
  // manager@A (Manager level) + stylist@B: the stylist row grants nothing.
  'manager-a-stylist-b': {
    id: 'mixed',
    businessId: 'biz',
    roles: ['manager', 'stylist'],
    permissions: [...DEFAULT_ROLE_PERMISSIONS.manager],
    allowedLocationIds: [A, '00000000-0000-4000-8000-00000000000b'],
    membershipGrants: [{ locationId: A, permissions: ['report.financials.view'] }],
  },
  stylist: {
    id: 'stylist',
    businessId: 'biz',
    roles: ['stylist'],
    membershipGrants: [],
    permissions: [...DEFAULT_ROLE_PERMISSIONS.manager],
    allowedLocationIds: [A],
    locations: [{ id: A, name: 'London' }],
    locationScope: { kind: 'self', locationIds: [A] },
  },
};

async function appWith(surface: ReportSurface) {
  const scope = {
    options: jest.fn().mockResolvedValue({ reportKey: 'money', locations: [], weekStartDay: 2 }),
    resolve: jest.fn().mockResolvedValue({ resolved: { reportKey: 'money', filter: {}, weekStartDay: null, locations: [] } }),
  };
  const money = { build: jest.fn().mockResolvedValue({ currencyCode: 'GBP' }) };
  const auth = {
    verifyAccessToken: jest.fn(async (token: string) => {
      const user = users[token];
      if (!user) throw reportHttpError('report_forbidden');
      return user as AuthUser;
    }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [
      { provide: REPORT_SURFACE, useValue: surface },
      { provide: ReportScopeService, useValue: scope },
      { provide: MoneyReportService, useValue: money },
      { provide: AuthService, useValue: auth },
      SupabaseAuthGuard,
      ReportAvailabilityGuard,
      ReportAccessGuard,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  await app.init();
  return { app, scope, money, auth };
}

describe('report routes with the foundation shell OFF (production)', () => {
  let app: INestApplication;
  let auth: { verifyAccessToken: jest.Mock };

  beforeAll(async () => {
    ({ app, auth } = await appWith({ foundationShell: false }));
  });
  afterAll(() => app.close());

  it('404s every foundation report before authentication, identically to an unknown report', async () => {
    const anonymous = await request(app.getHttpServer()).get('/api/reports/money/options');
    const asOwner = await request(app.getHttpServer()).get('/api/reports/pnl/result').set('Authorization', 'Bearer owner');
    const unknown = await request(app.getHttpServer()).get('/api/reports/bogus/options');
    expect(anonymous.status).toBe(404);
    expect(asOwner.status).toBe(404);
    expect(anonymous.body).toEqual(unknown.body);
    expect(asOwner.body).toEqual(unknown.body);
    expect(auth.verifyAccessToken).not.toHaveBeenCalled();
  });
});

describe('report routes with the foundation shell ON (dev-test)', () => {
  let app: INestApplication;
  let scope: { options: jest.Mock; resolve: jest.Mock };
  let money: { build: jest.Mock };

  beforeAll(async () => {
    ({ app, scope, money } = await appWith({ foundationShell: true }));
  });
  afterAll(() => app.close());
  beforeEach(() => {
    scope.options.mockClear();
    scope.resolve.mockClear();
    money.build.mockClear();
  });

  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  it('still 404s an unknown report before authentication', async () => {
    const response = await get('/api/reports/bogus/result');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'report_not_found' });
  });

  it('401s an available report without a token', async () => {
    expect((await get('/api/reports/money/options')).status).toBe(401);
  });

  it('403s a NULL-level manager and a stylist on every report, before any scope work', async () => {
    for (const token of ['null-level-manager', 'stylist']) {
      for (const key of ['money', 'cash-up', 'team', 'colour-lab', 'pnl']) {
        const response = await get(`/api/reports/${key}/options`, token);
        expect([token, key, response.status, response.body.code]).toEqual([token, key, 403, 'report_forbidden']);
      }
    }
    expect(scope.options).not.toHaveBeenCalled();
  });

  it('R1 Money actor matrix: only an owner or a grant carrying report.financials.view reaches the Money body', async () => {
    const outcomes: Array<[string, number, string | undefined]> = [];
    for (const token of ['owner', 'manager', 'manager-a-stylist-b', 'null-level-manager', 'receptionist', 'stylist', 'no-financials']) {
      money.build.mockClear();
      const response = await get('/api/reports/money/result', token);
      outcomes.push([token, response.status, money.build.mock.calls.length ? 'body built' : response.body.code]);
    }
    expect(outcomes).toEqual([
      ['owner', 200, 'body built'],
      ['manager', 200, 'body built'],
      ['manager-a-stylist-b', 200, 'body built'],
      ['null-level-manager', 403, 'report_forbidden'],
      ['receptionist', 403, 'report_forbidden'],
      ['stylist', 403, 'report_forbidden'],
      ['no-financials', 403, 'report_forbidden'],
    ]);
  });

  it('lets a Manager-level membership open Money and refuses P&L', async () => {
    expect((await get('/api/reports/money/options', 'manager')).status).toBe(200);
    const pnl = await get('/api/reports/pnl/options', 'manager');
    expect([pnl.status, pnl.body.code]).toEqual([403, 'report_forbidden']);
  });

  it('serves options to an owner with no-store caching, ignoring any query string', async () => {
    const response = await get(`/api/reports/pnl/options?locations=${A}&preset=bogus&anything=1`, 'owner');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, private');
    expect(scope.options).toHaveBeenCalledTimes(1);
    expect(Object.keys(scope.options.mock.calls[0][0]).sort()).toEqual(['businessId', 'id', 'roles']);
  });

  it('returns the resolved filter with the Money body', async () => {
    const response = await get('/api/reports/money/result?preset=this_week&view=detail&cursor=m1.abc', 'owner');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      reportKey: 'money',
      filter: { reportKey: 'money', filter: {}, weekStartDay: null, locations: [] },
      body: { currencyCode: 'GBP' },
    });
    expect(scope.resolve.mock.calls[0][2]).toEqual({ preset: 'this_week', view: 'detail', cursor: 'm1.abc' });
  });

  it('refuses a cursor on a report without a paged detail view', async () => {
    const response = await get('/api/reports/team/result?cursor=m1.abc', 'owner');
    expect([response.status, response.body.code]).toEqual([400, 'report_cursor_invalid']);
  });

  it('refuses unknown and repeated query parameters on result at the pipe', async () => {
    expect((await get('/api/reports/money/result?page=2', 'owner')).status).toBe(400);
    expect((await get(`/api/reports/money/result?cursor=${'x'.repeat(513)}`, 'owner')).status).toBe(400);
    expect((await get('/api/reports/money/result?preset=today&preset=yesterday', 'owner')).status).toBe(400);
    expect(scope.resolve).not.toHaveBeenCalled();
  });

  it('keeps the no-store header on a refusal raised by the scope service', async () => {
    scope.resolve.mockRejectedValueOnce(reportHttpError('report_location_out_of_scope'));
    const response = await get(`/api/reports/money/result?locations=${A}`, 'owner');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'report_location_out_of_scope' });
    expect(response.headers['cache-control']).toBe('no-store, private');
  });
});
