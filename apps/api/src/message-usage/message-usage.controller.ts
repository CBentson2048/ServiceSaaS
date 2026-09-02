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
 * The two write-shaped routes are `reconcile` and `recover`, and neither can
 * invent usage: one recomputes the materialised counters FROM the immutable
 * ledger, the other re-runs the idempotent recorder over events the platform had
 * already recorded as sent. Neither can reach a provider.
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

  /**
   * Account for sends the provider accepted but whose ledger write failed, for
   * THIS business only.
   *
   * Not the primary path — MessageUsageRecoveryService runs the same code on a
   * timer across every account, because a manual route alone would leave the
   * guarantee resting on somebody remembering. This exists so an owner or an
   * operator can force a pass now rather than in fifteen minutes.
   *
   * It cannot send a message and cannot invent usage: it only re-runs the
   * idempotent recorder over events already marked sent, and the ledger's unique
   * key means a redundant call changes nothing.
   */
  @Post('recover')
  recover(@CurrentUser() actor: AuthUser, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.usage.recoverForActor(actor, Number.isNaN(parsed) ? undefined : parsed);
  }
}
