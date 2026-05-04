import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import type { AuthenticatedRequest } from './types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.auth;
  },
);
