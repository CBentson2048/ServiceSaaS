/**
 * Guard-presence and handler contract for the report routes.
 *
 * RolesGuard / PermissionsGuard / LocationScopeGuard fail open when their
 * metadata is missing, and handler metadata REPLACES class metadata. The report
 * routes therefore use metadata-free guards only, and this spec fails if anyone
 * later adds a handler-level decorator that would look like protection and do
 * nothing.
 */
import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { NotFoundException } from '@nestjs/common';
import type { AuthUser, ReportOptions } from '@sheer/domain';
import { getReportDefinition } from '@sheer/domain';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ReportAccessGuard } from './report-access.guard';
import type { ReportRequest } from './report-actor';
import { ReportAvailabilityGuard } from './report-availability.guard';
import type { ReportScope, ReportScopeService } from './report-scope.service';
import { ReportsController } from './reports.controller';
import type { MoneyReportService } from './money/money-report.service';
import type { CashUpReportService } from './cash-up/cash-up-report.service';
import type { TeamReportService } from './team/team-report.service';

const GUARDS_KEY = '__guards__';
const HANDLER_METADATA_KEYS = ['sheer:roles', 'sheer:permissions', 'sheer:location-param', GUARDS_KEY];

const handlerNames = () =>
  Object.getOwnPropertyNames(ReportsController.prototype).filter(
    (name) => name !== 'constructor' && typeof (ReportsController.prototype as unknown as Record<string, unknown>)[name] === 'function',
  );

const routeHandlers = () =>
  handlerNames().filter((name) =>
    Reflect.hasMetadata('path', (ReportsController.prototype as unknown as Record<string, object>)[name]),
  );

describe('ReportsController guard contract', () => {
  it('runs exactly availability → authentication → access, in that order', () => {
    expect(Reflect.getMetadata(GUARDS_KEY, ReportsController)).toEqual([
      ReportAvailabilityGuard,
      SupabaseAuthGuard,
      ReportAccessGuard,
    ]);
  });

  it('carries no role, permission or location-scope metadata at class level', () => {
    for (const key of HANDLER_METADATA_KEYS.filter((k) => k !== GUARDS_KEY)) {
      expect([key, Reflect.getMetadata(key, ReportsController)]).toEqual([key, undefined]);
    }
  });

  it('exposes exactly the options and result routes, and no handler carries guard metadata', () => {
    expect(routeHandlers().sort()).toEqual(['options', 'result']);
    for (const name of routeHandlers()) {
      const handler = (ReportsController.prototype as unknown as Record<string, object>)[name];
      for (const key of HANDLER_METADATA_KEYS) {
        expect([name, key, Reflect.getMetadata(key, handler)]).toEqual([name, key, undefined]);
      }
    }
  });

  it('options binds no query parameters, so it cannot refuse a selection', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ReportsController, 'options') as Record<string, unknown>;
    const types = Object.keys(args).map((key) => Number(key.split(':')[0]));
    expect(types).not.toContain(RouteParamtypes.QUERY);
    const resultArgs = Reflect.getMetadata(ROUTE_ARGS_METADATA, ReportsController, 'result') as Record<string, unknown>;
    expect(Object.keys(resultArgs).map((key) => Number(key.split(':')[0]))).toContain(RouteParamtypes.QUERY);
  });
});

