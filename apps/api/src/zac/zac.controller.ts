import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ZacAskRequestDto } from './dto/zac-ask-request.dto';
import { ZacFeedbackRequestDto } from './dto/zac-feedback-request.dto';
import type {
  ZacFeedbackResponse,
  ZacHealthResponse,
  ZacResponse,
} from './responses/zac-response.types';
import { ZacFeatureGuard } from './zac-feature.guard';
import { ZacService } from './zac.service';

/**
 * ZAC surface. On by default since general availability; `ZAC_ENABLED=false` is
 * the kill-switch (plus the optional business allowlist, checked post-auth).
 * `zac.access` opens the feature only — every data tool independently re-checks
 * the underlying permission it needs, so this controller never widens
 * report/QLAB/stock access.
 */
@Controller('zac')
@UseGuards(ZacFeatureGuard, SupabaseAuthGuard, RolesGuard, PermissionsGuard)
// Stylists are admitted to the SURFACE only; the registry gives them a
// stylist-safe tool catalogue and the router adds self-scope/restricted
// handling. zac.access is still required — all staff roles hold it by default
// since GA, but owners can withdraw it per security level.
@RequireRoles('owner', 'manager', 'stylist')
@RequirePermissions('zac.access')
export class ZacController {
  constructor(private readonly zac: ZacService) {}

  /** Controlled Week 1 test response — contract-shaped, stub provider, no live business data. */
  @Post('ask')
  @HttpCode(200)
  ask(@CurrentUser() actor: AuthUser, @Body() body: ZacAskRequestDto): Promise<ZacResponse> {
    return this.zac.ask(actor, body);
  }

  /**
   * Useful/not-useful feedback on a persisted output. One active vote per
   * user per output (a change updates in place). Fail-closed: an output the
   * actor may not access — other business, other user's private answer —
   * is the same 404 as one that never existed. Fail-hard: a storage failure
   * surfaces as an error, never a false success.
   */
  @Post('outputs/:outputId/feedback')
  @HttpCode(200)
  feedback(
    @CurrentUser() actor: AuthUser,
    @Param('outputId', new ParseUUIDPipe()) outputId: string,
    @Body() body: ZacFeedbackRequestDto,
  ): Promise<ZacFeedbackResponse> {
    return this.zac.submitFeedback(actor, outputId, body);
  }

  /** Operational check for the dark launch. No model call, no business data. */
  @Get('health')
  health(@CurrentUser() actor: AuthUser): ZacHealthResponse {
    return this.zac.health(actor);
  }
}
