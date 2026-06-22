import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { userHasAnyRole } from '@sheer/domain';
import type { AuthenticatedRequest } from './types';

const STAFF_PROFILE_PARAM_KEY = 'sheer:staff-profile-param';

export const RequireStaffSelfScope = (paramName = 'staffProfileId') =>
  SetMetadata(STAFF_PROFILE_PARAM_KEY, paramName);

@Injectable()
export class StylistSelfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName = this.reflector.getAllAndOverride<string>(STAFF_PROFILE_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!paramName) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.auth;
    const staffProfileId = request.params?.[paramName];

    if (!user || !staffProfileId) {
      throw new ForbiddenException('Staff scope could not be resolved');
    }

    if (userHasAnyRole(user, ['owner', 'manager']) || user.staffProfileId === staffProfileId) {
      return true;
    }

    throw new ForbiddenException('Staff profile is outside the signed-in stylist scope');
  }
}
