import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  EffectiveFixedCostsResponse,
  ListLocationFixedCostsResponse,
  LocationFixedCostResponse,
  LocationRecordSettingsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { PermissionsGuard, RequirePermissions } from '../auth/permissions.guard';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  CreateLocationFixedCostDto,
  EffectiveFixedCostsQueryDto,
  FixedCostIdParamDto,
  LocationIdQueryDto,
  UpdateLocationFixedCostDto,
  UpdateLocationRecordSettingsDto,
} from './dto';
import { OwnerLocationSettingsService } from './owner-location-settings.service';

/**
 * Owner + manager configuration of the salon/location record: operating fields,
 * policy thresholds, reporting targets, Sunday Night Report, and effective-dated
 * fixed costs. Manager access is scoped to their assigned location(s) in the
 * service.
 */
@Controller('owner/location-settings')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('settings.location.manage')
export class OwnerLocationSettingsController {
  constructor(private readonly service: OwnerLocationSettingsService) {}

  @Get()
  async getSettings(
    @CurrentUser() actor: AuthUser,
    @Query() query: LocationIdQueryDto,
  ): Promise<LocationRecordSettingsResponse> {
    return { settings: await this.service.getSettings(actor, query.locationId) };
  }

  @Patch()
  async updateSettings(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateLocationRecordSettingsDto,
  ): Promise<LocationRecordSettingsResponse> {
    return { settings: await this.service.updateSettings(actor, body) };
  }

  // --- Fixed costs -----------------------------------------------------------

  @Get('fixed-costs')
  async listFixedCosts(
    @CurrentUser() actor: AuthUser,
    @Query() query: LocationIdQueryDto,
  ): Promise<ListLocationFixedCostsResponse> {
    return { fixedCosts: await this.service.listFixedCosts(actor, query.locationId) };
  }

  @Get('fixed-costs/effective')
  async getEffectiveFixedCosts(
    @CurrentUser() actor: AuthUser,
    @Query() query: EffectiveFixedCostsQueryDto,
  ): Promise<EffectiveFixedCostsResponse> {
    return this.service.getEffectiveFixedCosts(actor, query.locationId, query.date);
  }

  @Post('fixed-costs')
  async createFixedCost(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateLocationFixedCostDto,
  ): Promise<LocationFixedCostResponse> {
    return { fixedCost: await this.service.createFixedCost(actor, body) };
  }

  @Patch('fixed-costs/:id')
  async updateFixedCost(
    @CurrentUser() actor: AuthUser,
    @Param() params: FixedCostIdParamDto,
    @Body() body: UpdateLocationFixedCostDto,
  ): Promise<LocationFixedCostResponse> {
    return { fixedCost: await this.service.updateFixedCost(actor, params.id, body) };
  }

  @Delete('fixed-costs/:id')
  @HttpCode(204)
  async deleteFixedCost(
    @CurrentUser() actor: AuthUser,
    @Param() params: FixedCostIdParamDto,
  ): Promise<void> {
    await this.service.deleteFixedCost(actor, params.id);
  }
}
