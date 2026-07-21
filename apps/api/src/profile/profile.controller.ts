import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  CustomerSalonDetailResponse,
  CustomerSalonsResponse,
  ListProfilesResponse,
  UpdateProfileResponse,
  UserProfileResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminProfileEmailQueryDto, AdminUpdateProfileDto, ListProfilesQueryDto, UpdateCurrentProfileDto } from './dto';
import { ProfileService } from './profile.service';

@Controller('profiles')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('me')
  getMe(@CurrentUser() actor: AuthUser): Promise<UserProfileResponse> {
    return this.profiles.getCurrentProfile(actor);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateCurrentProfileDto,
  ): Promise<UpdateProfileResponse> {
    return this.profiles.updateCurrentProfile(actor, body);
  }

  @Delete('me')
  @HttpCode(204)
  deleteMe(@CurrentUser() actor: AuthUser): Promise<void> {
    return this.profiles.deleteCurrentAccount(actor);
  }

  // The customer's own salons (tiles on their profile home). Declared before the
  // parameterised admin routes below so 'me' + 'salons' never match a :param.
  @Get('me/salons')
  getMySalons(@CurrentUser() actor: AuthUser): Promise<CustomerSalonsResponse> {
    return this.profiles.listMySalons(actor);
  }

  @Get('me/salons/:clientProfileId')
  getMySalonDetail(
    @CurrentUser() actor: AuthUser,
    @Param('clientProfileId') clientProfileId: string,
  ): Promise<CustomerSalonDetailResponse> {
    return this.profiles.getMySalonDetail(actor, clientProfileId);
  }

  @Get()
  @RequireRoles('owner', 'manager')
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListProfilesQueryDto,
  ): Promise<ListProfilesResponse> {
    return this.profiles.listProfiles(actor, query);
  }

  @Get('clients/by-email')
  @RequireRoles('owner', 'manager', 'stylist')
  getClientByEmail(
    @CurrentUser() actor: AuthUser,
    @Query() query: AdminProfileEmailQueryDto,
  ): Promise<UserProfileResponse> {
    return this.profiles.getClientProfileByEmail(actor, query.email);
  }

  @Get('clients/:clientProfileId')
  @RequireRoles('owner', 'manager', 'stylist')
  getClient(
    @CurrentUser() actor: AuthUser,
    @Param('clientProfileId') clientProfileId: string,
  ): Promise<UserProfileResponse> {
    return this.profiles.getClientProfile(actor, clientProfileId);
  }

  @Get('staff/:staffProfileId')
  @RequireRoles('owner', 'manager', 'stylist')
  getStaff(
    @CurrentUser() actor: AuthUser,
    @Param('staffProfileId') staffProfileId: string,
  ): Promise<UserProfileResponse> {
    return this.profiles.getStaffProfile(actor, staffProfileId);
  }

  @Patch(':userProfileId')
  @RequireRoles('owner', 'manager')
  updateProfile(
    @CurrentUser() actor: AuthUser,
    @Param('userProfileId') userProfileId: string,
    @Body() body: AdminUpdateProfileDto,
  ): Promise<UpdateProfileResponse> {
    return this.profiles.updateProfileAsAdmin(actor, userProfileId, body);
  }
}
