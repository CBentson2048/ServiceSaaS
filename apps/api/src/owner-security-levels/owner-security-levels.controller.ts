import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  ListSecurityLevelsResponse,
  PermissionCatalogResponse,
  SecurityLevelResponse,
} from '@sheer/domain';
import { PERMISSION_CATALOG } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateSecurityLevelDto, UpdateSecurityLevelDto } from './dto';
import { OwnerSecurityLevelsService } from './owner-security-levels.service';

@Controller('owner/security-levels')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner')
@RequirePermissions('security.manage')
export class OwnerSecurityLevelsController {
  constructor(private readonly service: OwnerSecurityLevelsService) {}

  /** The fixed permission catalogue the UI renders as toggles. */
  @Get('permissions')
  permissions(): PermissionCatalogResponse {
    return { permissions: [...PERMISSION_CATALOG] };
  }

  @Get()
  async list(@CurrentUser() actor: AuthUser): Promise<ListSecurityLevelsResponse> {
    return { levels: await this.service.list(actor) };
  }

  @Post()
  async create(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateSecurityLevelDto,
  ): Promise<SecurityLevelResponse> {
    return { level: await this.service.create(actor, body) };
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateSecurityLevelDto,
  ): Promise<SecurityLevelResponse> {
    return { level: await this.service.update(actor, id, body) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<void> {
    await this.service.remove(actor, id);
  }
}
