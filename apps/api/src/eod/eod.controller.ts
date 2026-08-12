import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, EodDayResponse, ListEodDaysResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { EodService } from './eod.service';
import {
  AddEodPettyCashDto,
  GetEodDayQueryDto,
  ListEodDaysQueryDto,
  OpenEodDayDto,
  UpdateEodDayDto,
} from './dto';

/**
 * End-of-day cash-up (Week 5). Location scoping is enforced in the service on
 * every call (permission keys carry no location dimension). Receptionist-level
 * users hold eod.manage; sign-off additionally needs eod.sign_off.
 */
@Controller('eod')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('eod.manage')
export class EodController {
  constructor(private readonly eod: EodService) {}

  @Post('open')
  open(@CurrentUser() actor: AuthUser, @Body() body: OpenEodDayDto): Promise<EodDayResponse> {
    return this.eod.openDay(actor, body);
  }

  @Get('day')
  day(
    @CurrentUser() actor: AuthUser,
    @Query() query: GetEodDayQueryDto,
  ): Promise<EodDayResponse> {
    return this.eod.getDay(actor, query.locationId, query.businessDate);
  }

  @Get('days')
  days(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListEodDaysQueryDto,
  ): Promise<ListEodDaysResponse> {
    return this.eod.listDays(actor, query.locationId, query.limit);
  }

  @Post(':id/refresh')
  refresh(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<EodDayResponse> {
    return this.eod.refreshExpected(actor, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateEodDayDto,
  ): Promise<EodDayResponse> {
    return this.eod.updateDay(actor, id, body);
  }

  @Post(':id/petty-cash')
  addPettyCash(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: AddEodPettyCashDto,
  ): Promise<EodDayResponse> {
    return this.eod.addPettyCash(actor, id, body);
  }

  @Post(':id/sign-off')
  @RequirePermissions('eod.sign_off')
  signOff(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<EodDayResponse> {
    return this.eod.signOff(actor, id);
  }
}
