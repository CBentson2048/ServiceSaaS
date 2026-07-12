import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, ListAuditLogResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AuditService } from './audit.service';
import { ListAuditLogQueryDto } from './dto';

@Controller('audit')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('audit.read')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get('events')
  async list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListAuditLogQueryDto,
  ): Promise<ListAuditLogResponse> {
    return this.service.list(actor, query);
  }
}