describe('ReportsController handlers', () => {
  const definition = getReportDefinition('money');
  const auth = {
    id: 'u-1',
    businessId: 'biz-1',
    roles: ['manager'],
    permissions: ['report.financials.view', 'report.pnl.view'],
    allowedLocationIds: ['a', 'b'],
    membershipGrants: [{ locationId: 'a', permissions: ['report.financials.view'] }],
  } as unknown as AuthUser;

  function setup() {
    const options: ReportOptions = { reportKey: 'money', locations: [], weekStartDay: 2 };
    const resolved = { reportKey: 'money', filter: {}, weekStartDay: null, locations: [] };
    const scope = {
      options: jest.fn().mockResolvedValue(options),
      resolve: jest.fn().mockImplementation(async (actor, def, _query, asOf) => ({ actor, definition: def, asOf, resolved, windows: [] }) as unknown as ReportScope),
    };
    const moneyBody = { summary: 'money-body' };
    const money = { build: jest.fn().mockResolvedValue(moneyBody) };
    const cashUpBody = { summary: 'cash-up-body' };
    const cashUp = { build: jest.fn().mockResolvedValue(cashUpBody) };
    const teamBody = { summary: 'team-body' };
    const team = { build: jest.fn().mockResolvedValue(teamBody) };
    const controller = new ReportsController(
      scope as unknown as ReportScopeService,
      money as unknown as MoneyReportService,
      cashUp as unknown as CashUpReportService,
      team as unknown as TeamReportService,
    );
    const response = { setHeader: jest.fn() };
    return { controller, scope, money, moneyBody, cashUp, cashUpBody, team, teamBody, response, options, resolved };
  }

  it('result creates one instant, passes a report actor, and returns the Money body built on that scope', async () => {
    const { controller, scope, money, moneyBody, response, resolved } = setup();
    const before = Date.now();
    const result = await controller.result(
      { auth, reportDefinition: definition } as ReportRequest,
      { preset: 'today' },
      response as never,
    );
    expect(result).toEqual({ reportKey: 'money', filter: resolved, body: moneyBody });
    expect(money.build).toHaveBeenCalledWith(await scope.resolve.mock.results[0].value, { cursor: null });
    expect(scope.resolve).toHaveBeenCalledTimes(1);
    const [actor, def, query, asOf] = scope.resolve.mock.calls[0];
    expect(def).toBe(definition);
    expect(query).toEqual({ preset: 'today' });
    expect(asOf).toBeInstanceOf(Date);
    expect((asOf as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(Object.keys(actor).sort()).toEqual(['businessId', 'id', 'membershipGrants', 'roles']);
  });

  it('a report without a body builder returns a null body and refuses a cursor', async () => {
    const { controller, money, team, response, resolved } = setup();
    const colourLab = getReportDefinition('colour-lab');
    const result = await controller.result({ auth, reportDefinition: colourLab } as ReportRequest, {}, response as never);
    expect(result).toEqual({ reportKey: 'colour-lab', filter: resolved, body: null });
    await expect(
      controller.result({ auth, reportDefinition: colourLab } as ReportRequest, { cursor: 'm1.abc' }, response as never),
    ).rejects.toMatchObject({ response: { code: 'report_cursor_invalid' } });
    expect(money.build).not.toHaveBeenCalled();
    expect(team.build).not.toHaveBeenCalled();
  });

  it('builds the Team body on the same scope, and refuses a cursor (Team has no paged detail)', async () => {
    const { controller, scope, money, team, teamBody, response, resolved } = setup();
    const teamDefinition = getReportDefinition('team');
    const result = await controller.result({ auth, reportDefinition: teamDefinition } as ReportRequest, { staff: 'x' }, response as never);
    expect(result).toEqual({ reportKey: 'team', filter: resolved, body: teamBody });
    expect(team.build).toHaveBeenCalledWith(await scope.resolve.mock.results[0].value);
    await expect(
      controller.result({ auth, reportDefinition: teamDefinition } as ReportRequest, { cursor: 'm1.abc' }, response as never),
    ).rejects.toMatchObject({ response: { code: 'report_cursor_invalid' } });
    expect(team.build).toHaveBeenCalledTimes(1);
    expect(money.build).not.toHaveBeenCalled();
  });

  it('builds the Cash up body on the same scope and passes its cursor through', async () => {
    const { controller, money, cashUp, cashUpBody, response, resolved } = setup();
    const cashUpDefinition = getReportDefinition('cash-up');
    const result = await controller.result(
      { auth, reportDefinition: cashUpDefinition } as ReportRequest,
      { view: 'detail', cursor: 'c1.xyz' },
      response as never,
    );
    expect(result).toEqual({ reportKey: 'cash-up', filter: resolved, body: cashUpBody });
    expect(cashUp.build.mock.calls[0][1]).toEqual({ cursor: 'c1.xyz' });
    expect(money.build).not.toHaveBeenCalled();
  });

  it('passes the cursor through to the Money body', async () => {
    const { controller, money, response } = setup();
    await controller.result({ auth, reportDefinition: definition } as ReportRequest, { view: 'detail', cursor: 'm1.xyz' }, response as never);
    expect(money.build.mock.calls[0][1]).toEqual({ cursor: 'm1.xyz' });
  });

  it('options passes a report actor that has no merged permissions or location ids', async () => {
    const { controller, scope, response, options } = setup();
    expect(await controller.options({ auth, reportDefinition: definition } as ReportRequest, response as never)).toBe(options);
    const [actor] = scope.options.mock.calls[0];
    expect(actor).not.toHaveProperty('permissions');
    expect(actor).not.toHaveProperty('allowedLocationIds');
  });

  it('marks every response no-store, private', async () => {
    const { controller, response } = setup();
    await controller.options({ auth, reportDefinition: definition } as ReportRequest, response as never);
    await controller.result({ auth, reportDefinition: definition } as ReportRequest, {}, response as never);
    expect(response.setHeader.mock.calls).toEqual([
      ['Cache-Control', 'no-store, private'],
      ['Cache-Control', 'no-store, private'],
    ]);
  });

  it('refuses to run if the guards did not attach a definition or a user', async () => {
    const { controller, scope, response } = setup();
    await expect(controller.result({ auth } as ReportRequest, {}, response as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.options({ reportDefinition: definition } as ReportRequest, response as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(scope.resolve).not.toHaveBeenCalled();
    expect(scope.options).not.toHaveBeenCalled();
  });
});
