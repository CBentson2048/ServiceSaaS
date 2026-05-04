import type { Request } from 'express';
import type { AuthUser } from '@sheer/domain';

export interface AuthenticatedRequest extends Request {
  auth?: AuthUser;
}
