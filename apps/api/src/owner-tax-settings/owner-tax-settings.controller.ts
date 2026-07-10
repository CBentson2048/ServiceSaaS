import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  GetLocationTaxSettingsResponse,
  UpdateLocationTaxSettingsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { UpdateTaxSettingsDto } from './dto';
import { OwnerTaxSettingsService } from './owner-tax-settings.service';

@Controller('owner/tax-settings')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('settings.tax.manage')
export class OwnerTaxSettingsController {
  constructor(private readonly service: OwnerTaxSettingsService) {}

  @Get()
  async getTaxSettings(
    @CurrentUser() actor: AuthUser,
    @Query('locationId') locationId: string,
  ): Promise<GetLocationTaxSettingsResponse> {
    if (!locationId) {
      throw new BadRequestException('locationId query parameter is required');
    }
    return { settings: await this.service.getTaxSettings(actor, locationId) };
  }

  @Patch()
  async updateTaxSettings(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateTaxSettingsDto,
  ): Promise<UpdateLocationTaxSettingsResponse> {
    return { settings: await this.service.updateTaxSettings(actor, body) };
  }
}
