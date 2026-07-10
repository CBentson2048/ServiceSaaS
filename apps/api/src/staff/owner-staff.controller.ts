import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ListStaffResponse,
  StaffInvitation,
  StaffInvitationWithToken,
  UpdateStaffMemberResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { AuthUser } from '@sheer/domain';
import {
  CreateStaffInvitationDto,
  ListStaffInvitationsQueryDto,
  UpdateStaffMemberDto,
} from './dto';
import { StaffService } from './staff.service';

@Controller('owner')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner')
@RequirePermissions('staff.manage')
export class OwnerStaffController {
  constructor(private readonly staff: StaffService) {}

  @Post('staff/invitations')
  createInvitation(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateStaffInvitationDto,
  ): Promise<StaffInvitationWithToken> {
    return this.staff.createInvitation(actor, body);
  }

  @Get('staff/invitations')
  listInvitations(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListStaffInvitationsQueryDto,
  ): Promise<StaffInvitation[]> {
    return this.staff.listInvitations(actor, query.status);
  }

  @Post('staff/invitations/:id/resend')
  resendInvitation(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<StaffInvitationWithToken> {
    return this.staff.resendInvitation(actor, id);
  }

  @Post('staff/invitations/:id/revoke')
  revokeInvitation(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<StaffInvitation> {
    return this.staff.revokeInvitation(actor, id);
  }

  @Get('staff')
  listStaff(@CurrentUser() actor: AuthUser): Promise<ListStaffResponse> {
    return this.staff.listStaff(actor);
  }

  @Patch('staff/:userId')
  updateStaff(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
    @Body() body: UpdateStaffMemberDto,
  ): Promise<UpdateStaffMemberResponse> {
    return this.staff.updateStaffMember(actor, userId, body);
  }

  @Post('staff/:userId/deactivate')
  @HttpCode(200)
  deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
  ): Promise<UpdateStaffMemberResponse> {
    return this.staff.deactivateStaff(actor, userId);
  }

  @Post('staff/:userId/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
  ): Promise<UpdateStaffMemberResponse> {
    return this.staff.reactivateStaff(actor, userId);
  }
}
