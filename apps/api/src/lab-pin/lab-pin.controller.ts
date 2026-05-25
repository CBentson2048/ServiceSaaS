import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthUser, LabPinMutationResponse, ListLabPinStatusesResponse } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AssignLabPinDto, PinStatusQueryDto, ResetLabPinDto } from './dto';
import { LabPinService } from './lab-pin.service';

@Controller('lab/pins')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
export class LabPinController {
  constructor(private readonly labPinService: LabPinService) {}

  @Post('assign')
  assign(
    @CurrentUser() actor: AuthUser,
    @Body() dto: AssignLabPinDto,
  ): Promise<LabPinMutationResponse> {
    return this.labPinService.assign(actor, dto);
  }

  @Post('reset')
  reset(
    @CurrentUser() actor: AuthUser,
    @Body() dto: ResetLabPinDto,
  ): Promise<LabPinMutationResponse> {
    return this.labPinService.reset(actor, dto);
  }

  @Get('status')
  status(
    @CurrentUser() actor: AuthUser,
    @Query() query: PinStatusQueryDto,
  ): Promise<ListLabPinStatusesResponse> {
    return this.labPinService.status(actor, query);
  }
}
