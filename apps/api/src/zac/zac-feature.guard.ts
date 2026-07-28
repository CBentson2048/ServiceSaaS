import { Injectable, NotFoundException } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { ZacRolloutService } from './zac-rollout.service';

/**
 * First guard on every ZAC route: while the global flag is off the routes do not
 * exist (404 before any auth work). The per-business allowlist needs the
 * authenticated actor, so it is enforced after auth via
 * {@link ZacRolloutService.assertRolloutFor}.
 */
@Injectable()
export class ZacFeatureGuard implements CanActivate {
  constructor(private readonly rollout: ZacRolloutService) {}

  canActivate(): boolean {
    if (!this.rollout.isGloballyEnabled()) {
      throw new NotFoundException();
    }
    return true;
  }
}
