import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@sheer/domain';
import { userHasAnyRole } from '@sheer/domain';
import type { AuthenticatedRequest } from './types';

const ROLES_KEY = 'sheer:roles';

export const RequireRoles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.auth;

    // A multi-role user passes if ANY of their active roles is allowed.
    if (!user || !userHasAnyRole(user, requiredRoles)) {
      throw new ForbiddenException('Role is not allowed for this route');
    }

    return true;
  }
}
