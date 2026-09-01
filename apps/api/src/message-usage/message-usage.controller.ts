import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, MessageUsageResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MessageUsageService } from './message-usage.service';

/**
 * Account-level message usage (Wrike 4507284256).
 *
 * Owner-only, gated on `account.manage` — the existing permission for the
 * account/plan surface, which is exactly what an allowance is. The service
 * re-checks the owner role independently.
 *
 * THERE IS DELIBERATELY NO WRITE ENDPOINT. A salon cannot tell the server how
 * many messages it sent: usage derives solely from canonical messaging events
 * recorded inside the dispatcher. There is no `POST /usage/increment`, no
 * "set usage to zero", and no way to choose a different period — those would
 * make billing evidence untrustworthy.
 *
 * The one write-shaped route is `reconcile`, and it only ever recomputes the
 * materialised counters FROM the immutable ledger; it can never invent usage.
 */
@Controller('account/message-usage')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner')
@RequirePermissions('account.manage')
export class MessageUsageController {
  constructor(private readonly usage: MessageUsageService) {}

  /** Current period plus previous periods, newest first. */
  @Get()
  get(@CurrentUser() actor: AuthUser): Promise<MessageUsageResponse> {
    return this.usage.usageForActor(actor);
  }

  /**
   * Compare the period counters against the immutable ledger.
   *
   * Read-only unless `apply=true`. Evidence and recovery — the counters are
   * maintained transactionally, so nothing in production depends on this.
   */
  @Post('reconcile')
  reconcile(
    @CurrentUser() actor: AuthUser,
    @Query('periodStart') periodStart?: string,
    @Query('apply') apply?: string,
  ) {
    return this.usage.reconcile(actor, periodStart, apply === 'true');
  }
}
