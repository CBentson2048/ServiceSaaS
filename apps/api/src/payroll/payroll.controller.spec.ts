/**
 * Guard-presence contract for every payroll route.
 *
 * Both RolesGuard and PermissionsGuard FAIL OPEN when their decorator is
 * absent (roles.guard.ts:21-23, permissions.guard.ts:29-31) — a one-line
 * omission silently unguards a route (GET /kpi/me is the shipped example).
 * And `getAllAndOverride` means a handler-level @RequirePermissions REPLACES
 * the class-level one, so every handler must RE-LIST the base view key.
 * These wage endpoints get a test, not a code-review convention
 * (docs/V1.1/3-2 plan.md §10).
 */

import 'reflect-metadata';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PayrollController } from './payroll.controller';
import { PayrollSelfController } from './payroll-self.controller';

const ROLES_KEY = 'sheer:roles';
const PERMISSIONS_KEY = 'sheer:permissions';
const GUARDS_KEY = '__guards__';

type ControllerClass = { name: string; prototype: object };

function prototypeOf(controller: ControllerClass): Record<string, unknown> {
  return controller.prototype as unknown as Record<string, unknown>;
}

function handlerNames(controller: ControllerClass): string[] {
  const proto = prototypeOf(controller);
  return Object.getOwnPropertyNames(proto).filter(
    (name) => name !== 'constructor' && typeof proto[name] === 'function',
  );
}

describe('payroll guard-presence contract', () => {
  const cases: Array<{
    controller: ControllerClass;
    baseKey: string;
    mutating: string[];
  }> = [
    {
      controller: PayrollController,
      baseKey: 'payroll.view',
      mutating: ['createPeriod', 'generate', 'markReady', 'approve', 'lock', 'markPaid'],
    },
    {
      controller: PayrollSelfController,
      baseKey: 'payroll.self.view',
      mutating: [],
    },
  ];

  it.each(cases.map((c) => [c.controller.name, c] as const))(
    '%s carries all three guards at class level',
    (_name, testCase) => {
      const guards: unknown[] = Reflect.getMetadata(GUARDS_KEY, testCase.controller) ?? [];
      expect(guards).toContain(SupabaseAuthGuard);
      expect(guards).toContain(RolesGuard);
      expect(guards).toContain(PermissionsGuard);
    },
  );

  it.each(cases.map((c) => [c.controller.name, c] as const))(
    '%s: every handler re-lists the base permission (getAllAndOverride replaces, not unions)',
    (_name, testCase) => {
      const names = handlerNames(testCase.controller);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const handler = prototypeOf(testCase.controller)[name] as object;
        const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? [];
        expect({ handler: name, permissions }).toEqual({
          handler: name,
          permissions: expect.arrayContaining([testCase.baseKey]),
        });
      }
    },
  );

  it('PayrollController role list excludes stylists and clients', () => {
    const roles: string[] = Reflect.getMetadata(ROLES_KEY, PayrollController) ?? [];
    expect(roles.sort()).toEqual(['manager', 'owner']);
  });

  it('structure AUTHORING handlers narrow the role list to owner only', () => {
    for (const handlerName of [
      'createStructure',
      'previewStructure',
      'createStructureVersion',
      'updateDataSource',
    ]) {
      const handler = prototypeOf(PayrollController)[handlerName] as object;
      const roles: string[] = Reflect.getMetadata(ROLES_KEY, handler) ?? [];
      expect({ handler: handlerName, roles }).toEqual({ handler: handlerName, roles: ['owner'] });
    }
    // Assignment stays owner/manager (class-level) — no handler override.
    const assignRoles = Reflect.getMetadata(
      ROLES_KEY,
      prototypeOf(PayrollController)['assignStructure'] as object,
    );
    expect(assignRoles).toBeUndefined();
  });

  it('PayrollSelfController admits stylists but requires payroll.self.view', () => {
    const roles: string[] = Reflect.getMetadata(ROLES_KEY, PayrollSelfController) ?? [];
    expect(roles).toContain('stylist');
    const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, PayrollSelfController) ?? [];
    expect(permissions).toEqual(['payroll.self.view']);
  });

  it('mutating handlers carry their specific permission beyond payroll.view', () => {
    const expected: Record<string, string> = {
      createPeriod: 'payroll.edit',
      generate: 'payroll.edit',
      markReady: 'payroll.edit',
      approve: 'payroll.approve',
      lock: 'payroll.lock',
      markPaid: 'payroll.lock',
      createStructure: 'payroll.edit',
      previewStructure: 'payroll.edit',
      createStructureVersion: 'payroll.edit',
      assignStructure: 'payroll.edit',
      updateDataSource: 'payroll.edit',
    };
    for (const [handlerName, requiredKey] of Object.entries(expected)) {
      const handler = prototypeOf(PayrollController)[handlerName] as object;
      const permissions: string[] = Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? [];
      expect({ handler: handlerName, permissions }).toEqual({
        handler: handlerName,
        permissions: expect.arrayContaining(['payroll.view', requiredKey]),
      });
    }
  });

  it('self-view handlers take no staffProfileId parameter (colleague pay unrequestable)', () => {
    const paramTypes =
      Reflect.getMetadata('design:paramtypes', PayrollSelfController.prototype, 'getMySummary') ??
      [];
    // Handler params are (actor, PaySummaryIdParamDto) — the DTO only carries
    // summaryId (see dto.ts); there is no staff-scoped DTO on this controller.
    expect(paramTypes.length).toBeLessThanOrEqual(2);
  });
});
