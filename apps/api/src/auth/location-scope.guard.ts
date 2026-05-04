import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from './types';

const LOCATION_PARAM_KEY = 'sheer:location-param';

export const RequireLocationScope = (paramName = 'locationId') =>
  SetMetadata(LOCATION_PARAM_KEY, paramName);

@Injectable()
export class LocationScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName = this.reflector.getAllAndOverride<string>(LOCATION_PARAM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!paramName) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.auth;
    const locationId = resolveLocationId(request, paramName);

    if (!user || !locationId) {
      throw new ForbiddenException('Location scope could not be resolved');
    }

    if (user.role === 'owner' || user.allowedLocationIds.includes(locationId)) {
      return true;
    }

    throw new ForbiddenException('Location is outside the signed-in user scope');
  }
}

function resolveLocationId(request: AuthenticatedRequest, paramName: string): string | undefined {
  const fromParams = request.params?.[paramName];
  if (typeof fromParams === 'string' && fromParams) return fromParams;

  const fromQuery = request.query?.[paramName];
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  const body = request.body as Record<string, unknown> | undefined;
  const fromBody = body?.[paramName];
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined;
}
