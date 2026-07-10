import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@sheer/domain';
import { userHasAllPermissions } from '@sheer/domain';
import type { AuthenticatedRequest } from './types';

const PERMISSIONS_KEY = 'sheer:permissions';

/**
 * Require the signed-in user to hold ALL of the given permissions. Layered on
 * top of `@RequireRoles` (add both guards to the controller's `@UseGuards`):
 * roles gate the coarse surface, permissions gate the specific feature/report.
 * Owners always resolve with every permission, so V1 owner/manager flows are
 * unaffected while custom security levels can be denied.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.auth;

    if (!user || !userHasAllPermissions(user, required)) {
      throw new ForbiddenException('You do not have permission to access this resource');
    }

    return true;
  }
}
