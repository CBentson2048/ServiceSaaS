import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, ListBillsResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BillsService } from './bills.service';
import { ListBillsQueryDto } from './dto';

/**
 * Bill finder (Week 5): read-only search over the stored bills written by
 * checkout (0085). Opening a result goes through the existing
 * /checkout/visits/:visitId page, which serves the full itemisation.
 */
@Controller('bills')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('bills.view')
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListBillsQueryDto,
  ): Promise<ListBillsResponse> {
    return this.bills.list(actor, query);
  }
}
