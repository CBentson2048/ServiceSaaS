import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ZacAskRequestDto } from './dto/zac-ask-request.dto';
import type { ZacHealthResponse, ZacResponse } from './responses/zac-response.types';
import { ZacFeatureGuard } from './zac-feature.guard';
import { ZacService } from './zac.service';

/**
 * ZAC Phase 1 Week 1 surface. Dark-launched: routes 404 unless `ZAC_ENABLED=true`
 * (plus the optional business allowlist, checked post-auth). `zac.access` opens
 * the feature only — every data tool independently re-checks the underlying
 * permission it needs, so this controller never widens report/QLAB/stock access.
 */
@Controller('zac')
@UseGuards(ZacFeatureGuard, SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('zac.access')
export class ZacController {
  constructor(private readonly zac: ZacService) {}

  /** Controlled Week 1 test response — contract-shaped, stub provider, no live business data. */
  @Post('ask')
  @HttpCode(200)
  ask(@CurrentUser() actor: AuthUser, @Body() body: ZacAskRequestDto): Promise<ZacResponse> {
    return this.zac.ask(actor, body);
  }

  /** Operational check for the dark launch. No model call, no business data. */
  @Get('health')
  health(@CurrentUser() actor: AuthUser): ZacHealthResponse {
    return this.zac.health(actor);
  }
}
