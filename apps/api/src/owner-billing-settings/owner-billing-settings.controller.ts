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
  GetLocationProductBillingSettingsResponse,
  UpdateLocationProductBillingSettingsResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { UpdateProductBillingSettingsDto } from './dto';
import { OwnerBillingSettingsService } from './owner-billing-settings.service';

@Controller('owner/billing-settings')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
export class OwnerBillingSettingsController {
  constructor(private readonly service: OwnerBillingSettingsService) {}

  @Get('product')
  async getProductBillingSettings(
    @CurrentUser() actor: AuthUser,
    @Query('locationId') locationId: string,
  ): Promise<GetLocationProductBillingSettingsResponse> {
    if (!locationId) {
      throw new BadRequestException('locationId query parameter is required');
    }
    return { settings: await this.service.getProductBillingSettings(actor, locationId) };
  }

  @Patch('product')
  async updateProductBillingSettings(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateProductBillingSettingsDto,
  ): Promise<UpdateLocationProductBillingSettingsResponse> {
    return { settings: await this.service.updateProductBillingSettings(actor, body) };
  }
}
