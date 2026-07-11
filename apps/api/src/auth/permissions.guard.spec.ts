import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Permission } from '@sheer/domain';
import { PermissionsGuard } from './permissions.guard';

function contextWith(permissions: Permission[] | undefined): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => (permissions === undefined ? {} : { auth: { permissions } }),
    }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it('allows routes without permission metadata', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as unknown as Reflector;

    expect(new PermissionsGuard(reflector).canActivate(contextWith(undefined))).toBe(true);
  });

  it('allows a user holding every required permission', () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue(['crm.view', 'bookings.manage'] satisfies Permission[]),
    } as unknown as Reflector;

    expect(
      new PermissionsGuard(reflector).canActivate(
        contextWith(['crm.view', 'bookings.manage', 'retail.record']),
      ),
    ).toBe(true);
  });

  it('denies a user missing any required permission', () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue(['crm.view', 'crm.manage'] satisfies Permission[]),
    } as unknown as Reflector;

    expect(() =>
      new PermissionsGuard(reflector).canActivate(contextWith(['crm.view'])),
    ).toThrow(ForbiddenException);
  });

  it('denies an unauthenticated request on a protected route', () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(['inventory.manage'] satisfies Permission[]),
    } as unknown as Reflector;

    expect(() => new PermissionsGuard(reflector).canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
