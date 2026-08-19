import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, ColourPrepResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { ColourPrepService } from './colour-prep.service';
import { ColourPrepQueryDto } from './dto';

/**
 * Colour Prep sits on the same guard stack as the rest of the inventory surface:
 * it reads stock levels and client formula history, so it carries the same key.
 * The service re-checks location scope regardless — the guard proves who the
 * caller is, not which locations they may look at.
 */
@Controller('colour-prep')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('inventory.manage')
export class ColourPrepController {
  constructor(private readonly colourPrep: ColourPrepService) {}

  @Get()
  async getPlan(
    @CurrentUser() actor: AuthUser,
    @Query() query: ColourPrepQueryDto,
  ): Promise<ColourPrepResponse> {
    return { plan: await this.colourPrep.getPlan(actor, query) };
  }
}
