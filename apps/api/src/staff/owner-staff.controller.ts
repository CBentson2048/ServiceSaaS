import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  ListStaffResponse,
  StaffInvitation,
  StaffInvitationWithToken,
  StaffPhotoUploadResponse,
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
import { StaffService, type UploadedPhotoFile } from './staff.service';

// Backstop above the 5 MB business rule (enforced precisely in the service) so a
// runaway upload can't buffer unbounded memory.
const PHOTO_UPLOAD_HARD_LIMIT_BYTES = 8 * 1024 * 1024;

@Controller('owner')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('staff.view')
export class OwnerStaffController {
  constructor(private readonly staff: StaffService) {}

  @Post('staff/invitations')
  @RequirePermissions('staff.manage')
  createInvitation(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateStaffInvitationDto,
  ): Promise<StaffInvitationWithToken> {
    return this.staff.createInvitation(actor, body);
  }

  @Get('staff/invitations')
  @RequirePermissions('staff.manage')
  listInvitations(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListStaffInvitationsQueryDto,
  ): Promise<StaffInvitation[]> {
    return this.staff.listInvitations(actor, query.status);
  }

  @Post('staff/invitations/:id/resend')
  @RequirePermissions('staff.manage')
  resendInvitation(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<StaffInvitationWithToken> {
    return this.staff.resendInvitation(actor, id);
  }

  @Post('staff/invitations/:id/revoke')
  @RequirePermissions('staff.manage')
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
  @RequirePermissions('staff.manage')
  updateStaff(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
    @Body() body: UpdateStaffMemberDto,
  ): Promise<UpdateStaffMemberResponse> {
    return this.staff.updateStaffMember(actor, userId, body);
  }

  @Post('staff/:userId/photo')
  @RequirePermissions('staff.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PHOTO_UPLOAD_HARD_LIMIT_BYTES } }))
  uploadPhoto(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
    @UploadedFile() file: UploadedPhotoFile,
  ): Promise<StaffPhotoUploadResponse> {
    return this.staff.uploadStaffPhoto(actor, userId, file);
  }

  @Post('staff/:userId/deactivate')
  @HttpCode(200)
  @RequirePermissions('staff.manage')
  deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
  ): Promise<UpdateStaffMemberResponse> {
    return this.staff.deactivateStaff(actor, userId);
  }

  @Post('staff/:userId/reactivate')
  @HttpCode(200)
  @RequirePermissions('staff.manage')
  reactivate(
    @CurrentUser() actor: AuthUser,
    @Param('userId') userId: string,
  ): Promise<UpdateStaffMemberResponse> {
    return this.staff.reactivateStaff(actor, userId);
  }
}
