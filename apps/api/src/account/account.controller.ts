import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import type { AuthUser, GetAccountResponse, UpdateAccountTierResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AccountService } from './account.service';
import { UpdateAccountTierDto } from './dto';

@Controller('owner/account')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
export class AccountController {
  constructor(private readonly service: AccountService) {}

  @Get()
  async getAccount(@CurrentUser() actor: AuthUser): Promise<GetAccountResponse> {
    return { account: await this.service.getState(actor) };
  }

  @Patch('tier')
  @RequireRoles('owner')
  @RequirePermissions('account.manage')
  async updateTier(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateAccountTierDto,
  ): Promise<UpdateAccountTierResponse> {
    return { account: await this.service.updateTier(actor, body.tier) };
  }
}
